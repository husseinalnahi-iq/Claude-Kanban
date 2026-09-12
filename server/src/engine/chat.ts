import { basename, relative, isAbsolute } from "node:path";
import type { CanUseTool, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type { Chat, ChatMessage, Project } from "../types.ts";
import { ConflictError, NotFoundError, type QueryFn, type TaskRunner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import { createChatBoardServer } from "./chatBoard.ts";

/** Looking only. Anything else is refused: changing code is what a card is for. */
export const CHAT_READ_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
/** Never offered to the chat at all, so it does not even try. */
export const CHAT_DISALLOWED = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "BashOutput", "KillShell", "Task", "Agent", "AskUserQuestion"];
const NEW_CHAT = "New chat";

type Card = NonNullable<ChatMessage["meta"]["cards"]>[number];

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

export function chatPrompt(project: Project, now = new Date()): string {
  return [
    `You are the side chat of Claude Kanban, talking with the user about the project "${project.name}" (${project.path}).`,
    "Many users are not programmers: answer plainly and briefly, and explain any technical word you have to use.",
    "You can read the code (Read, Grep, Glob) and the web, but you cannot edit files or run commands, and should not offer to.",
    "Work gets done by task cards on the board. When the user wants something built, fixed or changed:",
    "1. Make sure you understand what they want; ask one short question if it is unclear.",
    "2. Create a card with board_create_task: a short title, and a spec with the problem and what done looks like.",
    "3. Say what you created, then offer to queue it now (board_queue_task) or schedule it (board_schedule_task).",
    "Never queue or schedule a card the user did not ask to run.",
    `Current local time: ${localNow(now)}. Scheduled times are ISO 8601 with that offset, or "reset" for when the user's Claude usage window resets.`,
  ].join("\n");
}

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

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

  constructor(private deps: ChatDeps) {}

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
    const chat = this.deps.repo.createChat({ project_id: projectId, title: title?.trim() || NEW_CHAT, model: s.chatModel, effort: s.chatEffort });
    this.publish(chat);
    return chat;
  }

  update(id: string, patch: { title?: string; model?: string; effort?: Chat["effort"]; archived?: boolean }): Chat {
    this.mustChat(id);
    const chat = this.deps.repo.updateChat(id, {
      title: patch.title?.trim() || undefined,
      model: patch.model,
      effort: patch.effort,
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
    const mine = this.message({ chat_id: id, role: "user", text })!;
    if (chat.title === NEW_CHAT) this.publish(this.deps.repo.updateChat(id, { title: text.replace(/\s+/g, " ").trim().slice(0, 60) }));
    const ctl = new AbortController();
    this.live.set(id, ctl);
    this.publish(this.deps.repo.getChat(id)!);
    void this.reply(this.deps.repo.getChat(id)!, project, text, ctl).finally(() => {
      this.live.delete(id);
      const after = this.deps.repo.getChat(id);
      if (after) this.publish(after);
    });
    return mine;
  }

  private async reply(chat: Chat, project: Project, text: string, ctl: AbortController): Promise<void> {
    const { repo, bus } = this.deps;
    const cards: Card[] = [];
    const canUseTool: CanUseTool = async (name, input) => {
      if (name.startsWith("mcp__board__") || CHAT_READ_TOOLS.includes(name)) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "The side chat only reads and makes cards. To change code, create a card with board_create_task and offer to queue it." };
    };
    const options: Options = {
      model: chat.model,
      effort: chat.effort,
      cwd: project.path,
      resume: chat.session_id ?? undefined,
      includePartialMessages: true,
      // The project's CLAUDE.md, not your global tool servers: a chat should be quick and cheap.
      settingSources: ["project"],
      strictMcpConfig: true,
      mcpServers: { board: createChatBoardServer(this.deps, project.id, (c) => cards.push(c)) },
      skills: [],
      plugins: [],
      extraArgs: { "no-chrome": null },
      disallowedTools: CHAT_DISALLOWED,
      permissionMode: "default",
      canUseTool,
      systemPrompt: { type: "preset", preset: "claude_code", append: chatPrompt(project) },
      maxTurns: 40,
      abortController: ctl,
    };

    let streamed = "";
    try {
      for await (const raw of this.queryFn({ prompt: userMessage(text), options })) {
        const msg = raw as any;
        if (!repo.getChat(chat.id)) break;
        if (msg.session_id && msg.session_id !== chat.session_id) {
          chat = repo.updateChat(chat.id, { session_id: msg.session_id });
        }
        if (msg.type === "stream_event") {
          const e = msg.event;
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
            streamed += e.delta.text;
            bus.publish({ type: "chat.delta", chatId: chat.id, text: streamed });
          }
          continue;
        }
        if (msg.type === "assistant" && !msg.parent_tool_use_id) {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              this.message({ chat_id: chat.id, role: "assistant", text: block.text });
              streamed = "";
            } else if (block.type === "tool_use") {
              this.message({ chat_id: chat.id, role: "tool", text: describeTool(block.name, block.input ?? {}, project.path) });
            }
          }
          continue;
        }
        if (msg.type === "result") {
          const cost = Number(msg.total_cost_usd ?? 0);
          chat = repo.updateChat(chat.id, { cost_usd: (repo.getChat(chat.id)?.cost_usd ?? 0) + cost });
          if (msg.is_error && !ctl.signal.aborted) {
            const why = (msg.errors ?? []).join("; ") || msg.subtype || "the reply failed";
            this.message({ chat_id: chat.id, role: "error", text: `Something went wrong: ${why}` });
          }
          // The cards it touched ride on a final line, so they show as chips under the reply.
          if (cards.length) this.message({ chat_id: chat.id, role: "tool", text: `${cards.length} card${cards.length > 1 ? "s" : ""}`, meta: { cards, cost_usd: cost } });
        }
      }
    } catch (err) {
      if (!ctl.signal.aborted) {
        this.message({ chat_id: chat.id, role: "error", text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` });
      }
    } finally {
      // A reply cut short by Stop keeps what was written so far.
      if (streamed.trim()) this.message({ chat_id: chat.id, role: "assistant", text: `${streamed}${ctl.signal.aborted ? " …(stopped)" : ""}` });
      bus.publish({ type: "chat.delta", chatId: chat.id, text: "" });
    }
  }
}
