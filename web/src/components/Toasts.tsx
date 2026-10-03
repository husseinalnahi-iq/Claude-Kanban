import { useEffect, useRef, useState } from "react";
import { kindInfo, onAlert, onResolve, openTask, type Alert, type Outcome } from "../lib/alerts.ts";
import { inputSummary } from "../lib/approvals.ts";
import { CommandExplainer } from "./CommandExplainer.tsx";
import { isQuestion } from "../lib/questions.ts";
import { navigate } from "../lib/router.ts";
import { NeedsYouActions, OUTCOME_TEXT } from "./NeedsYouActions.tsx";

interface Shown extends Alert {
  count: number;
  titles: string[];
  leaving?: boolean;
  /** Settled while on screen: says how for a moment, then leaves. */
  outcome?: Outcome;
}

/**
 * How long each stays. A "needs you" pop-up stays until the thing is dealt with — anywhere: on the
 * pop-up, the card, the Approvals tab or another tab — and then closes itself (D279).
 */
const LIFETIME: Partial<Record<Alert["kind"], number>> = { failed: 12_000, usage: 12_000, allClear: 9_000 };
const DEFAULT_LIFE = 7_000;
const MERGE_WINDOW = 6_000;
/** Pop-ups that come and go; the "needs you" ones are never pushed out by them. */
const MAX_SHOWN = 5;
/** More waiting than this and they fold into one pop-up that leads to the Approvals tab. */
const MAX_NEEDS = 3;
const OUTCOME_HOLD = 1_600;

const isSticky = (t: Pick<Alert, "key" | "preview">) => !!t.key && !t.preview;

const CONFETTI = ["var(--color-moss)", "var(--color-lime)", "var(--color-amber)", "var(--color-cyan)", "var(--color-iris)", "var(--color-rose)"];

const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

function Confetti() {
  // Fixed, not random per render, so a re-render does not restart the burst.
  const bits = useRef(
    Array.from({ length: 16 }, (_, i) => {
      const angle = (i / 16) * Math.PI * 2 + (i % 3) * 0.2;
      const dist = 34 + (i % 4) * 12;
      return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist - 10, r: (i * 47) % 360, c: CONFETTI[i % CONFETTI.length], d: 0.55 + (i % 5) * 0.08 };
    }),
  ).current;
  return (
    <span className="pointer-events-none absolute left-[26px] top-[26px]">
      {bits.map((b, i) => (
        <span
          key={i}
          className="kb-confetti absolute block h-[5px] w-[3px] rounded-[1px]"
          style={{ background: b.c, ["--dx" as string]: `${b.dx}px`, ["--dy" as string]: `${b.dy}px`, ["--r" as string]: `${b.r}deg`, animationDuration: `${b.d}s` }}
        />
      ))}
    </span>
  );
}

function ToastCard({ t, onClose }: { t: Shown; onClose: () => void }) {
  const info = kindInfo(t.kind);
  const sticky = isSticky(t) && !t.outcome;
  const life = sticky ? Infinity : t.outcome ? OUTCOME_HOLD : (LIFETIME[t.kind] ?? DEFAULT_LIFE);
  const [hover, setHover] = useState(false);
  const left = useRef(life);
  const startedAt = useRef(Date.now());

  // A merged repeat, or the thing being settled, restarts the clock. Declared before the timer so it
  // runs first: a settled pop-up still held `Infinity` from its sticky life, and setTimeout treats a
  // delay that large as zero — it vanished before saying "✓ Allowed".
  useEffect(() => {
    left.current = life;
    startedAt.current = Date.now();
  }, [t.count, life]);

  // Hovering holds the pop-up; the bar resumes from where it stopped.
  useEffect(() => {
    if (sticky) return;
    if (hover) {
      left.current -= Date.now() - startedAt.current;
      return;
    }
    startedAt.current = Date.now();
    const timer = setTimeout(onClose, Math.min(60_000, Math.max(400, left.current)));
    return () => clearTimeout(timer);
  }, [hover, sticky, t.count, t.outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = () => {
    openTask(t);
    // Opening a "needs you" card does not settle it: the pop-up stays until the thing is dealt with.
    if (!sticky) onClose();
  };
  const card = t.approval && !isQuestion(t.approval) ? t.approval : null;
  const done = t.outcome ? OUTCOME_TEXT[t.outcome] : null;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`kb-toast relative w-[360px] overflow-hidden rounded-xl border bg-ink-900/95 kb-raise backdrop-blur ${t.leaving ? "kb-toast-out" : ""} ${t.kind === "allClear" ? "kb-shimmer" : ""}`}
      style={{
        borderColor: tint(info.color, 45),
        backgroundImage: `radial-gradient(120% 90% at 0% 0%, ${tint(info.color, 16)}, transparent 55%)`,
      }}
      role="status"
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: info.color }} />
      <div className={`flex items-start gap-3 py-3 pr-3 pl-4 ${t.taskId ? "cursor-pointer" : ""}`} onClick={t.taskId ? open : undefined}>
        <span
          className={`relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${sticky ? "kb-ring" : ""}`}
          style={{ background: tint(info.color, 20), color: info.color, ["--ring" as string]: tint(info.color, 55) }}
        >
          {info.icon}
          {t.kind === "done" || t.kind === "allClear" ? <Confetti key={t.count} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em]" style={{ color: info.color }}>{t.label ?? info.label}</span>
            {t.count > 1 ? (
              <span className="rounded-full px-1.5 font-mono text-[9.5px]" style={{ background: tint(info.color, 22), color: info.color }}>×{t.count}</span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[13px] font-semibold leading-snug text-ink-100">
            {t.count > 1 ? `${t.count} tasks` : t.title}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-300">
            {t.count > 1 ? t.titles.slice(-3).join(" · ") + (t.count > 3 ? " …" : "") : t.body}
          </span>
          {card && inputSummary(card) && !done ? (
            <>
              {card.tool_name === "Bash" || card.tool_name === "PowerShell" ? <span className="mt-1 block"><CommandExplainer command={inputSummary(card)} compact /></span> : null}
              <span className="mt-1 block truncate rounded bg-ink-950 px-2 py-1 font-mono text-[11px] text-amber" title={inputSummary(card)}>
                {card.tool_name === "Bash" ? "$ " : ""}
                {inputSummary(card)}
              </span>
            </>
          ) : null}
          {done ? (
            <span className="mt-1.5 block text-[12px] font-semibold" style={{ color: done.color }}>{done.text}</span>
          ) : sticky ? (
            <NeedsYouActions a={t} />
          ) : t.taskId && t.count === 1 ? (
            <span className="mt-1 block text-[10.5px] text-ink-500">Click to open</span>
          ) : null}
        </span>
        <button
          className="-mt-0.5 cursor-pointer px-1 text-[15px] leading-none text-ink-500 hover:text-ink-100"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={sticky ? "Hide this pop-up — it stays in the bell's inbox until it is dealt with" : "Dismiss"}
        >
          ×
        </button>
      </div>
      {!sticky ? (
        <span
          key={t.count}
          className="kb-life absolute bottom-0 left-0 h-[2px]"
          style={{ background: info.color, animationDuration: `${life}ms`, animationPlayState: hover ? "paused" : "running" }}
        />
      ) : null}
    </div>
  );
}

/** The pop-ups, bottom right. Newest at the bottom, nearest your cursor after a click. */
export function Toasts() {
  const [items, setItems] = useState<Shown[]>([]);

  useEffect(
    () =>
      onAlert((a) =>
        setItems((cur) => {
          // Ten subtasks starting at once is one pop-up that says ×10, not ten pop-ups. A "needs you"
          // pop-up is never merged: each is its own decision, with its own buttons.
          const same = !isSticky(a)
            ? cur.find((x) => x.kind === a.kind && !isSticky(x) && !x.leaving && !a.preview && !x.preview && a.at - x.at < MERGE_WINDOW && x.taskId !== a.taskId)
            : undefined;
          if (same && a.taskId) {
            return cur.map((x) => (x === same ? { ...x, count: x.count + 1, titles: [...x.titles, a.title], at: a.at, taskId: undefined } : x));
          }
          const next = [...cur, { ...a, count: 1, titles: [a.title] }];
          // Too many: the oldest passing news goes first; what needs you is never pushed out.
          const passing = next.filter((x) => !isSticky(x));
          const drop = new Set(passing.slice(0, Math.max(0, passing.length - MAX_SHOWN)).map((x) => x.id));
          return next.filter((x) => !drop.has(x.id));
        }),
      ),
    [],
  );

  const close = (id: string) => {
    setItems((cur) => cur.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), 220);
  };

  // Settled anywhere — this pop-up, the card, the Approvals tab, another tab, a restart: say how,
  // briefly, and go. Its own timer (OUTCOME_HOLD) closes it.
  useEffect(
    () =>
      onResolve((key, outcome) =>
        setItems((cur) => cur.map((x) => (x.key === key && !x.outcome && !x.preview ? { ...x, outcome } : x))),
      ),
    [],
  );

  const waiting = items.filter((x) => isSticky(x) && !x.outcome && !x.leaving);
  const folded = waiting.length > MAX_NEEDS ? new Set(waiting.map((x) => x.id)) : null;

  return (
    <>
      <style>{CSS}</style>
      <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex flex-col items-end gap-2">
        {folded ? (
          <div className="pointer-events-auto">
            <NeedsSummary items={waiting} onHide={() => waiting.forEach((x) => close(x.id))} />
          </div>
        ) : null}
        {items
          .filter((t) => !folded?.has(t.id))
          .map((t) => (
            <div key={t.id} className="pointer-events-auto">
              <ToastCard t={t} onClose={() => close(t.id)} />
            </div>
          ))}
      </div>
    </>
  );
}

/** Several things waiting at once: one pop-up that names them and leads to where they are all dealt with. */
function NeedsSummary({ items, onHide }: { items: Shown[]; onHide: () => void }) {
  const info = kindInfo("approval");
  return (
    <div
      className="kb-toast relative w-[360px] cursor-pointer overflow-hidden rounded-xl border bg-ink-900/95 kb-raise backdrop-blur"
      style={{ borderColor: tint(info.color, 45), backgroundImage: `radial-gradient(120% 90% at 0% 0%, ${tint(info.color, 16)}, transparent 55%)` }}
      onClick={() => navigate({ view: "approvals", taskId: null })}
      role="status"
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: info.color }} />
      <div className="flex items-start gap-3 py-3 pr-3 pl-4">
        <span
          className="kb-ring relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
          style={{ background: tint(info.color, 20), color: info.color, ["--ring" as string]: tint(info.color, 55) }}
        >
          {info.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em]" style={{ color: info.color }}>{info.label}</span>
          <span className="mt-0.5 block text-[13px] font-semibold leading-snug text-ink-100">{items.length} things need you</span>
          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-300">{[...new Set(items.map((x) => x.title))].slice(0, 3).join(" · ")}</span>
          <span className="mt-1 block text-[10.5px] text-ink-500">Click to open Approvals</span>
        </span>
        <button
          className="-mt-0.5 cursor-pointer px-1 text-[15px] leading-none text-ink-500 hover:text-ink-100"
          onClick={(e) => {
            e.stopPropagation();
            onHide();
          }}
          title="Hide — they stay in the bell's inbox until dealt with"
        >
          ×
        </button>
      </div>
    </div>
  );
}

const CSS = `
.kb-toast { animation: kb-in .42s cubic-bezier(.2,1.25,.3,1) both; }
.kb-toast-out { animation: kb-out .22s ease-in both; }
@keyframes kb-in { from { opacity: 0; transform: translateX(36px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes kb-out { to { opacity: 0; transform: translateX(28px) scale(.97); } }
.kb-life { width: 100%; animation-name: kb-life; animation-timing-function: linear; animation-fill-mode: forwards; opacity: .8; }
@keyframes kb-life { to { width: 0%; } }
.kb-ring::after { content: ""; position: absolute; inset: -3px; border-radius: 9999px; border: 2px solid var(--ring); animation: kb-ring 1.6s ease-out infinite; }
@keyframes kb-ring { from { transform: scale(.9); opacity: 1; } to { transform: scale(1.55); opacity: 0; } }
.kb-confetti { animation-name: kb-pop; animation-timing-function: cubic-bezier(.15,.8,.3,1); animation-fill-mode: forwards; }
@keyframes kb-pop {
  0% { transform: translate(0,0) rotate(0) scale(1); opacity: 1; }
  100% { transform: translate(var(--dx), calc(var(--dy) + 18px)) rotate(var(--r)) scale(.6); opacity: 0; }
}
.kb-shimmer::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, var(--kb-shimmer) 50%, transparent 65%);
  transform: translateX(-100%); animation: kb-sweep 1.8s .2s ease-in-out 2;
}
@keyframes kb-sweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  .kb-toast, .kb-toast-out, .kb-confetti, .kb-shimmer::before, .kb-ring::after { animation: none !important; }
}
`;
