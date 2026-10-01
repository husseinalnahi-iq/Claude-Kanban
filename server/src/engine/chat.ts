import { basename, relative, isAbsolute } from "node:path";
import type { CanUseTool, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type { Chat, ChatMessage, ChatUpdate, ModelEntry, Project, Stage, Task } from "../types.ts";
import { ConflictError, NotFoundError, type QueryFn, type TaskRunner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import { createChatBoardServer, pipelineLine } from "./chatBoard.ts";
import { defaultPipeline } from "./boardMcp.ts";
import { resultText } from "./record.ts";
import type { Resolved } from "./providers/types.ts";
import { estimateCost, sumUsage } from "./providers/cost.ts";
import type { TokenUsage } from "./providers/types.ts";
import { ANTHROPIC_PROVIDER_ID } from "../types.ts";
import { readViolation } from "./gate.ts";
import { credentialRisk } from "./credentials.ts";
import { imageMakerLine } from "./images.ts";

/** Looking only. Anything else is refused: changing code is what a card is for. */
export const CHAT_READ_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
/** Never offered to the chat at all, so it does not even try. */
export const CHAT_DISALLOWED = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "BashOutput", "KillShell", "Task", "Agent", "AskUserQuestion"];
const NEW_CHAT = "New chat";
/** What one reply may cost: enough for a long, careful answer. */
const CHAT_CEILING_USD = 1.5;

type Card = NonNullable<ChatMessage["meta"]["cards"]>[number];

/** Counted by card, not by action: creating a card and queueing it is still one card. */
export function cardsLine(cards: Card[]): string {
  const n = new Set(cards.map((c) => c.id)).size;
  return `${n} card${n === 1 ? "" : "s"}`;
}

/** "read server/src/db.ts", "searched for “useWs”": one quiet line per tool call. */
export function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const path = (p: unknown) => {
    const s = String(p ?? "");
    const rel = relative(cwd, s);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : basename(s);
  };
  const q = (v: unknown) => `“${String(v ?? "").slice(0, 80)}”`;
  switch (name) {
    case "Read": return `read ${path(input.file_path)}`;
    case "Grep": return `searched the code for ${q(input.pattern)}`;
    case "Glob": return `looked for files matching ${q(input.pattern)}`;
    case "WebSearch": return `searched the web for ${q(input.query)}`;
    case "WebFetch": return `opened ${String(input.url ?? "a page")}`;
    case "TodoWrite": return "made a plan";
    case "mcp__board__board_list_tasks": return "looked at the board";
    case "mcp__board__board_get_task": return "read a card";
    case "mcp__board__board_create_task": return `created the card ${q(input.title)}`;
    case "mcp__board__board_update_task": return "edited a card";
    case "mcp__board__board_queue_task": return "queued a card";
    case "mcp__board__board_schedule_task": return "scheduled a card";
    case "mcp__board__board_task_progress": return "checked how a card is going";
    case "mcp__board__board_message_task": return `told a card: ${q(input.text)}`;
    case "mcp__board__board_answer_question": return "answered a card's question";
    case "mcp__board__board_stop_task": return "stopped a card";
    case "mcp__board__board_retry_task": return "ran a failed card again";
    case "mcp__board__board_memory": return "read the project's memory";
    default: return name.replace(/^mcp__[^_]+__/, "");
  }
}

/** Local time and offset, so "tonight at 3" becomes the right ISO time for board_schedule_task. */
function localNow(now = new Date()): string {
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${now.toLocaleString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} (UTC${sign}${hh}:${mm})`;
}

/**
 * Goes in front of each message, not in the system prompt: the system prompt sits before the whole
 * conversation in the prompt cache, so a clock in it made every new minute re-bill the history.
 */
export function turnContext(now = new Date()): string {
  return `[Local time: ${localNow(now)}]`;
}

/**
 * The chat's instructions. Stable for a project — the models line changes only when Settings does — so
 * the cached conversation behind it is not re-billed turn after turn.
 */
export function chatPrompt(project: Project, board?: { models: ModelEntry[]; defaults: Stage[]; pictures?: string | null }): string {
  return [
    `You are the side chat of Claude Kanban, talking with the user about the project "${project.name}" (${project.path}).`,
    "Many users are not programmers: answer plainly and briefly, and explain any technical word you have to use.",
    // In a real chat "I can't query BizApp from this chat…" opened the reply to "get me the latest PO" (D283).
    "You read the project's files and the web yourself. Everything else — running a command, looking something up in a live system (an ERP, a database, an API), changing a file — is done by a task card on the board, and its result comes back into this chat. Never tell the user what you cannot do from here, never mention your own tools or their limits (\"I can't run…\", \"I can only read…\"), and never ask the user to run something themselves: say what you will do (\"I'll make a card that looks it up\") and do it.",
    "Take the cheapest route that gets what the user wants:",
    "1. When the project's files or the web answer it fully, answer yourself. No card. If part of the answer needs a command (git, a script, a query) or a live system, do not give half an answer: make the answer card.",
    '2. A lookup, question or report that needs a live system or a command: one answer card — board_create_task with stages [{stage:"answer"}]. Related lookups go on one card: one session answering both costs less than two. When the user asked for the result ("get me…", "find…", "check…"), start it in the same reply with board_queue_task.',
    "3. Work that changes something: one card. Leave stages out for the board's default; one code stage is enough for a small, clear change; plan → code → review where choosing the approach, or a mistake, is the costly part. Split into several cards only when the parts are big and independent.",
    "When one part needs another's result or must come after it (look something up, then use it; build the API, then the page), make a chain: create the cards in order, give each later card depends_on the earlier ones, and start them together. A card waits in Queued until the cards it depends on are done, then starts by itself and is given what they reported.",
    "For a change, make sure you understand it first; ask one short question if it is unclear. The spec says the problem and what done looks like, from what the user asked, nothing more. Extras you think would help (a pause button, a README) go in your reply as suggestions they can say yes to; they never go into the spec on their own, because every line in it is paid for.",
    "When you create a change card, say in a few words how it will run and why, then ask whether to start it. The user can also press Start on the card here:",
    "- supervised: works in the project's own folder and asks the user before each change. Anything that reaches a live system or runs commands outside the project is supervised: an autonomous run is sandboxed and cannot reach it.",
    "- autonomous: works on its own branch without asking, and lands only when the user approves it. Good for changes to the project's own files, when the project allows it.",
    "Use the mode the user chose; otherwise recommend one with its reason. Set live: true only when the card will change a live system: it then waits for the user's OK on its plan and its review checks the live system. Reading one is not live.",
    `When the user names a model or an effort ("sonnet, high effort for the code"), put it on that stage in stages.${board ? ` This board's models: ${board.models.map((m) => `${m.label} (${m.id})`).join(", ")}. Default stages: ${pipelineLine(board.defaults)}.` : ""} Haiku has no effort setting. board_update_task changes a Backlog card's stages, mode, branch or live.`,
    "Never queue or schedule a change card the user did not ask to run.",
    "You can also follow and talk to the cards themselves:",
    "- board_list_tasks and board_task_progress tell you what each card is doing, what it did, what it cost and what it is waiting for. Look before you answer a question about a task; do not guess.",
    "- board_message_task passes the user's words to a card's own Claude session: a running card takes them in at its next step, a card in review or failed picks its session up again with them. Pass on what the user said; do not invent instructions.",
    "- board_answer_question answers a question a card asked, with the answer the user gave. board_stop_task and board_retry_task stop or re-run a card when the user asks.",
    // Only when a picture maker is ready: otherwise the chat would promise pictures no card can make (D303).
    ...(board?.pictures ? [`Task cards can make pictures with the board's picture tool (${board.pictures}): when the user wants an image in their project, a card does it.`] : []),
    "When a card from this chat finishes, fails, has a plan ready or asks something, the board posts it here, and the user's next message starts with a [Board news] note about it: use that rather than looking again.",
    "Approving, landing or discarding a card's work is the user's own decision, on the board or on the card shown here: say where the button is, never promise to do it.",
    'Each message starts with the user\'s local time in brackets. Scheduled times are ISO 8601 with that offset, or "reset" for when the user\'s Claude usage window resets.',
  ].join("\n");
}

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

/** One update in front of the next message, clipped: the model needs the gist, the chat shows it whole. */
function newsLine(u: ChatUpdate): string {
  const body = u.text.length > 1500 ? `${u.text.slice(0, 1500)} …` : u.text;
  const what = { finished: u.status === "done" ? "finished" : "finished and waits for review", failed: "failed", plan: "has a plan waiting for the user's OK", question: "asks" }[u.kind];
  const extra = u.kind === "question" ? ` (question_id ${u.question_id}${u.options?.length ? `; options: ${u.options.join(" / ")}` : ""})` : "";
  return `- "${u.title}" (${u.id}) ${what}${extra}: ${body}`;
}

/** Where a card stands, for telling a new state from one already reported. */
const stateKey = (t: Task) => (t.status === "approval" && t.plan_gate ? `plan:${t.plan_gate.created_at}` : t.status);

export interface ChatDeps {
  repo: Repo;
  bus: Bus;
  runner: TaskRunner;
  scheduler?: Scheduler;
  /** Defaults to the runner's, so a test's fake SDK drives both. */
  queryFn?: QueryFn;
}

/**
 * The side chat: conversations about a project, each one resumable Claude session in the project's
 * folder. It reads and makes cards; it never edits code. Replies stream word by word (`chat.delta`)
 * and are stored once complete, with a quiet line for each tool call and chips for cards it touched.
 */
export class ChatService {
  private live = new Map<string, AbortController>();
  /** Per card a chat made: where it last stood, and which of its questions the chat was shown. */
  private seen = new Map<string, { key: string | null; questions: Set<string> }>();

  constructor(private deps: ChatDeps) {
    deps.bus.subscribe((m) => {
      if (m.type !== "task.updated" || !m.task.chat_id) return;
      try {
        this.report(m.task);
      } catch (err) {
        // A report the chat misses is a nuisance; a throw here would break whoever published the update.
        console.error("Side chat could not report a card:", err);
      }
    });
  }

  /**
   * A card this chat made moved on by itself: say so in the chat, with its answer, the reason it failed,
   * its plan or its question. Written by the board, not the model, so it costs nothing (D285). Each state
   * is said once; on first sight after a restart, what the chat was already told counts as said.
   */
  private report(task: Task): void {
    const { repo } = this.deps;
    const chatId = task.chat_id!;
    if (!repo.getChat(chatId)) return;
    let seen = this.seen.get(task.id);
    if (!seen) {
      const told = repo.chatUpdatesFor(chatId, task.id).map((m) => m.meta.update!).filter(Boolean);
      const last = told.at(-1);
      const kind = this.kindOf(task);
      const already = last && kind && last.kind === kind && last.status === task.status;
      seen = { key: already ? stateKey(task) : null, questions: new Set(told.flatMap((u) => (u.question_id ? [u.question_id] : []))) };
      this.seen.set(task.id, seen);
    }
    const key = stateKey(task);
    if (seen.key !== key) {
      seen.key = key;
      const kind = this.kindOf(task);
      if (kind) this.postUpdate(chatId, task, kind);
    }
    for (const q of task.questions) {
      if (q.answer || seen.questions.has(q.id)) continue;
      seen.questions.add(q.id);
      this.postUpdate(chatId, task, "question", q);
    }
  }

  private kindOf(task: Task): ChatUpdate["kind"] | null {
    if (task.status === "review" || task.status === "done") return "finished";
    if (task.status === "failed") return "failed";
    if (task.status === "approval" && task.plan_gate) return "plan";
    return null;
  }

  private postUpdate(chatId: string, task: Task, kind: ChatUpdate["kind"], q?: Task["questions"][number]): void {
    const runs = this.deps.repo.runsForTask(task.id);
    const cost = Number(runs.reduce((sum, r) => sum + r.cost_usd, 0).toFixed(4));
    const plan = task.plan_gate?.revised ?? task.plan_gate?.original ?? "";
    const text =
      kind === "finished" ? resultText(runs, task.summary) ?? "It finished."
      : kind === "failed" ? task.error ?? "It stopped."
      : kind === "plan" ? (plan.length > 1200 ? `${plan.slice(0, 1200).trimEnd()} …` : plan) || "Its plan is ready."
      : q!.text;
    const update: ChatUpdate = {
      id: task.id, title: task.title, kind, status: task.status, text, cost_usd: cost,
      ...(q ? { question_id: q.id, options: q.options } : {}),
    };
    const line = { finished: "finished", failed: "failed", plan: "has a plan ready", question: "asks something" }[kind];
    this.message({ chat_id: chatId, role: "update", text: `“${task.title}” ${line}`, meta: { update } });
  }

  private get queryFn(): QueryFn {
    return this.deps.queryFn ?? this.deps.runner.sdkQuery;
  }

  private mustChat(id: string): Chat {
    const c = this.deps.repo.getChat(id);
    if (!c) throw new NotFoundError(`No chat ${id}`);
    return c;
  }

  private publish(chat: Chat) {
    this.deps.bus.publish({ type: "chat.updated", chat: { ...chat, busy: this.live.has(chat.id) } });
  }

  private message(m: Parameters<Repo["addChatMessage"]>[0]): ChatMessage | null {
    // Deleted mid-reply: nothing left to write to.
    if (!this.deps.repo.getChat(m.chat_id)) return null;
    const message = this.deps.repo.addChatMessage(m);
    this.deps.bus.publish({ type: "chat.message", message });
    return message;
  }

  list(projectId: string): Chat[] {
    return this.deps.repo.listChats(projectId).map((c) => ({ ...c, busy: this.live.has(c.id) }));
  }

  create(projectId: string, title?: string): Chat {
    if (!this.deps.repo.getProject(projectId)) throw new NotFoundError(`No project ${projectId}`);
    const s = this.deps.repo.getSettings();
    const chat = this.deps.repo.createChat({ project_id: projectId, title: title?.trim() || NEW_CHAT, model: s.chatModel, effort: s.chatEffort, provider: s.chatProvider });
    this.publish(chat);
    return chat;
  }

  update(id: string, patch: { title?: string; model?: string; effort?: Chat["effort"]; provider?: string; archived?: boolean }): Chat {
    const before = this.mustChat(id);
    if (patch.provider && patch.provider !== ANTHROPIC_PROVIDER_ID) this.chatProvider(patch.provider); // refused here, not at the next message
    const moved = Boolean(patch.provider) && patch.provider !== before.provider;
    const chat = this.deps.repo.updateChat(id, {
      title: patch.title?.trim() || undefined,
      model: patch.model,
      effort: patch.effort,
      provider: patch.provider,
      // Another endpoint cannot continue a session this one signed: a fresh one, with the conversation
      // carried in front of the next message (D301).
      ...(moved ? { session_id: null } : {}),
      archived_at: patch.archived === undefined ? undefined : patch.archived ? new Date().toISOString() : null,
    });
    this.publish(chat);
    return chat;
  }

  delete(id: string): void {
    const chat = this.mustChat(id);
    this.stop(id);
    this.deps.repo.deleteChat(id);
    this.deps.bus.publish({ type: "chat.deleted", id, project_id: chat.project_id });
  }

  /** A provider the chat may run on: Claude-compatible only, so its tools — the board's — keep working (D301). */
  private chatProvider(id: string): Resolved {
    const res = this.deps.runner.providers.resolve(id);
    if (res.provider?.kind !== "anthropic-compatible") {
      throw new ConflictError(`${res.label} cannot run the side chat: only Claude-compatible providers can (they run inside Claude Code, with the board's tools). Pick it for task stages instead.`);
    }
    return res;
  }

  /**
   * The conversation so far, for a session that starts fresh — a new provider, or one Claude Code lost —
   * so what was said is not lost with it: the last 20 lines, each clipped (D301).
   */
  private earlier(chatId: string): string {
    const said = this.deps.repo.chatMessages(chatId).filter((m) => m.role === "user" || m.role === "assistant");
    const before = said.slice(0, -1).slice(-20); // the last one is the message being answered
    if (!before.length) return "";
    const clip = (t: string) => (t.length > 1200 ? `${t.slice(0, 1200)} …` : t);
    return `[Earlier in this chat]\n${before.map((m) => `${m.role === "user" ? "User" : "You"}: ${clip(m.text)}`).join("\n")}\n\n`;
  }

  isBusy(id: string): boolean {
    return this.live.has(id);
  }

  stop(id: string): boolean {
    const ctl = this.live.get(id);
    ctl?.abort();
    return !!ctl;
  }

  /** Store your message and start the reply. Returns at once; the reply streams over the websocket. */
  send(id: string, text: string): ChatMessage {
    const chat = this.mustChat(id);
    if (this.live.has(id)) throw new ConflictError("Still answering your last message. Wait, or press Stop.");
    const project = this.deps.repo.getProject(chat.project_id);
    if (!project) throw new NotFoundError("This chat's project is gone.");
    // What the chat's cards did since your last message rides in front of this one (D285).
    const news = this.deps.repo.chatUpdatesSince(id, this.deps.repo.lastChatMessage(id, "user")?.id ?? 0).map((m) => m.meta.update!).filter(Boolean);
    const mine = this.message({ chat_id: id, role: "user", text })!;
    if (chat.title === NEW_CHAT) this.publish(this.deps.repo.updateChat(id, { title: text.replace(/\s+/g, " ").trim().slice(0, 60) }));
    const ctl = new AbortController();
    this.live.set(id, ctl);
    this.publish(this.deps.repo.getChat(id)!);
    void this.reply(this.deps.repo.getChat(id)!, project, text, ctl, news)
      // reply() reports its own failures in the chat; this only keeps a surprise from ending the board.
      .catch((err) => console.error("Side chat reply failed:", err))
      .finally(() => {
        this.live.delete(id);
        const after = this.deps.repo.getChat(id);
        if (after) this.publish(after);
      });
    return mine;
  }

  private async reply(chat: Chat, project: Project, text: string, ctl: AbortController, news: ChatUpdate[] = []): Promise<void> {
    const { repo, bus } = this.deps;
    const cards: Card[] = [];
    const canUseTool: CanUseTool = async (name, input) => {
      // A page or file the chat reads could tell it to fetch your keys and send them somewhere; nobody
      // sees a card here, so reading stays inside the project and away from credential files.
      if (readViolation(name, input, project.path)) {
        return { behavior: "deny", message: `The side chat only reads files inside this project (${project.path}). Tell the user you cannot open that file from here.` };
      }
      if (credentialRisk(name, input)) {
        return { behavior: "deny", message: "That file holds passwords or keys, and the side chat does not open those. Tell the user, and carry on without it." };
      }
      if (name.startsWith("mcp__board__") || CHAT_READ_TOOLS.includes(name)) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "That is a card's job: create one with board_create_task (an answer card for a lookup) and tell the user what it will do. Do not tell them what you cannot do." };
    };
    // Claude, or a Claude-compatible provider through the same Claude Code — tools and all (D301).
    let res: Resolved | null = null;
    try {
      res = chat.provider && chat.provider !== ANTHROPIC_PROVIDER_ID ? this.chatProvider(chat.provider) : null;
    } catch (err) {
      this.message({ chat_id: chat.id, role: "error", text: `This chat's model is on a provider the board cannot use now: ${err instanceof Error ? err.message : String(err)} Pick another model below.` });
      return;
    }
    const base: Options = {
      model: chat.model,
      effort: chat.effort,
      cwd: project.path,
      resume: chat.session_id ?? undefined,
      includePartialMessages: true,
      // The project's CLAUDE.md, not your global tool servers: a chat should be quick and cheap.
      settingSources: ["project"],
      strictMcpConfig: true,
      mcpServers: { board: createChatBoardServer(this.deps, project.id, chat.id, (c) => cards.push(c)) },
      skills: [],
      plugins: [],
      extraArgs: { "no-chrome": null },
      disallowedTools: CHAT_DISALLOWED,
      permissionMode: "default",
      canUseTool,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: chatPrompt(project, {
          models: repo.getSettings().models,
          defaults: defaultPipeline(repo, project),
          pictures: (await this.deps.runner.picturesReady()) ? imageMakerLine(repo.getSettings()) : null,
        }),
      },
      maxTurns: 40,
      // Every other call the board makes has a ceiling; a chat that went off reading the whole repo
      // or the web had none. Enough for a long, careful answer.
      maxBudgetUsd: CHAT_CEILING_USD,
      abortController: ctl,
    };
    // The provider's address and key go in the environment, which replaces the whole of it: the
    // computer's own comes first, or Claude Code would start without PATH. Effort and the SDK's
    // ceiling are stripped for another model, so the ceiling is metered below instead.
    const options: Options = res?.adapter.applyOptions && res.provider
      ? res.adapter.applyOptions({ ...base, env: { ...(process.env as Record<string, string>) } }, { provider: res.provider, model: chat.model, secret: res.secret })
      : base;
    const priceOf = (usage: TokenUsage) =>
      res?.provider ? estimateCost(res.provider, chat.model, usage, this.deps.runner.catalog.priceOf(res.provider, chat.model)).usd : 0;
    let metered = 0;
    const counted = new Set<string>();

    let streamed = "";
    const resumed = chat.session_id;
    /** Claude Code no longer has the session this chat was continuing (its history was cleaned up, or the folder moved). */
    const lostSession = (why: string) => Boolean(resumed) && /no conversation found|session.*not found/i.test(why);
    const startFresh = () => {
      repo.updateChat(chat.id, { session_id: null });
      this.message({ chat_id: chat.id, role: "error", text: "Claude no longer has the earlier part of this chat, so it cannot continue it. Send your message again: it starts fresh, without what was said before." });
    };
    try {
      const board = news.length ? `[Board news since your last message]\n${news.map(newsLine).join("\n")}\n\n` : "";
      const earlier = chat.session_id ? "" : this.earlier(chat.id);
      for await (const raw of this.queryFn({ prompt: userMessage(`${turnContext()}\n\n${earlier}${board}${text}`), options })) {
        const msg = raw as any;
        if (msg.type === "stream_event") {
          // Word-by-word deltas are the hot path: nothing here touches the database.
          const e = msg.event;
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
            streamed += e.delta.text;
            bus.publish({ type: "chat.delta", chatId: chat.id, text: streamed });
          }
          continue;
        }
        if (!repo.getChat(chat.id)) break;
        if (msg.session_id && msg.session_id !== chat.session_id) {
          chat = repo.updateChat(chat.id, { session_id: msg.session_id });
        }
        if (msg.type === "assistant" && res) {
          // Another model: the SDK cannot price it, so the board does, reply by reply, and stops at the ceiling.
          const id = msg.message?.id;
          const u = msg.message?.usage;
          if (u && !(typeof id === "string" && counted.has(id))) {
            if (typeof id === "string") counted.add(id);
            metered += priceOf({ inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadInputTokens: u.cache_read_input_tokens ?? 0, cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0 });
            if (metered > CHAT_CEILING_USD) {
              this.message({ chat_id: chat.id, role: "error", text: `Stopped: this reply passed the chat's $${CHAT_CEILING_USD.toFixed(2)} ceiling (estimated from your price table for ${chat.model}).` });
              ctl.abort();
              break;
            }
          }
        }
        if (msg.type === "assistant" && !msg.parent_tool_use_id) {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              this.message({ chat_id: chat.id, role: "assistant", text: block.text });
              streamed = "";
              // The stored message replaces the streamed words; without this both show until the reply ends.
              bus.publish({ type: "chat.delta", chatId: chat.id, text: "" });
            } else if (block.type === "tool_use") {
              this.message({ chat_id: chat.id, role: "tool", text: describeTool(block.name, block.input ?? {}, project.path) });
            }
          }
          continue;
        }
        if (msg.type === "result") {
          // The SDK prices Claude only; another model is priced from Settings → Providers (or its live list).
          const cost = res ? priceOf(sumUsage(msg.modelUsage ?? {})) : Number(msg.total_cost_usd ?? 0);
          chat = repo.updateChat(chat.id, { cost_usd: (repo.getChat(chat.id)?.cost_usd ?? 0) + cost });
          if (msg.is_error && !ctl.signal.aborted) {
            const why = (msg.errors ?? []).join("; ") || msg.subtype || "the reply failed";
            if (lostSession(why)) startFresh();
            else this.message({ chat_id: chat.id, role: "error", text: `Something went wrong: ${why}` });
          }
          // The cards it touched ride on a final line, so they show as chips under the reply.
          if (cards.length) this.message({ chat_id: chat.id, role: "tool", text: cardsLine(cards), meta: { cards, cost_usd: cost } });
        }
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (!ctl.signal.aborted) {
        if (lostSession(why) && repo.getChat(chat.id)?.session_id === resumed) startFresh();
        else this.message({ chat_id: chat.id, role: "error", text: `Something went wrong: ${why}` });
      }
    } finally {
      // A reply cut short by Stop keeps what was written so far.
      if (streamed.trim()) this.message({ chat_id: chat.id, role: "assistant", text: `${streamed}${ctl.signal.aborted ? " …(stopped)" : ""}` });
      bus.publish({ type: "chat.delta", chatId: chat.id, text: "" });
    }
  }
}
