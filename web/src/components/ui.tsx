import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger" | "outline" | "go";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-amber text-ink-950 hover:bg-[#ffbb55] font-semibold",
  go: "bg-lime/90 text-ink-950 hover:bg-lime font-semibold",
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
        className={`pointer-events-none absolute bottom-[calc(100%+8px)] z-50 ${align === "right" ? "right-0" : "left-0"} ${width} rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-[12px] font-normal normal-case leading-snug tracking-normal text-ink-200 opacity-0 shadow-xl shadow-black/60 transition-opacity group-hover/help:opacity-100 group-focus-within/help:opacity-100`}
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
      review as a finished diff.
      <br />
      <br />
      <b className="text-cyan">Supervised</b> — Claude works directly in your project folder, and every
      single file write or command becomes a card you Allow or Deny. Nothing happens without you.
      Slower, but it is the only mode for a repo where an unreviewed write is unacceptable.
    </Help>
  );
}

export function ModeChip({ mode, ownBranch }: { mode: "autonomous" | "supervised"; ownBranch?: boolean }) {
  return mode === "autonomous" ? (
    <Chip className="border-amber/40 text-amber bg-amber/5" title="Autonomous: runs in its own git worktree, merged on Approve">auto</Chip>
  ) : ownBranch ? (
    <Chip className="border-cyan/40 text-cyan bg-cyan/5" title="Supervised on its own branch: every write is an approval card, and the work lands only when you approve">supervised · branch</Chip>
  ) : (
    <Chip className="border-cyan/40 text-cyan bg-cyan/5" title="Supervised: runs in the main checkout, every write is an approval card">supervised</Chip>
  );
}

export function Modal({ title, onClose, children, width = "max-w-xl" }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    // The overlay scrolls, so a form taller than the window (a long pipeline) still reaches its buttons.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/75 backdrop-blur-[2px] p-6 pt-[8vh]" onMouseDown={onClose}>
      <div className={`rise w-full ${width} rounded-xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/60`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-ink-100">{title}</h2>
          <button className="text-ink-400 hover:text-ink-100 cursor-pointer text-lg leading-none" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="px-5 py-4">{children}</div>
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
