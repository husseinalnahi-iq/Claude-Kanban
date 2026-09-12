import { useMemo, useState } from "react";
import { ANTHROPIC_PROVIDER_ID, type Settings, type Task, type TierRef } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { clock, until } from "../lib/format.ts";
import { Button, useAction } from "./ui.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";

/** The stage a paused task stopped on: the first one without a successful run. */
function stoppedStage(task: Task, states: string[]): number {
  const i = states.findIndex((s) => s !== "success");
  return i < 0 ? Math.max(0, task.pipeline.length - 1) : i;
}

/** Somewhere sensible to carry on: Claude when a provider ran out, else the first provider that isn't Claude. */
function suggestion(task: Task, i: number, settings: Settings): TierRef {
  const stage = task.pipeline[i];
  const onClaude = !stage?.provider || stage.provider === ANTHROPIC_PROVIDER_ID;
  if (!onClaude) {
    const same = settings.defaultPipeline.find((s) => s.stage === stage.stage && (!s.provider || s.provider === ANTHROPIC_PROVIDER_ID));
    return { provider: ANTHROPIC_PROVIDER_ID, model: same?.model ?? settings.tiers.balanced.model };
  }
  const p = settings.providers.find((x) => x.enabled && x.kind === "anthropic-compatible") ?? settings.providers.find((x) => x.enabled);
  return p ? { provider: p.id, model: p.models[0]?.id ?? "" } : { provider: ANTHROPIC_PROVIDER_ID, model: "" };
}

/**
 * A task paused because Claude or a delegated provider ran out: say what happened, and offer the
 * three ways on — wait (it carries on by itself when a reset time is known), switch the stage to
 * another provider now (the next model picks up where it stopped), or stop (D194).
 */
export function OutOfUsage({ task, states, settings }: { task: Task; states: string[]; settings: Settings }) {
  const i = stoppedStage(task, states);
  const stage = task.pipeline[i];
  const fromLabel = stage?.provider && stage.provider !== ANTHROPIC_PROVIDER_ID
    ? settings.providers.find((p) => p.id === stage.provider)?.label ?? stage.provider
    : "Claude";
  const [to, setTo] = useState<TierRef>(() => suggestion(task, i, settings));
  const [remember, setRemember] = useState(false);
  const { busy, error, run } = useAction();
  const waits = Boolean(task.resume_at);
  const needsYou = task.pause_reason === "provider" && !waits;
  const same = useMemo(() => {
    const toId = !to.provider || to.provider === ANTHROPIC_PROVIDER_ID ? ANTHROPIC_PROVIDER_ID : to.provider;
    const fromId = stage?.provider && stage.provider !== ANTHROPIC_PROVIDER_ID ? stage.provider : ANTHROPIC_PROVIDER_ID;
    return toId === fromId;
  }, [to, stage]);

  return (
    <div className={`rise mt-2.5 rounded-lg border px-3 py-2.5 ${needsYou ? "border-rose/50 bg-rose/5" : "border-iris/40 bg-iris/5"}`}>
      <div className={`text-[12.5px] ${needsYou ? "text-rose" : "text-iris"}`}>
        {waits ? (
          <>
            <b>{fromLabel} ran out.</b> It carries on by itself {until(task.resume_at)} ({clock(task.resume_at!)}), in the same session — or carry it on elsewhere now.
          </>
        ) : (
          <>
            <b>{fromLabel} is out of credit.</b> Nothing comes back by itself: top it up and try again, or carry the stage on elsewhere.
          </>
        )}
      </div>
      {/* The provider's own words, from the note ("GLM is out of credit: <its words>. Top it up…"). */}
      {task.note ? (
        <div className="mt-1 text-[11.5px] text-ink-400">
          {task.pause_reason === "provider" ? task.note.replace(/^[^:]+:\s*/, "").split(/\. (?:Top it up|It carries on|Resumes by itself)/)[0] : task.note.split(". Resumes")[0]}
        </div>
      ) : null}

      <div className="mt-2.5 text-[11px] uppercase tracking-wider text-ink-500">Carry stage #{i + 1} ({stage?.stage}) on with</div>
      <div className="mt-1 flex flex-wrap items-start gap-2">
        <div className="min-w-[280px] flex-1">
          <ProviderPicker value={to} onChange={setTo} models={settings.models} providers={settings.providers} compact />
        </div>
        <Button
          variant="go"
          busy={busy}
          disabled={!to.model || same}
          title={same ? "That is where it already runs" : "Runs the stage again there. The new model is told what the last one did, and finds its changes in place."}
          onClick={() => run(() => api.switchStage(task.id, { provider: to.provider, model: to.model, remember }))}
        >
          ▶ Switch &amp; continue
        </Button>
      </div>
      <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-300">
        <input type="checkbox" className="accent-amber" checked={remember} disabled={same} onChange={(e) => setRemember(e.target.checked)} />
        Next time {fromLabel} runs out, switch here without asking
      </label>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-ink-800/80 pt-2">
        <Button
          busy={busy}
          onClick={() => run(() => api.resumeTask(task.id))}
          title={waits ? "Try now instead of waiting — it pauses again if it is still out" : "After topping up: run the stage again where it was"}
        >
          ↻ {waits ? "Try now" : "Try again"}
        </Button>
        <Button variant="danger" busy={busy} onClick={() => run(() => api.stopPaused(task.id))} title="Stop here. What it did so far is kept, and Retry is still possible later.">
          ■ Stop
        </Button>
        <span className="text-[11px] text-ink-500">Set a standing choice in Settings → Providers → “When it runs out”.</span>
      </div>
      {error ? <div className="mt-2 text-[12px] text-rust">{error}</div> : null}
    </div>
  );
}
