import { useState } from "react";
import type { Objection } from "../../../server/src/types.ts";
import { api, type TaskDetail } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { modelLabel } from "../lib/format.ts";
import { Button, ErrorLine, useAction } from "./ui.tsx";

const SEV: Record<Objection["severity"], string> = {
  high: "border-rust/60 text-rust",
  medium: "border-amber/50 text-amber",
  low: "border-ink-600 text-ink-400",
};

/**
 * The decision after a plan debate (docs/DECISIONS.md D131): the original plan, the critic's
 * objections, and the revised plan, with the human choosing which one the code stage builds from.
 */
export function PlanGate({ d }: { d: TaskDetail }) {
  const gate = d.task.plan_gate;
  const { busy, error, run } = useAction();
  const [edit, setEdit] = useState<string | null>(null);
  if (!gate) return null;
  const decide = (choice: "original" | "revised" | "custom", text?: string) => run(() => api.planDecision(d.task.id, { choice, text }));

  return (
    <div className="border-b border-ink-800 bg-iris/5 px-5 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold text-iris">Plan debated</span>
        <span className="text-[11.5px] text-ink-400">critiqued by <span className="font-mono">{modelLabel({ model: gate.critic.model, provider: gate.critic.provider === "anthropic" ? null : gate.critic.provider })}</span> — pick the plan to build from</span>
      </div>

      {gate.critique.objections.length ? (
        <ol className="mb-3 space-y-1.5">
          {gate.critique.objections.map((o) => (
            <li key={o.n} className="text-[12px] text-ink-200">
              <span className={`mr-2 rounded border px-1 py-0.5 font-mono text-[10px] uppercase ${SEV[o.severity]}`}>{o.severity}</span>
              {o.claim}
              {o.change ? <span className="text-ink-400"> → {o.change}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {edit === null ? (
        <div className="grid gap-3 md:grid-cols-2">
          {([
            ["original", "Original plan", gate.original],
            ["revised", "Revised plan", gate.revised],
          ] as const).map(([key, label, body]) => (
            <div key={key} className="flex min-h-0 flex-col rounded-lg border border-ink-700 bg-ink-950/40 p-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-500">{label}</span>
                {key === "revised" && !body.trim() ? <span className="text-[11px] text-ink-500">(the reviser produced none)</span> : null}
                <Button size="sm" variant="go" className="ml-auto" busy={busy} disabled={!body.trim()} onClick={() => decide(key)}>Use this</Button>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {body.trim() ? <Markdown text={body} className="text-[12px]" /> : <span className="text-[12px] text-ink-500">—</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <textarea className="w-full min-h-[180px] rounded-lg border border-ink-700 bg-ink-950/50 p-2.5 font-mono text-[12px] text-ink-100" value={edit} onChange={(e) => setEdit(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <Button size="sm" variant="go" busy={busy} disabled={!edit.trim()} onClick={() => decide("custom", edit)}>Use this plan</Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {edit === null ? (
        <button type="button" className="mt-2 text-[11.5px] text-ink-400 hover:text-ink-100 cursor-pointer" onClick={() => setEdit(gate.revised.trim() || gate.original)}>
          Edit and continue…
        </button>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}
