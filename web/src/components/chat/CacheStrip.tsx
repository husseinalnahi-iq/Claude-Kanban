import { useEffect, useState } from "react";
import type { Chat, UsageLimit } from "../../../../server/src/types.ts";
import { ANTHROPIC_PROVIDER_ID } from "../../../../server/src/types.ts";
import { CACHE_WARN_MIN, CACHE_WINDOW_MIN, KEEP_ALIVE_LEAD_MIN } from "../../../../server/src/engine/cacheWindow.ts";
import { api } from "../../lib/api.ts";
import { useWs, useWsReconnect } from "../../lib/ws.ts";
import { useAppData } from "../../lib/store.tsx";
import { clock, tokens, until } from "../../lib/format.ts";
import { Switch } from "../ui.tsx";

/** Re-render twice a minute so the bars drain without a request. */
function useTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Your Claude 5-hour window, live: the same number the top bar shows. */
function useFiveHour(): UsageLimit | null {
  const [limits, setLimits] = useState<UsageLimit[]>([]);
  const load = () => void api.limits().then(setLimits, () => {});
  useEffect(load, []);
  useWsReconnect(load);
  useWs((m) => {
    if (m.type === "limits.updated") setLimits(m.limits);
  });
  return limits.find((l) => l.type === "five_hour") ?? null;
}

/** From here the context bar turns amber and suggests a new chat for a new topic; red from 90%, like a card's (D360). */
const CONTEXT_WARN_PCT = 70;

/**
 * How full this chat's context is (D360): the conversation, what it read and its instructions, all
 * re-read with every message. Lavender so it stands apart from the cache bar's cyan and the 5h bar's green.
 */
function ContextMeter({ chat, inline = false }: { chat: Chat; inline?: boolean }) {
  const used = chat.context_tokens ?? 0;
  const win = chat.context_window ?? 0;
  const pct = used && win ? Math.min(100, (used / win) * 100) : null;
  const warn = pct !== null && pct >= CONTEXT_WARN_PCT;
  const fill = pct === null ? "bg-ink-500" : pct >= 90 ? "bg-rust" : warn ? "bg-amber" : "bg-iris";
  // A sliver even at 1%, so a chat that has started never reads as empty; no window known: a short stub.
  const width = !used ? 0 : pct === null ? 8 : Math.max(3, pct);
  const shown = !used ? "—" : `${tokens(used)}${pct === null ? "" : ` · ${pct < 1 ? "<1" : Math.round(pct)}%`}`;
  const title = used
    ? `This chat holds ${used.toLocaleString()} tokens${win ? ` of the ${win.toLocaleString()} its model can hold` : ""}: the conversation, the files and pages it read, and its instructions${chat.use_tools ? ", your connectors and skills" : ""}. Claude re-reads all of it with every message, so the fuller it is, the more each message uses of your limit.${warn ? " A new topic goes further in a new chat." : ""}`
    : "How full this chat is: shown after Claude's next reply.";

  return (
    <div className={`flex items-center gap-2 ${inline ? "" : "min-w-0 flex-1"}`} title={title}>
      <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-ink-500">context</span>
      <span className={`h-1.5 overflow-hidden rounded-full bg-ink-800 ${inline ? "w-24" : "min-w-10 flex-1"}`}>
        <span className={`block h-full rounded-full transition-[width] duration-700 ${fill}`} style={{ width: `${width}%` }} />
      </span>
      <span className={`shrink-0 font-mono text-[10.5px] ${pct !== null && pct >= 90 ? "text-rust" : warn ? "text-amber" : used ? "text-ink-300" : "text-ink-500"}`}>{shown}</span>
    </div>
  );
}

/** The amber note under a context past 70%: one line, the way the cache warning reads. */
function contextWarning(chat: Chat): string | null {
  const pct = chat.context_tokens && chat.context_window ? Math.round((chat.context_tokens / chat.context_window) * 100) : null;
  if (pct === null || pct < CONTEXT_WARN_PCT) return null;
  return `This chat is ${Math.min(100, pct)}% full. Each message re-reads all of it, so a new topic goes further in a new chat.`;
}

/**
 * Three bars above the conversation (D331, D360): how full this chat is, how long it stays cached, and how much of your Claude
 * 5-hour window is used, like Claude's own usage screen. Claude keeps a conversation cached for an
 * hour after its last reply; a message after that is re-read at full price. Fifteen minutes before
 * the end the bar turns amber and says so; the *Keep warm* switch sends a short message five minutes
 * before the end so the window moves on (D332).
 */
export function CacheStrip({ chat, compact = false, inline = false }: { chat: Chat; compact?: boolean; inline?: boolean }) {
  const { settings } = useAppData();
  const now = useTick();
  const five = useFiveHour();
  const onClaude = (chat.provider ?? ANTHROPIC_PROVIDER_ID) === ANTHROPIC_PROVIDER_ID;
  const [saving, setSaving] = useState(false);

  // The window, in minutes left. null: no reply yet, or the hour has passed.
  const left = chat.warm_at ? CACHE_WINDOW_MIN - (now - Date.parse(chat.warm_at)) / 60_000 : null;
  const open = left !== null && left > 0;
  const pct = open ? Math.max(2, Math.round((left / CACHE_WINDOW_MIN) * 100)) : 0;
  const warn = open && left <= CACHE_WARN_MIN;
  const keepOn = (settings?.chatKeepAlive ?? true) && chat.keep_alive;

  const toggle = async (on: boolean) => {
    setSaving(true);
    try {
      await api.patchChat(chat.id, { keep_alive: on });
    } catch {
      // the switch springs back to the row's value on the next push
    } finally {
      setSaving(false);
    }
  };

  const fivePct = five?.utilization === null || five?.utilization === undefined ? null : Math.min(100, Math.round(five.utilization * 100));
  const fiveTone = five?.status === "rejected" || (fivePct ?? 0) >= 90 ? "bg-rust" : (fivePct ?? 0) >= 70 ? "bg-amber" : "bg-moss";
  const resets = five?.resets_at ? five.resets_at * 1000 : null;

  const fullNote = contextWarning(chat);
  // Another provider's cache is its own business: no hour to count down, but its context still fills.
  if (!onClaude) {
    return inline ? (
      <ContextMeter chat={chat} inline />
    ) : (
      <div className={`border-b border-ink-800 ${compact ? "px-3 py-1.5" : "px-5 py-2"}`}>
        <ContextMeter chat={chat} />
      </div>
    );
  }

  const cacheTitle = open
    ? `Claude keeps this conversation cached for an hour after its last reply. ${Math.ceil(left!)} min left, until ${clock(Date.parse(chat.warm_at!) + CACHE_WINDOW_MIN * 60_000)}.`
    : chat.warm_at === null && !chat.busy
      ? "Claude keeps a conversation cached for an hour after each reply. This one is not cached now: the next message is read in full, at full price."
      : "";
  const keepTitle =
    settings?.chatKeepAlive === false
      ? "Switched off for every chat in Settings → Side chat."
      : `Five minutes before the hour ends, the board sends this chat a short message so it stays cached. Costs one short, cached turn each time. Stops ${settings?.chatKeepAliveMaxHours ?? 8} hours after your last own message, and never for an archived chat.`;

  // On the AI Manager's title row: the cache bar and the switch only, in one line; the 5-hour window is the top bar's (D343).
  if (inline) {
    return (
      <div className="flex shrink-0 items-center gap-3">
        {/* No pill for a full context here: with the cache's own it pushed the chat's title out. The bar turns amber and says why on hover. */}
        <ContextMeter chat={chat} inline />
        <span className="h-3 w-px bg-ink-700" aria-hidden />
        <div className="flex items-center gap-2" title={cacheTitle}>
          <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-500">cache</span>
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
            <span className={`block h-full rounded-full transition-[width] duration-700 ${warn ? "bg-amber" : "bg-cyan"}`} style={{ width: `${pct}%` }} />
          </span>
          <span className={`font-mono text-[10.5px] ${warn ? "text-amber" : open ? "text-ink-300" : "text-ink-500"}`}>
            {chat.busy ? "replying…" : open ? `${Math.ceil(left!)} min` : chat.warm_at === null && !chat.busy ? "not cached" : "ending"}
          </span>
        </div>
        {warn ? (
          <span
            className="rise flex items-center gap-1 rounded-full border border-amber/40 bg-amber/10 px-2 py-px text-[10.5px] text-amber"
            title={`This chat's cache resets in ${Math.ceil(left!)} min. Send your next idea before then, or the whole conversation is read again at full price.${keepOn && !chat.archived_at ? ` Keep warm is on: the board sends a short message ${KEEP_ALIVE_LEAD_MIN} minutes before the end if you have not.` : ""}`}
          >
            <span className="breathe">◔</span> resets in {Math.ceil(left!)} min
          </span>
        ) : null}
        <label className={`flex items-center gap-1.5 text-[11px] ${settings?.chatKeepAlive === false ? "text-ink-600" : "text-ink-400"}`} title={keepTitle}>
          <Switch on={keepOn} disabled={saving || settings?.chatKeepAlive === false || !!chat.archived_at} onChange={(v) => void toggle(v)} />
          Keep warm
        </label>
      </div>
    );
  }

  return (
    <div className={`border-b border-ink-800 ${compact ? "px-3 py-1.5" : "px-5 py-2"}`}>
      <div className={`flex items-center gap-3 ${compact ? "flex-wrap" : ""}`}>
        {/* how full the chat is */}
        <ContextMeter chat={chat} />

        {/* the chat's cache window */}
        <div className="flex min-w-0 flex-1 items-center gap-2" title={cacheTitle}>
          <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-ink-500">cache</span>
          <span className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-ink-800">
            <span className={`block h-full rounded-full transition-[width] duration-700 ${warn ? "bg-amber" : "bg-cyan"}`} style={{ width: `${pct}%` }} />
          </span>
          <span className={`shrink-0 font-mono text-[10.5px] ${warn ? "text-amber" : open ? "text-ink-300" : "text-ink-500"}`}>
            {chat.busy ? "replying…" : open ? `${Math.ceil(left!)} min` : chat.warm_at === null && !chat.busy ? "not cached" : "ending"}
          </span>
        </div>

        {/* the 5-hour window, like Claude's own usage screen */}
        {five ? (
          <div className="flex min-w-0 flex-1 items-center gap-2" title={`Your Claude 5-hour window: ${five.status === "rejected" ? "limit reached" : fivePct === null ? "fine" : `${fivePct}% used`}${resets ? `. Resets ${until(resets)}, at ${clock(resets)}.` : ""}`}>
            <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-ink-500">5h</span>
            <span className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-ink-800">
              <span className={`block h-full rounded-full transition-[width] ${fiveTone}`} style={{ width: `${five.status === "rejected" ? 100 : fivePct ?? 0}%` }} />
            </span>
            <span className={`shrink-0 font-mono text-[10.5px] ${five.status === "rejected" ? "text-rust" : "text-ink-300"}`}>
              {five.status === "rejected" ? "limit" : fivePct === null ? "ok" : `${fivePct}%`}
              {resets ? <span className="text-ink-500"> · resets {until(resets)}</span> : null}
            </span>
          </div>
        ) : null}

        {/* keep warm, per chat */}
        <label
          className={`flex shrink-0 items-center gap-1.5 text-[11px] ${settings?.chatKeepAlive === false ? "text-ink-600" : "text-ink-400"}`}
          title={keepTitle}
        >
          <Switch on={keepOn} disabled={saving || settings?.chatKeepAlive === false || !!chat.archived_at} onChange={(v) => void toggle(v)} />
          Keep warm
        </label>
      </div>
      {warn ? (
        <div className="rise mt-1.5 flex items-center gap-2 rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-[12px] text-amber">
          <span className="breathe">◔</span>
          <span className="min-w-0 flex-1">
            This chat's cache resets in {Math.ceil(left!)} min. Send your next idea before then, or the whole conversation is read again at full price.
            {keepOn && !chat.archived_at ? ` Keep warm is on: the board sends a short message ${KEEP_ALIVE_LEAD_MIN} minutes before the end if you have not.` : ""}
          </span>
        </div>
      ) : null}
      {fullNote ? (
        <div className="rise mt-1.5 flex items-center gap-2 rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-[12px] text-amber">
          <span className="breathe">◕</span>
          <span className="min-w-0 flex-1">{fullNote}</span>
        </div>
      ) : null}
    </div>
  );
}
