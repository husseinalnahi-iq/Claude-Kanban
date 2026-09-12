import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { inputCls } from "./ui.tsx";

export interface ModelOption {
  id: string;
  label: string;
  /** Heading the row is filed under; rows with the same group sit together, in the order given. */
  group?: string;
  /** Right-hand detail, e.g. "$3 / $15 per 1M · 200k". */
  meta?: string;
  /** A small warning chip, e.g. "not pulled". */
  tag?: string;
  /** Costs nothing to run: marked on the closed picker too. */
  free?: boolean;
}

/**
 * A model picker for lists too long for a <select> (OpenRouter has hundreds): type to filter,
 * rows grouped under headings, and anything typed can be used as a model id as it is.
 */
type Pos = { left: number; top?: number; bottom?: number; width: number; maxHeight: number };
const samePos = (a: Pos | null, b: Pos) => !!a && a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.width === b.width && a.maxHeight === b.maxHeight;

export function ModelCombobox({
  value, onChange, options, note, loading, warn, placeholder,
}: {
  value: string;
  onChange: (id: string) => void;
  options: ModelOption[];
  /** One line above the list, e.g. why the live list is missing. */
  note?: string | null;
  loading?: boolean;
  /** Something wrong with the current id, shown on the closed picker: red fails a run, amber is a likely typo. */
  warn?: { text: string; tone: "red" | "amber" };
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () => (q ? options.filter((o) => `${o.id} ${o.label} ${o.group ?? ""} ${o.tag ?? ""}`.toLowerCase().includes(q)) : options),
    [options, q],
  );
  const typed = query.trim();
  const offerTyped = typed !== "" && !options.some((o) => o.id === typed);
  const count = rows.length + (offerTyped ? 1 : 0);
  const current = options.find((o) => o.id === value);

  /**
   * Fixed to the viewport so a dialog's scroll box cannot clip it, and re-measured while open so it
   * stays under its button when the dialog scrolls. Width follows the button (a 600px minimum put the
   * panel half a screen away from a picker in a narrow column), and an unchanged measurement sets no
   * state: re-rendering on every scroll event made the list flicker and drift. The panel itself is
   * portalled to <body>: a dialog card that animates has a transform, which makes IT the reference for
   * position:fixed, and a tall card put the list hundreds of pixels off (docs/DECISIONS.md D204).
   */
  const measure = (): Pos | null => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    const width = Math.min(Math.max(r.width, 320), 560, window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    return below >= 260 || below >= above
      ? { left, top: r.bottom + 4, width, maxHeight: Math.min(420, below - 4) }
      : { left, bottom: window.innerHeight - r.top + 4, width, maxHeight: Math.min(420, above - 4) };
  };
  const place = () => setPos((prev) => { const next = measure(); return next && samePos(prev, next) ? prev : next; });

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    // Coalesce a burst of scroll events into one measurement per frame.
    let frame = 0;
    const soon = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const move = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) soon();
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", soon);
    window.addEventListener("scroll", move, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", soon);
      window.removeEventListener("scroll", move, true);
    };
  }, [open]);

  // Focusing the filter must not scroll the dialog the button sits in — that moved the panel away
  // from its button the moment it opened.
  useEffect(() => {
    if (open) filter.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
    button.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(count - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active < rows.length) pick(rows[active].id);
      else if (offerTyped) pick(typed);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    }
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${inputCls} flex min-w-0 cursor-pointer items-center gap-1 text-left font-mono ${
          warn?.tone === "red" ? "border-rust/70!" : warn ? "border-amber/60!" : ""
        }`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) {
            if (e.key.length === 1) setQuery(e.key);
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={
          (warn ? `⚠ ${warn.text}\n` : "") +
          (current ? `${current.id}${current.label !== current.id ? ` — ${current.label}` : ""}${current.meta ? ` · ${current.meta}` : ""}` : value || "Choose a model")
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={warn?.tone === "red" || undefined}
      >
        <span className={`min-w-0 flex-1 truncate ${value ? "" : "text-ink-500"}`}>{value || placeholder || "choose…"}</span>
        {warn ? <span className={`shrink-0 text-[11px] ${warn.tone === "red" ? "text-rust" : "text-amber"}`}>⚠</span> : null}
        {current?.free ? <span className="shrink-0 text-[10px] text-moss">free</span> : null}
        <span className="shrink-0 text-[10px] text-ink-500">▾</span>
      </button>
      {open && pos
        ? createPortal(
        <div
          ref={panel}
          className="fixed z-[100] flex flex-col overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl shadow-black/50"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
          onKeyDown={onKey}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && !panel.current?.contains(to) && to !== button.current) setOpen(false);
          }}
        >
          <div className="border-b border-ink-800 p-1.5">
            <input
              ref={filter}
              className={`${inputCls} font-mono`}
              placeholder="filter, or type any model id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter models"
            />
            {loading ? <div className="mt-1 px-1 text-[11px] text-ink-500">Asking the provider what it has…</div> : null}
            {note ? <div className="mt-1 px-1 text-[11px] text-amber">{note}</div> : null}
          </div>
          <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
            {rows.map((o, i) => {
              const heading = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <div key={`${o.group ?? ""}|${o.id}`}>
                  {heading ? <div className="sticky top-0 bg-ink-900 px-2.5 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-500">{heading}</div> : null}
                  <div
                    data-i={i}
                    role="option"
                    aria-selected={o.id === value}
                    className={`flex cursor-pointer items-baseline gap-2 px-2.5 py-1 text-[12.5px] ${i === active ? "bg-ink-800" : ""} ${o.id === value ? "text-amber" : "text-ink-100"}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o.id)}
                  >
                    <span className="max-w-[65%] shrink-0 truncate font-mono">{o.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-400">{o.label && o.label !== o.id ? o.label : ""}</span>
                    {o.tag ? <span className="shrink-0 rounded border border-amber/50 px-1 text-[10px] text-amber">{o.tag}</span> : null}
                    {o.meta ? <span className="shrink-0 font-mono text-[11px] text-ink-500">{o.meta}</span> : null}
                  </div>
                </div>
              );
            })}
            {offerTyped ? (
              <div
                data-i={rows.length}
                className={`cursor-pointer px-2.5 py-1.5 text-[12.5px] text-ink-200 ${active === rows.length ? "bg-ink-800" : ""}`}
                onMouseEnter={() => setActive(rows.length)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(typed)}
              >
                Use <span className="font-mono text-amber">{typed}</span> as the model id
              </div>
            ) : null}
            {!rows.length && !offerTyped ? <div className="px-2.5 py-2 text-[12px] text-ink-500">No models. Type a model id to use one anyway.</div> : null}
          </div>
          <div className="border-t border-ink-800 px-2.5 py-1 text-[10.5px] text-ink-500">
            {options.length} models · ↑↓ to move · Enter to pick · any id you type works too
          </div>
        </div>,
        document.body,
      )
        : null}
    </>
  );
}
