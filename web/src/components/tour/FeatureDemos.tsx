import type { CSSProperties, ReactNode } from "react";
import { tint } from "./TourStyles.tsx";

/**
 * Small looping pictures of the headline features, on their Tour cards. Each one is drawn in its
 * resting state — the moment that explains the feature — and plays only while its card is hovered or
 * has focus, so a page of them is calm until you look at one.
 *
 * Every demo shares one timeline per loop (`--t`): `at*` classes appear at a point and stay, `w1`–`w3`
 * take a third each in the same spot, so the states of a demo stay in step without timers.
 */

const vars = (v: Record<string, string>) => v as CSSProperties;
const STACK = "col-start-1 row-start-1";

function Frame({ color, on, children }: { color: string; on: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden
      className={`kb-demo relative mt-3 h-[76px] overflow-hidden rounded-lg border ${on ? "kb-demo-on" : ""}`}
      style={{ borderColor: tint(color, 20), background: tint(color, 5) }}
    >
      {children}
    </div>
  );
}

/** Three states taking turns in one place; the last is the one shown at rest. */
function Turns({ items, className = "" }: { items: [ReactNode, ReactNode, ReactNode]; className?: string }) {
  return (
    <span className={`inline-grid ${className}`}>
      {items.map((it, i) => (
        <span key={i} className={`${STACK} kb-d-w${i + 1} whitespace-nowrap`}>
          {it}
        </span>
      ))}
    </span>
  );
}

const STAGES: [string, string][] = [
  ["plan", "opus · high"],
  ["code", "opus · medium"],
  ["review", "sonnet · medium"],
];

function Pipeline({ color }: { color: string }) {
  return (
    <>
      <div className="absolute inset-x-3 top-3 grid grid-cols-3 gap-2">
        {STAGES.map(([s, m], i) => (
          <div key={s} className="kb-d-stage rounded-md border border-ink-700 bg-ink-900 px-2 py-1" style={vars({ "--d": `${i * 1.2}s`, "--c": color })}>
            <div className="text-[10.5px] font-semibold text-ink-100">{s}</div>
            <div className="truncate font-mono text-[9px] text-ink-500">{m}</div>
          </div>
        ))}
      </div>
      <div className="absolute inset-x-3 bottom-3 h-[3px] overflow-hidden rounded-full bg-ink-800">
        <span className="kb-d-fill block h-full w-full rounded-full" style={{ background: color }} />
      </div>
    </>
  );
}

function Chat({ color }: { color: string }) {
  return (
    <>
      <div className="kb-d-at0 absolute right-3 top-2.5 max-w-[80%] truncate rounded-lg rounded-br-sm px-2 py-1 text-[10.5px] text-ink-100" style={{ background: tint(color, 22) }}>
        get me the latest purchase order
      </div>
      <div className="absolute bottom-2.5 left-3 flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[9.5px]">
        <span className="text-ink-400">✦ card</span>
        <Turns
          items={[
            <span className="text-ink-500">⏳ queued</span>,
            <span className="text-amber">● looking it up…</span>,
            <span className="text-moss">✓ PO-1042 · ACME · $0.02</span>,
          ]}
        />
      </div>
    </>
  );
}

function Schedule({ color }: { color: string }) {
  return (
    <div className="absolute inset-0 flex items-center gap-3 px-3">
      <svg viewBox="0 0 44 44" className="h-[52px] w-[52px] shrink-0">
        <circle cx="22" cy="22" r="19" fill="var(--color-ink-900)" stroke={tint(color, 55)} strokeWidth="1.5" />
        {[0, 90, 180, 270].map((a) => (
          <line key={a} x1="22" y1="5.5" x2="22" y2="8" stroke="var(--color-ink-500)" strokeWidth="1.2" transform={`rotate(${a} 22 22)`} />
        ))}
        <line className="kb-d-hour" x1="22" y1="22" x2="22" y2="12.5" stroke="var(--color-ink-100)" strokeWidth="2.2" strokeLinecap="round" />
        <line className="kb-d-min" x1="22" y1="22" x2="22" y2="7.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="22" cy="22" r="1.6" fill="var(--color-ink-100)" />
      </svg>
      <div className="min-w-0 font-mono text-[10px] leading-relaxed">
        <div className="truncate text-ink-300">⏰ every Monday · 2:00 AM</div>
        <Turns
          items={[
            <span className="text-ink-500">☾ 22:00 · waiting</span>,
            <span className="text-ink-500">☾ 01:00 · waiting</span>,
            <span style={{ color }}>▶ 02:00 · started by itself</span>,
          ]}
        />
      </div>
    </div>
  );
}

function Modes({ color }: { color: string }) {
  return (
    <div className="absolute inset-0 grid grid-cols-3">
      <div className="relative border-r border-ink-800 px-3 pt-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em]" style={{ color }}>✋ supervised</div>
        <div className="kb-d-at0 mt-1.5 rounded-md border border-ink-700 bg-ink-900 px-2 py-1">
          <div className="truncate text-[10px] text-ink-200">Edit Header.tsx?</div>
          <div className="mt-1 flex items-center gap-1 font-mono text-[9px]">
            <span className="kb-d-press rounded border border-moss/60 px-1.5 text-moss">Allow</span>
            <span className="rounded border border-ink-700 px-1.5 text-ink-500">Deny</span>
            <span className="kb-d-at50 ml-auto text-moss" title="allowed">✓</span>
          </div>
        </div>
      </div>
      <div className="relative px-3 pt-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-cyan">⑂ autonomous</div>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-x-3 bottom-2 h-[40px] w-[calc(100%-24px)]">
          <path d="M2 34 H98" stroke="var(--color-ink-600)" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
          <path
            className="kb-d-draw"
            d="M10 34 C22 34 20 14 32 14 H70 C82 14 80 34 92 34"
            stroke="var(--color-cyan)"
            strokeWidth="1.5"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* the commits sit outside the stretched svg so they stay round */}
        {[0.38, 0.52, 0.66].map((x, i) => (
          <span
            key={x}
            className={`kb-d-at${[25, 50, 75][i]} absolute h-[7px] w-[7px] rounded-full bg-cyan`}
            style={{ left: `calc(12px + (100% - 24px) * ${x} - 3.5px)`, bottom: `calc(8px + 40px * ${26 / 40} - 3.5px)` }}
          />
        ))}
      </div>
      {/* Autonomous + asks me: the same branch, but a question that changes the result waits for you (D361). */}
      <div className="relative border-l border-ink-800 px-3 pt-2">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-iris">? asks me</div>
        <div className="kb-d-at25 mt-1.5 rounded-md border border-iris/40 bg-ink-900 px-2 py-1">
          <div className="truncate text-[10px] text-ink-200">Blue or green?</div>
          <div className="mt-1 flex items-center gap-1 font-mono text-[9px]">
            <span className="kb-d-at50 rounded border border-iris/60 bg-iris/15 px-1.5 text-iris">Blue</span>
            <span className="rounded border border-ink-700 px-1.5 text-ink-500">Green</span>
          </div>
        </div>
        <div className="kb-d-at75 mt-1 truncate font-mono text-[9px] text-iris">✓ carries on</div>
      </div>
    </div>
  );
}

function Steer({ color }: { color: string }) {
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-1 px-3 font-mono text-[9.5px]">
      <div className="kb-d-at0 truncate text-ink-400">
        <span style={{ color }}>●</span> editing Header.tsx — accent colour
      </div>
      <div className="kb-d-at25 self-end truncate rounded-lg rounded-br-sm px-2 py-0.5 font-sans text-[10.5px] text-ink-100" style={{ background: tint(color, 22) }}>
        use the blue from the header
      </div>
      <div className="kb-d-at50 truncate text-ink-300">
        <span className="text-moss">↳</span> heard you — switching to the header's blue
      </div>
    </div>
  );
}

function Usage({ color }: { color: string }) {
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-2 px-3">
      <div className="flex items-center gap-2 font-mono text-[9.5px] text-ink-400">
        <span className="shrink-0">5-hour window</span>
        <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-ink-800">
          <span className="kb-d-meter block h-full rounded-full" style={vars({ "--c": color, background: color, width: "62%" })} />
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[9.5px]">
        <span className="truncate text-ink-200">Dark mode, part 2</span>
        <Turns
          className="ml-auto"
          items={[
            <span className="text-amber">● coding</span>,
            <span className="text-rose">⏸ paused · resets 14:00</span>,
            <span className="text-moss">▶ carried on by itself</span>,
          ]}
        />
      </div>
    </div>
  );
}

function Alerts({ color }: { color: string }) {
  const toast = (c: string, head: string, body: string) => (
    <span className="flex items-center gap-2 rounded-md border bg-ink-900 px-2 py-1" style={{ borderColor: tint(c, 55) }}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c }} />
      <span className="font-semibold" style={{ color: c }}>{head}</span>
      <span className="truncate text-ink-300">{body}</span>
    </span>
  );
  return (
    <div className="absolute inset-0 flex items-center gap-3 px-3 text-[10px]">
      <span className="kb-d-bell inline-block shrink-0" style={{ color }}>
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" />
          <path d="M10 20.5a2 2 0 0 0 4 0" strokeLinecap="round" />
        </svg>
      </span>
      <Turns
        className="min-w-0 flex-1"
        items={[
          toast("var(--color-lime)", "Ready for review", "Dark mode toggle"),
          toast("var(--color-moss)", "Landed ✓", "Fix flaky test · $0.42"),
          toast("var(--color-rose)", "Needs you", "Allow git commit?"),
        ]}
      />
    </div>
  );
}

const DEMOS: Record<string, (p: { color: string }) => ReactNode> = {
  pipeline: Pipeline,
  chat: Chat,
  schedule: Schedule,
  modes: Modes,
  steer: Steer,
  usage: Usage,
  alerts: Alerts,
};

export const hasDemo = (id: string) => id in DEMOS;

export function FeatureDemo({ id, color, on }: { id: string; color: string; on: boolean }) {
  const Demo = DEMOS[id];
  if (!Demo) return null;
  return (
    <Frame color={color} on={on}>
      <Demo color={color} />
    </Frame>
  );
}

const CSS = `
.kb-demo { --t: 4.2s; }
.kb-demo .kb-d-w1, .kb-demo .kb-d-w2 { opacity: 0; }
.kb-demo-on .kb-d-at0  { animation: kb-at0  var(--t) infinite both; }
.kb-demo-on .kb-d-at25 { animation: kb-at25 var(--t) infinite both; }
.kb-demo-on .kb-d-at50 { animation: kb-at50 var(--t) infinite both; }
.kb-demo-on .kb-d-at75 { animation: kb-at75 var(--t) infinite both; }
.kb-demo-on .kb-d-w1 { animation: kb-w1 var(--t) infinite both; }
.kb-demo-on .kb-d-w2 { animation: kb-w2 var(--t) infinite both; }
.kb-demo-on .kb-d-w3 { animation: kb-w3 var(--t) infinite both; }
@keyframes kb-at0  { 0% { opacity: 0; transform: translateY(5px) } 6%, 92% { opacity: 1; transform: none } 100% { opacity: 0 } }
@keyframes kb-at25 { 0%, 22% { opacity: 0; transform: translateY(5px) } 30%, 92% { opacity: 1; transform: none } 100% { opacity: 0 } }
@keyframes kb-at50 { 0%, 47% { opacity: 0; transform: translateY(5px) } 55%, 92% { opacity: 1; transform: none } 100% { opacity: 0 } }
@keyframes kb-at75 { 0%, 72% { opacity: 0; transform: translateY(5px) } 80%, 92% { opacity: 1; transform: none } 100% { opacity: 0 } }
@keyframes kb-w1 { 0% { opacity: 0 } 4%, 30% { opacity: 1 } 34%, 100% { opacity: 0 } }
@keyframes kb-w2 { 0%, 30% { opacity: 0 } 34%, 63% { opacity: 1 } 67%, 100% { opacity: 0 } }
@keyframes kb-w3 { 0%, 63% { opacity: 0 } 67%, 96% { opacity: 1 } 100% { opacity: 0 } }

/* pipeline: no fill, so a stage waiting for its turn keeps its resting look */
.kb-demo-on .kb-d-stage { animation: kb-d-stage 3.6s var(--d) infinite; }
.kb-demo-on .kb-d-fill { animation: kb-d-fill 3.6s linear infinite; }
@keyframes kb-d-stage {
  0%, 28% { border-color: var(--c); background: color-mix(in srgb, var(--c) 14%, var(--color-ink-900)); transform: translateY(-2px) }
  36%, 100% { border-color: var(--color-ink-700); background: var(--color-ink-900); transform: none }
}
@keyframes kb-d-fill { from { width: 0 } to { width: 100% } }

/* schedule: four hours of minute hand while the hour hand walks from 10 to 2 */
.kb-d-hour, .kb-d-min { transform-box: view-box; transform-origin: 50% 50%; }
.kb-d-hour { transform: rotate(60deg); }
.kb-demo-on .kb-d-hour { animation: kb-d-hour var(--t) infinite both; }
.kb-demo-on .kb-d-min { animation: kb-d-min var(--t) infinite both; }
@keyframes kb-d-hour { 0% { transform: rotate(-60deg) } 66%, 100% { transform: rotate(60deg) } }
@keyframes kb-d-min { 0% { transform: rotate(0) } 66%, 100% { transform: rotate(1440deg) } }

/* modes */
.kb-demo-on .kb-d-press { animation: kb-d-press var(--t) infinite both; }
@keyframes kb-d-press {
  0%, 40% { transform: none; background: transparent; color: var(--color-moss) }
  44% { transform: scale(.85) }
  48%, 92% { transform: none; background: var(--color-moss); color: var(--color-ink-950) }
  100% { background: transparent; color: var(--color-moss) }
}
/* Dashes of a non-scaling stroke are measured on screen, not in the stretched viewBox (where pathLength
   would be), so the dash is simply longer than the branch can ever be drawn. */
.kb-d-draw { stroke-dasharray: 800; }
.kb-demo-on .kb-d-draw { animation: kb-d-draw var(--t) infinite both; }
@keyframes kb-d-draw { 0% { stroke-dashoffset: 800 } 70%, 100% { stroke-dashoffset: 0 } }

/* usage: the window fills, hits the limit, resets, and the task carries on */
.kb-demo-on .kb-d-meter { animation: kb-d-meter var(--t) infinite both; }
@keyframes kb-d-meter {
  0% { width: 38%; background: var(--c) }
  30% { width: 92%; background: var(--c) }
  34%, 63% { width: 100%; background: var(--color-rose) }
  67% { width: 3%; background: var(--c) }
  100% { width: 22%; background: var(--c) }
}

/* alerts: the bell rings as each new toast lands */
.kb-demo-on .kb-d-bell { transform-origin: 50% 10%; animation: kb-d-bell var(--t) infinite; }
@keyframes kb-d-bell {
  0%, 9%, 33%, 42%, 66%, 75%, 100% { transform: none }
  2%, 35%, 68% { transform: rotate(-16deg) } 5%, 38%, 71% { transform: rotate(14deg) } 7%, 40%, 73% { transform: rotate(-8deg) }
}

.kb-demo-hint { transition: opacity .25s; }
.kb-feature:is(:hover, :focus-within) .kb-demo-hint { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .kb-demo-on * { animation: none !important; }
  .kb-demo-hint { display: none; }
}
`;

export const DemoStyles = () => <style>{CSS}</style>;
