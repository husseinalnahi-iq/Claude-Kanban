import { basename, relative, isAbsolute } from "node:path";
import type { CanUseTool, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { Approval, Chat, ChatFile, ChatFolder, ChatMessage, ChatUpdate, FolderColor, Mode, ModelEntry, Project, RunStyle, Settings, Stage, Task } from "../types.ts";
import { ATTACHMENT_TYPES, FOLDER_COLORS, MAX_ATTACHMENT_BYTES, attachmentKind } from "../types.ts";
import { ConflictError, forceAsk, NotFoundError, QUESTION_TOOL, type QueryFn, type TaskRunner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import { askedQuestions, createChatBoardServer, pipelineLine } from "./chatBoard.ts";
import { defaultPipeline } from "./boardMcp.ts";
import { resultText } from "./record.ts";
import type { Resolved } from "./providers/types.ts";
import { estimateCost, sumUsage } from "./providers/cost.ts";
import type { TokenUsage } from "./providers/types.ts";
import { ANTHROPIC_PROVIDER_ID } from "../types.ts";
import { isReadOnlyShell, readViolation } from "./gate.ts";
import { commandOf, explainCommand } from "./explain.ts";
import { credentialRisk } from "./credentials.ts";
import { imageMakerLine } from "./images.ts";
import { CACHE_WARN_MIN, CACHE_WINDOW_MIN, KEEP_ALIVE_LEAD_MIN } from "./cacheWindow.ts";

/** Looking only. Anything else is refused: changing code is what a card is for. */
export const CHAT_READ_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
/**
 * Never offered to the chat at all, so it does not even try. The shell is offered, but only a command
 * that can only read passes (`isReadOnlyShell`, the supervised rule, D350): `git log` answers "what
 * changed last" here in a second instead of on a 20-cent card.
 */
export const CHAT_DISALLOWED = ["Edit", "Write", "MultiEdit", "NotebookEdit", "BashOutput", "KillShell", "Task", "Agent", "AskUserQuestion"];
/** Said to the model when a command is not read-only: a card, not an apology (D283). */
export const CHAT_COMMAND_REFUSED =
  "Only a command that can only read runs from the chat (git log, git status, git diff, ls, grep…). This one could change something or run a program, so it is a card's job: create one with board_create_task (an answer card for a lookup) and tell the user what it will do. Do not tell them what you cannot do.";
export const CHAT_COMMANDS_OFF =
  "Commands do not run from this chat (Settings → Runs & limits has read-only commands without a card switched off): create a card with board_create_task (an answer card for a lookup) and tell the user what it will do. Do not tell them what you cannot do.";
const NEW_CHAT = "New chat";
/** What one reply may cost: enough for a long, careful answer. */
const CHAT_CEILING_USD = 1.5;
/** The context bar moves while a reply reads files; pushing it to every open page once a second is enough. */
const CONTEXT_PUSH_MS = 1000;
/** What ✦ What next? asks (D338). The user picks; the chat makes no card on its own. */
export const NEXT_STEPS_PROMPT =
  "Looking at this conversation and the cards it made, suggest the next 5 things we might need to do: bugs to fix, security to tighten, follow-up edits once this work lands, or useful additions related to it. Number them, one line each with a short why, most valuable first. Create no cards: I will pick.";
/** In front of the keep-alive message, so the reply is one cheap line and nothing else happens. */
export const KEEP_ALIVE_NOTE = "[Automatic keep-alive from the board, sent to keep this conversation cached. Answer in one short line and do nothing else.]";

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
    case "Bash":
    case "PowerShell": {
      // The same plain-words table as a card's Commands tab (D336), when it knows the command.
      const cmd = commandOf(name, input) ?? "";
      const why = explainCommand(cmd);
      return `ran ${q(cmd)}${why.complete && cmd ? `: ${why.summary.charAt(0).toLowerCase()}${why.summary.slice(1).replace(/\.$/, "")}` : ""}`;
    }
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

/**
 * Where a follow-up goes (D377). A card that did the work remembers its files and choices; continuing it
 * while its memory is warm costs a fraction of a new card finding them again, so the chat checks first.
 */
function followUpLines(how: Settings["followUpRouting"]): string[] {
  const find = "Before you make a change card, call board_related_cards with the user's request and any project files you looked at for it.";
  if (how === "new") {
    return ["Follow-ups go to a new card: that is the user's setting. When the request is about an earlier card's work, pass follows with that card's id so the new card is told what it did. Send it to an existing card only when the user asks."];
  }
  if (how === "ask") {
    return [
      find,
      "When a card matches (the same page, feature or files), say in one line which card and route the board recommends and what it saves, and wait for the user's yes before acting. A new card otherwise.",
    ];
  }
  return [
    find,
    "When it returns a card the request is about (the same page, feature or files), take the route it recommends: board_continue_task for steer, add_to_round, new_round or fork, or board_create_task with follows for a fresh card. Choose otherwise only when the request is clearly separate work, and a new card for anything unrelated.",
    'In your reply, say in one line where it went and why, in plain words, for example: Sent to "Main page" as round 2: its memory is still warm, about $0.04 instead of about $0.30 for a new card. What the user says wins: "make a new card" or "send it to the page card" is done as said.',
  ];
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
export function chatPrompt(project: Project, board?: { models: ModelEntry[]; defaults: Stage[]; pictures?: string | null; tools?: boolean; mode?: RunStyle; followUps?: Settings["followUpRouting"] }): string {
  return [
    `You are the side chat of Claude Kanban, talking with the user about the project "${project.name}" (${project.path}).`,
    "Many users are not programmers: answer plainly and briefly, and explain any technical word you have to use.",
    // In a real chat "I can't query BizApp from this chat…" opened the reply to "get me the latest PO" (D283).
    "You read the project's files, its git history and the web yourself, and you can run a command that only reads, inside the project folder: git log, git status, git diff, git show, git blame, ls, grep, wc and the like. Everything else — a command that changes something or runs a program (a script, tests, a build, npm), looking something up in a live system (an ERP, a database, an API), changing a file — is done by a task card on the board, and its result comes back into this chat. Never tell the user what you cannot do from here, never mention your own tools or their limits (\"I can't run…\", \"I can only read…\"), and never ask the user to run something themselves: say what you will do (\"I'll make a card that looks it up\") and do it.",
    // Only when the chat was given them: otherwise it would promise tools it does not have (D335).
    ...(board?.tools
      ? ["You also have the user's own skills, MCP servers and connectors. Use them to look things up and to work with their systems when they can do the job from here; a command that changes or runs something, and changing a file, are still a card's job."]
      : []),
    "Files the user attaches are listed in front of their message with their paths: open an image, a PDF or a text file with Read. A spreadsheet or a Word file needs a card (MarkItDown reads them): make an answer card and say so.",
    "Take the cheapest route that gets what the user wants:",
    "1. When the project's files, its git history (a read-only command) or the web answer it fully, answer yourself. No card. If part of the answer needs a command that changes or runs something (a script, tests, a query) or a live system, do not give half an answer: make the answer card.",
    '2. A lookup, question or report that needs a live system or a command: one answer card — board_create_task with stages [{stage:"answer"}]. Related lookups go on one card: one session answering both costs less than two. When the user asked for the result ("get me…", "find…", "check…"), start it in the same reply with board_queue_task.',
    "3. Work that changes something: one card. Leave stages out for the board's default; one code stage is enough for a small, clear change; plan → code → review where choosing the approach, or a mistake, is the costly part. Split into several cards only when the parts are big and independent.",
    "When one part needs another's result or must come after it (look something up, then use it; build the API, then the page), make a chain: create the cards in order, give each later card depends_on the earlier ones, and start them together. A card waits in Queued until the cards it depends on are done, then starts by itself and is given what they reported.",
    "For a change, make sure you understand it first; ask one short question if it is unclear. The spec says the problem and what done looks like, from what the user asked, nothing more. Extras you think would help (a pause button, a README) go in your reply as suggestions they can say yes to; they never go into the spec on their own, because every line in it is paid for.",
    "When you create a change card, say in a few words how it will run and why. A card with a plan stage opens its setup card here, where the user checks the mode and each step's model and effort and presses Start; list those for them, and never start it yourself (D365). Another change card: ask whether to start it; the user can also press Start on the card. The modes:",
    "- supervised: works in the project's own folder and asks the user before each change. A change that reaches a live system or runs commands outside the project is supervised: an autonomous change is sandboxed and cannot reach it.",
    "- autonomous: works on its own branch without asking, and lands only when the user approves it. Good for changes to the project's own files, when the project allows it.",
    "- ask (Autonomous + asks me): autonomous, but when it needs the user's answer to go on, it stops and waits for it; its question appears in this chat. For work where the user wants a say in the choices along the way.",
    "- an answer card follows the same switch. Autonomous: it runs in the project's own folder, reaches what the project reaches (a live system, its scripts and keys) and asks nothing; it still changes nothing. Supervised: each command that is not read-only waits for the user's Allow. The card's reply tells you which it got.",
    // The switch under the chat is the default; a mode named in the message wins over it (D344).
    `Use the mode the user chose in their message; otherwise leave mode out and the chat's own mode switch applies${board?.mode ? ` (it is set to ${board.mode === "ask" ? "ask, Autonomous + asks me" : board.mode} now)` : ""}, and say which mode the card got and why. Set live: true only when the card will change a live system: it then waits for the user's OK on its plan and its review checks the live system. Reading one is not live.`,
    `When the user names a model or an effort ("sonnet, high effort for the code"), put it on that stage in stages.${board ? ` This board's models: ${board.models.map((m) => `${m.label} (${m.id})`).join(", ")}. Default stages: ${pipelineLine(board.defaults)}.` : ""} Haiku has no effort setting. board_update_task changes a Backlog card's stages, mode, branch or live.`,
    "Never queue or schedule a change card the user did not ask to run.",
    ...followUpLines(board?.followUps ?? "memory"),
    "When the user asks you to remember something for later work (a rule, a decision, a correction), save it with board_remember: every later card starts with it.",
    "You can also follow and talk to the cards themselves:",
    "- board_list_tasks and board_task_progress tell you what each card is doing, what it did, what it cost and what it is waiting for. Look before you answer a question about a task; do not guess.",
    "- board_message_task passes the user's words to a card's own Claude session: a running card takes them in at its next step, a card in review or failed picks its session up again with them. Pass on what the user said; do not invent instructions.",
    "- board_answer_question answers a question a card asked, with the answer the user gave — a note it carried on past, or a question card it stopped on and waits for (an Autonomous + asks me or supervised card). board_stop_task and board_retry_task stop or re-run a card when the user asks.",
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
  const what = {
    finished: u.status === "done" ? "finished" : "finished and waits for review", failed: "failed", plan: "has a plan waiting for the user's OK", question: "asks",
    asks: "stopped and waits for the user's answer to",
  }[u.kind];
  const extra =
    u.kind === "question" ? ` (question_id ${u.question_id}${u.options?.length ? `; options: ${u.options.join(" / ")}` : ""})`
    : u.kind === "asks" ? ` (question_id ${u.approval_id}; the user can click an answer on the card shown here, or tell you and you pass it on)`
    : "";
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
  /** Chats warned about this window already, by the window they were warned about (`id:warm_at`). */
  private warned = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: ChatDeps) {
    deps.bus.subscribe((m) => {
      if (m.type === "approval.requested" && m.approval.tool_name === QUESTION_TOOL) {
        try {
          this.reportAsk(m.approval);
        } catch (err) {
          console.error("Side chat could not report a card's question:", err);
        }
        return;
      }
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

  /**
   * A card this chat made stopped on a question card: put it in the chat, where it can be answered by
   * a click or in words (D361). Each card is its own approval, so there is nothing to tell apart.
   */
  private reportAsk(approval: Approval): void {
    const { repo } = this.deps;
    const task = repo.getTask(approval.task_id);
    if (!task?.chat_id || !repo.getChat(task.chat_id)) return;
    const asked = askedQuestions(approval.input);
    const text = asked.map((q) => (q.options.length ? `${q.question} (${q.options.join(" / ")})` : q.question)).join("\n") || "It has a question for you.";
    const update: ChatUpdate = { id: task.id, title: task.title, kind: "asks", status: task.status, text, approval_id: approval.id };
    this.message({ chat_id: task.chat_id, role: "update", text: `“${task.title}” asks you`, meta: { update } });
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
    const line = { finished: "finished", failed: "failed", plan: "has a plan ready", question: "asks something", asks: "asks you" }[kind];
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

  update(id: string, patch: { title?: string; model?: string; effort?: Chat["effort"]; provider?: string; archived?: boolean; folder_id?: string | null; keep_alive?: boolean; use_tools?: boolean; mode?: RunStyle }): Chat {
    const before = this.mustChat(id);
    if (patch.provider && patch.provider !== ANTHROPIC_PROVIDER_ID) this.chatProvider(patch.provider); // refused here, not at the next message
    if (patch.folder_id) {
      const folder = this.deps.repo.getChatFolder(patch.folder_id);
      if (!folder || folder.project_id !== before.project_id) throw new NotFoundError("That folder is gone. Pick another, or none.");
    }
    const moved = Boolean(patch.provider) && patch.provider !== before.provider;
    const chat = this.deps.repo.updateChat(id, {
      title: patch.title?.trim() || undefined,
      model: patch.model,
      effort: patch.effort,
      provider: patch.provider,
      folder_id: patch.folder_id,
      keep_alive: patch.keep_alive,
      use_tools: patch.use_tools,
      mode: patch.mode,
      // Another endpoint cannot continue a session this one signed: a fresh one, with the conversation
      // carried in front of the next message (D301).
      // Its context is measured again by the first reply there.
      ...(moved ? { session_id: null, context_tokens: 0, context_window: 0 } : {}),
      archived_at: patch.archived === undefined ? undefined : patch.archived ? new Date().toISOString() : null,
    });
    this.publish(chat);
    return chat;
  }

  delete(id: string): void {
    const chat = this.mustChat(id);
    this.stop(id);
    // Its files go with it (the rows cascade; the folder does not).
    const dir = join(this.deps.repo.getSettings().stateDir || process.cwd(), "chat-files", id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.deps.repo.deleteChat(id);
    this.deps.bus.publish({ type: "chat.deleted", id, project_id: chat.project_id });
  }

  // ---------- folders (the AI Manager's chat list) ----------
  folders(projectId: string): ChatFolder[] {
    return this.deps.repo.listChatFolders(projectId);
  }

  private publishFolders(projectId: string) {
    this.deps.bus.publish({ type: "chat.folders", project_id: projectId, folders: this.deps.repo.listChatFolders(projectId) });
  }

  /** A new folder takes the first colour no folder of the project wears yet, so neighbours never look alike by accident. */
  createFolder(projectId: string, name: string): ChatFolder {
    if (!this.deps.repo.getProject(projectId)) throw new NotFoundError(`No project ${projectId}`);
    const worn = new Set(this.deps.repo.listChatFolders(projectId).map((f) => f.color));
    const color = FOLDER_COLORS.find((c) => !worn.has(c)) ?? FOLDER_COLORS[this.deps.repo.listChatFolders(projectId).length % FOLDER_COLORS.length];
    const folder = this.deps.repo.createChatFolder(projectId, name.trim() || "New folder", color);
    this.publishFolders(projectId);
    return folder;
  }

  updateFolder(id: string, patch: { name?: string; color?: FolderColor | null }): ChatFolder {
    const before = this.deps.repo.getChatFolder(id);
    if (!before) throw new NotFoundError(`No folder ${id}`);
    const folder = this.deps.repo.updateChatFolder(id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() || before.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    });
    this.publishFolders(folder.project_id);
    return folder;
  }

  /** The folder goes; its chats stay, unfiled. Nothing a person wrote is ever removed by this. */
  deleteFolder(id: string): void {
    const folder = this.deps.repo.getChatFolder(id);
    if (!folder) throw new NotFoundError(`No folder ${id}`);
    this.deps.repo.deleteChatFolder(id);
    for (const c of this.deps.repo.listChats(folder.project_id)) if (!c.folder_id) this.publish(c);
    this.publishFolders(folder.project_id);
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

  // ---------- files (D334) ----------

  /** Where a chat's files live: under the board's state dir, like a task's attachments, never in the project. */
  private filesDir(chatId: string): string {
    const dir = join(this.deps.repo.getSettings().stateDir || process.cwd(), "chat-files", chatId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Save a file for a chat. It rides with the next message you send. */
  addFile(chatId: string, f: { name: string; data: Buffer }): ChatFile {
    this.mustChat(chatId);
    const media = ATTACHMENT_TYPES[extname(f.name).toLowerCase()];
    if (!media) throw new ConflictError(`The board does not handle "${extname(f.name) || f.name}" files.`);
    if (f.data.byteLength > MAX_ATTACHMENT_BYTES) throw new ConflictError(`"${f.name}" is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
    // The stored name is ours, so a crafted name can never escape the folder or overwrite anything.
    const path = join(this.filesDir(chatId), `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${extname(f.name).toLowerCase() || ".bin"}`);
    writeFileSync(path, f.data);
    return this.deps.repo.addChatFile({ chat_id: chatId, message_id: null, name: f.name.slice(0, 120), media_type: media, bytes: f.data.byteLength, path });
  }

  files(chatId: string): ChatFile[] {
    return this.deps.repo.listChatFiles(chatId);
  }

  /** Only a file not yet sent can be taken back: one Claude has seen is part of the conversation. */
  removeFile(id: string): void {
    const f = this.deps.repo.getChatFile(id);
    if (!f) throw new NotFoundError("No such file.");
    if (f.message_id !== null) throw new ConflictError("That file went with a message already. Delete the chat to remove it.");
    if (existsSync(f.path)) rmSync(f.path, { force: true });
    this.deps.repo.deleteChatFile(id);
  }

  /** The lines in front of a message that name its files, so Claude knows where they are and how to open them. */
  private filesNote(files: ChatFile[]): string {
    if (!files.length) return "";
    const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const how = (f: ChatFile) => (attachmentKind(f.media_type) === "document" && f.media_type !== "application/pdf" ? "needs a card to read" : "open with Read");
    return `[Attached files]\n${files.map((f) => `- ${f.name} (${f.media_type}, ${kb(f.bytes)}; ${how(f)}): ${f.path}`).join("\n")}\n\n`;
  }

  /** ✦ What next?: the board asks the chat for five next steps as a marked message of its own (D338). */
  suggest(id: string): ChatMessage {
    return this.send(id, NEXT_STEPS_PROMPT, { suggest: true });
  }

  // ---------- the cache window (D331, D332) ----------

  /** Watch the chats' cache windows every half minute. Unref'd: it never keeps the process alive on its own. */
  startWatch(intervalMs = 30_000): void {
    this.stopWatch();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stopWatch(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One look at every warm chat: say when a window is about to close, send the keep-alive message just
   * before it does, and forget a window that has closed. `now` is a parameter so a test can move the
   * clock instead of waiting an hour.
   */
  tick(now = new Date()): void {
    const { repo } = this.deps;
    const settings = repo.getSettings();
    for (const chat of repo.warmChats()) {
      const left = CACHE_WINDOW_MIN - (now.getTime() - Date.parse(chat.warm_at!)) / 60_000;
      if (left <= 0) {
        // The window has closed: the next message is re-read at full price, and the bar should say so.
        this.publish(repo.updateChat(chat.id, { warm_at: null }));
        continue;
      }
      if (this.live.has(chat.id)) continue; // a reply is being written: the window moves when it lands
      const window = `${chat.id}:${chat.warm_at}`;
      if (left <= CACHE_WARN_MIN && !this.warned.has(window)) {
        this.warned.add(window);
        this.deps.bus.publish({ type: "chat.expiring", chat, minutes: Math.ceil(left) });
      }
      if (left <= KEEP_ALIVE_LEAD_MIN && this.keepsAlive(chat, settings, now)) {
        try {
          this.send(chat.id, settings.chatKeepAliveMessage, { keepalive: true });
        } catch (err) {
          console.error("Keep-alive message failed:", err);
        }
      }
    }
    // Windows that closed or moved on are no longer worth remembering.
    const open = new Set(repo.warmChats().map((c) => `${c.id}:${c.warm_at}`));
    for (const w of this.warned) if (!open.has(w)) this.warned.delete(w);
  }

  /**
   * Whether this chat gets a keep-alive now: the setting and the chat's own switch are on, it is not
   * archived, and your own last message is recent enough. Only a person's message counts for that: a
   * keep-alive that counted as activity would keep itself going for ever.
   */
  private keepsAlive(chat: Chat, settings: { chatKeepAlive: boolean; chatKeepAliveMaxHours: number }, now: Date): boolean {
    if (!settings.chatKeepAlive || !chat.keep_alive || chat.archived_at) return false;
    const last = this.deps.repo.lastOwnChatMessage(chat.id);
    if (!last) return false;
    return now.getTime() - Date.parse(last.ts) < settings.chatKeepAliveMaxHours * 3_600_000;
  }

  stop(id: string): boolean {
    const ctl = this.live.get(id);
    ctl?.abort();
    return !!ctl;
  }

  /**
   * Store your message and start the reply. Returns at once; the reply streams over the websocket.
   * A keep-alive is the board's own message (D332): stored marked as such, never used as a title, and
   * sent with a note asking for one line back.
   */
  send(id: string, text: string, opts: { keepalive?: boolean; suggest?: boolean } = {}): ChatMessage {
    const chat = this.mustChat(id);
    if (this.live.has(id)) throw new ConflictError("Still answering your last message. Wait, or press Stop.");
    const project = this.deps.repo.getProject(chat.project_id);
    if (!project) throw new NotFoundError("This chat's project is gone.");
    // What the chat's cards did since your last message rides in front of this one (D285).
    const news = this.deps.repo.chatUpdatesSince(id, this.deps.repo.lastChatMessage(id, "user")?.id ?? 0).map((m) => m.meta.update!).filter(Boolean);
    // Files attached since your last message go with this one; the board's own messages carry none.
    const files = opts.keepalive || opts.suggest ? [] : this.deps.repo.pendingChatFiles(id);
    const meta: ChatMessage["meta"] = {
      ...(opts.keepalive ? { keepalive: true } : {}),
      ...(opts.suggest ? { suggest: true } : {}),
      ...(files.length ? { files: files.map((f) => ({ id: f.id, name: f.name, media_type: f.media_type, bytes: f.bytes })) } : {}),
    };
    const mine = this.message({ chat_id: id, role: "user", text, meta })!;
    if (files.length) this.deps.repo.attachChatFiles(files.map((f) => f.id), mine.id);
    const auto = Boolean(opts.keepalive || opts.suggest);
    if (chat.title === NEW_CHAT && !auto) this.publish(this.deps.repo.updateChat(id, { title: text.replace(/\s+/g, " ").trim().slice(0, 60) }));
    const ctl = new AbortController();
    this.live.set(id, ctl);
    this.publish(this.deps.repo.getChat(id)!);
    void this.reply(this.deps.repo.getChat(id)!, project, `${this.filesNote(files)}${opts.keepalive ? `${KEEP_ALIVE_NOTE}\n` : ""}${text}`, ctl, news)
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
    // Its own files may be read too (D334): they sit in the state dir, outside the project.
    const fileRoots = this.deps.repo.listChatFiles(chat.id).length ? [this.filesDir(chat.id)] : [];
    const settings = repo.getSettings();
    const canUseTool: CanUseTool = async (name, input) => {
      // A page or file the chat reads could tell it to fetch your keys and send them somewhere; nobody
      // sees a card here, so reading stays inside the project and away from credential files.
      if (readViolation(name, input, project.path, fileRoots)) {
        return { behavior: "deny", message: `The side chat only reads files inside this project (${project.path}) and the files attached to it. Tell the user you cannot open that file from here.` };
      }
      if (credentialRisk(name, input)) {
        return { behavior: "deny", message: "That file holds passwords or keys, and the side chat does not open those. Tell the user, and carry on without it." };
      }
      if (name.startsWith("mcp__board__") || CHAT_READ_TOOLS.includes(name)) return { behavior: "allow", updatedInput: input };
      // A command that can only read runs here, under the supervised rule and its setting (D350): the
      // rule keeps it inside the project and away from credential files, like the chat's own reads.
      if (name === "Bash" || name === "PowerShell") {
        if (!settings.autoAllowReadOnly) return { behavior: "deny", message: CHAT_COMMANDS_OFF };
        if (isReadOnlyShell(commandOf(name, input) ?? "", project.path)) return { behavior: "allow", updatedInput: input };
        return { behavior: "deny", message: CHAT_COMMAND_REFUSED };
      }
      // Your own servers, connectors and skills, unless Settings turned them off (D335, D381). Never an edit.
      if (settings.chatTools && (name.startsWith("mcp__") || name === "Skill")) return { behavior: "allow", updatedInput: input };
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
    // With your connectors and skills (on unless Settings turned them off, D381) the chat loads what a task
    // does: your user settings (plugins, hooks, MCP servers), your skills and your connectors. Otherwise only
    // the project's CLAUDE.md and the board's own server.
    const tools = settings.chatTools;
    const base: Options = {
      model: chat.model,
      effort: chat.effort,
      cwd: project.path,
      resume: chat.session_id ?? undefined,
      includePartialMessages: true,
      settingSources: tools && settings.loadUserPlugins ? ["user", "project"] : ["project"],
      ...(tools ? {} : { strictMcpConfig: true, skills: [], plugins: [], env: { ...(process.env as Record<string, string>), ENABLE_CLAUDEAI_MCP_SERVERS: "false" } }),
      mcpServers: { board: createChatBoardServer(this.deps, project.id, chat.id, (c) => cards.push(c)) },
      extraArgs: { "no-chrome": null },
      disallowedTools: CHAT_DISALLOWED,
      permissionMode: "default",
      canUseTool,
      // A project settings file that pre-allows a command would skip canUseTool; the supervised hook
      // forces every non-read-only tool back through it (D20, D350).
      hooks: { PreToolUse: forceAsk(settings.autoAllowReadOnly, project.path) },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: chatPrompt(project, {
          models: settings.models,
          defaults: defaultPipeline(repo, project),
          pictures: (await this.deps.runner.picturesReady()) ? imageMakerLine(settings) : null,
          tools,
          mode: chat.mode,
          followUps: settings.followUpRouting,
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
      ? res.adapter.applyOptions({ ...base, env: { ...(process.env as Record<string, string>), ...(base.env ?? {}) } }, { provider: res.provider, model: chat.model, secret: res.secret })
      : base;
    const priceOf = (usage: TokenUsage) =>
      res?.provider ? estimateCost(res.provider, chat.model, usage, this.deps.runner.catalog.priceOf(res.provider, chat.model)).usd : 0;
    let metered = 0;
    const counted = new Set<string>();
    let contextPushedAt = 0;

    let streamed = "";
    const resumed = chat.session_id;
    /** Claude Code no longer has the session this chat was continuing (its history was cleaned up, or the folder moved). */
    const lostSession = (why: string) => Boolean(resumed) && /no conversation found|session.*not found/i.test(why);
    const startFresh = () => {
      repo.updateChat(chat.id, { session_id: null, context_tokens: 0, context_window: 0 });
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
        // How full the conversation is: what Claude read for its latest answer, plus the answer (D360).
        // The latest, not the largest: a session Claude Code compacted holds less than it did.
        const u = msg.type === "assistant" && !msg.parent_tool_use_id ? msg.message?.usage : null;
        if (u) {
          const held = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          if (held && held !== chat.context_tokens) {
            chat = repo.updateChat(chat.id, { context_tokens: held });
            if (Date.now() - contextPushedAt >= CONTEXT_PUSH_MS) {
              contextPushedAt = Date.now();
              this.publish(chat);
            }
          }
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
          // The window is the chat's model's; a quick helper model in the same reply may have a smaller one.
          const used = (msg.modelUsage ?? {}) as Record<string, { contextWindow?: number }>;
          const window = used[chat.model]?.contextWindow || Math.max(0, ...Object.values(used).map((m) => m.contextWindow ?? 0));
          chat = repo.updateChat(chat.id, { cost_usd: (repo.getChat(chat.id)?.cost_usd ?? 0) + cost, ...(window ? { context_window: window } : {}) });
          if (msg.is_error && !ctl.signal.aborted) {
            // A result can fail with subtype "success": then the error is in `result`, and `errors` is empty.
            const why = msg.subtype === "success" ? msg.result || "the reply failed" : (msg.errors ?? []).join("; ") || msg.subtype || "the reply failed";
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
      // Claude's last request in this reply is when its cache window starts (D331). Only Claude's own
      // cache is an hour; another provider's is its own business, so the bar is not shown for it.
      if (repo.getChat(chat.id)) repo.updateChat(chat.id, { warm_at: res ? null : new Date().toISOString() });
    }
  }
}
