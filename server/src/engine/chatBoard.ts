import { memoryFacts } from "./memory.ts";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type { ChatMessage, Effort, EventRow, Mode, RunStyle, Stage, Task } from "../types.ts";
import { EFFORTS, PRIORITIES, RUN_STYLES, runStyleFields, TASK_STATUSES, TASK_TYPES } from "../types.ts";
import { allowedMode, defaultPipeline } from "./boardMcp.ts";
import { QUESTION_TOOL, type TaskRunner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import { answerStage, isAnswerPipeline, stageLabel } from "./answer.ts";
import { findClaudeModel, resolveClaudeModel } from "./claudeModels.ts";

type Card = NonNullable<ChatMessage["meta"]["cards"]>[number];

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ ...text(message), isError: true });
/** "answer · claude-sonnet-5-5 · medium": how a card will run, in one line the model reads cheaply. */
export const pipelineLine = (p: Stage[]) => p.map((s) => `${stageLabel(s)} · ${s.model} · ${s.effort}`).join(" → ");
const brief = (t: Task) => ({
  id: t.id, title: t.title, status: t.status, type: t.type, priority: t.priority, mode: t.mode, summary: t.summary, start_at: t.start_at,
  pipeline: pipelineLine(t.pipeline),
  ...(t.live ? { live: true } : {}),
  ...(t.own_branch ? { own_branch: true } : {}),
  ...(t.mode === "autonomous" && t.may_ask ? { asks_user: true } : {}),
  // Only when there is one, so a quiet board stays a short list.
  ...(t.questions.some((q) => !q.answer) ? { open_questions: t.questions.filter((q) => !q.answer).length } : {}),
});

/** Cards a follow-up can go to: working, waiting for review, failed, or done. */
const FOLLOW_UP_STATUSES = new Set<Task["status"]>(["running", "planning", "review", "failed", "done"]);
/** Words that say nothing about which card a request is about. */
const STOP_WORDS = new Set(["make", "change", "please", "with", "that", "this", "from", "into", "have", "should", "would", "could", "about", "there", "their", "them", "then", "than", "what", "when", "where", "which", "also", "just", "like", "more", "some", "same", "add", "the", "and", "for"]);
const normFile = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** The questions on an AskUserQuestion card and their option labels, tolerant of anything malformed. */
export function askedQuestions(input: unknown): { question: string; options: string[] }[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is { question: string; options?: unknown } => !!q && typeof q.question === "string")
    .map((q) => ({ question: q.question, options: Array.isArray(q.options) ? q.options.flatMap((o) => (o && typeof o.label === "string" ? [o.label as string] : [])) : [] }));
}

const clip = (s: unknown, max: number) => {
  const t = String(s ?? "").trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
};

/** One transcript row as a plain line: what Claude said or did. null for rows that say nothing to a reader. */
export function activityLine(e: EventRow): string | null {
  const p = (e.payload ?? {}) as { type?: string; text?: string; result?: string; is_error?: boolean; message?: { content?: unknown } };
  if (p.type === "user_chat") return `Message to the task: ${clip(p.text, 300)}`;
  if (p.type === "result") return `${p.is_error ? "Stage failed" : "Stage finished"}: ${clip(p.result, 400)}`;
  if (p.type !== "assistant" || !Array.isArray(p.message?.content)) return null;
  const parts: string[] = [];
  for (const b of p.message.content as { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (b.type === "text" && b.text?.trim()) parts.push(`Claude: ${clip(b.text, 400)}`);
    else if (b.type === "tool_use") {
      const i = b.input ?? {};
      const what = i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.description ?? "";
      parts.push(`→ ${String(b.name).replace(/^mcp__[^_]+__/, "")}${what ? ` ${clip(what, 140)}` : ""}`);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

/** A stage as the chat names it: "answer" is a lookup, the rest are the pipeline's own stages. */
export type StageArg = { stage: "plan" | "code" | "review" | "answer"; model?: string; effort?: Effort };

export interface ChatBoardDeps {
  repo: Repo;
  bus: Bus;
  runner: TaskRunner;
  scheduler?: Scheduler;
}

/**
 * The side chat's hands: it reads the board (cards, how each run is going, what it has done), makes,
 * edits, queues and schedules cards, and talks to a card's own Claude session — all in its own
 * project. It never touches code itself, and never approves, lands or discards work: those stay yours. Handlers are separate from the
 * MCP wrapper so tests call them directly. `onCard` records each card touched, for the chips.
 */
export function chatBoardHandlers({ repo, bus, runner, scheduler }: ChatBoardDeps, projectId: string, chatId: string | null, onCard: (c: Card) => void) {
  const mine = (id: string) => {
    const t = repo.getTask(id);
    return t && t.project_id === projectId ? t : undefined;
  };
  const publish = (t: Task) => bus.publish({ type: "task.updated", task: t });

  /**
   * The stages the chat asked for, each on the model and effort the user named in words, or the board's
   * own choice for that stage. An error names what the board has instead, so the chat can pass it on.
   */
  const buildPipeline = (stages: StageArg[]): { pipeline: Stage[] } | { error: string } => {
    const settings = repo.getSettings();
    const defaults = defaultPipeline(repo, repo.getProject(projectId)!);
    // Only what is already known: asking Claude Code for its list would start a session mid-reply.
    const list = runner.knownClaudeModels();
    if (stages.some((s) => s.stage === "answer") && stages.length > 1) {
      return { error: "An answer card is one stage on its own. For work that changes something, use plan, code and review stages instead." };
    }
    const out: Stage[] = [];
    for (const want of stages) {
      const base: Stage =
        want.stage === "answer"
          ? answerStage(settings)
          : { ...(defaults.find((s) => s.stage === want.stage) ?? { stage: want.stage, model: settings.tiers.balanced.model, effort: "medium" as Effort }) };
      const stage: Stage = { ...base, effort: want.effort ?? base.effort };
      if (want.model) {
        const id = resolveClaudeModel(want.model, settings.models, list);
        if (!id) {
          const names = settings.models.map((m) => `${m.label} (${m.id})`).join(", ");
          return { error: `There is no model called "${want.model}" on this board. It has: ${names}. Short names work too: opus, sonnet, haiku.` };
        }
        stage.model = id;
        // A model named by the user is a Claude model, whatever provider the default stage used.
        delete stage.provider;
      }
      const info = findClaudeModel(stage.model, list);
      if (want.effort && info?.efforts.length && !info.efforts.includes(want.effort)) {
        return { error: `${info.label} takes ${info.efforts.join(", ")} effort, not ${want.effort}.` };
      }
      out.push(stage);
    }
    return { pipeline: out };
  };

  return {
    listTasks(args: { status?: string }) {
      const all = repo.listTasks({ project_id: projectId }).filter((t) => !t.archived_at);
      // Finished cards are counted, not listed, unless asked for: a board with months of Done would
      // otherwise bury the handful that are running under hundreds that are not.
      const tasks = all.filter((t) => (args.status ? t.status === args.status : t.status !== "done"));
      const counts: Record<string, number> = {};
      for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
      const note = !all.length
        ? "No cards on this board yet."
        : !tasks.length
          ? args.status ? `No card is ${args.status} right now.` : "Every card on this board is done."
          : !args.status && counts.done ? `${counts.done} done card(s) are not listed; ask with status "done" to see them.` : undefined;
      // One line per card: the list is read by the model, and indentation only costs tokens.
      return { content: [{ type: "text" as const, text: JSON.stringify({ counts, tasks: tasks.map(brief), note }) }] };
    },

    getTask(args: { task_id: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      return text({ ...brief(t), spec_md: t.spec_md, depends_on: t.depends_on, error: t.error, pipeline: t.pipeline.map((s) => `${s.stage} · ${s.model} · ${s.effort}`) });
    },

    createTask(args: {
      title: string; spec_md: string; type?: string; priority?: string; mode?: RunStyle; depends_on?: string[];
      stages?: StageArg[]; live?: boolean; own_branch?: boolean; follows?: string;
    }) {
      const follows = args.follows ? mine(args.follows) : undefined;
      if (args.follows && !follows) return fail(`No card ${args.follows} in this project.`);
      const project = repo.getProject(projectId)!;
      const deps = (args.depends_on ?? []).filter((id) => mine(id));
      const built = args.stages?.length ? buildPipeline(args.stages) : null;
      if (built && "error" in built) return fail(built.error);
      const pipeline = built?.pipeline ?? defaultPipeline(repo, project);
      const answer = isAnswerPipeline(pipeline);
      // The message's choice first, then the chat's own switch (D344), then the board's default. A
      // lookup follows it too: under autonomous it runs in the project's own folder with nobody asked,
      // where the project gives autonomous that access (D352); otherwise it is supervised (D284).
      const picked: RunStyle = args.mode ?? (chatId ? repo.getChat(chatId)?.mode : undefined) ?? repo.getSettings().defaultRunStyle;
      // "Asks me" is about change work you want a say in. On a lookup it would mean autonomous: a
      // session that reaches the live system with nobody asked, so a lookup takes it as supervised
      // and runs autonomous only when the message or the chat's switch says so outright (D365).
      const style: RunStyle = answer && picked === "ask" && args.mode !== "ask" ? "supervised" : picked;
      const wanted: Mode = runStyleFields(style).mode;
      const mode: Mode = allowedMode(project, wanted, pipeline);
      const t = repo.createTask({
        project_id: projectId,
        title: args.title.trim(),
        // A fresh card that follows another is told what that one did (D56): it cannot remember it.
        spec_md: follows ? `${args.spec_md}\n\n${runner.handoff(follows.id)}` : args.spec_md,
        ...(follows ? { related_to: [follows.id] } : {}),
        type: (args.type as Task["type"]) ?? (answer ? "chore" : "feature"),
        priority: (args.priority as Task["priority"]) ?? "p2",
        mode,
        may_ask: mode === "autonomous" && style === "ask",
        own_branch: !answer && mode === "supervised" && Boolean(args.own_branch),
        live: !answer && Boolean(args.live),
        pipeline,
        depends_on: deps,
        status: "backlog",
        chat_id: chatId,
        // A card with a plan waits for the user to see its mode and models on its setup card (D365).
        setup_pending: repo.getSettings().confirmSetup && pipeline.some((s) => s.stage === "plan"),
      });
      publish(t);
      // The same intake a card made on the board gets — type and labels — but what was settled here with
      // the user is not offered back as a second opinion (D286).
      if (repo.getSettings().autoTriage) {
        void runner.triage(t.id, "classify", { decided: { pipeline: Boolean(built), live: answer || args.live !== undefined } }).catch(() => {});
      }
      onCard({ id: t.id, title: t.title, action: "created" });
      const downgraded = wanted === "autonomous" && mode === "supervised";
      const asks = t.mode === "autonomous" && t.may_ask;
      return text({
        created: brief(t),
        note: [
          answer
            ? `An answer card: one stage that reads and reports, and it lands in Done with its answer. ${mode === "autonomous" ? "It runs autonomous: in the project's own folder, and nothing is asked." : "It runs supervised: a command that is not read-only waits for the user's Allow."} Start it now if the user asked for the result.`
            : t.setup_pending
              ? "It is in Backlog with its setup card. Tell the user, in a short list, the mode it will run in and each step's model and effort, and say they can change any of them on the card and press Start there. Do not start it yourself: board_queue_task waits for that Start."
              : "It is in Backlog. Tell the user how it will run (mode, and why) and offer to start it now or schedule it.",
          asks ? "It is Autonomous + asks me: when it needs the user's answer it stops, and its question appears in this chat, where the user can click an answer or tell you; pass what they say on with board_answer_question." : "",
          downgraded ? (answer ? "This project keeps autonomous inside a sandbox, which a lookup cannot work from, so it is supervised. Full access is a switch in the project's settings." : "This project does not allow autonomous runs, so it is supervised.") : "",
          "Its result is posted into this chat when it finishes.",
        ].filter(Boolean).join(" "),
      });
    },

    updateTask(args: {
      task_id: string; title?: string; spec_md?: string; priority?: string; labels?: string[];
      stages?: StageArg[]; mode?: RunStyle; own_branch?: boolean; live?: boolean;
    }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      if (t.status !== "backlog" && t.status !== "failed") return fail(`"${t.title}" is ${t.status}; only a card in Backlog (or one that failed) can be edited from chat.`);
      const project = repo.getProject(projectId)!;
      const built = args.stages?.length ? buildPipeline(args.stages) : null;
      if (built && "error" in built) return fail(built.error);
      const pipeline = built?.pipeline;
      const answer = isAnswerPipeline(pipeline ?? t.pipeline);
      // A lookup may be autonomous only where the project gives autonomous full access (D352): one
      // that was autonomous as a change card is checked again when it becomes a lookup.
      const asked = args.mode ? runStyleFields(args.mode) : undefined;
      const allowed = allowedMode(project, asked?.mode ?? t.mode, pipeline ?? t.pipeline);
      const mode: Mode | undefined = answer ? (allowed === t.mode ? undefined : allowed) : asked && allowed;
      const ownBranch = answer ? (t.own_branch ? false : undefined) : args.own_branch;
      try {
        runner.assertReconfigurable(t, { mode, pipeline, own_branch: ownBranch });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      let updated = repo.updateTask(t.id, {
        title: args.title?.trim() || undefined,
        spec_md: args.spec_md,
        priority: args.priority as Task["priority"] | undefined,
        labels: args.labels,
        pipeline,
        mode,
        may_ask: asked ? allowed === "autonomous" && asked.may_ask : undefined,
        own_branch: ownBranch,
        live: answer ? (t.live ? false : undefined) : args.live,
      });
      // What the user just settled here replaces what triage offered for the same thing.
      if (updated.suggestion && (pipeline || args.live !== undefined)) updated = runner.dismissSuggestion(t.id, { pipeline: Boolean(pipeline), live: args.live !== undefined });
      else publish(updated);
      onCard({ id: t.id, title: updated.title, action: "updated" });
      const refused = args.mode !== undefined && args.mode !== "supervised" && updated.mode !== "autonomous";
      return text({ updated: brief(updated), ...(refused ? { note: answer ? "This project keeps autonomous inside a sandbox, which a lookup cannot work from, so it stays supervised." : "This project does not allow autonomous runs, so it stays supervised." } : {}) });
    },

    queueTask(args: { task_id: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      // Queueing starts a card from its first stage: on a card in review that would redo reviewed
      // work, and on a failed one it would pay for the plan again instead of continuing.
      if (t.status === "failed") return fail(`"${t.title}" failed; use board_retry_task to continue it from the stage that failed.`);
      if (t.status !== "backlog") return fail(`"${t.title}" is ${t.status}; only a card in Backlog can be started from chat.`);
      if (t.setup_pending && repo.getSettings().confirmSetup) {
        return text({ waiting: brief(t), note: "It waits on its setup card: the user checks its mode and models there and presses Start. Tell them that; it starts the moment they do." });
      }
      try {
        const queued = runner.queueTask(t.id);
        onCard({ id: t.id, title: t.title, action: "queued" });
        const waits = runner.blockers(queued);
        return text({
          queued: brief(queued),
          ...(waits.length ? { note: `It waits for ${waits.map((w) => `"${w.title}" (${w.status})`).join(", ")} to be done, then starts by itself.` } : {}),
        });
      } catch (err) {
        return fail(`Could not queue "${t.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    scheduleTask(args: { task_id: string; start_at: string | null }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      // A start time would queue it later without the person ever seeing how it runs (D365).
      if (args.start_at && args.start_at !== "reset" && t.setup_pending && repo.getSettings().confirmSetup) {
        return fail(`"${t.title}" waits on its setup card. Ask the user to check its mode and models there first; they can set the start time on the card too.`);
      }
      if (args.start_at && t.status !== "backlog" && t.status !== "failed") return fail(`"${t.title}" is ${t.status}; only a Backlog card can be scheduled.`);
      if (args.start_at && args.start_at !== "reset") {
        const at = Date.parse(args.start_at);
        if (!Number.isFinite(at)) return fail(`"${args.start_at}" is not a time. Use ISO 8601 with the offset, e.g. 2026-09-14T03:00:00+03:00, or "reset".`);
        if (at < Date.now() - 60_000) return fail("That time has already passed. Pick a time in the future.");
      }
      const updated = repo.updateTask(t.id, { start_at: args.start_at ? (args.start_at === "reset" ? "reset" : new Date(args.start_at).toISOString()) : null, note: null });
      publish(updated);
      scheduler?.tick();
      onCard({ id: t.id, title: t.title, action: "scheduled" });
      return text({ scheduled: brief(updated) });
    },

    /** How a card's run is going: each stage, what it cost, what it is waiting for, and its latest steps. */
    taskProgress(args: { task_id: string; lines?: number }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      const runs = repo.runsForTask(t.id);
      const latest = runs.at(-1);
      const recent = latest ? repo.recentEvents(latest.id, 120).map(activityLine).filter((l): l is string => !!l).slice(-(args.lines ?? 20)) : [];
      return text({
        ...brief(t),
        error: t.error,
        note: t.note,
        working_now: runner.isBusy(t.id),
        cost_usd: Number(runs.reduce((sum, r) => sum + r.cost_usd, 0).toFixed(4)),
        stages: t.pipeline.map((s, i) => {
          const run = runs.findLast((r) => r.stage_index === i && r.role === "stage");
          return {
            stage: `${i + 1}. ${s.stage} · ${s.model} · ${s.effort}`,
            status: run?.status ?? "not started",
            cost_usd: run ? Number(run.cost_usd.toFixed(4)) : 0,
            error: run?.error ?? undefined,
            result: run?.result_md ? clip(run.result_md, 1500) : undefined,
          };
        }),
        open_questions: t.questions.filter((q) => !q.answer).map((q) => ({ question_id: q.id, text: q.text, options: q.options })),
        // A question card it stopped on: nothing moves until it is answered (D361).
        waiting_on_question: repo.pendingApprovals(t.id).filter((a) => a.tool_name === QUESTION_TOOL).map((a) => ({ question_id: a.id, questions: askedQuestions(a.input) })),
        // Claude's own to-do list for the stage: the quickest honest answer to "how far along is it?".
        steps: t.checklist.map((x) => `${x.status === "completed" ? "[done]" : x.status === "in_progress" ? "[now]" : "[todo]"} ${x.text}`),
        waiting_for_approval: repo.pendingApprovals(t.id).filter((a) => a.tool_name !== QUESTION_TOOL).map((a) => a.title ?? a.tool_name),
        recent_activity: recent,
      });
    },

    /**
     * The cards a request is most likely about, with what the board knows of each one's memory (D375): the
     * chat decides where a follow-up goes from this, not from a guess. Scored by the files the chat looked
     * at against the files each card changed, the request's words in its title, summary, spec and files,
     * and whether this chat made it.
     */
    async relatedCards(args: { request: string; files?: string[] }) {
      const words = [...new Set(args.request.toLowerCase().match(/[\p{L}\p{N}_.-]{4,}/gu) ?? [])].filter((w) => !STOP_WORDS.has(w)).slice(0, 20);
      const asked = (args.files ?? []).map(normFile);
      const candidates = repo.listTasks({ project_id: projectId }).filter((t) => !t.archived_at && FOLLOW_UP_STATUSES.has(t.status));
      const scored: { t: Task; files: string[]; score: number }[] = [];
      for (const t of candidates) {
        let files = t.files;
        // Work not landed yet has no file list of its own: its diff is where it worked.
        if (!files.length && (t.status === "review" || t.status === "failed") && t.branch) {
          files = await runner.diff(t.id).then((d) => d.map((f) => f.file), () => []);
        }
        const mineFiles = files.map(normFile);
        let score = 0;
        for (const f of asked) if (mineFiles.some((m) => m === f || m.endsWith(`/${f}`) || f.endsWith(`/${m}`))) score += 5;
        const title = t.title.toLowerCase();
        const body = `${t.summary ?? ""} ${t.spec_md}`.toLowerCase();
        for (const w of words) {
          if (title.includes(w)) score += 3;
          else if (body.includes(w)) score += 1;
          if (mineFiles.some((m) => m.includes(w))) score += 2;
        }
        if (score > 0 && chatId && t.chat_id === chatId) score += 2;
        if (score > 0) scored.push({ t, files, score });
      }
      scored.sort((a, b) => b.score - a.score || b.t.updated_at.localeCompare(a.t.updated_at));
      const top = scored.slice(0, 3).map(({ t, files }) => {
        const m = memoryFacts(runner.memoryInput(t.id));
        return {
          ...brief(t),
          round: t.round,
          files: files.slice(0, 15),
          memory: m.memory,
          ...(m.warmUntil ? { warm_until: m.warmUntil } : {}),
          memory_full_pct: m.contextPct,
          model: m.model,
          cost_to_continue: m.continueUsd !== null ? `about $${m.continueUsd.toFixed(2)}` : `about ${Math.round(m.continueWeight / 1000)}k token-equivalents`,
          cost_of_new_card: m.freshUsd !== null ? `about $${m.freshUsd.toFixed(2)}` : `about ${Math.round(m.freshWeight / 1000)}k token-equivalents`,
          routes: m.can,
          recommended: m.recommendation,
          why: m.why,
        };
      });
      return text({
        cards: top,
        note: top.length
          ? "Routes: steer / add_to_round / new_round / fork go through board_continue_task; fresh is board_create_task with follows set. Take the recommended route unless the request is clearly not the same work."
          : "No card on this board matches: make a new card.",
      });
    },

    /**
     * Sends a follow-up where the memory is (D375, D376): steer or add_to_round as a message to the card's
     * coder, new_round on a done card, fork into a new card that starts with a copy of its memory.
     */
    async continueTask(args: { task_id: string; how: "steer" | "add_to_round" | "new_round" | "fork"; request: string; title?: string; review?: boolean }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      const ask = args.request.trim();
      if (!ask) return fail("The request is empty.");
      const facts = memoryFacts(runner.memoryInput(t.id));
      if (!facts.can.includes(args.how)) {
        return fail(`"${t.title}" cannot take ${args.how.replace("_", " ")} now: ${facts.why} Routes open: ${facts.can.join(", ") || "none"}.`);
      }
      try {
        if (args.how === "steer" || args.how === "add_to_round") {
          runner.chat(t.id, ask);
          onCard({ id: t.id, title: t.title, action: "messaged" });
          return text({ sent: true, card: brief(t), note: args.how === "steer" ? "It is running and takes this at its next step." : "Its coder is on it now; the change joins the work waiting for the user's review. Say so, and that they approve it all together." });
        }
        if (args.how === "new_round") {
          const r = await runner.startRound(t.id, ask, { review: args.review });
          publish(r);
          onCard({ id: r.id, title: r.title, action: "continued" });
          return text({ round: r.round, card: brief(r), note: `Round ${r.round} is queued on "${r.title}": its coder continues with what it remembers (${facts.memory === "warm" ? "its memory is warm, so it is cheap" : "its memory had cooled; it re-reads it once"}). Say so in one line, and that it lands on its own Approve.` });
        }
        const f = await runner.forkTask(t.id, { title: args.title ?? "", request: ask, chatId, review: args.review });
        onCard({ id: f.id, title: f.title, action: "forked" });
        return text({ created: brief(f), note: `A new card "${f.title}" started with a copy of "${t.title}"'s coder memory, in its own folder. Say so in one line.` });
      } catch (err) {
        return fail(`Could not continue "${t.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    /**
     * Says something to a card's own Claude session: a running stage gets it at its next step, a
     * finished or failed one continues its session with it. A card that never ran has no session.
     */
    messageTask(args: { task_id: string; text: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      const body = args.text.trim();
      if (!body) return fail("The message is empty.");
      const wasRunning = runner.isBusy(t.id);
      try {
        runner.chat(t.id, body);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const hint = t.status === "backlog" ? " It has not run yet: edit its spec with board_update_task, or queue it." : "";
        return fail(`Could not message "${t.title}": ${why}${hint}`);
      }
      onCard({ id: t.id, title: t.title, action: "messaged" });
      return text({
        sent: true,
        note: wasRunning
          ? "It is running: Claude gets the message at its next step. Use board_task_progress in a while to see what it did with it."
          : "Its session has picked the message up and is working on it now. Use board_task_progress to follow it.",
      });
    },

    answerQuestion(args: { task_id: string; answer: string; question_id?: string; answers?: Record<string, string> }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      // A question card the run stopped on comes first: something is waiting for it (D361).
      const cards = repo.pendingApprovals(t.id).filter((a) => a.tool_name === QUESTION_TOOL);
      const card = args.question_id ? cards.find((a) => a.id === args.question_id) : cards.length === 1 ? cards[0] : undefined;
      if (card) {
        const asked = askedQuestions(card.input);
        let answers: Record<string, string>;
        if (asked.length <= 1) {
          answers = { [asked[0]?.question ?? "Question"]: args.answers?.[asked[0]?.question ?? ""]?.trim() || args.answer.trim() };
        } else {
          const given = Object.fromEntries(asked.map((q) => [q.question, args.answers?.[q.question]?.trim() ?? ""]));
          const missing = asked.filter((q) => !given[q.question]);
          if (missing.length) {
            return fail(`"${t.title}" asks ${asked.length} questions; pass answers with one entry per question, keyed by its exact text. Still missing: ${missing.map((q) => JSON.stringify(q.question)).join("; ")}`);
          }
          answers = given;
        }
        try {
          runner.answerApproval(card.id, answers);
        } catch (err) {
          return fail(`Could not answer: ${err instanceof Error ? err.message : String(err)}`);
        }
        onCard({ id: t.id, title: t.title, action: "answered" });
        return text({ answered: answers, note: "The card was waiting for this; it carries on now." });
      }
      if (cards.length > 1 && !args.question_id) {
        return fail(`"${t.title}" waits on ${cards.length} question cards; say which with question_id: ${cards.map((a) => `${a.id} (${clip(askedQuestions(a.input)[0]?.question, 80)})`).join("; ")}`);
      }
      const open = t.questions.filter((q) => !q.answer);
      const q = args.question_id ? open.find((x) => x.id === args.question_id) : open.length === 1 ? open[0] : undefined;
      if (!q) {
        return fail(open.length
          ? `"${t.title}" has ${open.length} open questions; say which with question_id: ${open.map((x) => `${x.id} (${clip(x.text, 80)})`).join("; ")}`
          : `"${t.title}" has no open question.`);
      }
      try {
        runner.answerQuestion(t.id, q.id, args.answer);
      } catch (err) {
        return fail(`Could not answer: ${err instanceof Error ? err.message : String(err)}`);
      }
      onCard({ id: t.id, title: t.title, action: "answered" });
      return text({ answered: q.text, with: args.answer.trim() });
    },

    stopTask(args: { task_id: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      try {
        const stopped = runner.stopTask(t.id);
        onCard({ id: t.id, title: t.title, action: "stopped" });
        return text({ stopped: brief(stopped) });
      } catch (err) {
        return fail(`Could not stop "${t.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    retryTask(args: { task_id: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      if (t.status !== "failed") return fail(`"${t.title}" is ${t.status}; only a failed card can be retried.`);
      try {
        const retried = runner.retryTask(t.id);
        onCard({ id: t.id, title: t.title, action: "retried" });
        return text({ retried: brief(retried), note: "It continues from the stage that failed, in the same session." });
      } catch (err) {
        return fail(`Could not retry "${t.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    memory() {
      return text({ memory: repo.notes(projectId).map((n) => ({ kind: n.kind, text: n.text })) });
    },

    /**
     * A lesson the user asked to keep: every later card in this project starts with it (D379). Written as
     * the user's own note, so it keeps its place in prompts like the lessons the board learned (D307).
     */
    remember(args: { text: string }) {
      const note = repo.addNote({ project_id: projectId, text: args.text, source: "user", kind: "lesson" });
      if (!note) return fail("That is too short to be worth remembering: say it in a full sentence.");
      return text({ remembered: note.text, note: "Saved to the project's memory: every later card starts with it. The user can read, change or delete it on the Memory page." });
    },
  };
}

const stagesArg = z
  .array(z.object({
    stage: z.enum(["plan", "code", "review", "answer"]),
    model: z.string().optional().describe('A model in words: "opus", "sonnet", "haiku", "Sonnet 5.5", or a full id. Leave out for the board\'s choice for that stage.'),
    effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional().describe("Leave out for the board's choice."),
  }))
  .min(1)
  .max(4)
  .optional();

export function createChatBoardServer(deps: ChatBoardDeps, projectId: string, chatId: string | null, onCard: (c: Card) => void) {
  const h = chatBoardHandlers(deps, projectId, chatId, onCard);
  return createSdkMcpServer({
    name: "board",
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "This project's Claude Kanban board. List and read cards and how their runs are going, create cards for work to be done, send follow-ups to the card that did the work (by what it remembers), edit Backlog cards, queue or schedule them, and talk to a card's own Claude session (message it, answer its question, stop it, retry it).",
    tools: [
      tool("board_list_tasks", "List the cards on this project's board with a count per status. Done cards are only counted unless you ask for status \"done\".",
        { status: z.enum(TASK_STATUSES as [string, ...string[]]).optional() }, async (a) => h.listTasks(a)),
      tool("board_get_task", "Read one card: its spec, status, summary and pipeline.", { task_id: z.string() }, async (a) => h.getTask(a)),
      tool("board_create_task",
        "Create a card in Backlog: a short title and a spec that says what done looks like, in the user's terms. " +
          'stages: [{stage:"answer"}] for a lookup, question or report: one stage that reads and reports, changes nothing and lands in Done with its answer. ' +
          "For work that changes something, leave stages out for the board's default, or list plan/code/review with the model and effort the user asked for. " +
          "mode: only when the user named one in their message (\"ask\" is Autonomous + asks me: autonomous, but it stops and waits when it has a question for the user); left out, the chat's own mode switch applies. live: true only when the card will change a live system.",
        {
          title: z.string().min(1).max(200),
          spec_md: z.string().max(20_000),
          type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
          priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
          mode: z.enum(RUN_STYLES as [RunStyle, ...RunStyle[]]).optional(),
          stages: stagesArg,
          live: z.boolean().optional().describe("The card changes a live system (an ERP, a production database, a payment API): it then waits for the user's OK on its plan."),
          own_branch: z.boolean().optional().describe("Supervised only: work on its own branch, landing when the user approves."),
          depends_on: z.array(z.string()).max(10).optional().describe("Ids of cards that must be done first. It can be started at once: it waits for them, then starts by itself with their results."),
          follows: z.string().optional().describe("The id of an earlier card this one follows on from, when board_related_cards recommends a fresh card: it is told what that card did and which files it changed."),
        },
        async (a) => h.createTask(a)),
      tool("board_related_cards",
        "Before making a change card, find the cards this request is about and what each one remembers: whether its coder's memory is warm, how full it is, what continuing costs against a new card, the routes open and the board's recommendation. Pass the user's request and any project files you looked at for it.",
        { request: z.string().min(1).max(4000), files: z.array(z.string()).max(40).optional() },
        async (a) => h.relatedCards(a)),
      tool("board_continue_task",
        "Send a follow-up to the card that did the work, by a route board_related_cards offered: steer (it is running), add_to_round (it waits in review: the change joins its unapproved work), new_round (it is done: its coder continues with what it remembers, landing on its own approval), fork (a new card that starts with a copy of its memory, for new work beside it). request is what to do, in the user's terms. review: true for new work rather than a small change.",
        {
          task_id: z.string(),
          how: z.enum(["steer", "add_to_round", "new_round", "fork"]),
          request: z.string().min(1).max(8000),
          title: z.string().max(200).optional().describe("fork only: the new card's title."),
          review: z.boolean().optional(),
        },
        async (a) => h.continueTask(a)),
      tool("board_update_task",
        "Change a card that is in Backlog or failed: title, spec, priority, labels, its stages (model and effort per stage), mode, own branch or live. Not while it runs.",
        {
          task_id: z.string(), title: z.string().optional(), spec_md: z.string().optional(), priority: z.enum(PRIORITIES as [string, ...string[]]).optional(), labels: z.array(z.string()).max(8).optional(),
          stages: stagesArg, mode: z.enum(RUN_STYLES as [RunStyle, ...RunStyle[]]).optional(), own_branch: z.boolean().optional(), live: z.boolean().optional(),
        },
        async (a) => h.updateTask(a)),
      tool("board_queue_task", "Start a Backlog card now (it joins the queue). Only when the user asked for it to run.", { task_id: z.string() }, async (a) => h.queueTask(a)),
      tool("board_schedule_task",
        'Start a Backlog card later: start_at is an ISO 8601 time with the local offset, or "reset" for when the Claude usage window resets; null cancels.',
        { task_id: z.string(), start_at: z.string().nullable() }, async (a) => h.scheduleTask(a)),
      tool("board_task_progress",
        "How a card's run is going: each stage's status, cost and result, what it is waiting for (a question, an approval), and its latest steps in plain lines. Use this to answer “what is it doing?” or “what did it do?”.",
        { task_id: z.string(), lines: z.number().int().min(1).max(60).optional().describe("How many recent steps to include (default 20).") },
        async (a) => h.taskProgress(a)),
      tool("board_message_task",
        "Say something to a card's own Claude session that is not a piece of work: a question about what it did, or a word the user asked you to pass on. A running card gets it at its next step; a card in review or failed continues its session with it. For work, use board_continue_task.",
        { task_id: z.string(), text: z.string().min(1).max(8000) }, async (a) => h.messageTask(a)),
      tool("board_answer_question",
        "Answer a question a card asked the user (open_questions or waiting_on_question in board_task_progress, or one posted in this chat). Only with an answer the user gave you. " +
          "A question card with several questions needs answers: one entry per question, keyed by its exact text; for options, use the option's label.",
        {
          task_id: z.string(), answer: z.string().min(1).max(4000), question_id: z.string().optional(),
          answers: z.record(z.string(), z.string().max(4000)).optional(),
        },
        async (a) => h.answerQuestion(a)),
      tool("board_stop_task", "Stop a card that is queued or running. Only when the user asked.", { task_id: z.string() }, async (a) => h.stopTask(a)),
      tool("board_retry_task", "Run a failed card again from the stage that failed. Only when the user asked.", { task_id: z.string() }, async (a) => h.retryTask(a)),
      tool("board_memory", "Read what the board remembers about this project: decisions and conventions from earlier tasks.", {}, async () => h.memory()),
      tool("board_remember",
        "Save one lesson to the project's memory, so every later card starts with it. Only when the user asks you to remember something (\"remember: buttons use the brand blue\", \"from now on…\"). One plain sentence, in the user's terms.",
        { text: z.string().min(8).max(400) }, async (a) => h.remember(a)),
    ],
  });
}
