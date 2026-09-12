import { useState } from "react";
import type { Objection, PlanGate as Gate } from "../../../server/src/types.ts";
import { api, type TaskDetail } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { modelLabel } from "../lib/format.ts";
import { Button, ErrorLine, inputCls, useAction } from "./ui.tsx";

const SEV: Record<Objection["severity"], string> = {
  high: "border-rust/60 text-rust",
  medium: "border-amber/50 text-amber",
  low: "border-ink-600 text-ink-400",
};

/**
 * A plan waiting for the human before any code is written. After a debate (D131): the original plan,
 * the critic's objections and the revised plan, pick one. With plan approval on (D200): the plan
 * alone — approve it, edit it, or send the task back with a note.
 */
export function PlanGate({ d }: { d: TaskDetail }) {
  const gate = d.task.plan_gate;
  if (!gate) return null;
  return gate.kind === "approval" ? <ApprovalGate d={d} gate={gate} /> : <DebateGate d={d} gate={gate} />;
}

function PlanEditor({ initial, busy, onUse, onCancel }: { initial: string; busy: boolean; onUse: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="space-y-2">
      <textarea className="w-full min-h-[220px] rounded-lg border border-ink-700 bg-ink-950/50 p-2.5 font-mono text-[12px] text-ink-100" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <div className="flex gap-2">
        <Button size="sm" variant="go" busy={busy} disabled={!text.trim()} onClick={() => onUse(text)}>Approve this plan</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ApprovalGate({ d, gate }: { d: TaskDetail; gate: Gate }) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const decide = (choice: "original" | "custom", text?: string) => run(() => api.planDecision(d.task.id, { choice, text }));
  return (
    <div className="border-b border-ink-800 bg-iris/5 px-5 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="pulse-rose inline-block h-2 w-2 rounded-full bg-iris" />
        <span className="text-[12.5px] font-semibold text-iris">Plan waiting for you</span>
        <span className="text-[11.5px] text-ink-400">
          nothing is written until you approve it{d.task.live ? " — this task touches a live system" : ""}. The full plan is also on the Plan tab.
        </span>
      </div>
      {editing ? (
        <PlanEditor initial={gate.original} busy={busy} onUse={(text) => decide("custom", text)} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <div className="max-h-80 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950/40 p-2.5">
            <Markdown text={gate.original} className="text-[12px]" />
          </div>
          {sending ? (
            <div className="mt-2 flex items-center gap-2">
              <input className={inputCls} placeholder="What should change? The planner reads this first." value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
              <Button size="sm" variant="danger" busy={busy} disabled={!note.trim()} onClick={() => run(() => api.reject(d.task.id, note.trim()))}>Send back</Button>
              <Button size="sm" variant="ghost" onClick={() => setSending(false)}>Cancel</Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="go" busy={busy} onClick={() => decide("original")}>Approve plan</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit, then approve…</Button>
              <Button size="sm" variant="ghost" onClick={() => setSending(true)}>Send back with a note…</Button>
            </div>
          )}
        </>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function DebateGate({ d, gate }: { d: TaskDetail; gate: Gate }) {
  const { busy, error, run } = useAction();
  const [edit, setEdit] = useState<string | null>(null);
  const decide = (choice: "original" | "revised" | "custom", text?: string) => run(() => api.planDecision(d.task.id, { choice, text }));
  const revised = gate.revised ?? "";
  const objections = gate.critique?.objections ?? [];

  return (
    <div className="border-b border-ink-800 bg-iris/5 px-5 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold text-iris">Plan debated</span>
        {gate.critic ? (
          <span className="text-[11.5px] text-ink-400">critiqued by <span className="font-mono">{modelLabel({ model: gate.critic.model, provider: gate.critic.provider === "anthropic" ? null : gate.critic.provider })}</span> — pick the plan to build from</span>
        ) : null}
      </div>

      {objections.length ? (
        <ol className="mb-3 space-y-1.5">
          {objections.map((o) => (
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
            ["revised", "Revised plan", revised],
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
        <PlanEditor initial={edit} busy={busy} onUse={(text) => decide("custom", text)} onCancel={() => setEdit(null)} />
      )}

      {edit === null ? (
        <button type="button" className="mt-2 text-[11.5px] text-ink-400 hover:text-ink-100 cursor-pointer" onClick={() => setEdit(revised.trim() || gate.original)}>
          Edit and continue…
        </button>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}
