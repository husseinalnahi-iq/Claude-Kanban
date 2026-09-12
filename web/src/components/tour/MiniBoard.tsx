import { useEffect, useState } from "react";
import { useAlertPrefs } from "../../lib/alerts.ts";
import { playSound, type SoundId } from "../../lib/sounds.ts";
import { tint } from "./TourStyles.tsx";

/** The real board's columns: plan, code, review and "needs you" all happen inside In progress. */
const LANES = [
  { label: "Queued", color: "var(--color-slate)" },
  { label: "In progress", color: "var(--color-amber)" },
  { label: "Review", color: "var(--color-lime)" },
  { label: "Done", color: "var(--color-moss)" },
];

interface Step {
  lane: number;
  chip: string;
  line: string;
  ms: number;
  /** The card's colour while it is in In progress, as its badge on the real board. */
  color?: string;
  sound?: SoundId;
  busy?: boolean;
  ask?: boolean;
  party?: boolean;
}

/** One task's life on the board, compressed into fifteen seconds. */
const STEPS: Step[] = [
  { lane: 0, chip: "queued", line: "waiting for a free slot", ms: 1500 },
  { lane: 1, chip: "planning · fable-5-1 · high", line: "reading the code", ms: 1700, color: "var(--color-cyan)", sound: "started", busy: true },
  { lane: 1, chip: "coding · opus-5 · high", line: "editing 3 files", ms: 1600, busy: true },
  { lane: 1, chip: "📸 browser check", line: "screenshot looks right", ms: 1500 },
  { lane: 1, chip: "needs you", line: "Allow: git commit?", ms: 2000, color: "var(--color-rose)", sound: "approval", ask: true },
  { lane: 1, chip: "✓ allowed", line: "you said yes", ms: 800 },
  { lane: 1, chip: "reviewing · sonnet-5 · medium", line: "checking its own work", ms: 1600, busy: true },
  { lane: 2, chip: "ready for you", line: "the diff to look over", ms: 1500, sound: "review" },
  { lane: 3, chip: "landed ✓  $0.42", line: "merged into main", ms: 2800, sound: "done", party: true },
];

const N = LANES.length;
const GAP = 8;
const left = (lane: number) => `calc(${lane} * ((100% - ${GAP * (N - 1)}px) / ${N} + ${GAP}px))`;
const WIDTH = `calc((100% - ${GAP * (N - 1)}px) / ${N})`;

const BITS = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * Math.PI * 2;
  const d = 40 + (i % 4) * 14;
  const colors = ["var(--color-moss)", "var(--color-lime)", "var(--color-amber)", "var(--color-cyan)", "var(--color-iris)", "var(--color-rose)"];
  return { dx: Math.cos(a) * d, dy: Math.sin(a) * d - 14, r: (i * 53) % 360, c: colors[i % colors.length], delay: (i % 3) * 0.04 };
});

function Ghost({ lane, title, color, top }: { lane: number; title: string; color: string; top: number }) {
  return (
    <div
      className="absolute rounded-md border px-2 py-1.5 text-[10.5px] text-ink-500"
      style={{ left: left(lane), width: WIDTH, top, borderColor: tint(color, 22), background: tint(color, 5) }}
    >
      <div className="truncate">{title}</div>
      <div className="mt-1 h-1 w-2/3 rounded-full" style={{ background: tint(color, 25) }} />
    </div>
  );
}

/**
 * A pretend board where one card walks from Queued to Done in the real status colours. With `sound`
 * on, each step plays the sound the real board would, in your chosen theme.
 */
export function MiniBoard({ sound = false, className = "" }: { sound?: boolean; className?: string }) {
  const [i, setI] = useState(0);
  const [round, setRound] = useState(0);
  const prefs = useAlertPrefs();
  const step = STEPS[i]!;
  const lane = { ...LANES[step.lane]!, color: step.color ?? LANES[step.lane]!.color };

  useEffect(() => {
    const t = setTimeout(() => {
      if (i === STEPS.length - 1) setRound((r) => r + 1);
      setI((i + 1) % STEPS.length);
    }, step.ms);
    return () => clearTimeout(t);
  }, [i, step.ms]);

  useEffect(() => {
    if (sound && step.sound) playSound(step.sound, prefs.theme, prefs.volume);
    // Only on arriving at a step, not when the theme or volume is changed mid-step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, sound]);

  return (
    <div className={`relative select-none ${className}`} aria-label="A demo of one task moving across the board" role="img">
      <div className="grid" style={{ gap: GAP, gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` }}>
        {LANES.map((l, n) => {
          const on = n === step.lane;
          return (
            <div
              key={l.label}
              className="kb-lane-on h-[140px] rounded-lg border px-2 pt-1.5"
              style={{ borderColor: on ? tint(l.color, 45) : "var(--color-ink-800)", background: on ? tint(l.color, 7) : tint("var(--color-ink-900)", 60) }}
            >
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: on ? l.color : "var(--color-ink-500)" }}>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: l.color, opacity: on ? 1 : 0.45 }} />
                <span className="truncate">{l.label}</span>
              </div>
            </div>
          );
        })}
      </div>

      <Ghost lane={0} title="Rename API routes" color="var(--color-slate)" top={102} />
      <Ghost lane={1} title="Dark mode, part 2" color="var(--color-amber)" top={102} />
      <Ghost lane={3} title="Fix flaky test" color="var(--color-moss)" top={102} />

      <div
        className={`kb-card absolute top-[26px] rounded-md border bg-ink-900 px-2 py-1.5 shadow-lg shadow-black/40 ${step.ask ? "kb-ask" : ""}`}
        style={{ left: left(step.lane), width: WIDTH, borderColor: lane.color, borderLeftWidth: 3 }}
      >
        <div className="truncate text-[11.5px] font-semibold text-ink-100">Add a dark-mode toggle</div>
        <div className="mt-1 truncate font-mono text-[9.5px]" style={{ color: lane.color }}>
          {step.chip}
        </div>
        <div className={`mt-0.5 truncate text-[10.5px] text-ink-400 ${step.busy ? "kb-type" : ""}`}>{step.line}</div>
        {step.party ? (
          <span key={round} className="pointer-events-none absolute left-1/2 top-1/2">
            {BITS.map((b, n) => (
              <span
                key={n}
                className="kb-bit"
                style={{ background: b.c, animationDelay: `${b.delay}s`, ["--dx" as string]: `${b.dx}px`, ["--dy" as string]: `${b.dy}px`, ["--r" as string]: `${b.r}deg` }}
              />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
