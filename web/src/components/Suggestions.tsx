import { useState } from "react";
import type { Stage, Task } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useAppData } from "../lib/store.tsx";
import { modelLabel } from "../lib/format.ts";
import { effortsFor, useClaudeModels } from "../lib/claudeModels.ts";
import { stageLabel } from "../../../server/src/engine/answer.ts";
import { Button, ErrorLine, useAction } from "./ui.tsx";
import { PipelineEditor, pipelineLine } from "./PipelineEditor.tsx";

/** Two pipelines are the same when every stage, model and effort matches. */
export const samePipeline = (a: Stage[], b: Stage[]) =>
  a.length === b.length && a.every((s, i) => s.stage === b[i].stage && s.model === b[i].model && s.effort === b[i].effort);

/** Whether triage has a live-system or sizing decision waiting on this card (only before it runs, D191). */
export function hasRunDecisions(t: Task, busy: boolean): boolean {
  if (t.status !== "backlog" || busy || !t.suggestion) return false;
  return Boolean((t.suggestion.live && !t.live) || (t.suggestion.pipeline?.length && !samePipeline(t.suggestion.pipeline, t.pipeline)));
}

/**
 * Triage's two decisions about how a card runs — is it live, and which models and efforts — with the
 * same buttons wherever the card is shown: the task drawer and the side chat (D288). Nothing here
 * is ever applied by itself: a wrong guess spends real money.
 */
export function RunSuggestions({ t, busy, compact }: { t: Task; busy: boolean; compact?: boolean }) {
  const { settings } = useAppData();
  const claude = useClaudeModels();
  // The suggested pipeline, being changed before it is used: model and effort per stage.
  const [adjusting, setAdjusting] = useState<Stage[] | null>(null);
  const { busy: acting, error, run } = useAction();
  const sug = t.suggestion;
  if (!sug || t.status !== "backlog" || busy) return null;
  const pad = compact ? "px-2.5 py-1.5 text-[12px]" : "px-3 py-2 text-[12.5px]";
  return (
    <>
      {/* Triage saw that this changes a live system: offered as a live task, never applied by itself (D241). */}
      {sug.live && !t.live ? (
        <div className={`rounded-lg border border-rose/40 bg-rose/5 ${pad}`}>
          <div className="mb-1 text-rose">Claude thinks this touches a live system</div>
          {sug.live_reason ? <div className="mb-1.5 text-ink-300">{sug.live_reason}</div> : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="go" busy={acting} onClick={() => run(() => api.acceptSuggestion(t.id, { live: true }))}>Mark it live</Button>
            <Button size="sm" variant="ghost" onClick={() => run(() => api.dismissSuggestion(t.id, { live: true }))}>It isn't</Button>
          </div>
        </div>
      ) : null}
      {/* The board sizes the pipeline to the task, but never applies it: the wrong guess here costs money. */}
      {sug.pipeline?.length && !samePipeline(sug.pipeline, t.pipeline) ? (
        <div className={`rounded-lg border border-amber/40 bg-amber/5 ${pad}`}>
          <div className="mb-1.5 text-amber">Claude sized this task — the model and effort it suggests for each stage:</div>
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {sug.pipeline.map((st, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i ? <span className="text-ink-500">→</span> : null}
                <span className="rounded-md border border-amber/40 bg-ink-900/60 px-2 py-0.5 font-mono text-[11.5px] text-ink-100">
                  {stageLabel(st)} · {modelLabel(st)} ·{" "}
                  {/* Haiku has no effort setting: the level sizing picked would not be sent, so it is not shown as if it were. */}
                  <span className="text-amber">{st.provider || !effortsFor(st.model, claude.result).none ? `${st.effort} effort` : "no effort setting"}</span>
                </span>
              </span>
            ))}
          </div>
          {sug.sizing_reason ? <div className="mb-1.5 text-ink-300">{sug.sizing_reason}</div> : null}
          {adjusting ? (
            <div className="mb-2">
              <PipelineEditor value={adjusting} onChange={setAdjusting} models={settings?.models ?? []} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-ink-500">now: {pipelineLine(t.pipeline, modelLabel)}</span>
            <span className="ml-auto flex gap-2">
              {adjusting ? (
                <>
                  <Button
                    size="sm"
                    variant="go"
                    disabled={!adjusting.length}
                    onClick={() =>
                      run(async () => {
                        await api.patchTask(t.id, { pipeline: adjusting });
                        await api.dismissSuggestion(t.id, { pipeline: true });
                        setAdjusting(null);
                      })
                    }
                  >
                    Use these
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdjusting(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="go" busy={acting} onClick={() => run(() => api.acceptSuggestion(t.id, { pipeline: true }))}>Use it</Button>
                  <Button size="sm" variant="ghost" title="Change a model or effort before using it" onClick={() => setAdjusting(sug.pipeline!.map((s) => ({ ...s })))}>Adjust</Button>
                  <Button size="sm" variant="ghost" onClick={() => run(() => api.dismissSuggestion(t.id, { pipeline: true }))}>Keep default</Button>
                </>
              )}
            </span>
          </div>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </>
  );
}
