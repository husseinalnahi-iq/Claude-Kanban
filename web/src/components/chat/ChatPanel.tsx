import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Chat, ChatMessage, Effort } from "../../../../server/src/types.ts";
import { effortsFor, useClaudeModels } from "../../lib/claudeModels.ts";
import { ClaudeModelPicker, EffortSelect } from "../ClaudeModelPicker.tsx";
import { api, type ProjectWithGit } from "../../lib/api.ts";
import { useWs, watchChat } from "../../lib/ws.ts";
import { navigate } from "../../lib/router.ts";
import { useAppData } from "../../lib/store.tsx";
import { Markdown } from "../../lib/markdown.tsx";
import { ago, cost } from "../../lib/format.ts";

const STARTERS = [
  "What does this project do, in plain words?",
  "What's on the board right now, and what should I do next?",
  "I want a new feature. Help me write the task.",
  "Where would I change the page title?",
];

/** A project's chats, live. */
function useChats(projectId: string) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  useEffect(() => {
    setChats(null);
    void api.chats(projectId).then(setChats, () => setChats([]));
  }, [projectId]);
  useWs((m) => {
    if (m.type === "chat.updated" && m.chat.project_id === projectId) {
      setChats((prev) => {
        const list = prev ?? [];
        const rest = list.filter((c) => c.id !== m.chat.id);
        return [m.chat, ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      });
    } else if (m.type === "chat.deleted" && m.project_id === projectId) {
      setChats((prev) => prev?.filter((c) => c.id !== m.id) ?? prev);
    }
  });
  return chats;
}

function CardChips({ m }: { m: ChatMessage }) {
  const [started, setStarted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="rise space-y-1.5">
      {m.meta.cards!.map((c) => (
        <div key={`${c.id}-${c.action}`} className="flex items-center gap-2 rounded-lg border border-amber/40 bg-amber/5 px-2.5 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-amber/80">{c.action}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{c.title}</span>
          <button className="cursor-pointer rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 hover:border-ink-400 hover:text-ink-100" onClick={() => navigate({ taskId: c.id })}>
            open
          </button>
          {c.action === "created" && !started.has(c.id) ? (
            <button
              className="cursor-pointer rounded border border-amber/50 px-1.5 py-px font-mono text-[10.5px] text-amber hover:bg-amber/10"
              title="Queue it now"
              onClick={() => void api.queue(c.id).then(() => setStarted((s) => new Set(s).add(c.id)), (e: Error) => setError(e.message))}
            >
              start
            </button>
          ) : null}
        </div>
      ))}
      {error ? <div className="text-[11.5px] text-rust">{error}</div> : null}
    </div>
  );
}

function MessageRow({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="rise flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-amber/15 px-3.5 py-2 text-[13px] leading-relaxed text-ink-100 whitespace-pre-wrap">{m.text}</div>
      </div>
    );
  }
  if (m.role === "tool") {
    if (m.meta.cards?.length) return <CardChips m={m} />;
    return <div className="rise pl-1 font-mono text-[11px] text-ink-500">· {m.text}</div>;
  }
  if (m.role === "error") return <div className="rise rounded-lg border border-rust/40 bg-rust/10 px-3 py-2 text-[12.5px] text-rust">{m.text}</div>;
  return <Markdown text={m.text} className="rise text-[13px]" />;
}

/**
 * Talk to Claude about the project: ask how something works, plan a feature, and have it write the
 * task cards. It reads the code but never changes it. Slides in from the right; the board stays usable.
 */
export function ChatPanel({ project, onClose }: { project: ProjectWithGit; onClose: () => void }) {
  const { settings } = useAppData();
  const claude = useClaudeModels();
  const chats = useChats(project.id);
  const [chatId, setChatId] = useState<string | null>(null);
  // What a new chat will run on. An empty chat has no row to patch, so the choice waits here.
  const [pending, setPending] = useState<{ model: string; effort: Effort } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [text, setText] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const chat = chats?.find((c) => c.id === chatId) ?? null;
  const open = (chats ?? []).filter((c) => !c.archived_at);
  const archived = (chats ?? []).filter((c) => c.archived_at);

  // Open the most recent chat when the panel opens (or the project changes).
  useEffect(() => {
    if (chats && !chatId) setChatId(open[0]?.id ?? null);
  }, [chats, chatId]);
  useEffect(() => setChatId(null), [project.id]);

  useEffect(() => {
    watchChat(chatId);
    setStreaming("");
    setMessages([]);
    if (chatId) void api.chatMessages(chatId).then(setMessages, () => {});
    return () => watchChat(null);
  }, [chatId]);

  useWs((m) => {
    if (m.type === "chat.message" && m.message.chat_id === chatId) setMessages((prev) => (prev.some((x) => x.id === m.message.id) ? prev : [...prev, m.message]));
    else if (m.type === "chat.delta" && m.chatId === chatId) setStreaming(m.text);
  });

  // Follow the conversation as it grows, unless you scrolled up to read.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 180);
  }, [onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !listOpen && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [close, listOpen]);
  useEffect(() => input.current?.focus(), [chatId]);

  // What this chat runs on: its own row once it exists, otherwise the choice made here, else Settings.
  const model = chat?.model ?? pending?.model ?? settings?.chatModel ?? "claude-sonnet-5";
  const effort = (chat?.effort ?? pending?.effort ?? settings?.chatEffort ?? "medium") as Effort;
  const setModel = (id: string) => {
    const next = effortsFor(id, claude.result);
    const keep = next.efforts.includes(effort) ? effort : next.efforts[0] ?? effort;
    if (chat) void api.patchChat(chat.id, { model: id, ...(keep === effort ? {} : { effort: keep }) });
    else setPending({ model: id, effort: keep });
  };
  const setEffort = (e: Effort) => (chat ? void api.patchChat(chat.id, { effort: e }) : setPending({ model, effort: e }));

  const newChat = async () => {
    const c = await api.createChat(project.id);
    if (pending) await api.patchChat(c.id, pending).catch(() => {});
    setChatId(c.id);
    setListOpen(false);
  };
  const send = async (value = text) => {
    const t = value.trim();
    if (!t) return;
    setError(null);
    try {
      let id = chatId;
      if (!id) {
        const c = await api.createChat(project.id);
        id = c.id;
        // The chat row exists only now, so the model picked before the first message lands here.
        if (pending) await api.patchChat(c.id, pending).catch(() => {});
        setChatId(c.id);
        watchChat(c.id);
      }
      setText("");
      pinned.current = true;
      await api.sendChat(id, t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setText(t);
    }
  };
  const archive = (c: Chat, on: boolean) => {
    setLeaving((s) => new Set(s).add(c.id));
    setTimeout(() => {
      void api.patchChat(c.id, { archived: on }).finally(() => setLeaving((s) => { const n = new Set(s); n.delete(c.id); return n; }));
      if (on && c.id === chatId) setChatId(open.find((x) => x.id !== c.id)?.id ?? null);
    }, 170);
  };

  return (
    <aside
      className={`fixed inset-y-0 right-0 z-30 flex w-[460px] max-w-full flex-col border-l border-ink-700 bg-ink-900 xl:w-[540px] shadow-2xl shadow-black/50 ${closing ? "slide-out-right" : "slide-in-right"}`}
      aria-label="Chat"
    >
      <header className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-ink-850"
          onClick={() => setListOpen((v) => !v)}
          title="Your chats about this project"
        >
          <span className="min-w-0 flex-1">
            <span className="block min-w-0 truncate text-[14px] font-semibold text-ink-100">{chat?.title ?? "New chat"}</span>
            <span className="block min-w-0 truncate text-[10.5px] text-ink-500">{project.name}</span>
          </span>
          <span className={`text-[10px] text-ink-500 transition-transform ${listOpen ? "rotate-180" : ""}`}>▾</span>
        </button>
        {chat?.busy ? <span className="breathe h-1.5 w-1.5 rounded-full bg-amber" title="Writing a reply" /> : null}
        {chat ? <span className="font-mono text-[10.5px] text-ink-500" title="What this chat has cost">{cost(chat.cost_usd)}</span> : null}
        <button className="cursor-pointer rounded-md border border-ink-700 px-2 py-0.5 text-[12px] text-ink-300 hover:border-amber/60 hover:text-amber" onClick={() => void newChat()}>
          + New
        </button>
        <button className="cursor-pointer px-1 text-[18px] leading-none text-ink-400 hover:text-ink-100" onClick={close} title="Close (Esc)">×</button>
      </header>

      <div className="relative min-h-0 flex-1">
        {listOpen ? (
          <div className="fade-in absolute inset-0 z-10 overflow-y-auto bg-ink-900/97 px-3 py-3 backdrop-blur-sm">
            <div className="mb-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-500">{project.name} · chats</div>
            <div className="space-y-1">
              {open.map((c) => (
                <div key={c.id} className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${c.id === chatId ? "bg-ink-800" : "hover:bg-ink-850"} ${leaving.has(c.id) ? "fade-out" : "rise"}`}>
                  <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => { setChatId(c.id); setListOpen(false); }}>
                    <div className="truncate text-[12.5px] text-ink-100">{c.title}</div>
                    <div className="font-mono text-[10px] text-ink-500">{ago(c.updated_at)} · {cost(c.cost_usd)}</div>
                  </button>
                  <button className="cursor-pointer font-mono text-[10.5px] text-ink-500 opacity-0 transition-opacity hover:text-ink-100 group-hover:opacity-100" onClick={() => archive(c, true)} title="Hide it; nothing is deleted">
                    archive
                  </button>
                </div>
              ))}
              {!open.length ? <div className="px-2 py-3 text-[12px] text-ink-500">No chats yet. Press + New, or just type below.</div> : null}
            </div>
            {archived.length ? (
              <div className="mt-4">
                <button className="cursor-pointer px-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-500 hover:text-ink-300" onClick={() => setShowArchived((v) => !v)}>
                  {showArchived ? "▾" : "▸"} Archived · {archived.length}
                </button>
                {showArchived ? (
                  <div className="mt-1 space-y-1">
                    {archived.map((c) => (
                      <div key={c.id} className={`flex items-center gap-2 rounded-md px-2 py-1.5 opacity-70 hover:opacity-100 ${leaving.has(c.id) ? "fade-out" : "rise"}`}>
                        <button className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12.5px] text-ink-300" onClick={() => { setChatId(c.id); setListOpen(false); }}>{c.title}</button>
                        <button className="cursor-pointer font-mono text-[10.5px] text-ink-400 hover:text-amber" onClick={() => archive(c, false)}>restore</button>
                        <button
                          className="cursor-pointer font-mono text-[10.5px] text-ink-500 hover:text-rust"
                          onClick={() => confirm(`Delete “${c.title}” for good?`) && void api.deleteChat(c.id).then(() => c.id === chatId && setChatId(null))}
                        >
                          delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          ref={scroller}
          className="h-full space-y-3 overflow-y-auto px-4 py-4"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {!messages.length && !streaming ? (
            <div className="rise mx-auto mt-8 max-w-sm text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber/15 text-[18px] text-amber">✦</div>
              <div className="text-[14px] font-medium text-ink-100">Ask about {project.name}</div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
                Claude reads the project to answer, and can turn what you want into task cards. It never changes code from here.
              </p>
              <div className="mt-4 space-y-1.5 text-left">
                {STARTERS.map((s, i) => (
                  <button
                    key={s}
                    className="rise group flex w-full cursor-pointer items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-left text-[12.5px] text-ink-300 transition-colors hover:border-amber/50 hover:bg-amber/5 hover:text-ink-100"
                    style={{ animationDelay: `${80 + i * 50}ms` }}
                    onClick={() => void send(s)}
                  >
                    <span className="min-w-0 flex-1">{s}</span>
                    <span className="shrink-0 text-[11px] text-ink-600 transition-colors group-hover:text-amber">→</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {messages.map((m) => <MessageRow key={m.id} m={m} />)}
          {streaming ? <Markdown text={streaming} className="text-[13px] after:ml-0.5 after:inline-block after:h-3.5 after:w-1.5 after:animate-pulse after:bg-amber after:align-middle after:content-['']" /> : null}
          {chat?.busy && !streaming ? (
            <div className="flex items-center gap-1.5 pl-1 text-[11.5px] text-ink-500">
              <span className="breathe h-1.5 w-1.5 rounded-full bg-amber" /> thinking…
            </div>
          ) : null}
        </div>
      </div>

      <footer className="border-t border-ink-800 px-3 pb-3 pt-2.5">
        {error ? <div className="mb-2 text-[12px] text-rust">{error}</div> : null}
        <div className="rounded-xl border border-ink-700 bg-ink-850 focus-within:border-amber/50">
          <textarea
            ref={input}
            rows={2}
            className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] text-ink-100 outline-none placeholder:text-ink-500"
            placeholder={`Ask about ${project.name}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!chat?.busy) void send();
              }
            }}
          />
          <div className="flex items-center gap-1.5 border-t border-ink-800/70 px-2 py-1.5">
            {/* The same pickers the pipeline uses, and they work before the first message: an empty
                chat has no row to patch yet, so the choice is held here and used when it is created. */}
            <div className="w-[148px] shrink-0" title="Model for this chat">
              <ClaudeModelPicker value={model} onChange={setModel} models={settings?.models ?? []} />
            </div>
            {effortsFor(model, claude.result).none ? null : (
              <div className="w-[104px] shrink-0">
                <EffortSelect model={model} value={effort} onChange={setEffort} />
              </div>
            )}
            <span className="ml-auto hidden truncate pr-1 text-[10.5px] text-ink-600 xl:inline">Enter to send · Shift+Enter new line</span>
            {chat?.busy ? (
              <button className="shrink-0 cursor-pointer rounded-md border border-rust/50 px-2.5 py-1.5 text-[12px] text-rust hover:bg-rust/10" onClick={() => chat && void api.stopChat(chat.id)}>
                ■ Stop
              </button>
            ) : (
              <button
                className="shrink-0 cursor-pointer rounded-md bg-amber px-3 py-1.5 text-[12px] font-semibold text-ink-950 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!text.trim()}
                onClick={() => void send()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </footer>
    </aside>
  );
}
