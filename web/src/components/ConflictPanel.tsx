import type { Resolution, Task } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { Button, ErrorLine, useAction } from "./ui.tsx";

const ACTIVE: Resolution["state"][] = ["resolving", "checking", "reviewing"];

function headline(r: Resolution): string {
  switch (r.state) {
    case "resolving": return r.attempt > 1 ? `Claude is trying again (try ${r.attempt} of ${r.max_attempts})…` : "Claude is combining both changes…";
    case "checking": return "Checking nothing from either side was lost…";
    case "reviewing": return "A second look is reading both sides and the result…";
    case "resolved": return r.land_after ? "Conflict resolved — every check passed" : "Conflict resolved — every check passed. Approve to land it.";
    case "failed": return "Claude could not resolve this conflict safely";
  }
}

/**
 * A conflict with the base, before and after Claude is given it (D355–D359): the warning with Fix now,
 * then what Claude kept from each side and every check the board ran on it.
 */
export function ConflictPanel({ t, busy: taskBusy }: { t: Task; busy: boolean }) {
  const { busy, error, run } = useAction();
  const r = t.resolution;
  const active = !!r && ACTIVE.includes(r.state);
  const risk = !active ? t.conflict_risk : null;
  // A finished resolution stays worth showing while the task is still open; once it lands, the card is history.
  const showResolution = !!r && (active || t.status !== "done" || r.state === "resolved");
  if (!risk && !showResolution) return null;

  return (
    <div className="space-y-2">
      {risk ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber/40 bg-amber/5 px-3 py-2 text-[12px] text-ink-200">
          <span className="min-w-0 flex-1">
            <b className="text-amber">Will conflict with <span className="font-mono">{risk.base}</span></b> in{" "}
            <span className="font-mono">{risk.files.join(", ")}</span> — another change landed on the same lines. Claude can combine
            both now, in this task's own copy; nothing lands until you approve.
          </span>
          <Button size="sm" busy={busy} disabled={taskBusy} title={taskBusy ? "Wait for the task to finish" : "Have Claude resolve it now"} onClick={() => run(() => api.resolveConflict(t.id))}>
            Fix now
          </Button>
        </div>
      ) : null}
      <ErrorLine error={error} />

      {showResolution && r ? (
        <div className={`rounded-md border px-3 py-2.5 text-[12px] ${r.state === "failed" ? "border-rust/40 bg-rust/5" : r.state === "resolved" ? "border-moss/40 bg-moss/5" : "border-slate/40 bg-slate/5"}`}>
          <div className={`font-semibold ${r.state === "failed" ? "text-rust" : r.state === "resolved" ? "text-moss" : "text-slate"}`}>{headline(r)}</div>
          <div className="mt-1 text-ink-400">
            Conflict with <span className="font-mono">{r.base}</span>
            {r.conflicts.length ? <> in <span className="font-mono">{r.conflicts.join(", ")}</span></> : null}
            {r.others.length ? <>, after: {r.others.join("; ")}</> : null}
          </div>
          {r.error ? <div className="mt-1.5 whitespace-pre-wrap text-ink-200">{r.error}</div> : null}

          {r.checks.length ? (
            <ul className="mt-2 space-y-1">
              {r.checks.map((c) => (
                <li key={c.id} className="flex gap-2">
                  <span className={c.ok ? "text-moss" : "text-rust"} aria-label={c.ok ? "passed" : "failed"}>{c.ok ? "✓" : "✗"}</span>
                  <span className="min-w-0 whitespace-pre-wrap text-ink-300">{c.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {r.lost.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-ink-400">Lines not in the result word for word ({r.lost.reduce((n, l) => n + l.lines.length, 0)})</summary>
              <ul className="mt-1 space-y-1 font-mono text-[11px] text-ink-300">
                {r.lost.map((l) => (
                  <li key={`${l.file}:${l.side}`}>
                    <span className="text-ink-500">{l.file} · {l.side === "task" ? "this task" : r.base}</span>
                    {l.lines.map((x, i) => <div key={i} className="truncate pl-3">{x}</div>)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {r.report ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-ink-400">What Claude kept from each side</summary>
              <div className="mt-1 whitespace-pre-wrap text-ink-300">{r.report}</div>
            </details>
          ) : null}
          {r.review ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-ink-400">The second look</summary>
              <div className="mt-1 whitespace-pre-wrap text-ink-300">{r.review}</div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
