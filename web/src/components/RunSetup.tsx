import { useState } from "react";
import type { Stage, Task } from "../../../server/src/types.ts";
import { runStyleFields, runStyleOf } from "../../../server/src/types.ts";
import { isAnswerPipeline } from "../../../server/src/engine/answer.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { useAppData } from "../lib/store.tsx";
import { modelLabel } from "../lib/format.ts";
import { Button, ErrorLine, RunStyleSwitch, useAction } from "./ui.tsx";
import { PipelineEditor, pipelineLine } from "./PipelineEditor.tsx";
import { RunSuggestions } from "./Suggestions.tsx";
import { autonomousBlocked, branchBlocked, lookupAutoBlocked } from "./forms.tsx";

const small = "cursor-pointer rounded border px-1.5 py-px font-mono text-[10.5px] disabled:cursor-default disabled:opacity-40";

/** How a Backlog card will run, changeable here: mode, its own branch, and the model and effort per stage. */
export function RunSetup({ card, project }: { card: Task; project: ProjectWithGit }) {
  const { settings } = useAppData();
  const [editing, setEditing] = useState<Stage[] | null>(null);
  const { busy, error, run } = useAction();
  const answer = isAnswerPipeline(card.pipeline);
  const noAuto = answer ? lookupAutoBlocked(project) : autonomousBlocked(project);
  const noBranch = branchBlocked(project);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <RunStyleSwitch
          value={runStyleOf(card)}
          onChange={(m) => run(() => api.patchTask(card.id, runStyleFields(m)))}
          disabled={busy}
          blocked={noAuto}
          titles={{
            ask: "Like autonomous, but stops to ask you when your answer changes the result, and waits for it",
            autonomous: answer ? "Runs in the project's folder and asks nothing; it reads and reports, and changes nothing" : "Works without asking — on its own branch, or in the project folder when Settings say so — and lands when you approve",
            supervised: answer ? "Runs in the project's folder; a command that is not read-only waits for your Allow" : "Works in the project's folder and asks you before each change",
          }}
        />
        {card.mode === "supervised" && !answer ? (
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-300" title={noBranch ?? "Its own copy of the project; lands only when you approve"}>
            <input
              type="checkbox"
              className="accent-cyan"
              checked={card.own_branch}
              disabled={busy || !!noBranch || !!card.branch}
              onChange={(e) => run(() => api.patchTask(card.id, { own_branch: e.target.checked }))}
            />
            own branch
          </label>
        ) : null}
        {answer ? <span className="text-[11px] text-ink-500">reads only · lands in Done with its answer</span> : null}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <PipelineEditor value={editing} onChange={setEditing} models={settings?.models ?? []} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="go" busy={busy} disabled={!editing.length} onClick={() => run(async () => { await api.patchTask(card.id, { pipeline: editing }); setEditing(null); })}>
              Use these
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug text-ink-400">{pipelineLine(card.pipeline, modelLabel)}</span>
          <button className={`${small} shrink-0 border-ink-600 text-ink-300 hover:text-ink-100`} title="Change the model or effort of a stage" onClick={() => setEditing(card.pipeline.map((s) => ({ ...s })))}>
            change
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}


/**
 * A Backlog card's setup: how it runs, which models at what effort, what Claude suggests, and Start.
 * A card the chat made with a plan waits here until someone presses Start (D365), so Start says so
 * and confirms the setup on the way.
 */
export function SetupCard({ card, project, compact = false }: { card: Task; project: ProjectWithGit; compact?: boolean }) {
  const { busy, error, run } = useAction();
  return (
    <div className={card.setup_pending ? "space-y-1.5 rounded-lg border border-amber/40 bg-amber/5 p-2.5" : "space-y-1.5"}>
      {card.setup_pending ? (
        <div className="text-[12px] text-ink-200">
          <b className="font-medium text-amber">Check how it runs, then Start.</b> Change the mode or any step's model and effort first if you want; nothing runs until you press Start.
        </div>
      ) : null}
      <RunSetup card={card} project={project} />
      <div className="space-y-1.5">
        <RunSuggestions t={card} busy={false} compact={compact} />
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="go" busy={busy} title={card.setup_pending ? "Start it with this mode and these models" : "Queue it now"} onClick={() => run(() => api.queue(card.id, false, card.setup_pending))}>
          ▶ Start
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
