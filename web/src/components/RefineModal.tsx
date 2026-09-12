import { useEffect, useState } from "react";
import type { TaskType } from "../../../server/src/types.ts";
import { TASK_TYPES, PRIORITIES } from "../../../server/src/types.ts";
import { api, type TriageProposal } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { Button, ErrorLine, Field, inputCls, Modal, useAction } from "./ui.tsx";

/**
 * "Improve this request": Claude rewrites a rough ask into a spec with checkable outcomes and,
 * when it genuinely helps, subtasks. Nothing is saved until you accept — and you can edit first.
 */
export function RefineModal({ taskId, onClose, onApplied }: { taskId: string; onClose: () => void; onApplied: () => void }) {
  const [proposal, setProposal] = useState<TriageProposal | null>(null);
  const [drop, setDrop] = useState<Set<number>>(new Set());
  const [autoRun, setAutoRun] = useState(true);
  const { busy, error, run } = useAction();
  const load = useAction();

  useEffect(() => {
    void load.run(async () => setProposal(await api.refine(taskId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const apply = () =>
    run(async () => {
      if (!proposal) return;
      const kept = proposal.subtasks.filter((_, i) => !drop.has(i));
      // Renumber dependencies after any removals so the graph stays valid.
      const indexMap = new Map<number, number>();
      proposal.subtasks.forEach((_, i) => {
        if (!drop.has(i)) indexMap.set(i + 1, indexMap.size + 1);
      });
      await api.applyRefine(taskId, {
        ...proposal,
        auto_queue_children: autoRun,
        subtasks: kept.map((s) => ({ ...s, depends_on: s.depends_on.map((d) => indexMap.get(d)).filter((d): d is number => Boolean(d)) })),
      });
      onApplied();
      onClose();
    });

  return (
    <Modal title="Improve this request" onClose={onClose} width="max-w-3xl">
      {load.busy || (!proposal && !load.error) ? (
        <div className="py-10 text-center text-[13px] text-ink-400">
          <span className="breathe">Reading the request…</span>
          <div className="mt-1 text-[11.5px] text-ink-500">Claude rewrites it into a spec with checkable outcomes. Nothing is saved yet.</div>
        </div>
      ) : null}
      <ErrorLine error={load.error} />
      {proposal ? (
        <div className="space-y-4">
          <Field label="Title">
            <input className={inputCls} value={proposal.title} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} />
          </Field>

          <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Field label="Type">
              <select className={`${inputCls} font-mono`} value={proposal.type} onChange={(e) => setProposal({ ...proposal, type: e.target.value as TaskType })}>
                {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Priority" hint="Claude's suggestion — you decide.">
              <select className={`${inputCls} font-mono`} value={proposal.priority} onChange={(e) => setProposal({ ...proposal, priority: e.target.value as typeof proposal.priority })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Confidence">
              <div className="px-2 py-1.5 font-mono text-[13px] text-ink-300">{Math.round((proposal.confidence ?? 0) * 100)}%</div>
            </Field>
          </div>

          {proposal.questions.length ? (
            <div className="rounded-lg border border-cyan/40 bg-cyan/5 p-3">
              <div className="mb-1 text-[12px] font-semibold text-cyan">Claude needs to know</div>
              <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-200">
                {proposal.questions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
              <div className="mt-2 text-[11.5px] text-ink-400">Answer these in the spec below before queueing, or accept as-is and let the run make a sensible choice.</div>
            </div>
          ) : null}

          <Field label="Spec" hint="Edit freely — this is what the run will receive.">
            <textarea className={`${inputCls} min-h-[200px] font-mono text-[12.5px]`} value={proposal.spec_md} onChange={(e) => setProposal({ ...proposal, spec_md: e.target.value })} />
          </Field>
          <details className="rounded-lg border border-ink-700 bg-ink-850/50 p-3">
            <summary className="cursor-pointer text-[12px] text-ink-300">Preview</summary>
            <Markdown text={proposal.spec_md} className="mt-2 text-[12.5px]" />
          </details>

          {/* The board decides one-task-or-several, and says why. Splitting multiplies the sessions,
              so the trade-off is stated in the same breath. */}
          <div className={`rounded-lg border px-3 py-2 text-[12.5px] ${proposal.subtasks.length ? "border-amber/40 bg-amber/5" : "border-ink-700 bg-ink-850/50"}`}>
            <span className={proposal.subtasks.length ? "text-amber" : "text-ink-200"}>
              {proposal.subtasks.length ? `Splitting this into ${proposal.subtasks.length} tasks` : "Keeping this as one task"}
            </span>
            <span className="text-ink-300"> — {proposal.split?.reason ?? "no reason given"}</span>
            <div className="mt-1 text-[11.5px] text-ink-500">
              {proposal.subtasks.length
                ? `${proposal.subtasks.length} tasks means ${proposal.subtasks.length} separate pipelines, so expect roughly ${proposal.subtasks.length}× the usage of doing it in one — worth it when the parts run in parallel or need different owners.`
                : "One pipeline, one session's context. Cheapest and usually fastest when the work is one coherent change."}
            </div>
          </div>

          {proposal.subtasks.length ? (
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-400">Subtasks ({proposal.subtasks.length - drop.size})</span>
                <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-300">
                  <input type="checkbox" className="accent-amber" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
                  run them automatically in order
                </label>
              </div>
              <div className="space-y-1.5">
                {proposal.subtasks.map((s, i) => (
                  <div key={i} className={`rounded-lg border px-3 py-2 ${drop.has(i) ? "border-ink-800 opacity-40" : "border-ink-700 bg-ink-850"}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10.5px] uppercase text-ink-500">{s.type}</span>
                      <span className="flex-1 text-[13px] text-ink-100">{s.title}</span>
                      {s.depends_on.length ? <span className="font-mono text-[10.5px] text-amber">after #{s.depends_on.join(", #")}</span> : <span className="font-mono text-[10.5px] text-moss">parallel</span>}
                      <button
                        className="cursor-pointer text-ink-500 hover:text-rust"
                        title={drop.has(i) ? "Keep" : "Drop"}
                        onClick={() => setDrop((d) => { const n = new Set(d); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                      >
                        {drop.has(i) ? "↩" : "×"}
                      </button>
                    </div>
                    {s.files?.length ? <div className="mt-1 font-mono text-[10.5px] text-ink-500">files: {s.files.join(", ")}</div> : null}
                  </div>
                ))}
              </div>
              <div className="mt-1.5 text-[11.5px] text-ink-500">Subtasks that touch the same files are ordered automatically, so two runs never edit one file at once.</div>
            </div>
          ) : null}

          <ErrorLine error={error} />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} onClick={apply}>Accept</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
