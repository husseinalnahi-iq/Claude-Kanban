import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Attachment, Chat, ChatFile, ChatFolder, ChatMessage, EventRow, FolderColor, TaskCard } from "../../../server/src/types.ts";
import { FOLDER_COLORS, attachmentKind } from "../../../server/src/types.ts";
import { checklistSummary, liveChecklist } from "../../../server/src/engine/checklist.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useAppData } from "../lib/store.tsx";
import { useWs } from "../lib/ws.ts";
import { ago, cost, modelLabel } from "../lib/format.ts";
import { isQuestion } from "../lib/questions.ts";
import { waitingOn } from "../lib/phase.ts";
import { useAsk } from "../components/Ask.tsx";
import { ArchiveIcon, Button, Empty, ErrorLine, FolderIcon, OpenIcon, PencilIcon, RestoreIcon, Select, StageDots, TrashIcon, inputCls, useAction, useEscape } from "../components/ui.tsx";
import { inputSummary } from "../components/Transcript.tsx";
import { BellControl } from "../components/BellControl.tsx";
import { ThemeControl } from "../components/ThemeControl.tsx";
import { FontControl } from "../components/FontControl.tsx";
import { ZoomControl } from "../components/ZoomControl.tsx";
import { UsageMeters } from "../components/UsageMeters.tsx";
import { QuestionCard } from "../components/QuestionCard.tsx";
import { pipelineLine } from "../components/PipelineEditor.tsx";
import { ChatThread } from "../components/chat/ChatThread.tsx";
import { CacheStrip } from "../components/chat/CacheStrip.tsx";
import { StatusPill, ToolApproval } from "../components/chat/ChatCard.tsx";
import { useChatFolders, useChats } from "../components/chat/useChats.ts";
import { CommandList } from "../components/CommandExplainer.tsx";
import { useTaskCards } from "./Board.tsx";
import { useColumnWidth } from "../lib/useColumnWidth.ts";

/** Cards still on their way: anything between Queued and Review, in the board's columns. */
const IN_PROGRESS = new Set(["queued", "approval", "planning", "running", "paused"]);
type GroupBy = "folders" | "status";
const GROUP_KEY = "kanban.studio.groupBy";

/** What each chat's cards are up to, so the list can say "working" or "needs you" without opening it. */
interface ChatState {
  working: number;
  needsYou: number;
}

const bytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const section = "px-3 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-500";
const tiny = "cursor-pointer rounded px-1.5 py-px font-mono text-[10.5px] text-ink-500 hover:bg-ink-800 hover:text-ink-100";

/**
 * The Studio: the chat as the whole screen. Everything the board shows about a project is one click
 * away behind the Board button, and nothing else of it is on screen — so a long conversation with
 * Claude reads like a conversation, not a side panel. Left, your chats for the project (switch
 * projects at the top; file chats in folders, or group them by what they are doing); middle, the
 * conversation; right, the work it started: each card with Claude's own steps, the files the cards
 * produced and the links they mentioned.
 */
export function Studio({ project, projects, onAddProject, onSearch }: { project: ProjectWithGit | null; projects: ProjectWithGit[]; onAddProject: () => void; onSearch: () => void }) {
  return (
    <div className="flex h-full flex-col bg-ink-950">
      <header className="flex items-center gap-2 border-b border-ink-800 bg-ink-900/80 px-3 py-2">
        <button
          className="flex cursor-pointer items-center gap-2 rounded-md border border-ink-700 px-2 py-1 text-[12.5px] text-ink-200 transition-colors hover:border-amber/60 hover:text-amber"
          onClick={() => navigate({ view: "board", taskId: null })}
          title="Leave the Studio and go back to the board (press 1)"
        >
          <span className="flex h-5 w-5 items-end gap-[2px] rounded bg-ink-800 p-[3px]">
            <span className="h-full w-1 rounded-sm bg-amber" />
            <span className="h-2/3 w-1 rounded-sm bg-ink-200" />
            <span className="h-1/3 w-1 rounded-sm bg-ink-500" />
          </span>
          Board
        </button>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-500">Studio</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-ink-700 px-2.5 py-1 text-[12px] text-ink-400 transition-colors hover:border-ink-500 hover:text-ink-200 cursor-pointer"
            onClick={onSearch}
            title="Search specs, transcripts, results and memory"
          >
            Search <span className="font-mono text-[10px] text-ink-600">/</span>
          </button>
          <BellControl />
          <ThemeControl />
          <FontControl />
          <ZoomControl />
          <div className="pr-1">
            <UsageMeters />
          </div>
        </div>
      </header>
      {project ? (
        <StudioBody key={project.id} project={project} projects={projects} onAddProject={onAddProject} />
      ) : (
        <div className="mx-auto mt-24 max-w-md space-y-4 text-center">
          <Empty>{projects.length ? "Pick a project to talk about." : "No projects yet. Register a folder to start talking about it."}</Empty>
          {projects.length ? (
            <ProjectSwitch project={null} projects={projects} />
          ) : (
            <Button variant="primary" onClick={onAddProject}>+ Add project</Button>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectSwitch({ project, projects }: { project: ProjectWithGit | null; projects: ProjectWithGit[] }) {
  return (
    <span className="relative block min-w-0">
      <Select wide className="text-transparent!" value={project?.id ?? ""} onChange={(e) => navigate({ view: "studio", projectId: e.target.value || null, taskId: null })} title={project ? `${project.name} — which project these chats are about` : "Which project these chats are about"}>
        {!project ? <option value="">Pick a project…</option> : null}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </Select>
      {/* A browser's own <select> cannot cut a long name short with an ellipsis, so the name on show is this span over the box; the list still opens from the box beneath. */}
      <span className="pointer-events-none absolute inset-y-0 left-2.5 right-7 flex items-center">
        <span className="truncate text-[13px] text-ink-100">{project?.name ?? "Pick a project…"}</span>
      </span>
    </span>
  );
}

function StudioBody({ project, projects, onAddProject }: { project: ProjectWithGit; projects: ProjectWithGit[]; onAddProject: () => void }) {
  const chats = useChats(project.id);
  const folders = useChatFolders(project.id);
  const { cards } = useTaskCards(project.id);
  const { pending } = useAppData();
  // undefined: nothing chosen yet, so the newest chat opens; null: a new chat, made with its first message.
  const [chatId, setChatId] = useState<string | null | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chat = chats?.find((c) => c.id === chatId) ?? null;

  useEffect(() => {
    if (chats && chatId === undefined) setChatId(chats.find((c) => !c.archived_at)?.id ?? null);
  }, [chats, chatId]);

  // Per chat: how many of its cards are on their way, and how many wait for you.
  const states = useMemo(() => {
    const m = new Map<string, ChatState>();
    for (const c of cards) {
      if (!c.chat_id || c.archived_at) continue;
      const s = m.get(c.chat_id) ?? { working: 0, needsYou: 0 };
      if (IN_PROGRESS.has(c.status)) s.working++;
      s.needsYou += pending.filter((a) => a.task_id === c.id).length;
      m.set(c.chat_id, s);
    }
    return m;
  }, [cards, pending]);

  const onMessages = useCallback((m: ChatMessage[]) => setMessages(m), []);
  // Both side columns are dragged by their inner edge and remembered on this computer.
  const left = useColumnWidth("kanban.studio.left", 272, 200, 480);
  const right = useColumnWidth("kanban.studio.right", 340, 260, 640);

  return (
    <div className="flex min-h-0 flex-1">
      <ChatList
        project={project}
        projects={projects}
        chats={chats}
        folders={folders}
        states={states}
        chatId={chatId ?? null}
        onPick={setChatId}
        onAddProject={onAddProject}
        width={left.width}
      />
      <ColumnHandle onDrag={(e) => left.drag(e, 1)} onReset={left.reset} what="the chat list" />
      <main className="flex min-w-0 flex-1 flex-col bg-ink-900/40">
        {/* One row: the title (click to rename) and what it cost on the left, the cache bar and Keep warm on the right. */}
        <div className="flex items-center gap-4 px-5 pt-3 pb-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {chat ? <ChatTitle chat={chat} /> : <div className="truncate text-[14px] font-semibold text-ink-100">New chat</div>}
              {chat?.busy ? <span className="breathe h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title="Writing a reply" /> : null}
            </div>
            <div className="truncate text-[10.5px] text-ink-500">
              {project.name}
              {chat ? ` · ${modelLabel({ model: chat.model, provider: chat.provider === "anthropic" ? null : chat.provider })} · ${cost(chat.cost_usd)}` : ""}
            </div>
          </div>
          {chat ? <CacheStrip chat={chat} inline /> : null}
        </div>
        <div className="min-h-0 flex-1">
          {chatId === undefined ? null : <ChatThread project={project} chats={chats} chatId={chatId} onChatId={setChatId} onMessages={onMessages} wide />}
        </div>
      </main>
      <ColumnHandle onDrag={(e) => right.drag(e, -1)} onReset={right.reset} what="the work pane" />
      <ChatWork chatId={chatId ?? null} cards={cards} messages={messages} width={right.width} />
    </div>
  );
}

/** The chat's title: click it to rename, Enter or a click elsewhere saves, Escape puts the old one back. */
function ChatTitle({ chat }: { chat: Chat }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(chat.title);
  const { error, run } = useAction();
  useEffect(() => {
    if (!editing) setText(chat.title);
  }, [chat.title, editing]);
  const save = () => {
    setEditing(false);
    const t = text.trim();
    if (t && t !== chat.title) void run(() => api.patchChat(chat.id, { title: t }));
    else setText(chat.title);
  };
  if (!editing) {
    return (
      <button className="block min-w-0 cursor-text truncate text-left text-[14px] font-semibold text-ink-100 hover:text-amber" title="Click to rename this chat" onClick={() => setEditing(true)}>
        {chat.title}
      </button>
    );
  }
  return (
    <div className="min-w-0 flex-1">
      <input
        autoFocus
        className="w-full border-b border-amber/60 bg-transparent text-[14px] font-semibold text-ink-100 focus:outline-none"
        aria-label="Chat title"
        value={text}
        maxLength={120}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(chat.title);
            setEditing(false);
          }
        }}
      />
      {error ? <div className="text-[11px] text-rust">The new name was not saved: {error}</div> : null}
    </div>
  );
}

/** The edge between a side column and the chat: the line you see, and a wider strip to catch the pointer. */
function ColumnHandle({ onDrag, onReset, what }: { onDrag: (e: React.PointerEvent) => void; onReset: () => void; what: string }) {
  return (
    <div
      className="group/edge relative w-1.5 shrink-0 cursor-col-resize"
      onPointerDown={onDrag}
      onDoubleClick={onReset}
      title={`Drag to make ${what} wider or narrower · double-click to put it back`}
      role="separator"
      aria-orientation="vertical"
    >
      <div className="absolute inset-y-0 left-[2px] w-px bg-ink-800 transition-colors group-hover/edge:bg-amber/60 group-active/edge:bg-amber" />
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Left: the project's chats                                                                         */
/* ----------------------------------------------------------------------------------------------- */

/** Tailwind only emits a class it can read whole in the source, so each colour is spelled out once. */
const FOLDER_BG: Record<FolderColor, string> = { amber: "bg-amber", cyan: "bg-cyan", moss: "bg-moss", iris: "bg-iris", rose: "bg-rose", rust: "bg-rust", lime: "bg-lime", slate: "bg-slate" };
const FOLDER_WORD: Record<FolderColor, string> = { amber: "amber", cyan: "sky blue", moss: "green", iris: "violet", rose: "pink", rust: "orange", lime: "lime", slate: "grey-blue" };
const icon = "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-ink-400 hover:bg-ink-700 hover:text-ink-100";
const popItem = "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-ink-200 hover:bg-ink-800 hover:text-ink-100";

/** A small panel under a button. Escape or a click anywhere else closes it; the button that opened it (`data-pop-trigger`) toggles it instead. */
function Popover({ onClose, children, className = "" }: { onClose: () => void; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (box.current && !box.current.contains(t) && !t.closest("[data-pop-trigger]")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <div ref={box} className={`rise absolute z-20 mt-1 rounded-md border border-ink-700 bg-ink-900 p-1 kb-raise ${className}`}>
      {children}
    </div>
  );
}

type Pop = { kind: "folder"; id: string } | { kind: "color"; id: string } | { kind: "bulk" } | null;

/** What a drag carries: the chats being moved, as ids. A chat dragged while selected takes the whole selection along. */
const DRAG_TYPE = "text/chat-ids";

function ChatList({
  project, projects, chats, folders, states, chatId, onPick, onAddProject, width,
}: {
  project: ProjectWithGit;
  projects: ProjectWithGit[];
  chats: Chat[] | null;
  folders: ChatFolder[];
  states: Map<string, ChatState>;
  chatId: string | null;
  onPick: (id: string | null) => void;
  onAddProject: () => void;
  width: number;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try {
      return localStorage.getItem(GROUP_KEY) === "status" ? "status" : "folders";
    } catch {
      return "folders";
    }
  });
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set(["archived"]));
  const [pop, setPop] = useState<Pop>(null);
  const closePop = useCallback(() => setPop(null), []);
  // Several chats at once: Ctrl-click (⌘ on a Mac) adds one, Shift-click a run of them; a bar above the list acts on them all.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const lastPicked = useRef<string | null>(null);
  // The group a drag is held over, lit so the drop lands where it looks.
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useAsk();

  const pickGroup = (g: GroupBy) => {
    setGroupBy(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      // a private window keeps the choice for this page only
    }
  };
  const toggle = (id: string) => setClosed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const say = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const q = filter.trim().toLowerCase();
  const all = (chats ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
  const open = all.filter((c) => !c.archived_at);
  const archived = all.filter((c) => c.archived_at);

  // A chat that went away (deleted, or filtered out) leaves the selection, so the bar never counts ghosts.
  useEffect(() => {
    setSelected((s) => {
      const keep = new Set([...s].filter((id) => all.some((c) => c.id === id)));
      return keep.size === s.size ? s : keep;
    });
  }, [all.length, chats]); // eslint-disable-line react-hooks/exhaustive-deps
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  useEscape(clearSelection, selected.size > 0 && pop === null);

  // ----- actions on a chat
  const rename = async (c: Chat) => {
    const name = await dialog.ask({ title: "Rename this chat", input: { initial: c.title, required: true }, confirmLabel: "Rename" });
    if (name && name.trim() !== c.title) await api.patchChat(c.id, { title: name.trim() }).catch(say);
  };
  const archive = async (c: Chat, on: boolean) => {
    await api.patchChat(c.id, { archived: on }).catch(say);
    if (on && c.id === chatId) onPick(open.find((x) => x.id !== c.id)?.id ?? null);
  };
  const remove = async (c: Chat) => {
    if (!(await dialog.confirm({ title: `Delete “${c.title}” for good?`, message: "The chat and its messages are removed. Cards it made stay.", confirmLabel: "Delete", danger: true }))) return;
    await api.deleteChat(c.id).catch(say);
    if (c.id === chatId) onPick(null);
  };
  const file = (c: Chat, folderId: string | null) => void api.patchChat(c.id, { folder_id: folderId }).catch(say);

  // ----- the same, for several chats: one request each, side by side; the board pushes each row back as it lands.
  const byIds = (ids: string[]) => ids.map((id) => (chats ?? []).find((c) => c.id === id)).filter((c): c is Chat => Boolean(c));
  const fileMany = async (ids: string[], folderId: string | null) => {
    // Dropping an archived chat into a folder is "I want this back": it is reopened as it is filed.
    await Promise.all(byIds(ids).map((c) => api.patchChat(c.id, { folder_id: folderId, ...(c.archived_at ? { archived: false } : {}) }).catch(say)));
    clearSelection();
  };
  const archiveMany = async (ids: string[], on: boolean) => {
    const them = byIds(ids).filter((c) => Boolean(c.archived_at) !== on);
    await Promise.all(them.map((c) => api.patchChat(c.id, { archived: on }).catch(say)));
    if (on && chatId && ids.includes(chatId)) onPick(open.find((x) => !ids.includes(x.id))?.id ?? null);
    clearSelection();
  };

  // ----- actions on a folder
  const newFolder = async () => {
    const name = await dialog.ask({ title: "New folder", message: "A name for a group of chats, such as “Billing” or “Ideas”. It gets a colour of its own; change it from its heading.", input: { placeholder: "Folder name", required: true }, confirmLabel: "Create" });
    if (name) await api.createChatFolder(project.id, name).catch(say);
  };
  const renameFolder = async (f: ChatFolder) => {
    const name = await dialog.ask({ title: "Rename folder", input: { initial: f.name, required: true }, confirmLabel: "Rename" });
    if (name && name.trim() !== f.name) await api.patchChatFolder(f.id, { name: name.trim() }).catch(say);
  };
  const colorFolder = (f: ChatFolder, color: FolderColor | null) => void api.patchChatFolder(f.id, { color }).catch(say);
  const removeFolder = async (f: ChatFolder) => {
    if (!(await dialog.confirm({ title: `Remove the folder “${f.name}”?`, message: "Only the folder goes. The chats in it stay, unfiled.", confirmLabel: "Remove" }))) return;
    await api.deleteChatFolder(f.id).catch(say);
  };

  // ----- where a drag can land: a folder (filed there), the unfiled group (taken out), Archived (put away).
  type Target = { kind: "folder"; id: string } | { kind: "unfiled" } | { kind: "archived" };
  const targetOf = (groupId: string): Target | null =>
    groupId === "archived" ? { kind: "archived" } : groupId === "unfiled" || groupId === "all" ? { kind: "unfiled" } : folders.some((f) => f.id === groupId) ? { kind: "folder", id: groupId } : null;
  const dropOn = (groupId: string, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const ids = e.dataTransfer.getData(DRAG_TYPE).split(",").filter(Boolean);
    const t = targetOf(groupId);
    if (!ids.length || !t) return;
    if (t.kind === "archived") void archiveMany(ids, true);
    else void fileMany(ids, t.kind === "folder" ? t.id : null);
  };
  const dragProps = (groupId: string) =>
    targetOf(groupId)
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over !== groupId) setOver(groupId);
          },
          onDragLeave: (e: React.DragEvent) => {
            // Leaving for a child of the same group is not leaving.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === groupId ? null : o));
          },
          onDrop: (e: React.DragEvent) => dropOn(groupId, e),
        }
      : {};

  const dot = (color: FolderColor | null, cls = "h-2 w-2") => <span className={`${cls} shrink-0 rounded-full ${color ? FOLDER_BG[color] : "border border-ink-500"}`} />;

  // Rows in the order they are on screen, for Shift-click: computed as the groups are drawn.
  const shown: string[] = [];
  const pick = (c: Chat, e: React.MouseEvent) => {
    if (e.shiftKey && lastPicked.current && shown.includes(lastPicked.current)) {
      const [i, j] = [shown.indexOf(lastPicked.current), shown.indexOf(c.id)].sort((x, y) => x - y);
      setSelected((s) => new Set([...s, ...shown.slice(i, j + 1)]));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; });
      lastPicked.current = c.id;
      return;
    }
    lastPicked.current = c.id;
    clearSelection();
    onPick(c.id);
    setPop(null);
  };
  const tick = (c: Chat) => {
    setSelected((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; });
    lastPicked.current = c.id;
  };

  const row = (c: Chat) => {
    shown.push(c.id);
    const s = states.get(c.id);
    const active = c.id === chatId;
    const picking = pop?.kind === "folder" && pop.id === c.id;
    const checked = selected.has(c.id);
    return (
      <div
        key={c.id}
        draggable
        onDragStart={(e) => {
          const ids = checked ? [...selected] : [c.id];
          e.dataTransfer.setData(DRAG_TYPE, ids.join(","));
          e.dataTransfer.effectAllowed = "move";
        }}
        className={`group relative rounded-md ${checked ? "bg-amber/10 ring-1 ring-amber/40" : active ? "bg-ink-800" : "hover:bg-ink-850"}`}
      >
        <button className="block w-full min-w-0 cursor-pointer py-1.5 pr-2 pl-6 text-left" onClick={(e) => pick(c, e)} onDoubleClick={() => void rename(c)} title="Double-click to rename · Ctrl-click to select several · drag into a folder">
          <div className="flex items-center gap-1.5">
            {c.busy ? <span className="breathe h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title="Writing a reply" /> : null}
            <span className={`truncate text-[12px] leading-snug ${c.archived_at ? "text-ink-500" : active || checked ? "text-ink-100" : "text-ink-300"}`}>{c.title}</span>
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-ink-500">
            <span>{ago(c.updated_at)} · {cost(c.cost_usd)}</span>
            {s?.needsYou ? <span className="text-rose">{s.needsYou} waiting on you</span> : s?.working ? <span className="text-amber">{s.working} working</span> : null}
          </div>
        </button>
        {/* The tick box sits where the row's padding is; it shows on hover, and stays once ticked. */}
        <button
          className={`absolute top-2 left-1.5 flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-[3px] border text-[9px] leading-none transition-opacity ${checked ? "border-amber bg-amber text-ink-950 opacity-100" : "border-ink-500 text-transparent opacity-0 hover:border-ink-300 group-hover:opacity-100"} ${selected.size ? "opacity-100" : ""}`}
          onClick={(e) => { e.stopPropagation(); tick(c); }}
          title={checked ? "Take it out of the selection" : "Select it, to move or archive several at once"}
          aria-pressed={checked}
        >
          ✓
        </button>
        {/* The actions live in the top right corner and show on hover, so the row itself stays a title and a line. */}
        <div className={`absolute top-1 right-1 flex items-center gap-px rounded-md border border-ink-700/80 bg-ink-900/95 p-px transition-opacity ${picking ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"}`}>
          <button className={icon} title="Rename" onClick={() => void rename(c)}><PencilIcon /></button>
          {folders.length ? (
            <button data-pop-trigger className={`${icon} ${picking ? "bg-ink-700 text-ink-100" : ""}`} title="Move to a folder" onClick={() => setPop(picking ? null : { kind: "folder", id: c.id })}>
              <FolderIcon />
            </button>
          ) : null}
          {c.archived_at ? (
            <>
              <button className={`${icon} hover:text-amber`} title="Reopen: back in the list" onClick={() => void archive(c, false)}><RestoreIcon /></button>
              <button className={`${icon} hover:text-rust`} title="Delete for good" onClick={() => void remove(c)}><TrashIcon /></button>
            </>
          ) : (
            <button className={icon} title="Archive: moves under Archived; nothing is deleted" onClick={() => void archive(c, true)}><ArchiveIcon /></button>
          )}
        </div>
        {picking ? (
          <Popover onClose={closePop} className="top-7 right-1 w-48">
            <button className={popItem} onClick={() => { file(c, null); setPop(null); }}>
              {dot(null)}<span className="flex-1">No folder</span>{!c.folder_id ? <span className="text-ink-500">✓</span> : null}
            </button>
            {folders.map((f) => (
              <button key={f.id} className={popItem} onClick={() => { file(c, f.id); setPop(null); }}>
                {dot(f.color)}<span className="min-w-0 flex-1 truncate">{f.name}</span>{c.folder_id === f.id ? <span className="text-ink-500">✓</span> : null}
              </button>
            ))}
          </Popover>
        ) : null}
      </div>
    );
  };

  const group = (id: string, title: string, list: Chat[], extra?: { folder?: ChatFolder; tone?: string }) => {
    const shut = closed.has(id);
    const f = extra?.folder;
    const color = f?.color ?? null;
    const coloring = pop?.kind === "color" && pop.id === id;
    const tone = extra?.tone || (f ? "text-ink-100" : "text-ink-400");
    const lit = over === id;
    const droppable = Boolean(targetOf(id));
    return (
      <div key={id} className={`relative rounded-md pt-2 transition-colors ${lit ? "bg-amber/5 ring-1 ring-amber/60" : ""}`} {...dragProps(id)}>
        <div className="group/h flex items-center gap-1 pr-1.5 pl-2 pb-1">
          <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" onClick={() => toggle(id)} aria-expanded={!shut} title={shut ? "Show these chats" : "Hide these chats"}>
            <span className={`h-3.5 w-[3px] shrink-0 rounded-full ${color ? FOLDER_BG[color] : "bg-ink-600"}`} />
            <span className={`truncate text-[13px] font-bold tracking-tight ${tone}`}>{title}</span>
            <span className="font-mono text-[10.5px] text-ink-500">{list.length}</span>
            <span className="text-[9px] text-ink-600">{shut ? "▸" : "▾"}</span>
          </button>
          {f ? (
            <div className={`flex items-center gap-px transition-opacity ${coloring ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/h:opacity-100"}`}>
              <button data-pop-trigger className={`${icon} ${coloring ? "bg-ink-700" : ""}`} title={`Colour: ${color ? FOLDER_WORD[color] : "none"}. Click to change`} onClick={() => setPop(coloring ? null : { kind: "color", id })}>
                {dot(color, "h-2.5 w-2.5")}
              </button>
              <button className={icon} title="Rename the folder" onClick={() => void renameFolder(f)}><PencilIcon /></button>
              <button className={`${icon} hover:text-rust`} title="Remove the folder; its chats stay" onClick={() => void removeFolder(f)}><TrashIcon /></button>
            </div>
          ) : null}
        </div>
        {coloring && f ? (
          <Popover onClose={closePop} className="top-8 right-1.5 w-44">
            <div className="grid grid-cols-4 gap-1 p-1">
              {FOLDER_COLORS.map((c) => (
                <button key={c} className={`flex h-7 cursor-pointer items-center justify-center rounded hover:bg-ink-800 ${c === color ? "ring-1 ring-ink-300" : ""}`} title={FOLDER_WORD[c]} onClick={() => { colorFolder(f, c); setPop(null); }}>
                  {dot(c, "h-3.5 w-3.5")}
                </button>
              ))}
            </div>
            <button className={popItem} onClick={() => { colorFolder(f, null); setPop(null); }}>{dot(null)}No colour</button>
          </Popover>
        ) : null}
        {shut ? (
          lit ? <div className="px-3 pb-1 text-[11.5px] text-amber">Drop here</div> : null
        ) : list.length ? (
          <div className="space-y-0.5 px-1.5">{list.map(row)}</div>
        ) : (
          <div className="px-3 pb-1 text-[11.5px] text-ink-600">{droppable && lit ? "Drop here" : "Nothing here."}</div>
        )}
      </div>
    );
  };

  let groups: ReactElement[];
  if (groupBy === "status") {
    const needsYou = open.filter((c) => (states.get(c.id)?.needsYou ?? 0) > 0);
    const working = open.filter((c) => !needsYou.includes(c) && (c.busy || (states.get(c.id)?.working ?? 0) > 0));
    const quiet = open.filter((c) => !needsYou.includes(c) && !working.includes(c));
    groups = [
      group("needs-you", "Needs you", needsYou, { tone: needsYou.length ? "text-rose" : "" }),
      group("working", "Working", working, { tone: working.length ? "text-amber" : "" }),
      group("quiet", "Quiet", quiet),
      group("archived", "Archived", archived),
    ];
  } else {
    const unfiled = open.filter((c) => !c.folder_id || !folders.some((f) => f.id === c.folder_id));
    groups = [
      ...folders.map((f) => group(f.id, f.name, open.filter((c) => c.folder_id === f.id), { folder: f })),
      ...(folders.length ? [group("unfiled", "Not in a folder", unfiled)] : [group("all", "Chats", unfiled)]),
      group("archived", "Archived", archived),
    ];
  }

  const chosen = byIds([...selected]);
  const bulk = pop?.kind === "bulk";

  return (
    <aside className="flex shrink-0 flex-col bg-ink-900/80" style={{ width }}>
      <div className="space-y-2 px-3 pt-3">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1"><ProjectSwitch project={project} projects={projects} /></div>
          <button className={`${tiny} h-8 shrink-0 rounded-md border border-ink-700 px-2 text-[12px]`} onClick={onAddProject} title="Register another folder as a project">+</button>
        </div>
        <button
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-amber/50 bg-amber/10 px-2.5 py-1.5 text-[12.5px] font-medium text-amber transition-colors hover:bg-amber/15"
          onClick={() => { onPick(null); setPop(null); clearSelection(); }}
          title="Start a new chat about this project"
        >
          + New chat
        </button>
        <input className={`${inputCls} py-1! text-[12px]!`} placeholder="Find a chat…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-ink-500">Group by</span>
          {(["folders", "status"] as GroupBy[]).map((g) => (
            <button
              key={g}
              className={`cursor-pointer rounded px-1.5 py-px font-mono text-[10.5px] ${groupBy === g ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:text-ink-200"}`}
              onClick={() => pickGroup(g)}
            >
              {g}
            </button>
          ))}
          {groupBy === "folders" ? <button className={`${tiny} ml-auto`} onClick={() => void newFolder()} title="A new folder to file chats in">+ folder</button> : null}
        </div>
      </div>
      {/* The bar is z-20: the rise animation gives it a layer of its own, which would otherwise sit under the list and swallow its menu. */}
      {chosen.length ? (
        <div className="rise relative z-20 mx-2 mt-2 flex items-center gap-1 rounded-md border border-amber/40 bg-amber/10 py-1 pr-1 pl-2.5 text-[11.5px] text-ink-100">
          <span className="min-w-0 flex-1 truncate">{chosen.length} selected</span>
          {folders.length ? (
            <button data-pop-trigger className={`${icon} ${bulk ? "bg-ink-700 text-ink-100" : ""}`} title="Move them to a folder" onClick={() => setPop(bulk ? null : { kind: "bulk" })}><FolderIcon /></button>
          ) : null}
          {chosen.some((c) => !c.archived_at) ? <button className={icon} title="Archive them" onClick={() => void archiveMany([...selected], true)}><ArchiveIcon /></button> : null}
          {chosen.some((c) => c.archived_at) ? <button className={`${icon} hover:text-amber`} title="Reopen them" onClick={() => void archiveMany([...selected], false)}><RestoreIcon /></button> : null}
          <button className={icon} title="Clear the selection (Esc)" onClick={clearSelection}>×</button>
          {bulk ? (
            <Popover onClose={closePop} className="top-7 right-1 w-48">
              <button className={popItem} onClick={() => void fileMany([...selected], null)}>{dot(null)}<span className="flex-1">No folder</span></button>
              {folders.map((f) => (
                <button key={f.id} className={popItem} onClick={() => void fileMany([...selected], f.id)}>
                  {dot(f.color)}<span className="min-w-0 flex-1 truncate">{f.name}</span>
                </button>
              ))}
            </Popover>
          ) : null}
        </div>
      ) : null}
      <nav className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {chatId === null ? (
          <div className="mx-1.5 mt-2 rounded-md bg-ink-800 px-2 py-1.5">
            <div className="text-[12px] text-ink-100">New chat</div>
            <div className="font-mono text-[10px] text-ink-500">made with your first message</div>
          </div>
        ) : null}
        {chats === null ? <div className="px-3 pt-3 text-[12px] text-ink-500">Loading…</div> : groups}
        {chats && !all.length && q ? <div className="px-3 pt-3 text-[12px] text-ink-500">No chat is called that.</div> : null}
        <div className="px-3 pt-2"><ErrorLine error={error} /></div>
      </nav>
      {dialog.element}
    </aside>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Right: the work this chat started                                                                 */
/* ----------------------------------------------------------------------------------------------- */

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g;

/** The cards this chat made, with Claude's steps on each; the files they produced; the links mentioned. */
function ChatWork({ chatId, cards, messages, width }: { chatId: string | null; cards: TaskCard[]; messages: ChatMessage[]; width: number }) {
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const mine = useMemo(() => cards.filter((c) => c.chat_id === chatId && !c.archived_at).sort((a, b) => b.created_at.localeCompare(a.created_at)), [cards, chatId]);
  const files = useAttachments(mine.map((c) => c.id));
  const now = useTaskNow(mine.map((c) => c.id));
  const yours = useChatFiles(chatId, messages);
  const links = useMemo(() => {
    const seen = new Map<string, string>();
    const take = (text: string | null | undefined) => {
      for (const m of (text ?? "").matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:!?]+$/, "");
        if (!seen.has(url)) seen.set(url, url);
      }
    };
    for (const m of messages) if (m.role === "assistant" || m.role === "update") take(m.text);
    for (const c of mine) take(c.summary);
    return [...seen.keys()];
  }, [messages, mine]);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setShut((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const head = (id: string, title: string, n: number) => (
    <button className={`flex w-full cursor-pointer items-center gap-1.5 text-left hover:text-ink-300 ${section}`} onClick={() => toggle(id)}>
      <span className="w-2.5 text-[9px]">{shut.has(id) ? "▸" : "▾"}</span>
      <span>{title}</span>
      <span className="font-mono text-ink-600">{n}</span>
    </button>
  );

  // One list: what you attached to the chat and what its cards produced, each with its own address and
  // the call that opens it on this computer (D351): a chat file and a card's file live in different tables.
  const all = [
    ...yours.map((f) => ({ id: f.id, name: f.name, media_type: f.media_type, bytes: f.bytes, description: null as string | null, url: api.chatFileUrl(f.id), from: "you", open: (w: Reveal) => api.openChatFile(f.id, w) })),
    ...files.map((f) => ({ id: f.id, name: f.name, media_type: f.media_type, bytes: f.bytes, description: f.description, url: api.attachmentUrl(f.id), from: "a card", open: (w: Reveal) => api.openAttachment(f.id, w) })),
  ];
  const images = all.filter((f) => attachmentKind(f.media_type) === "image");
  const docs = all.filter((f) => attachmentKind(f.media_type) !== "image");
  // The button that was pressed glows for a moment: the file opens in another window, so the page
  // itself shows nothing happening. A failure (the file is gone) is said under the list.
  const [lit, setLit] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const reveal = (f: (typeof all)[number], where: Reveal) => {
    setLit(`${f.id}:${where}`);
    setOpenError(null);
    window.setTimeout(() => setLit((cur) => (cur === `${f.id}:${where}` ? null : cur)), 700);
    f.open(where).catch((e: unknown) => setOpenError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <aside className="flex shrink-0 flex-col overflow-y-auto bg-ink-900/60" style={{ width }}>
      {head("tasks", "Tasks from this chat", mine.length)}
      {shut.has("tasks") ? null : mine.length ? (
        <div className="space-y-2 px-3 pb-2">
          {mine.map((c) => <WorkCard key={c.id} card={c} byId={byId} now={now.get(c.id) ?? null} children={cards.filter((x) => x.parent_id === c.id && !x.archived_at)} />)}
        </div>
      ) : (
        <p className="px-3 pb-2 text-[12px] leading-relaxed text-ink-500">
          {chatId ? "Nothing yet. Ask for a lookup, a fix or a feature and the card it makes shows up here, with Claude's steps as it works." : "Send a message to start."}
        </p>
      )}

      {head("files", "Files", all.length)}
      {shut.has("files") ? null : all.length ? (
        <div className="space-y-2 px-3 pb-2">
          {images.length ? (
            <div className="grid grid-cols-3 gap-1.5">
              {images.map((f) => (
                <div key={f.id} className="group relative aspect-square overflow-hidden rounded-md border border-ink-700 bg-ink-950 transition-colors hover:border-ink-500">
                  <a href={f.url} target="_blank" rel="noreferrer" className="block h-full w-full" title={`${f.name} · from ${f.from}${f.description ? `\n${f.description}` : ""}`}>
                    <img src={f.url} alt={f.description ?? f.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
                  </a>
                  {/* A shade from the bottom, so the icons read on any picture. */}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-ink-950/85 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
                  <div className="absolute bottom-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <FileActions lit={lit} id={f.id} onOpen={(w) => reveal(f, w)} dark />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {docs.map((f) => (
            <div key={f.id} className="group flex items-center gap-2 rounded-md border border-ink-700 pl-2.5 pr-1.5 py-1 transition-colors hover:border-amber/50 hover:bg-amber/5">
              <a href={f.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-2 py-0.5" title={`Open in the browser, or download ${f.name} (from ${f.from})`}>
                <span className="font-mono text-[10px] uppercase text-ink-500">{f.name.split(".").pop()}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-100">{f.name}</span>
                {f.from === "you" ? <span className="font-mono text-[9.5px] uppercase text-ink-600">yours</span> : null}
              </a>
              {/* One fixed slot: the size fades out and the two icons fade in over it, so nothing jumps. */}
              <span className="relative h-6 w-[52px] shrink-0">
                <span className="absolute inset-y-0 right-1 flex items-center font-mono text-[10px] text-ink-500 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">{bytes(f.bytes)}</span>
                <span className="absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <FileActions lit={lit} id={f.id} onOpen={(w) => reveal(f, w)} />
                </span>
              </span>
            </div>
          ))}
          {openError ? <p className="px-1 text-[11.5px] text-rust">{openError}</p> : null}
        </div>
      ) : (
        <p className="px-3 pb-2 text-[12px] leading-relaxed text-ink-500">Files you attach to the chat, and the screenshots, spreadsheets and PDFs its cards make, land here.</p>
      )}

      {head("links", "Links", links.length)}
      {shut.has("links") ? null : links.length ? (
        <div className="space-y-1 px-3 pb-3">
          {links.map((u) => {
            let host = u;
            let path = "";
            try {
              const p = new URL(u);
              host = p.host;
              path = `${p.pathname}${p.search}`.replace(/\/$/, "");
            } catch {
              // not a URL the browser understands: shown whole
            }
            return (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="block truncate rounded-md px-2 py-1 text-[12px] text-ink-300 hover:bg-ink-850 hover:text-amber" title={u}>
                <span className="text-ink-100">{host}</span>
                <span className="text-ink-500">{path}</span>
              </a>
            );
          })}
        </div>
      ) : (
        <p className="px-3 pb-3 text-[12px] leading-relaxed text-ink-500">Web addresses Claude or its cards mention are collected here.</p>
      )}
    </aside>
  );
}

type Reveal = "file" | "folder";

/**
 * Open on this computer, and show in its folder: two small icon buttons, shown on hover over a file.
 * They act on the computer the board runs on, which is the one in front of you when the board is
 * local (its normal case); the browser link beside them downloads the file anywhere.
 */
function FileActions({ id, lit, onOpen, dark = false }: { id: string; lit: string | null; onOpen: (where: Reveal) => void; dark?: boolean }) {
  const base = `flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors ${dark ? "bg-ink-950/70 text-ink-200 backdrop-blur-sm hover:bg-ink-950 hover:text-amber" : "text-ink-400 hover:bg-ink-800 hover:text-amber"}`;
  const glow = (where: Reveal) => (lit === `${id}:${where}` ? " !text-amber" : "");
  return (
    <div className="flex items-center gap-0.5">
      <button className={`${base}${glow("file")}`} title="Open with its own app on this computer" onClick={(e) => { e.preventDefault(); onOpen("file"); }}>
        <OpenIcon />
      </button>
      <button className={`${base}${glow("folder")}`} title="Show in its folder" onClick={(e) => { e.preventDefault(); onOpen("folder"); }}>
        <FolderIcon />
      </button>
    </div>
  );
}

/** The files you attached to this chat that have been sent. Re-read when the messages change: a new message may carry new ones. */
function useChatFiles(chatId: string | null, messages: ChatMessage[]): ChatFile[] {
  const [files, setFiles] = useState<ChatFile[]>([]);
  const sent = messages.filter((m) => m.meta.files?.length).length;
  useEffect(() => {
    if (!chatId) {
      setFiles([]);
      return;
    }
    let stale = false;
    void api.chatFiles(chatId).then((all) => !stale && setFiles(all.filter((f) => f.message_id !== null)), () => {});
    return () => {
      stale = true;
    };
  }, [chatId, sent]);
  return files;
}

/** The attachments of these cards, together and live: a card that saves a file shows it here at once. */
function useAttachments(taskIds: string[]): Attachment[] {
  const key = taskIds.join(",");
  const [files, setFiles] = useState<Attachment[]>([]);
  useEffect(() => {
    if (!key) {
      setFiles([]);
      return;
    }
    let stale = false;
    void Promise.all(key.split(",").map((id) => api.attachments(id).catch(() => [] as Attachment[]))).then((lists) => {
      if (!stale) setFiles(lists.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)));
    });
    return () => {
      stale = true;
    };
  }, [key]);
  useWs((m) => {
    if (m.type === "attachment.added" && key.split(",").includes(m.attachment.task_id)) {
      setFiles((prev) => (prev.some((f) => f.id === m.attachment.id) ? prev : [m.attachment, ...prev]));
    }
  });
  return files;
}

/** A verb for the tool a run is using, so the "now" line reads as a sentence. */
const TOOL_WORD: Record<string, string> = {
  Read: "reading", Edit: "editing", Write: "writing", MultiEdit: "editing", Bash: "running", PowerShell: "running",
  Grep: "searching", Glob: "looking for", WebFetch: "fetching", WebSearch: "searching the web for", Task: "delegating", TodoWrite: "planning its steps",
};
const toolWord = (name: string) => TOOL_WORD[name] ?? (name.startsWith("mcp__board__") ? `board: ${name.slice("mcp__board__".length).replace(/_/g, " ")}` : name.startsWith("mcp__") ? `using ${name.split("__")[1] ?? name}` : name);

/** What a run is doing right now, read off one transcript event: its latest tool call, or the first line it wrote. */
function nowLine(ev: EventRow): string | null {
  if (ev.type !== "assistant") return null;
  const p = ev.payload as { message?: { content?: unknown } };
  const c = p?.message?.content;
  const blocks = (Array.isArray(c) ? c : typeof c === "string" ? [{ type: "text", text: c }] : []) as { type: string; text?: string; name?: string; input?: unknown }[];
  for (const b of [...blocks].reverse()) {
    if (b.type === "tool_use") return `${toolWord(b.name ?? "tool")} ${inputSummary(b.name ?? "", b.input).slice(0, 140)}`.trim();
    if (b.type === "text" && b.text?.trim()) return b.text.trim().split("\n")[0]!.slice(0, 140);
  }
  return null;
}

/**
 * The latest "now" line per card, kept from the transcript events the socket already pushes: no
 * request, no second copy of the transcript. Empty until a card's next event (D346).
 */
function useTaskNow(ids: string[]): Map<string, string> {
  const key = ids.join(",");
  const [now, setNow] = useState<Map<string, string>>(() => new Map());
  useEffect(() => setNow(new Map()), [key]);
  useWs((m) => {
    if (m.type !== "event" || !key.split(",").includes(m.taskId)) return;
    const line = nowLine(m.event);
    if (line) setNow((prev) => new Map(prev).set(m.taskId, line));
  });
  return now;
}

/** One card from this chat: where it is, what it is doing, Claude's steps on it, and what it waits for. Opens on click. */
function WorkCard({ card, byId, now, children }: { card: TaskCard; byId: Map<string, TaskCard>; now: string | null; children: TaskCard[] }) {
  const { pending } = useAppData();
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(() => card.status !== "done");
  const [commands, setCommands] = useState(false);
  const waiting = pending.filter((a) => a.task_id === card.id);
  const asking = waiting.some(isQuestion);
  const live = card.status === "running" || card.status === "planning";
  const steps = liveChecklist(card.checklist);
  const sum = checklistSummary(card.checklist);
  const needsSwitch = card.status === "failed" && card.blocked?.needs === "supervised" && card.mode === "autonomous";
  const rose = waiting.length > 0;
  return (
    <div className={`rounded-lg border ${rose ? "border-rose/50 bg-rose/5" : "border-ink-700 bg-ink-850/60"}`}>
      <button className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="w-2.5 shrink-0 text-[9px] text-ink-500">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{card.title}</span>
        <StatusPill card={card} asking={asking} waits={waitingOn(card, byId).length > 0} />
      </button>
      {!open && sum ? (
        <div className="px-2.5 pb-2">
          <div className="h-[3px] overflow-hidden rounded-full bg-ink-700">
            <div className={`h-full rounded-full transition-[width] duration-500 ${sum.done === sum.total ? "bg-moss" : "bg-amber"}`} style={{ width: `${Math.round((sum.done / sum.total) * 100)}%` }} />
          </div>
        </div>
      ) : null}
      {open ? (
        <div className="space-y-2 border-t border-ink-800/70 px-2.5 py-2">
          {/* Where it is in its pipeline, and what it cost so far. */}
          <div className="flex items-center gap-2 overflow-hidden" title={pipelineLine(card.pipeline, modelLabel)}>
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"><StageDots card={card} /></div>
            {card.cost_usd > 0 ? <span className="shrink-0 font-mono text-[10.5px] text-ink-500">{cost(card.cost_usd)}</span> : null}
          </div>
          {/* What it is doing this minute, while it runs: its latest tool call or sentence. */}
          {live && now ? (
            <div className="flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-300">
              <span className="breathe mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
              <span className="min-w-0 truncate" title={now}>{now}</span>
            </div>
          ) : null}
          {card.summary && IN_PROGRESS.has(card.status) ? <div className="text-[11.5px] leading-snug text-ink-400">{card.summary}</div> : null}
          {steps.length ? (
            <ol className="space-y-0.5">
              {steps.map((x) => (
                <li key={x.id} className={`flex items-start gap-2 text-[12px] leading-snug ${x.status === "completed" ? "text-ink-500" : x.status === "in_progress" ? "text-ink-100" : "text-ink-300"}`}>
                  <span className={`mt-px w-3.5 shrink-0 text-center ${x.status === "completed" ? "text-moss" : x.status === "in_progress" ? "text-amber" : "text-ink-600"}`}>
                    {x.status === "completed" ? "✓" : x.status === "in_progress" ? <span className={live ? "breathe" : ""}>▸</span> : "○"}
                  </span>
                  <span className={x.status === "completed" ? "line-through decoration-ink-600" : ""}>{x.status === "in_progress" && x.doing ? x.doing : x.text}</span>
                </li>
              ))}
            </ol>
          ) : card.status === "queued" ? (
            <div className="text-[11.5px] text-ink-500">Waiting for its turn.</div>
          ) : live && !now && !card.summary ? (
            <div className="text-[11.5px] text-ink-500">Starting up…</div>
          ) : null}
          {/* Done, or ready for review: the one-line result Claude posted; the whole report is a click away. */}
          {(card.status === "done" || card.status === "review") && card.summary ? (
            <div className="rounded-md border border-ink-800 bg-ink-900/60 px-2 py-1.5">
              <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-500">Result</div>
              <div className="line-clamp-4 text-[12px] leading-snug text-ink-200">{card.summary}</div>
            </div>
          ) : null}
          {children.length ? (
            <div>
              <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-500">Subtasks</div>
              <ul className="space-y-0.5">
                {children.map((k) => (
                  <li key={k.id} className="flex items-center gap-2">
                    <button className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12px] text-ink-300 hover:text-ink-100" onClick={() => navigate({ taskId: k.id })} title={k.title}>{k.title}</button>
                    <StatusPill card={k} asking={false} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {waiting.map((a) => (isQuestion(a) ? <QuestionCard key={a.id} a={a} focused /> : <ToolApproval key={a.id} a={a} />))}
          {card.status !== "backlog" && card.status !== "queued" ? (
            <details className="group/cmd" onToggle={(e) => setCommands((e.currentTarget as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-[11px] text-ink-400 hover:text-ink-200">Commands it ran, runs or waits to run</summary>
              <div className="mt-1"><CommandList taskId={card.id} compact enabled={commands} /></div>
            </details>
          ) : null}
          {card.status === "failed" ? <div className="line-clamp-3 font-mono text-[11px] text-rust">{card.blocked?.reason ?? card.error ?? "It stopped."}</div> : null}
          {card.status === "review" ? <div className="text-[11.5px] text-ink-400">Ready for your review: open it to look at the work and approve it.</div> : null}
          <div className="flex items-center justify-end gap-1.5">
            {card.status === "backlog" ? <Button size="sm" variant="go" busy={busy} title="Queue it now" onClick={() => run(() => api.queue(card.id))}>▶ Start</Button> : null}
            {IN_PROGRESS.has(card.status) ? <Button size="sm" variant="ghost" busy={busy} onClick={() => run(() => api.stop(card.id))}>stop</Button> : null}
            {card.status === "failed" && !needsSwitch ? <Button size="sm" busy={busy} title="Carry on from the stage that failed" onClick={() => run(() => api.retry(card.id))}>Retry</Button> : null}
            <Button size="sm" onClick={() => navigate({ taskId: card.id })}>open</Button>
          </div>
          <ErrorLine error={error} />
        </div>
      ) : null}
    </div>
  );
}
