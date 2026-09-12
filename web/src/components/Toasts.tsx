import { useEffect, useRef, useState } from "react";
import { kindInfo, onAlert, type Alert } from "../lib/alerts.ts";
import { navigate } from "../lib/router.ts";

interface Shown extends Alert {
  count: number;
  titles: string[];
  leaving?: boolean;
}

/** How long each stays. "Needs you" stays until you deal with it: it is the one you must not miss. */
const LIFETIME: Partial<Record<Alert["kind"], number>> = { failed: 12_000, approval: Infinity, usage: 12_000, allClear: 9_000 };
const DEFAULT_LIFE = 7_000;
const MERGE_WINDOW = 6_000;
const MAX_SHOWN = 5;

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
  const life = LIFETIME[t.kind] ?? DEFAULT_LIFE;
  const sticky = !Number.isFinite(life);
  const [hover, setHover] = useState(false);
  const left = useRef(life);
  const startedAt = useRef(Date.now());

  // Hovering holds the pop-up; the bar resumes from where it stopped.
  useEffect(() => {
    if (sticky) return;
    if (hover) {
      left.current -= Date.now() - startedAt.current;
      return;
    }
    startedAt.current = Date.now();
    const timer = setTimeout(onClose, Math.max(400, left.current));
    return () => clearTimeout(timer);
  }, [hover, sticky, t.count]); // eslint-disable-line react-hooks/exhaustive-deps

  // A merged repeat restarts the clock.
  useEffect(() => {
    left.current = life;
    startedAt.current = Date.now();
  }, [t.count, life]);

  const open = () => {
    if (t.taskId) navigate({ projectId: t.projectId ?? null, taskId: t.taskId, view: "board" });
    onClose();
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`kb-toast relative w-[360px] overflow-hidden rounded-xl border bg-ink-900/95 shadow-2xl shadow-black/60 backdrop-blur ${t.leaving ? "kb-toast-out" : ""} ${t.kind === "allClear" ? "kb-shimmer" : ""}`}
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
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em]" style={{ color: info.color }}>{info.label}</span>
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
          {t.taskId && t.count === 1 ? <span className="mt-1 block text-[10.5px] text-ink-500">Click to open</span> : null}
        </span>
        <button
          className="-mt-0.5 cursor-pointer px-1 text-[15px] leading-none text-ink-500 hover:text-ink-100"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Dismiss"
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
          // Ten subtasks starting at once is one pop-up that says ×10, not ten pop-ups.
          const same = cur.find((x) => x.kind === a.kind && !x.leaving && !a.preview && !x.preview && a.at - x.at < MERGE_WINDOW && x.taskId !== a.taskId);
          if (same && a.taskId) {
            return cur.map((x) => (x === same ? { ...x, count: x.count + 1, titles: [...x.titles, a.title], at: a.at, taskId: undefined } : x));
          }
          const next = [...cur, { ...a, count: 1, titles: [a.title] }];
          return next.slice(-MAX_SHOWN);
        }),
      ),
    [],
  );

  const close = (id: string) => {
    setItems((cur) => cur.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), 220);
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex flex-col items-end gap-2">
        {items.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastCard t={t} onClose={() => close(t.id)} />
          </div>
        ))}
      </div>
    </>
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
  background: linear-gradient(105deg, transparent 35%, color-mix(in srgb, var(--color-cyan) 22%, transparent) 50%, transparent 65%);
  transform: translateX(-100%); animation: kb-sweep 1.8s .2s ease-in-out 2;
}
@keyframes kb-sweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  .kb-toast, .kb-toast-out, .kb-confetti, .kb-shimmer::before, .kb-ring::after { animation: none !important; }
}
`;
