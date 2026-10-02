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

/** Where one card is at one step. Absent from a step's `cards`, a card is not on the board yet. */
interface CardAt {
  lane: number;
  chip: string;
  line: string;
  /** The card's colour while it is in In progress, as its badge on the real board. */
  color?: string;
  busy?: boolean;
  ask?: boolean;
  party?: boolean;
}

interface Step {
  ms: number;
  sound?: SoundId;
  /** What is going on, under the board; `you` and `claude` draw it as a chat message. */
  say: string;
  who?: "you" | "claude";
  cards: Record<string, CardAt>;
}

interface Scene {
  id: string;
  label: string;
  /** Card titles by key; their order is their row on the board. */
  titles: Record<string, string>;
  ghosts: { lane: number; title: string; color: string }[];
  steps: Step[];
}

const at = (lane: number, chip: string, line: string, more: Partial<CardAt> = {}): CardAt => ({ lane, chip, line, ...more });
const CYAN = "var(--color-cyan)";
const ROSE = "var(--color-rose)";
const IRIS = "var(--color-iris)";

const SCENES: Scene[] = [
  {
    id: "life",
    label: "A task's life",
    titles: { a: "Add a dark-mode toggle" },
    ghosts: [
      { lane: 0, title: "Rename API routes", color: "var(--color-slate)" },
      { lane: 1, title: "Dark mode, part 2", color: "var(--color-amber)" },
      { lane: 3, title: "Fix flaky test", color: "var(--color-moss)" },
    ],
    steps: [
      { ms: 1500, say: "Queued: it waits for a free slot.", cards: { a: at(0, "queued", "waiting for a free slot") } },
      { ms: 1700, sound: "started", say: "Plan: the strongest model reads the code first.", cards: { a: at(1, "planning · opus-5-5 · high", "reading the code", { color: CYAN, busy: true }) } },
      { ms: 1600, say: "Code: it works through the plan, step by step.", cards: { a: at(1, "coding · opus-5-5 · medium", "editing 3 files", { busy: true }) } },
      { ms: 1500, say: "It opens what it built in a browser and looks.", cards: { a: at(1, "📸 browser check", "screenshot looks right") } },
      { ms: 2000, sound: "approval", say: "A change that needs you rings the bell.", cards: { a: at(1, "needs you", "Allow: git commit?", { color: ROSE, ask: true }) } },
      { ms: 800, say: "You said yes.", cards: { a: at(1, "✓ allowed", "you said yes") } },
      { ms: 1600, say: "Review: a cheaper model checks every step was done.", cards: { a: at(1, "reviewing · sonnet-5-5 · medium", "checking its own work", { busy: true }) } },
      { ms: 1500, sound: "review", say: "Ready for you: the diff to look over.", cards: { a: at(2, "ready for you", "the diff to look over") } },
      { ms: 2800, sound: "done", say: "Approved, it lands on main — one task at a time.", cards: { a: at(3, "landed ✓  $0.42", "merged into main", { party: true }) } },
    ],
  },
  {
    id: "chat",
    label: "Ask the chat",
    titles: { a: "Latest purchase order" },
    ghosts: [{ lane: 3, title: "Fix flaky test", color: "var(--color-moss)" }],
    steps: [
      { ms: 1900, who: "you", say: "get me the latest purchase order", cards: {} },
      { ms: 1500, say: "The chat makes a card for it: a lookup, one cheap step.", cards: { a: at(0, "✦ from the chat", "a lookup · haiku · low") } },
      { ms: 2000, sound: "started", say: "It runs straight away, because you asked it to.", cards: { a: at(1, "looking it up", "reading the orders", { color: CYAN, busy: true }) } },
      { ms: 1300, say: "It lands with its answer…", cards: { a: at(3, "answered ✓  $0.02", "sent back to the chat") } },
      { ms: 3000, sound: "done", who: "claude", say: "PO-1042 from ACME, $1,240 — placed yesterday.", cards: { a: at(3, "answered ✓  $0.02", "sent back to the chat") } },
    ],
  },
  {
    id: "chain",
    label: "One after another",
    titles: { a: "Find the latest order", b: "Email its supplier" },
    ghosts: [],
    steps: [
      { ms: 2100, say: "Starts after: the second task waits for the first. Queue both at once.", cards: { a: at(0, "queued", "ready to go"), b: at(0, "⏳ starts after “Find…”", "takes no run slot") } },
      { ms: 1900, sound: "started", say: "The first one runs; the second keeps waiting.", cards: { a: at(1, "looking it up", "reading the orders", { color: CYAN, busy: true }), b: at(0, "⏳ starts after “Find…”", "takes no run slot") } },
      { ms: 1500, sound: "done", say: "The first is done…", cards: { a: at(3, "done ✓", "PO-1042 · ACME"), b: at(0, "⏳ starting…", "its wait is over") } },
      { ms: 2200, sound: "started", say: "…so the second starts by itself, told what the first found.", cards: { a: at(3, "done ✓", "PO-1042 · ACME"), b: at(1, "coding · sonnet-5-5", "using PO-1042 from ACME", { busy: true }) } },
      { ms: 2600, sound: "review", say: "Ready for you to look over.", cards: { a: at(3, "done ✓", "PO-1042 · ACME"), b: at(2, "ready for you", "the email to send") } },
    ],
  },
  {
    id: "limit",
    label: "Usage runs out",
    titles: { a: "Dark mode, part 2" },
    ghosts: [{ lane: 0, title: "Rename API routes", color: "var(--color-slate)" }],
    steps: [
      { ms: 1700, sound: "started", say: "Your 5-hour window is nearly used up.", cards: { a: at(1, "coding · opus-5-5 · medium", "editing 4 files", { busy: true }) } },
      { ms: 2200, sound: "paused", say: "It hits the limit and pauses. Nothing fails, nothing is lost.", cards: { a: at(1, "⏸ usage limit", "resets at 14:00", { color: IRIS }) } },
      { ms: 1400, say: "The queue waits for the same window rather than walk into the wall.", cards: { a: at(1, "⏸ 13:59", "one minute to go", { color: IRIS }) } },
      { ms: 2000, sound: "resumed", say: "The window resets, and it carries on where it stopped.", cards: { a: at(1, "coding · resumed", "picks up at step 4 of 7", { busy: true }) } },
      { ms: 2400, sound: "review", say: "Ready for you, as if nothing happened.", cards: { a: at(2, "ready for you", "the diff to look over") } },
    ],
  },
];

const N = LANES.length;
const GAP = 8;
const ROW = 64;
const TOP = 26;
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

function Card({ title, c, row, round }: { title: string; c: CardAt; row: number; round: number }) {
  const color = c.color ?? LANES[c.lane]!.color;
  return (
    <div
      className={`kb-card kb-card-in absolute rounded-md border bg-ink-900 px-2 py-1.5 kb-raise-sm ${c.ask ? "kb-ask" : ""}`}
      style={{ left: left(c.lane), width: WIDTH, top: TOP + row * ROW, borderColor: color, borderLeftWidth: 3 }}
    >
      <div className="truncate text-[11.5px] font-semibold text-ink-100">{title}</div>
      <div className="mt-1 truncate font-mono text-[9.5px]" style={{ color }}>
        {c.chip}
      </div>
      <div className={`mt-0.5 truncate text-[10.5px] text-ink-400 ${c.busy ? "kb-type" : ""}`}>{c.line}</div>
      {c.party ? (
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
  );
}

function Say({ step }: { step: Step }) {
  if (step.who === "you")
    return (
      <span className="ml-auto max-w-full truncate rounded-xl rounded-br-sm px-3 py-1 text-[12px] text-ink-100" style={{ background: tint("var(--color-amber)", 22) }}>
        {step.say}
      </span>
    );
  if (step.who === "claude")
    return (
      <span className="max-w-full truncate rounded-xl rounded-bl-sm border border-ink-700 bg-ink-900 px-3 py-1 text-[12px] text-ink-100">
        <span className="mr-1.5 text-amber">✦</span>
        {step.say}
      </span>
    );
  return <span className="truncate text-[12px] text-ink-300">{step.say}</span>;
}

/**
 * A pretend board, in the real status colours, where a few short scenes play: one task's whole life,
 * a question to the chat, a chain of two tasks, a usage limit. `scenes` picks which and shows a picker
 * when there is more than one; they then play one after another. With `sound` on, each step plays
 * the sound the real board would, in your chosen theme.
 */
export function MiniBoard({ sound = false, scenes = ["life"], className = "" }: { sound?: boolean; scenes?: string[]; className?: string }) {
  const list = SCENES.filter((s) => scenes.includes(s.id));
  const [n, setN] = useState(0);
  const [i, setI] = useState(0);
  const [round, setRound] = useState(0);
  const prefs = useAlertPrefs();
  const scene = list[n] ?? SCENES[0]!;
  const step = scene.steps[i] ?? scene.steps[0]!;
  const keys = Object.keys(scene.titles);
  const total = scene.steps.reduce((t, s) => t + s.ms, 0);

  useEffect(() => {
    const t = setTimeout(() => {
      if (i < scene.steps.length - 1) return setI(i + 1);
      setRound((r) => r + 1);
      setN((n + 1) % list.length);
      setI(0);
    }, step.ms);
    return () => clearTimeout(t);
    // `round` too: picking the scene already on its first step changes nothing else, and must still restart it.
  }, [i, n, round, step.ms, scene.steps.length, list.length]);

  useEffect(() => {
    if (sound && step.sound) playSound(step.sound, prefs.theme, prefs.volume);
    // Only on arriving at a step, not when the theme or volume is changed mid-step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, n, sound]);

  const pick = (k: number) => {
    setN(k);
    setI(0);
    setRound((r) => r + 1);
  };

  // One height for every scene in the list, so switching scenes never makes the page jump.
  const laneH = Math.max(140, TOP + Math.max(...list.map((s) => Object.keys(s.titles).length)) * ROW + 14);
  const busyLane = new Set(keys.map((k) => step.cards[k]?.lane).filter((l) => l !== undefined));

  return (
    <div className={`select-none ${className}`}>
      {list.length > 1 ? (
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Pick a scene">
          {list.map((s, k) => (
            <button
              key={s.id}
              aria-pressed={k === n}
              onClick={() => pick(k)}
              className={`relative cursor-pointer overflow-hidden rounded-full border px-3 py-1 text-[11.5px] transition-colors ${
                k === n ? "border-ink-500 bg-ink-850 text-ink-100" : "border-ink-800 text-ink-400 hover:border-ink-600 hover:text-ink-200"
              }`}
            >
              {s.label}
              {k === n ? (
                <span
                  key={`${s.id}-${round}`}
                  aria-hidden
                  className="kb-scene-bar absolute inset-x-0 bottom-0 h-[2px] bg-amber"
                  style={{ ["--kb-dur" as string]: `${total}ms` }}
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="relative" aria-label={`A demo: ${scene.label}. ${step.say}`} role="img">
        <div className="grid" style={{ gap: GAP, gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` }}>
          {LANES.map((l, k) => {
            const on = busyLane.has(k);
            const color = keys.map((key) => step.cards[key]).find((c) => c?.lane === k)?.color ?? l.color;
            return (
              <div
                key={l.label}
                className="kb-lane-on rounded-lg border px-2 pt-1.5"
                style={{ height: laneH, borderColor: on ? tint(color, 45) : "var(--color-ink-700)", background: on ? tint(color, 7) : tint("var(--color-ink-850)", 70) }}
              >
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: on ? color : "var(--color-ink-500)" }}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: l.color, opacity: on ? 1 : 0.45 }} />
                  <span className="truncate">{l.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        {scene.ghosts.map((g) => (
          <Ghost key={`${scene.id}-${g.title}`} lane={g.lane} title={g.title} color={g.color} top={laneH - 38} />
        ))}

        {/* keyed by scene, so a new scene's cards start where they are instead of sliding over from the last one */}
        {keys.map((k, row) => {
          const c = step.cards[k];
          return c ? <Card key={`${scene.id}-${k}`} title={scene.titles[k]!} c={c} row={row} round={round} /> : null;
        })}
      </div>

      <div className="mt-3 flex h-[30px] items-center">
        <span key={`${scene.id}-${i}-${round}`} className="kb-say flex min-w-0 flex-1">
          <Say step={step} />
        </span>
      </div>
    </div>
  );
}
