import { useEffect, useState } from "react";
import type { UsageLimit } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { clock, until } from "../lib/format.ts";
import { inputCls } from "./ui.tsx";

export type When =
  | { kind: "now" }
  | { kind: "at"; at: string }
  | { kind: "reset" }
  | { kind: "repeat"; days: number[]; time: string };

/** Monday first, the way a week reads; values are JavaScript's getDay() (0 = Sunday). */
const WEEK: { d: number; short: string }[] = [
  { d: 1, short: "Mon" }, { d: 2, short: "Tue" }, { d: 3, short: "Wed" }, { d: 4, short: "Thu" },
  { d: 5, short: "Fri" }, { d: 6, short: "Sat" }, { d: 0, short: "Sun" },
];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];

/** "every day", "weekdays", "weekends", "Mon Wed Fri". */
export function describeDays(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "every day";
  if (set.size === 5 && WEEKDAYS.every((d) => set.has(d))) return "weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "weekends";
  return WEEK.filter((w) => set.has(w.d)).map((w) => w.short).join(" ");
}

/** A `datetime-local` value ("2026-09-14T02:00") for a Date, in local time. */
function localValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The next time the clock reads h:00 — "tonight at 2" is tomorrow's date once it is past 2 AM. */
function nextHour(h: number): Date {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

export const defaultWhen = (kind: When["kind"]): When =>
  kind === "at" ? { kind, at: localValue(nextHour(2)) }
  : kind === "repeat" ? { kind, days: EVERY_DAY, time: "03:00" }
  : { kind };

/** What the server stores for a one-time start, or null for "now" / a repeat. */
export function startAtOf(w: When): string | null {
  if (w.kind === "at") return new Date(w.at).toISOString();
  if (w.kind === "reset") return "reset";
  return null;
}

export function whenInvalid(w: When): string | null {
  if (w.kind === "at" && !(Date.parse(w.at) > Date.now())) return "Pick a time in the future.";
  if (w.kind === "repeat" && !w.days.length) return "Pick at least one day.";
  return null;
}

const OPTIONS: { kind: When["kind"]; label: string; sub: string }[] = [
  { kind: "now", label: "Backlog", sub: "you start it" },
  { kind: "at", label: "Later", sub: "a date and time" },
  { kind: "reset", label: "After reset", sub: "fresh usage window" },
  { kind: "repeat", label: "Repeat", sub: "on set days" },
];

/**
 * When a card should start. Everything but "now" keeps the card in Backlog with a clock on it until
 * its time comes, then it is queued like any other — caps, dependencies and approvals still apply.
 */
export function WhenPicker({ value, onChange, allowNow = true }: { value: When; onChange: (w: When) => void; allowNow?: boolean }) {
  const [limits, setLimits] = useState<UsageLimit[]>([]);
  useEffect(() => {
    if (value.kind === "reset") void api.limits().then(setLimits, () => {});
  }, [value.kind]);
  const five = limits.find((l) => l.type === "five_hour" && l.resets_at && l.resets_at * 1000 > Date.now());

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {OPTIONS.filter((o) => allowNow || o.kind !== "now").map((o) => (
          <button
            key={o.kind}
            type="button"
            onClick={() => value.kind !== o.kind && onChange(defaultWhen(o.kind))}
            className={`rounded-md border px-2.5 py-1.5 text-left transition-all duration-200 cursor-pointer ${
              value.kind === o.kind ? "border-cyan/70 bg-cyan/10 text-cyan shadow-[0_0_0_3px_rgb(80_200_220/0.08)]" : "border-ink-700 text-ink-300 hover:border-ink-500"
            }`}
          >
            <div className="text-[12.5px] font-semibold">{o.label}</div>
            <div className="text-[10.5px] opacity-75">{o.sub}</div>
          </button>
        ))}
      </div>

      {/* keyed by kind so each detail panel rises in as you switch */}
      <div key={value.kind} className="rise">
        {value.kind === "now" ? (
          <p className="text-[11.5px] text-ink-400">It waits in Backlog until you press Queue, as usual.</p>
        ) : value.kind === "at" ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <input type="datetime-local" className={`${inputCls} w-auto!`} value={value.at} onChange={(e) => onChange({ kind: "at", at: e.target.value })} />
              {[
                { label: "Tonight 2 AM", d: () => nextHour(2) },
                { label: "In 1 hour", d: () => new Date(Date.now() + 3_600_000) },
                { label: "Tomorrow 9 AM", d: () => { const t = nextHour(9); if (t.toDateString() === new Date().toDateString()) t.setDate(t.getDate() + 1); return t; } },
              ].map((q) => (
                <button key={q.label} type="button" className="rounded-full border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-cyan/60 hover:text-cyan cursor-pointer" onClick={() => onChange({ kind: "at", at: localValue(q.d()) })}>
                  {q.label}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-ink-400">
              {Date.parse(value.at) > Date.now() ? <>Starts {clock(Date.parse(value.at))}, {until(Date.parse(value.at))}. </> : null}
              The card waits in Backlog with a clock on it.
            </p>
          </div>
        ) : value.kind === "reset" ? (
          <p className="text-[11.5px] text-ink-400">
            Starts when your Claude 5-hour usage window next resets
            {five ? <> — about <b className="text-ink-200">{clock(five.resets_at! * 1000)}</b> ({until(five.resets_at! * 1000)})</> : " (no reset time known yet, so it starts right away)"}.
            Good for work you want done on a fresh window.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1">
              {WEEK.map((w) => {
                const on = value.days.includes(w.d);
                return (
                  <button
                    key={w.d}
                    type="button"
                    onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== w.d) : [...value.days, w.d] })}
                    className={`h-8 w-11 rounded-md border text-[12px] transition-all duration-150 cursor-pointer active:scale-95 ${on ? "border-cyan/70 bg-cyan/15 text-cyan" : "border-ink-700 text-ink-400 hover:border-ink-500"}`}
                  >
                    {w.short}
                  </button>
                );
              })}
              <span className="mx-1 text-[12px] text-ink-500">at</span>
              <input type="time" className={`${inputCls} w-auto!`} value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value || "03:00" })} />
            </div>
            <div className="flex gap-1.5">
              {[{ label: "Every day", d: EVERY_DAY }, { label: "Weekdays", d: WEEKDAYS }, { label: "Weekends", d: [0, 6] }].map((p) => (
                <button key={p.label} type="button" className="rounded-full border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-cyan/60 hover:text-cyan cursor-pointer" onClick={() => onChange({ ...value, days: p.d })}>
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-ink-400">
              Each time, a fresh copy of this card is made and queued ({describeDays(value.days) || "no days picked"} at {value.time}), so earlier
              results are never overwritten. If the computer was off, a missed run happens once when the board opens.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
