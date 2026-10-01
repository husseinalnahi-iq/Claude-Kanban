import { useState } from "react";
import type { ChecklistItem } from "../../../server/src/types.ts";
import { checklistSummary, liveChecklist } from "../../../server/src/engine/checklist.ts";

/** On a board card: "3/7 · Writing the login form", with a thin bar. Nothing when Claude made no list. */
export function ChecklistLine({ list, live }: { list: ChecklistItem[] | undefined; live: boolean }) {
  const s = checklistSummary(list);
  if (!s) return null;
  const pct = Math.round((s.done / s.total) * 100);
  const all = s.done === s.total;
  return (
    <div className="mt-1.5" title={liveChecklist(list).map((x) => `${x.status === "completed" ? "✓" : x.status === "in_progress" ? "▸" : "·"} ${x.text}`).join("\n")}>
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-300">
        <span className={`font-mono ${all ? "text-moss" : "text-amber"}`}>{s.done}/{s.total}</span>
        <span className="min-w-0 flex-1 truncate">{s.now ?? (all ? "every step done" : live ? "between steps" : "stopped here")}</span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full transition-[width] duration-500 ${all ? "bg-moss" : "bg-amber"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** In the task drawer: Claude's own to-do list for the stage, step by step. */
export function ChecklistPanel({ list, live }: { list: ChecklistItem[]; live: boolean }) {
  const s = checklistSummary(list);
  const [open, setOpen] = useState(true);
  if (!s) return null;
  return (
    <div className="border-b border-ink-800 px-5 py-2.5">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 text-left text-[12px] text-ink-300" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="text-[10px] text-ink-500">{open ? "▾" : "▸"}</span>
        <span className="font-medium text-ink-100">Claude's steps</span>
        <span className={`font-mono ${s.done === s.total ? "text-moss" : "text-amber"}`}>{s.done}/{s.total}</span>
        {!open && s.now ? <span className="min-w-0 flex-1 truncate text-ink-400">{s.now}</span> : null}
      </button>
      {open ? (
        <ol className="mt-1.5 space-y-0.5">
          {liveChecklist(list).map((x) => (
            <li key={x.id} className={`flex items-start gap-2 text-[12.5px] leading-snug ${x.status === "completed" ? "text-ink-500" : x.status === "in_progress" ? "text-ink-100" : "text-ink-300"}`}>
              <span className={`mt-px w-3.5 shrink-0 text-center ${x.status === "completed" ? "text-moss" : x.status === "in_progress" ? "text-amber" : "text-ink-600"}`}>
                {x.status === "completed" ? "✓" : x.status === "in_progress" ? <span className={live ? "breathe" : ""}>▸</span> : "○"}
              </span>
              <span className={x.status === "completed" ? "line-through decoration-ink-600" : ""}>{x.status === "in_progress" && x.doing ? x.doing : x.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
