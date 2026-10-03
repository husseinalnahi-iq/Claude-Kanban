import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Chat, ChatFile, ChatMessage, Effort, Mode } from "../../../../server/src/types.ts";
import { ANTHROPIC_PROVIDER_ID, attachmentKind } from "../../../../server/src/types.ts";
import { effortsFor, useClaudeModels } from "../../lib/claudeModels.ts";
import { EffortSelect } from "../ClaudeModelPicker.tsx";
import { ChatModelPicker } from "./ChatModelPicker.tsx";
import { api, type ProjectWithGit } from "../../lib/api.ts";
import { useWs, useWsReconnect, watchChat } from "../../lib/ws.ts";
import { useAppData } from "../../lib/store.tsx";
import { Markdown } from "../../lib/markdown.tsx";
import { useTaskCards } from "../../views/Board.tsx";
import { connectedSystemIn } from "../../../../server/src/engine/connected.ts";
import { PaperclipIcon, Switch } from "../ui.tsx";
import { autonomousBlocked } from "../forms.tsx";
import { ChatBoard, ChatCards, ChatTray, ChatUpdateRow } from "./ChatCard.tsx";
import { CacheStrip } from "./CacheStrip.tsx";

const STARTERS = [
  "What does this project do, in plain words?",
  "What is each task doing right now, and is any waiting on me?",
  "I want a new feature. Help me write the task.",
  "Where would I change the page title?",
];

/** What you were typing, per project, so closing the panel (or Esc) never loses it. */
const drafts = new Map<string, string>();

/**
 * The one-line explanation of the connectors switch, shown under the box until you dismiss it. Per
 * machine, like the welcome: the switch itself is three words and a tooltip, which nobody reads.
 */
const TOOLS_HINT_KEY = "kanban.chat.toolsHint";
function toolsHintSeen(): boolean {
  try {
    return localStorage.getItem(TOOLS_HINT_KEY) === "seen";
  } catch {
    return true; // storage blocked: better never than on every load
  }
}

/**
 * Memoised: stored messages never change, and a streaming reply re-renders the panel many times a
 * second. The cards they name do change: those rows read the board's live cards from context.
 */
const MessageRow = memo(function MessageRow({ m }: { m: ChatMessage }) {
  // The board's own messages (D332, D338): a quiet line, not a speech bubble you did not write.
  if (m.role === "user" && m.meta.keepalive) return <div className="rise pl-1 font-mono text-[11px] text-ink-500" title={m.text}>· kept the conversation cached</div>;
  if (m.role === "user" && m.meta.suggest) return <div className="rise pl-1 font-mono text-[11px] text-ink-500" title={m.text}>· asked for the next five things</div>;
  if (m.role === "user") {
    return (
      <div className="rise flex flex-col items-end gap-1">
        {m.meta.files?.length ? <FileChips files={m.meta.files} /> : null}
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-amber/15 px-3.5 py-2 text-[13px] leading-relaxed text-ink-100 whitespace-pre-wrap">{m.text}</div>
      </div>
    );
  }
  if (m.role === "tool") {
    if (m.meta.cards?.length) return <ChatCards m={m} />;
    return <div className="rise pl-1 font-mono text-[11px] text-ink-500">· {m.text}</div>;
  }
  if (m.role === "update" && m.meta.update) return <ChatUpdateRow m={m} />;
  if (m.role === "error") return <div className="rise rounded-lg border border-rust/40 bg-rust/10 px-3 py-2 text-[12.5px] text-rust">{m.text}</div>;
  return <Markdown text={m.text} className="rise text-[13px]" />;
});

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The files on a message, or waiting to go with the next one (D334): images as thumbnails, the rest as named chips. */
function FileChips({ files, onRemove }: { files: Pick<ChatFile, "id" | "name" | "media_type" | "bytes">[]; onRemove?: (id: string) => void }) {
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {files.map((f) =>
        attachmentKind(f.media_type) === "image" ? (
          <span key={f.id} className="relative">
            <a href={api.chatFileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name}>
              <img src={api.chatFileUrl(f.id)} alt={f.name} className="h-16 w-16 rounded-md border border-ink-700 object-cover" loading="lazy" />
            </a>
            {onRemove ? <button className="absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-ink-700 text-[10px] text-ink-200 hover:bg-rust hover:text-ink-950" onClick={() => onRemove(f.id)} title="Take it back">×</button> : null}
          </span>
        ) : (
          <span key={f.id} className="flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11.5px] text-ink-200">
            <span className="font-mono text-[9.5px] uppercase text-ink-500">{f.name.split(".").pop()}</span>
            <a href={api.chatFileUrl(f.id)} target="_blank" rel="noreferrer" className="max-w-[160px] truncate hover:text-amber" title={`${f.name} · ${kb(f.bytes)}`}>{f.name}</a>
            {onRemove ? <button className="cursor-pointer text-ink-500 hover:text-rust" onClick={() => onRemove(f.id)} title="Take it back">×</button> : null}
          </span>
        ),
      )}
    </div>
  );
}

/** File → base64 without the `data:…;base64,` prefix, which is what the upload route expects. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.readAsDataURL(file);
  });
}

/**
 * One conversation: its messages, the reply as it streams, and the box you type in with the model
 * and effort pickers. Shared by the side panel and the Studio, which only differ in what is around
 * it. `chatId` null is a chat that does not exist yet: its row is created with the first message, so
 * pressing New never leaves empty chats behind.
 */
export function ChatThread({
  project,
  chats,
  chatId,
  onChatId,
  onMessages,
  wide = false,
}: {
  project: ProjectWithGit;
  chats: Chat[] | null;
  chatId: string | null;
  /** The thread made the chat's row (first message of a new chat): show it as the open one. */
  onChatId: (id: string) => void;
  /** Whoever wants the stored messages too (the Studio's Links pane) hears them here. */
  onMessages?: (messages: ChatMessage[]) => void;
  /** The Studio's middle column: messages in a readable column, with room around them. */
  wide?: boolean;
}) {
  const { settings } = useAppData();
  const claude = useClaudeModels();
  // What a new chat will run on. An empty chat has no row to patch, so the choice waits here.
  const [pending, setPending] = useState<{ model: string; effort: Effort; provider: string } | null>(null);
  // "my connectors and skills" for a chat that does not exist yet: applied to the row once it is made (D335).
  const [pendingTools, setPendingTools] = useState(false);
  const [pendingMode, setPendingMode] = useState<Mode>("supervised");
  // Files attached and not yet sent (D334). A new chat has no row to hold them, so they wait in the browser until the first message.
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [local, setLocal] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [text, setText] = useState(() => drafts.get(project.id) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [toolsHint, setToolsHint] = useState(() => !toolsHintSeen());
  const dismissToolsHint = () => {
    setToolsHint(false);
    try {
      localStorage.setItem(TOOLS_HINT_KEY, "seen");
    } catch {
      // a private window just sees it again next time
    }
  };
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const chat = chats?.find((c) => c.id === chatId) ?? null;
  // The cards this chat names, live: a stored message only says what the chat did, not where the card is now.
  const { cards } = useTaskCards(project.id);

  useEffect(() => void drafts.set(project.id, text), [project.id, text]);
  useEffect(() => onMessages?.(messages), [messages, onMessages]);

  const current = useRef(chatId);
  current.current = chatId;
  // Merged, not replaced: a message pushed while this was loading must not be dropped, and a slow
  // answer for the chat you just left must not land in this one.
  const loadMessages = useCallback((id: string) => {
    void api.chatMessages(id).then((loaded) => {
      if (current.current !== id) return;
      setMessages((prev) => [...loaded, ...prev.filter((x) => !loaded.some((l) => l.id === x.id))]);
    }, () => {});
  }, []);
  useEffect(() => {
    watchChat(chatId);
    setStreaming("");
    setMessages([]);
    setFiles([]);
    if (chatId) {
      loadMessages(chatId);
      void api.chatFiles(chatId).then((all) => current.current === chatId && setFiles(all.filter((f) => f.message_id === null)), () => {});
    }
    return () => watchChat(null);
  }, [chatId, loadMessages]);
  useWsReconnect(() => {
    setStreaming("");
    if (chatId) loadMessages(chatId);
  });

  // Each delta carries the whole reply so far and is re-parsed as markdown: once per frame is plenty.
  const latestDelta = useRef("");
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useWs((m) => {
    if (m.type === "chat.message" && m.message.chat_id === chatId) setMessages((prev) => (prev.some((x) => x.id === m.message.id) ? prev : [...prev, m.message]));
    else if (m.type === "chat.delta" && m.chatId === chatId) {
      latestDelta.current = m.text;
      cancelAnimationFrame(frame.current);
      // The empty delta that ends a reply is applied at once, so the cursor never outlives it.
      if (!m.text) setStreaming("");
      else frame.current = requestAnimationFrame(() => setStreaming(latestDelta.current));
    }
  });

  const board = useMemo(() => {
    // Controls go on each card's newest mention only.
    const latest = new Map<string, number>();
    for (const m of messages) for (const c of m.meta.cards ?? []) latest.set(c.id, m.id);
    return { project, cards: new Map(cards.map((c) => [c.id, c])), latest };
  }, [project, cards, messages]);

  // Follow the conversation as it grows, unless you scrolled up to read.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => input.current?.focus(), [chatId]);

  // What this chat runs on: its own row once it exists, otherwise the choice made here, else Settings.
  const model = chat?.model ?? pending?.model ?? settings?.chatModel ?? "sonnet";
  const effort = (chat?.effort ?? pending?.effort ?? settings?.chatEffort ?? "medium") as Effort;
  // Claude, or a Claude-compatible provider running through the same Claude Code (D301).
  const provider = chat?.provider ?? pending?.provider ?? settings?.chatProvider ?? ANTHROPIC_PROVIDER_ID;
  const onClaude = provider === ANTHROPIC_PROVIDER_ID;
  // A button that fails says why, instead of looking like it did nothing.
  const say = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const setModel = (v: { provider: string; model: string }) => {
    const next = effortsFor(v.model, claude.result);
    const keep = v.provider !== ANTHROPIC_PROVIDER_ID || next.efforts.includes(effort) ? effort : next.efforts[0] ?? effort;
    if (chat) void api.patchChat(chat.id, { model: v.model, provider: v.provider, ...(keep === effort ? {} : { effort: keep }) }).catch(say);
    else setPending({ model: v.model, provider: v.provider, effort: keep });
  };
  const setEffort = (e: Effort) => (chat ? void api.patchChat(chat.id, { effort: e }).catch(say) : setPending({ model, provider, effort: e }));
  const useTools = chat?.use_tools ?? pendingTools;
  const setUseTools = (on: boolean) => (chat ? void api.patchChat(chat.id, { use_tools: on }).catch(say) : setPendingTools(on));
  // How the cards this chat makes will run, unless a message says otherwise (D344).
  const mode: Mode = chat?.mode ?? pendingMode;
  const setMode = (m: Mode) => (chat ? void api.patchChat(chat.id, { mode: m }).catch(say) : setPendingMode(m));
  const noAuto = autonomousBlocked(project);
  // Naming Slack with the switch off would get a card where the chat could have looked itself (D349).
  // Offered while you type, because the switch is read when the reply starts; × mutes that system here.
  const [mutedSystem, setMutedSystem] = useState<string | null>(null);
  const namedSystem = useTools ? null : connectedSystemIn(text);
  const offerTools = namedSystem && namedSystem !== mutedSystem ? namedSystem : null;

  /** Upload to the chat's row; a chat that does not exist yet keeps them in the browser until its first message. */
  const attach = async (list: File[]) => {
    if (!list.length) return;
    setError(null);
    if (!chatId) {
      setLocal((prev) => [...prev, ...list]);
      return;
    }
    setUploading(true);
    try {
      for (const f of list) {
        const saved = await api.addChatFile(chatId, { name: f.name || "pasted image.png", data: await toBase64(f) });
        setFiles((prev) => [...prev, saved]);
      }
    } catch (e) {
      say(e);
    } finally {
      setUploading(false);
    }
  };
  const unattach = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    void api.deleteChatFile(id).catch(say);
  };

  const send = async (value = text) => {
    const t = value.trim();
    if (!t && !files.length && !local.length) return;
    setError(null);
    try {
      let id = chatId;
      if (!id) {
        const c = await api.createChat(project.id);
        id = c.id;
        // The chat row exists only now, so the model and tools picked before the first message land here.
        if (pending || pendingTools || pendingMode !== "supervised") {
          await api.patchChat(c.id, { ...(pending ?? {}), ...(pendingTools ? { use_tools: true } : {}), ...(pendingMode !== "supervised" ? { mode: pendingMode } : {}) }).catch(() => {});
        }
        for (const f of local) await api.addChatFile(c.id, { name: f.name || "pasted image.png", data: await toBase64(f) });
        setLocal([]);
        onChatId(c.id);
        watchChat(c.id);
      }
      setText("");
      setFiles([]);
      pinned.current = true;
      await api.sendChat(id, t || "Here is a file.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setText(t);
    }
  };
  const suggest = async () => {
    if (!chatId) return;
    setError(null);
    pinned.current = true;
    await api.suggestNext(chatId).catch(say);
  };
  const waiting = [...files.map((f) => ({ id: f.id, name: f.name, media_type: f.media_type, bytes: f.bytes })), ...local.map((f, i) => ({ id: `local-${i}`, name: f.name, media_type: f.type || "application/octet-stream", bytes: f.size }))];

  const column = wide ? "mx-auto w-full max-w-[860px]" : "";

  return (
    <ChatBoard.Provider value={board}>
      <div className="flex h-full min-h-0 flex-col">
        {/* The Studio carries the cache bar on its title row; the panel keeps the strip above the thread. */}
        {chat && !wide ? <CacheStrip chat={chat} compact /> : null}
        <div
          ref={scroller}
          className={`min-h-0 flex-1 overflow-y-auto ${wide ? "px-6 py-6" : "px-4 py-4"}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          <div className={`space-y-3 ${column}`}>
            {!messages.length && !streaming ? (
              <div className={`rise mx-auto max-w-sm text-center ${wide ? "mt-16" : "mt-8"}`}>
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber/15 text-[18px] text-amber">✦</div>
                <div className="text-[14px] font-medium text-ink-100">Ask about {project.name}</div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
                  Claude answers from the project itself: its files, its git history, the web. For anything else, a lookup in a live system, a fix or a feature, it makes a task card with the
                  models you name, runs it when you say, and brings the result back here.
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

        <footer className={wide ? "px-6 pb-4 pt-1" : "border-t border-ink-800 px-3 pb-3 pt-2.5"}>
          <div className={column}>
            {/* The Studio has the work on its right; the panel keeps its cards above the box, where they stay in sight. */}
            {wide ? null : <ChatTray chatId={chatId} />}
            {error ? <div className="mb-2 text-[12px] text-rust">{error}</div> : null}
            {offerTools ? (
              <div className="rise mb-2 flex items-center gap-2 rounded-lg border border-amber/40 bg-amber/5 px-3 py-1.5 text-[11.5px] leading-snug text-ink-300">
                <span className="min-w-0 flex-1">
                  Asking about {offerTools}? With <span className="font-medium text-ink-100">my connectors and skills</span> on, this chat looks there itself
                  when {offerTools === "your MCP server" ? "it is" : `${offerTools} is`} connected to your Claude. Off, it makes a card for the lookup.
                </span>
                <button className="shrink-0 cursor-pointer rounded-md bg-amber/90 px-2 py-1 text-[11px] font-semibold text-ink-950 hover:bg-amber" onClick={() => setUseTools(true)}>
                  Turn it on
                </button>
                <button className="shrink-0 cursor-pointer px-1 text-ink-500 hover:text-ink-200" title="Not for this one" onClick={() => setMutedSystem(offerTools)}>
                  ×
                </button>
              </div>
            ) : null}
            {waiting.length ? (
              <div className="mb-2 flex justify-end">
                <FileChips files={waiting} onRemove={(id) => (id.startsWith("local-") ? setLocal((prev) => prev.filter((_, i) => `local-${i}` !== id)) : unattach(id))} />
              </div>
            ) : null}
            <div
              className={`rounded-xl border bg-ink-850 transition-colors focus-within:border-amber/50 ${dragging ? "border-amber bg-amber/5" : "border-ink-700"}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void attach([...e.dataTransfer.files]); }}
            >
              <textarea
                ref={input}
                rows={wide ? 3 : 2}
                className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] text-ink-100 outline-none placeholder:text-ink-500"
                placeholder={dragging ? "Drop the file here" : `Ask about ${project.name}… (drop or paste a file to attach it)`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  const pasted = [...e.clipboardData.files];
                  if (pasted.length) {
                    e.preventDefault();
                    void attach(pasted);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!chat?.busy) void send();
                  }
                }}
              />
              <div className="flex items-center gap-1.5 border-t border-ink-800/70 px-2 py-1.5">
                <input ref={picker} type="file" multiple className="hidden" accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.csv,.tsv,.xlsx,.xls,.docx,.doc,.pptx,.txt,.md,.log,.json,.yaml,.yml,.xml,.html,.htm" onChange={(e) => { void attach([...(e.target.files ?? [])]); e.target.value = ""; }} />
                <button
                  className={`flex shrink-0 cursor-pointer items-center rounded-md px-1.5 py-1 ${uploading ? "breathe text-amber" : "text-ink-400 hover:text-amber"}`}
                  onClick={() => picker.current?.click()}
                  title="Attach a file: an image, a PDF, a spreadsheet, a document. Claude opens images, PDFs and text itself; a spreadsheet or Word file is read by a card."
                  aria-label="Attach a file"
                  disabled={uploading}
                >
                  <PaperclipIcon />
                </button>
                {/* The same pickers the pipeline uses, and they work before the first message: an empty
                    chat has no row to patch yet, so the choice is held here and used when it is created. */}
                <div className="w-[196px] shrink-0" title="Model for this chat: Claude, or a Claude-compatible provider (Settings → Providers)">
                  <ChatModelPicker provider={provider} model={model} onChange={setModel} models={settings?.models ?? []} />
                </div>
                {/* Effort is Claude's: Claude Code does not send it to another model. */}
                {!onClaude || effortsFor(model, claude.result).none ? null : (
                  <div className="w-[100px] shrink-0">
                    <EffortSelect model={model} value={effort} onChange={setEffort} />
                  </div>
                )}
                <label
                  className={`flex shrink-0 cursor-pointer items-center gap-1 text-[11px] ${useTools ? "text-ink-200" : "text-ink-500"}`}
                  title="Give this chat your connected systems (Slack, Gmail, Google Drive, your own MCP servers) and your skills, the way a task gets them. Off, a chat is quicker and cheaper: their tool lists ride on every message. Either way it never changes files; it only reads and runs read-only commands itself."
                >
                  <Switch on={useTools} onChange={setUseTools} />
                  my connectors and skills
                </label>
                {/* The mode the cards of this chat will run in; a message that names one wins (D344). */}
                <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-ink-700 text-[11px]" role="radiogroup" aria-label="How cards from this chat run">
                  {(["supervised", "autonomous"] as Mode[]).map((m) => (
                    <button
                      key={m}
                      role="radio"
                      aria-checked={mode === m}
                      disabled={m === "autonomous" && !!noAuto}
                      className={`cursor-pointer px-2 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${mode === m ? (m === "autonomous" ? "bg-amber/15 text-amber" : "bg-cyan/15 text-cyan") : "text-ink-500 hover:text-ink-200"}`}
                      title={
                        m === "autonomous"
                          ? noAuto ?? "Cards this chat makes work on their own branch without asking, and the work lands when you approve it. Say “supervised” in a message to make one card the other way. A lookup card runs in the project's own folder and asks nothing (it changes nothing), unless the project keeps autonomous in a sandbox."
                          : "Cards this chat makes work in the project's own folder and ask you before each change; “Always allow” on a card stops the asking for that command. Say “autonomous” in a message to make one card the other way."
                      }
                      onClick={() => setMode(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <span className="ml-auto hidden truncate pr-1 text-[10.5px] text-ink-600 2xl:inline">Enter to send · Shift+Enter new line</span>
                {settings?.nextStepsSuggestions !== false && chatId && messages.some((m) => m.role === "assistant") && !chat?.busy ? (
                  <button
                    className="shrink-0 cursor-pointer rounded-md border border-iris/50 px-2 py-1.5 text-[11.5px] text-iris hover:bg-iris/10"
                    onClick={() => void suggest()}
                    title="Ask for the next five things worth doing after this: bugs to fix, security to tighten, follow-up edits, useful additions. One reply at this chat's model; nothing is created until you say so."
                  >
                    ✦ What next?
                  </button>
                ) : null}
                {chat?.busy ? (
                  <button className="shrink-0 cursor-pointer rounded-md border border-rust/50 px-2.5 py-1.5 text-[12px] text-rust hover:bg-rust/10" onClick={() => chat && void api.stopChat(chat.id).catch(say)}>
                    ■ Stop
                  </button>
                ) : (
                  <button
                    className="shrink-0 cursor-pointer rounded-md bg-amber px-3 py-1.5 text-[12px] font-semibold text-ink-950 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!text.trim() && !waiting.length}
                    onClick={() => void send()}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
            {toolsHint ? (
              <div className="rise mt-1.5 flex items-start gap-2 px-1 text-[11.5px] leading-snug text-ink-400">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-ink-200">my connectors and skills</span> gives this chat your connected systems (Slack, Gmail, Google Drive, your own MCP servers)
                  and your skills, so it can look there itself instead of making a card. Leave it off for plain questions about the project: quicker and cheaper.
                </span>
                <button className="shrink-0 cursor-pointer text-amber hover:underline" onClick={dismissToolsHint}>
                  Got it
                </button>
              </div>
            ) : null}
          </div>
        </footer>
      </div>
    </ChatBoard.Provider>
  );
}
