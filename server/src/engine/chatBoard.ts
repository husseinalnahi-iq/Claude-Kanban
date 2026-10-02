import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type { ChatMessage, Effort, EventRow, Mode, Stage, Task } from "../types.ts";
import { EFFORTS, PRIORITIES, TASK_STATUSES, TASK_TYPES } from "../types.ts";
import { allowedMode, defaultPipeline } from "./boardMcp.ts";
import type { TaskRunner } from "./runner.ts";
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
  // Only when there is one, so a quiet board stays a short list.
  ...(t.questions.some((q) => !q.answer) ? { open_questions: t.questions.filter((q) => !q.answer).length } : {}),
});

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
      title: string; spec_md: string; type?: string; priority?: string; mode?: Mode; depends_on?: string[];
      stages?: StageArg[]; live?: boolean; own_branch?: boolean;
    }) {
      const project = repo.getProject(projectId)!;
      const deps = (args.depends_on ?? []).filter((id) => mine(id));
      const built = args.stages?.length ? buildPipeline(args.stages) : null;
      if (built && "error" in built) return fail(built.error);
      const pipeline = built?.pipeline ?? defaultPipeline(repo, project);
      const answer = isAnswerPipeline(pipeline);
      // A lookup only reads: it needs no worktree, and an autonomous run's sandbox could not reach a live
      // system to read it from (D284).
      const mode: Mode = answer ? "supervised" : allowedMode(project, args.mode ?? "supervised");
      const t = repo.createTask({
        project_id: projectId,
        title: args.title.trim(),
        spec_md: args.spec_md,
        type: (args.type as Task["type"]) ?? (answer ? "chore" : "feature"),
        priority: (args.priority as Task["priority"]) ?? "p2",
        mode,
        own_branch: !answer && mode === "supervised" && Boolean(args.own_branch),
        live: !answer && Boolean(args.live),
        pipeline,
        depends_on: deps,
        status: "backlog",
        chat_id: chatId,
      });
      publish(t);
      // The same intake a card made on the board gets — type and labels — but what was settled here with
      // the user is not offered back as a second opinion (D286).
      if (repo.getSettings().autoTriage) {
        void runner.triage(t.id, "classify", { decided: { pipeline: Boolean(built), live: answer || args.live !== undefined } }).catch(() => {});
      }
      onCard({ id: t.id, title: t.title, action: "created" });
      const downgraded = args.mode === "autonomous" && mode === "supervised";
      return text({
        created: brief(t),
        note: [
          answer
            ? "An answer card: one stage that reads and reports, supervised, and it lands in Done with its answer. Start it now if the user asked for the result."
            : "It is in Backlog. Tell the user how it will run (mode, and why) and offer to start it now or schedule it.",
          downgraded ? (answer ? "It runs supervised: a lookup needs no branch of its own." : "This project does not allow autonomous runs, so it is supervised.") : "",
          "Its result is posted into this chat when it finishes.",
        ].filter(Boolean).join(" "),
      });
    },

    updateTask(args: {
      task_id: string; title?: string; spec_md?: string; priority?: string; labels?: string[];
      stages?: StageArg[]; mode?: Mode; own_branch?: boolean; live?: boolean;
    }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      if (t.status !== "backlog" && t.status !== "failed") return fail(`"${t.title}" is ${t.status}; only a card in Backlog (or one that failed) can be edited from chat.`);
      const project = repo.getProject(projectId)!;
      const built = args.stages?.length ? buildPipeline(args.stages) : null;
      if (built && "error" in built) return fail(built.error);
      const pipeline = built?.pipeline;
      const answer = isAnswerPipeline(pipeline ?? t.pipeline);
      // An answer card is always supervised on the main checkout (D284); anything else asks the project.
      const mode: Mode | undefined = answer ? (t.mode === "supervised" ? undefined : "supervised") : args.mode && allowedMode(project, args.mode);
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
        own_branch: ownBranch,
        live: answer ? (t.live ? false : undefined) : args.live,
      });
      // What the user just settled here replaces what triage offered for the same thing.
      if (updated.suggestion && (pipeline || args.live !== undefined)) updated = runner.dismissSuggestion(t.id, { pipeline: Boolean(pipeline), live: args.live !== undefined });
      else publish(updated);
      onCard({ id: t.id, title: updated.title, action: "updated" });
      const refused = args.mode === "autonomous" && updated.mode !== "autonomous";
      return text({ updated: brief(updated), ...(refused ? { note: answer ? "An answer card runs supervised." : "This project does not allow autonomous runs, so it stays supervised." } : {}) });
    },

    queueTask(args: { task_id: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      // Queueing starts a card from its first stage: on a card in review that would redo reviewed
      // work, and on a failed one it would pay for the plan again instead of continuing.
      if (t.status === "failed") return fail(`"${t.title}" failed; use board_retry_task to continue it from the stage that failed.`);
      if (t.status !== "backlog") return fail(`"${t.title}" is ${t.status}; only a card in Backlog can be started from chat.`);
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
        // Claude's own to-do list for the stage: the quickest honest answer to "how far along is it?".
        steps: t.checklist.map((x) => `${x.status === "completed" ? "[done]" : x.status === "in_progress" ? "[now]" : "[todo]"} ${x.text}`),
        waiting_for_approval: repo.pendingApprovals(t.id).map((a) => a.title ?? a.tool_name),
        recent_activity: recent,
      });
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

    answerQuestion(args: { task_id: string; answer: string; question_id?: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
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
      "This project's Claude Kanban board. List and read cards and how their runs are going, create cards for work to be done, edit Backlog cards, queue or schedule them, and talk to a card's own Claude session (message it, answer its question, stop it, retry it).",
    tools: [
      tool("board_list_tasks", "List the cards on this project's board with a count per status. Done cards are only counted unless you ask for status \"done\".",
        { status: z.enum(TASK_STATUSES as [string, ...string[]]).optional() }, async (a) => h.listTasks(a)),
      tool("board_get_task", "Read one card: its spec, status, summary and pipeline.", { task_id: z.string() }, async (a) => h.getTask(a)),
      tool("board_create_task",
        "Create a card in Backlog: a short title and a spec that says what done looks like, in the user's terms. " +
          'stages: [{stage:"answer"}] for a lookup, question or report: one stage that reads and reports, changes nothing, runs supervised and lands in Done with its answer. ' +
          "For work that changes something, leave stages out for the board's default, or list plan/code/review with the model and effort the user asked for. " +
          "mode: supervised unless the user chose autonomous. live: true only when the card will change a live system.",
        {
          title: z.string().min(1).max(200),
          spec_md: z.string().max(20_000),
          type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
          priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
          mode: z.enum(["supervised", "autonomous"]).optional(),
          stages: stagesArg,
          live: z.boolean().optional().describe("The card changes a live system (an ERP, a production database, a payment API): it then waits for the user's OK on its plan."),
          own_branch: z.boolean().optional().describe("Supervised only: work on its own branch, landing when the user approves."),
          depends_on: z.array(z.string()).max(10).optional().describe("Ids of cards that must be done first. It can be started at once: it waits for them, then starts by itself with their results."),
        },
        async (a) => h.createTask(a)),
      tool("board_update_task",
        "Change a card that is in Backlog or failed: title, spec, priority, labels, its stages (model and effort per stage), mode, own branch or live. Not while it runs.",
        {
          task_id: z.string(), title: z.string().optional(), spec_md: z.string().optional(), priority: z.enum(PRIORITIES as [string, ...string[]]).optional(), labels: z.array(z.string()).max(8).optional(),
          stages: stagesArg, mode: z.enum(["supervised", "autonomous"]).optional(), own_branch: z.boolean().optional(), live: z.boolean().optional(),
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
        "Say something to a card's own Claude session. A running card gets it at its next step (steering); a card in review or failed continues its session with it. Only when the user asked you to tell the task something.",
        { task_id: z.string(), text: z.string().min(1).max(8000) }, async (a) => h.messageTask(a)),
      tool("board_answer_question",
        "Answer a question a card asked the user (see open_questions in board_task_progress). Only with an answer the user gave you.",
        { task_id: z.string(), answer: z.string().min(1).max(4000), question_id: z.string().optional() }, async (a) => h.answerQuestion(a)),
      tool("board_stop_task", "Stop a card that is queued or running. Only when the user asked.", { task_id: z.string() }, async (a) => h.stopTask(a)),
      tool("board_retry_task", "Run a failed card again from the stage that failed. Only when the user asked.", { task_id: z.string() }, async (a) => h.retryTask(a)),
      tool("board_memory", "Read what the board remembers about this project: decisions and conventions from earlier tasks.", {}, async () => h.memory()),
    ],
  });
}
