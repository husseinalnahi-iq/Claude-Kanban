import { RUN_STYLE_LABEL, RUN_STYLES, type RunStyle } from "../../../server/src/types.ts";
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { pageZoom } from "../lib/view.ts";
import type { StageState, TaskCard } from "../../../server/src/types.ts";
import { isAnswerStage, stageLabel } from "../../../server/src/engine/answer.ts";
import { shortModel } from "../lib/format.ts";
import { memoryLine } from "../lib/memory.ts";
import type { MemoryFacts } from "../../../server/src/engine/memory.ts";

type Variant = "primary" | "ghost" | "danger" | "outline" | "go";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-amber text-ink-950 hover:bg-[var(--kb-amber-hover)] font-semibold",
  go: "bg-lime text-ink-950 hover:bg-[var(--kb-lime-hover)] font-semibold",
  outline: "border border-ink-600 text-ink-200 hover:border-ink-400 hover:text-ink-100 bg-ink-850",
  ghost: "text-ink-300 hover:text-ink-100 hover:bg-ink-800",
  danger: "border border-rust/50 text-rust hover:bg-rust/10",
};

export function Button({
  variant = "outline",
  size = "md",
  className = "",
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean }) {
  const s = size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]";
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap ${s} ${VARIANTS[variant]} ${className}`}
    >
      {busy ? <span className="breathe">…</span> : null}
      {children}
    </button>
  );
}

export function Chip({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[10.5px] uppercase tracking-wide border ${className}`}>
      {children}
    </span>
  );
}

/**
 * A `?` that explains something in place. The board is meant to be usable by someone who does not
 * already know what a worktree is, so the explanation lives next to the choice, not in a manual.
 */
export function Help({ children, width = "w-[300px]", align = "left" }: { children: ReactNode; width?: string; align?: "left" | "right" }) {
  return (
    <span className="relative inline-flex group/help align-middle">
      <span
        tabIndex={0}
        role="note"
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-ink-600 text-[10px] leading-none text-ink-400 transition-colors hover:border-amber hover:text-amber focus:border-amber focus:text-amber focus:outline-none"
      >
        ?
      </span>
      <span
        className={`pointer-events-none absolute bottom-[calc(100%+8px)] z-50 ${align === "right" ? "right-0" : "left-0"} ${width} rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-[12px] font-normal normal-case leading-snug tracking-normal text-ink-200 opacity-0 kb-raise-sm transition-opacity group-hover/help:opacity-100 group-focus-within/help:opacity-100`}
      >
        {children}
      </span>
    </span>
  );
}

/** The one explanation of the two modes, so every place that offers the choice says the same thing. */
export function ModeHelp({ align = "left" }: { align?: "left" | "right" }) {
  return (
    <Help width="w-[340px]" align={align}>
      <b className="text-amber">Autonomous</b> — Claude works in a private copy of the repo (a git
      worktree on its own branch). It edits freely there without asking, and nothing reaches your code
      until you press <b>Approve</b>, which merges the branch. Best for well-specified work you want to
      review as a finished diff. With Settings → <i>Autonomous tasks work in their own copy</i> off, or in a
      folder without git, it works in the project folder itself: Approve commits only the files it changed,
      Discard puts them back, and tasks that would change the same files take turns.
      <br />
      <br />
      <b className="text-cyan">Supervised</b> — Claude works directly in your project folder, and every
      single file write or command becomes a card you Allow or Deny. Nothing happens without you.
      Slower, but it is the only mode for a repo where an unreviewed write is unacceptable.
      <br />
      <br />
      <b className="text-iris">Autonomous + asks me</b> — autonomous in every way, except that when
      Claude has a question that changes the result, it stops and waits for your answer on a question
      card (options to tick, or your own words). Small choices it still makes itself and notes on the card.
      <br />
      <br />
      <b className="text-ink-100">A lookup</b> (an answer card) changes nothing, so under autonomous it
      runs in your project folder, reaches what the project reaches, and asks nothing — when the
      project's <i>autonomous access</i> is Full access.
    </Help>
  );
}

/** The colour of each way to run, so a picker and a chip agree: amber autonomous, cyan supervised, iris asks me. */
export const RUN_STYLE_TONE: Record<RunStyle, string> = {
  supervised: "border-cyan/60 bg-cyan/10 text-cyan",
  autonomous: "border-amber/60 bg-amber/10 text-amber",
  ask: "border-iris/60 bg-iris/10 text-iris",
};

/** The sliding highlight for each choice. Asks me is autonomous that stops to ask, so it spans both, amber into iris. */
const SWITCH_GLOW: Record<RunStyle, string> = {
  supervised: "border-cyan/45 bg-cyan/12",
  autonomous: "border-amber/45 bg-amber/12",
  ask: "border-iris/40 bg-linear-to-r from-amber/14 to-iris/20",
};
const SWITCH_WORD_TONE: Record<RunStyle, string> = { supervised: "text-cyan", autonomous: "text-amber", ask: "text-iris" };
const SWITCH_SIZE = {
  sm: { box: "inline-flex items-stretch rounded-md p-0.5", seg: "h-[26px] px-2.5 text-[11.5px]" },
  md: { box: "inline-flex h-[34px] items-stretch rounded-md p-0.5", seg: "px-2.5 text-[11.5px]" },
  lg: { box: "grid gap-1 rounded-lg p-1 sm:grid-cols-3", seg: "px-3 py-2 text-left text-[12.5px]" },
} as const;

/**
 * The one way a mode is picked: the chat, the New task form, a card's setup, the task drawer and Settings (D372).
 * A single highlight slides to the choice; on asks me it stretches over autonomous and asks me as one piece.
 */
export function RunStyleSwitch({
  value, onChange, size = "sm", blocked, titles, detail, disabled, capitalized, label = "How it runs",
}: {
  value: RunStyle;
  onChange: (s: RunStyle) => void;
  size?: keyof typeof SWITCH_SIZE;
  /** Why autonomous and asks me can't be picked here; null or absent when they can. */
  blocked?: string | null;
  titles?: Partial<Record<RunStyle, string>>;
  /** A second line under each choice, for the large tiles. */
  detail?: Partial<Record<RunStyle, ReactNode>>;
  disabled?: boolean;
  capitalized?: boolean;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const seg = useRef<Partial<Record<RunStyle, HTMLButtonElement | null>>>({});
  const [glow, setGlow] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // The first placement must not slide in from nowhere; only later changes move.
  const [placed, setPlaced] = useState(false);
  useLayoutEffect(() => {
    const place = () => {
      const from = seg.current[value === "ask" ? "autonomous" : value];
      const to = seg.current[value];
      if (!from || !to) return setGlow(null);
      // A union of the two boxes, so it also joins them when the tiles stack on a narrow screen.
      const left = Math.min(from.offsetLeft, to.offsetLeft);
      const top = Math.min(from.offsetTop, to.offsetTop);
      setGlow({
        left, top,
        width: Math.max(from.offsetLeft + from.offsetWidth, to.offsetLeft + to.offsetWidth) - left,
        height: Math.max(from.offsetTop + from.offsetHeight, to.offsetTop + to.offsetHeight) - top,
      });
    };
    place();
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    const t = requestAnimationFrame(() => setPlaced(true));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(t);
    };
  }, [value]);
  const s = SWITCH_SIZE[size];
  const word = (m: RunStyle) => {
    const w = m === "ask" ? "asks me" : m;
    return capitalized ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  };
  return (
    <div ref={box} role="radiogroup" aria-label={label} className={`relative shrink-0 border border-ink-700 ${s.box}`}>
      {glow ? (
        <div
          aria-hidden
          className={`pointer-events-none absolute rounded-[5px] border ${SWITCH_GLOW[value]} ${placed ? "transition-all duration-200 ease-out motion-reduce:transition-none" : ""}`}
          style={glow}
        />
      ) : null}
      {RUN_STYLES.map((m) => {
        const off = !!disabled || (m !== "supervised" && !!blocked);
        const lit = value === m || (value === "ask" && m === "autonomous");
        return (
          <button
            key={m}
            ref={(el) => {
              seg.current[m] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === m}
            aria-label={RUN_STYLE_LABEL[m]}
            disabled={off}
            title={(m !== "supervised" && blocked) || titles?.[m]}
            onClick={() => m !== value && onChange(m)}
            className={`relative z-[1] flex cursor-pointer flex-col justify-center rounded-[5px] transition-colors duration-200 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40 ${s.seg} ${
              lit ? SWITCH_WORD_TONE[m] : "text-ink-500 hover:text-ink-200"
            }`}
          >
            {m === "ask" ? (
              // On the seam between autonomous and asks me: "autonomous ▸ asks me", only while it is the choice.
              <span
                aria-hidden
                className={`absolute top-1/2 -left-[0.45em] -translate-y-1/2 text-[0.8em] text-iris transition-opacity duration-200 motion-reduce:transition-none ${size === "lg" ? "hidden sm:block" : ""} ${value === "ask" ? "opacity-100" : "opacity-0"}`}
              >
                ▸
              </span>
            ) : null}
            <span className={size === "lg" ? "font-semibold" : undefined}>{word(m)}</span>
            {detail?.[m] ? <span className="text-[11px] font-normal opacity-80">{detail[m]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A card's memory at a glance (D374): a green dot while warm, a grey ring once cooled. */
export function MemoryDot({ facts }: { facts: MemoryFacts }) {
  const warm = facts.memory === "warm";
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${warm ? "bg-moss shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-moss)_22%,transparent)]" : "border border-ink-500"}`}
      title={memoryLine(facts)}
      aria-label={warm ? "Memory warm" : "Memory cooled"}
    />
  );
}

export function ModeChip({ mode, ownBranch, lookup, mayAsk }: { mode: "autonomous" | "supervised"; ownBranch?: boolean; lookup?: boolean; mayAsk?: boolean }) {
  return mode === "autonomous" && mayAsk ? (
    <Chip className="border-iris/40 text-iris bg-iris/5" title="Autonomous + asks me: works without asking, and stops to ask you when your answer changes the result">auto · asks</Chip>
  ) : mode === "autonomous" && lookup ? (
    <Chip className="border-amber/40 text-amber bg-amber/5" title="Autonomous lookup: runs in the project's own folder and asks nothing. It reads and reports; it changes nothing">auto</Chip>
  ) : mode === "autonomous" ? (
    <Chip className="border-amber/40 text-amber bg-amber/5" title="Autonomous: works without asking — in its own git worktree, merged on Approve, or in the project folder when Settings say so or there is no git">auto</Chip>
  ) : ownBranch ? (
    <Chip className="border-cyan/40 text-cyan bg-cyan/5" title="Supervised on its own branch: every write is an approval card, and the work lands only when you approve">supervised · branch</Chip>
  ) : (
    <Chip className="border-cyan/40 text-cyan bg-cyan/5" title="Supervised: runs in the main checkout, every write is an approval card">supervised</Chip>
  );
}

/**
 * Everything open that Escape can close, oldest first. One key press closes only the newest: with a
 * listener each, Escape in a confirm dialog also closed the task drawer under it, and the chat beside it.
 */
const escapeLayers: { current: (e: KeyboardEvent) => void }[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // A drop-down list drawn by the page (Chrome's styled <select>) is a layer of its own: Escape
    // closes the list and nothing else. The operating system's list never let the key reach here.
    if (selectListOpen(e.target)) return;
    escapeLayers[escapeLayers.length - 1]?.current(e);
  });
}

/** The key lands on the list's focused option, or on the select itself while its list is open. */
function selectListOpen(target: EventTarget | null): boolean {
  if (target instanceof HTMLOptionElement) return true;
  if (!(target instanceof HTMLSelectElement)) return false;
  try {
    return target.matches(":open");
  } catch {
    return false;
  }
}

/** Close on Escape, but only while this is the top thing on screen. `active` is for pop-ups that are sometimes shut. */
export function useEscape(onEscape: (e: KeyboardEvent) => void, active = true) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    escapeLayers.push(ref);
    return () => {
      const i = escapeLayers.indexOf(ref);
      if (i >= 0) escapeLayers.splice(i, 1);
    };
  }, [active]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps the keyboard inside a dialog while it is open: Tab goes round its own controls instead of
 * wandering into the page behind it, and focus returns to where it was when the dialog closes.
 * Put the ref on the dialog's box, with `tabIndex={-1}` so it can hold focus when nothing inside asks for it.
 */
export function useFocusTrap<T extends HTMLElement>() {
  const box = useRef<T>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    // A field with autoFocus already has it; otherwise the dialog itself takes it.
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      // A dialog opened inside this one has already turned the corner.
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length);
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!first || !last) e.preventDefault();
      else if (e.shiftKey && (at === first || at === el)) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && at === last) (e.preventDefault(), first.focus());
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return box;
}

export function Modal({ title, onClose, children, width = "max-w-xl" }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEscape(onClose);
  const box = useFocusTrap<HTMLDivElement>();
  return (
    // The overlay scrolls, so a form taller than the window (a long pipeline) still reaches its buttons.
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[var(--kb-scrim)] backdrop-blur-[2px]">
      {/* The click-outside area is this inner layer, not the scrolling one: a press on the overlay's own
          scrollbar — the way to reach those buttons — used to close the form and lose what was typed. */}
      <div className="flex min-h-full items-start justify-center p-6 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`rise w-full ${width} rounded-xl border border-ink-700 bg-ink-900 kb-raise focus:outline-none`}>
          <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3">
            <h2 className="text-[14px] font-semibold text-ink-100">{title}</h2>
            <button className="text-ink-400 hover:text-ink-100 cursor-pointer text-lg leading-none" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="px-5 py-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** On/off switch, for a setting whose two states are worth seeing at a glance. */
export function Switch({ on, disabled, onChange, title }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-moss/70" : "bg-ink-700"}`}
    >
      <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-ink-100 transition-all ${on ? "left-[16px]" : "left-[2px]"}`} />
    </button>
  );
}

/** Labelled form row. `group` renders a div so a click on empty space can't activate the first control inside. */
export function Field({ label, hint, group, children }: { label: ReactNode; hint?: ReactNode; group?: boolean; children: ReactNode }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="block" role={group ? "group" : undefined} aria-label={group && typeof label === "string" ? label : undefined}>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-ink-400">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-[11.5px] text-ink-400">{hint}</div> : null}
    </Tag>
  );
}

export const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[13px] text-ink-100 placeholder:text-ink-500 focus:border-amber/60 focus:outline-none";

/** The one arrow every drop-down and the model picker share, so they read as one family of control. */
export function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 12 12" width="12" height="12" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** A box with its lid: put away, kept. */
export function ArchiveIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className={`shrink-0 ${className}`} {...ICON}>
      <path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M6.5 9.5h3" />
    </svg>
  );
}

/** An arrow turning back: bring it out again. */
export function RestoreIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className={`shrink-0 ${className}`} {...ICON}>
      <path d="M3 7.5h7a3 3 0 0 1 0 6H6M5.5 5 3 7.5 5.5 10" />
    </svg>
  );
}

export function FolderIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className={`shrink-0 ${className}`} {...ICON}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function TrashIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className={`shrink-0 ${className}`} {...ICON}>
      <path d="M3 4.5h10M6.5 4.5v-1h3v1M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.5M9.2 7v3.5" />
    </svg>
  );
}

export function PaperclipIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="15" height="15" className={`shrink-0 ${className}`} {...ICON}>
      <path d="M10.5 5.5 6.2 9.8a1.3 1.3 0 0 0 1.8 1.8l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4-4" />
    </svg>
  );
}

/** An arrow leaving a box: open it outside the board, on this computer. */
export function OpenIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className={`shrink-0 ${className}`} {...ICON}>
      <path d="M7 3H3.5v9.5H13V9M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5" />
    </svg>
  );
}

export function PencilIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className={`shrink-0 ${className}`} {...ICON}>
      <path d="M3 13h3l7-7-3-3-7 7zM9 4l3 3" />
    </svg>
  );
}

/**
 * Whether this browser lets the page style the open list of a <select> (Chrome and Edge 135+). Where
 * it does, an option can carry a second line (`data-note`); where it does not, the list is the
 * operating system's own and only the option text shows, so callers fold the note into the text.
 */
export const RICH_SELECT = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("appearance", "base-select");

/**
 * A drop-down list: the browser's own <select>, so the keyboard, screen readers and forms keep
 * working, dressed to match the board. The closed box gets the shared arrow; in Chrome the open list
 * is styled too (`.kb-select` in index.css) instead of the operating system's white menu. Sized to
 * its content like a button unless `wide`, which fills the row. `wrapClassName` sizes the whole
 * control (a max width, say), `className` the box itself.
 */
export function Select({
  className = "", wrapClassName = "", wide, children, ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { wide?: boolean; wrapClassName?: string }) {
  return (
    <span className={`kb-select relative inline-flex min-w-0 max-w-full ${wide ? "w-full" : ""} ${wrapClassName}`}>
      <select
        {...rest}
        className={`${inputCls} ${wide ? "" : "w-auto!"} cursor-pointer appearance-none truncate pr-7 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        {children}
      </select>
      <Chevron className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-500" />
    </span>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-md border border-rust/40 bg-rust/10 px-3 py-2 text-[12.5px] text-rust">{error}</div>;
}

/** Runs an async action, tracking busy + error for inline display. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-ink-700 px-4 py-8 text-center text-[12.5px] text-ink-400">{children}</div>;
}

/**
 * A panel that drops down from a button in the top bar. Portalled to <body> and fixed to the
 * viewport, because the top bar scrolls sideways — and a box that scrolls one way clips both, so an
 * `absolute` panel inside it opened invisibly (D281). Right-aligned to its button, kept on screen,
 * re-measured on resize and scroll; a click outside both the button and the panel closes it.
 */
export function AnchoredPanel({
  anchor, open, onClose, width, children, className = "",
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width: number;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const place = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    // Measured in screen pixels, placed in zoomed ones (see pageZoom).
    const z = pageZoom();
    const w = Math.min(width * z, window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const top = r.bottom + 6;
    const next = { left: left / z, top: top / z, width: w / z, maxHeight: (window.innerHeight - top - 12) / z };
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.maxHeight === next.maxHeight ? prev : next));
  };

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) closeRef.current();
    };
    let frame = 0;
    const soon = (e?: Event) => {
      if (e && panel.current?.contains(e.target as Node)) return;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", soon);
    window.addEventListener("scroll", soon, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", soon);
      window.removeEventListener("scroll", soon, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEscape(() => onClose(), open);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panel}
      className={`rise fixed z-[90] overflow-y-auto rounded-xl border border-ink-700 bg-ink-900 kb-raise ${className}`}
      style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
    >
      {children}
    </div>,
    document.body,
  );
}

const STAGE_DOT: Record<StageState, string> = {
  idle: "border border-ink-500 bg-transparent",
  running: "bg-amber breathe",
  approval: "bg-rose pulse-rose",
  success: "bg-moss",
  failed: "bg-rust",
};
const STAGE_LETTER = { plan: "P", code: "C", review: "R", custom: "·" } as const;

/** A card's stages as dots: which ran, which runs, which failed; the letter says which stage, the word which model. */
export function StageDots({ card }: { card: Pick<TaskCard, "pipeline" | "stage_states"> }) {
  return (
    <>
      {card.pipeline.map((s, i) => (
        <span key={i} className={`flex items-center gap-1 font-mono text-[10px] ${s.provider ? "text-iris" : "text-ink-400"}`} title={`${stageLabel(s)} · ${s.model}${s.provider ? ` via ${s.provider}` : ""} · ${s.effort} · ${card.stage_states[i] ?? "idle"}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${STAGE_DOT[card.stage_states[i] ?? "idle"]}`} />
          <span className="text-ink-500">{isAnswerStage(s) ? "A" : STAGE_LETTER[s.stage]}</span>
          {shortModel(s.model).split("-")[0]}
          {s.fast ? <span className="text-amber" title="Fast mode">↯</span> : null}
        </span>
      ))}
    </>
  );
}

