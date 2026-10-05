import { useCallback, useEffect, useState } from "react";
import type { Chat } from "../../../../server/src/types.ts";
import { api, type ProjectWithGit } from "../../lib/api.ts";
import { navigate } from "../../lib/router.ts";
import { ago, cost } from "../../lib/format.ts";
import { useAsk } from "../Ask.tsx";
import { useEscape } from "../ui.tsx";
import { ChatThread } from "./ChatThread.tsx";
import { useChats } from "./useChats.ts";

/**
 * Talk to Claude about the project: ask how something works, plan a feature, have it make and run
 * task cards — a lookup, a fix — with the models you name, follow them live, and get their results
 * back here. It reads the code itself and leaves changing anything to a card. Slides in from the
 * right; the board stays usable. The AI Manager tab shows the same chats full-screen.
 */
export function ChatPanel({ project, onClose }: { project: ProjectWithGit; onClose: () => void }) {
  const chats = useChats(project.id);
  // undefined: nothing chosen yet, so the newest chat opens; null: a new chat, made with its first message.
  const [chatId, setChatId] = useState<string | null | undefined>(undefined);
  const [listOpen, setListOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  const chat = chats?.find((c) => c.id === chatId) ?? null;
  const open = (chats ?? []).filter((c) => !c.archived_at);
  const archived = (chats ?? []).filter((c) => c.archived_at);

  // Open the most recent chat when the panel opens (or the project changes).
  useEffect(() => {
    if (chats && chatId === undefined) setChatId(open[0]?.id ?? null);
  }, [chats, chatId]);
  useEffect(() => setChatId(undefined), [project.id]);

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 180);
  }, [onClose]);
  // Esc closes one thing at a time: the chat list first, then the panel — and only when nothing is open on top of it.
  useEscape(() => (listOpen ? setListOpen(false) : close()));

  const say = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const dialog = useAsk();
  // The board's own dialog, not confirm(): the browser's is dismissed unseen in embedded browsers (D193).
  const remove = async (c: Chat) => {
    if (!(await dialog.confirm({ title: `Delete “${c.title}” for good?`, message: "The chat and its messages are removed. Cards it made stay.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.deleteChat(c.id);
      if (c.id === chatId) setChatId(null);
    } catch (e) {
      say(e);
    }
  };
  const archive = (c: Chat, on: boolean) => {
    setLeaving((s) => new Set(s).add(c.id));
    setTimeout(() => {
      void api.patchChat(c.id, { archived: on }).catch(say).finally(() => setLeaving((s) => { const n = new Set(s); n.delete(c.id); return n; }));
      if (on && c.id === chatId) setChatId(open.find((x) => x.id !== c.id)?.id ?? null);
    }, 170);
  };

  return (
    <aside
      className={`fixed inset-y-0 right-0 z-30 flex w-[460px] max-w-full flex-col border-l border-ink-700 bg-ink-900 xl:w-[540px] kb-raise ${closing ? "slide-out-right" : "slide-in-right"}`}
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
        <button
          className="cursor-pointer rounded-md border border-ink-700 px-2 py-0.5 text-[12px] text-ink-300 hover:border-amber/60 hover:text-amber"
          onClick={() => navigate({ view: "ai-manager", projectId: project.id, taskId: null })}
          title="Open this chat full-screen in the AI Manager: your chats on the left, the work they started on the right"
        >
          ⤢ AI Manager
        </button>
        <button className="cursor-pointer rounded-md border border-ink-700 px-2 py-0.5 text-[12px] text-ink-300 hover:border-amber/60 hover:text-amber" onClick={() => { setChatId(null); setListOpen(false); }}>
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
                        <button className="cursor-pointer font-mono text-[10.5px] text-ink-500 hover:text-rust" onClick={() => void remove(c)}>
                          delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {error ? <div className="mt-3 px-1 text-[12px] text-rust">{error}</div> : null}
          </div>
        ) : null}

        {chatId === undefined ? null : <ChatThread project={project} chats={chats} chatId={chatId} onChatId={setChatId} />}
      </div>
      {dialog.element}
    </aside>
  );
}
