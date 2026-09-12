import { useEffect, useState } from "react";
import {
  ANTHROPIC_PROVIDER_ID, DEFAULT_EFFORT, EFFORT_NOTES, EFFORTS, supportsFastMode,
  type FastModeStatus, type ModelEntry, type Provider, type Stage, type StageName,
} from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useAppData } from "../lib/store.tsx";
import { Help, inputCls } from "./ui.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";

/** Fast-mode availability is per account and changes rarely, so every editor on screen shares one check. */
let fastCache: Promise<FastModeStatus> | null = null;
function useFastMode(): FastModeStatus | null {
  const [status, setStatus] = useState<FastModeStatus | null>(null);
  useEffect(() => {
    fastCache ??= api.fastMode();
    void fastCache.then(setStatus, () => (fastCache = null));
  }, []);
  return status;
}

/** Claude's own wording for fast mode (code.claude.com/docs/en/fast-mode). */
function FastHelp({ status }: { status: FastModeStatus | null }) {
  return (
    <Help width="w-[320px]" align="right">
      <b className="text-amber">↯ Fast mode</b> — a high-speed configuration for Claude Opus, making the model up to 2.5x
      faster at a higher cost per token. Same model and quality; it does not switch to a smaller model. Opus 5 and Opus 4.8
      only, and billed as extra usage.
      <br />
      <br />
      It is separate from <b>effort</b>: lower effort means less thinking, fast mode means the same thinking delivered sooner.
      Claude's advice is to combine them — fast mode with a lower effort — for straightforward work.
      {status ? (
        <>
          <br />
          <br />
          <span className={status.state === "on" ? "text-moss" : "text-rust"}>Your account: {status.message}</span>
        </>
      ) : null}
    </Help>
  );
}

const STAGES: StageName[] = ["plan", "code", "review", "custom"];
const STAGE_TINT: Record<StageName, string> = { plan: "text-cyan!", code: "text-amber!", review: "text-lime!", custom: "text-ink-200!" };

/** Is this stage on Claude (through your login)? Effort and fast mode only mean something there. */
const onClaude = (s: Stage) => !s.provider || s.provider === ANTHROPIC_PROVIDER_ID;

/** Edits a pipeline: one row per stage with provider + model, effort and optional prompt. */
export function PipelineEditor({ value, onChange, models, providers: providersProp }: { value: Stage[]; onChange: (v: Stage[]) => void; models: ModelEntry[]; providers?: Provider[] }) {
  const fastStatus = useFastMode();
  const fastAvailable = fastStatus?.state === "on";
  const { settings } = useAppData();
  const providers = providersProp ?? settings?.providers ?? [];
  const set = (i: number, patch: Partial<Stage>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {value.map((s, i) => (
        <div key={i} className="rounded-lg border border-ink-700 bg-ink-850/60 p-2.5">
          <div className="grid grid-cols-[92px_1fr_150px_auto_auto] items-center gap-2">
            <select className={`${inputCls} font-mono ${STAGE_TINT[s.stage]}`} value={s.stage} onChange={(e) => set(i, { stage: e.target.value as StageName })}>
              {STAGES.map((st) => (
                <option key={st} value={st}>{st}</option>
              ))}
            </select>
            <ProviderPicker
              compact
              value={{ provider: s.provider ?? ANTHROPIC_PROVIDER_ID, model: s.model }}
              models={models}
              providers={providers}
              onChange={(v) => set(i, { model: v.model, provider: v.provider === ANTHROPIC_PROVIDER_ID ? undefined : v.provider, ...(v.provider === ANTHROPIC_PROVIDER_ID ? {} : { fast: undefined }) })}
            />
            <select
              className={`${inputCls} font-mono`}
              value={s.effort}
              disabled={!onClaude(s)}
              onChange={(e) => set(i, { effort: e.target.value as Stage["effort"] })}
              title={onClaude(s) ? `Effort: ${EFFORT_NOTES[s.effort]}` : "Effort is a Claude control; it is not sent to other providers"}
            >
              {EFFORTS.map((ef) => (
                <option key={ef} value={ef}>
                  {ef} — {EFFORT_NOTES[ef]}
                </option>
              ))}
            </select>
            {(() => {
              // Fast mode is Opus 5 / 4.8 only, and only when the account allows it. When it cannot run,
              // the toggle says why instead of silently doing nothing.
              const modelOk = onClaude(s) && supportsFastMode(s.model);
              const usable = modelOk && fastAvailable;
              const why = !onClaude(s)
                ? "Fast mode is a Claude control"
                : !modelOk
                ? "Fast mode is Opus 5 and Opus 4.8 only"
                : !fastStatus
                  ? "Checking whether fast mode is available…"
                  : fastAvailable
                    ? s.fast ? "Fast mode on — click to turn off" : "Turn fast mode on for this stage"
                    : fastStatus.message;
              return (
                <button
                  type="button"
                  disabled={!usable && !s.fast}
                  onClick={() => set(i, { fast: s.fast ? undefined : true })}
                  title={why}
                  className={`rounded-md border px-2 py-1.5 font-mono text-[12px] transition-colors ${
                    s.fast && usable
                      ? "border-amber/60 bg-amber/10 text-amber cursor-pointer"
                      : s.fast
                        ? "border-rust/50 text-rust cursor-pointer"
                        : usable
                          ? "border-ink-700 text-ink-400 hover:text-ink-100 cursor-pointer"
                          : "cursor-not-allowed border-ink-800 text-ink-600"
                  }`}
                >
                  ↯
                </button>
              );
            })()}
            <div className="flex items-center text-ink-400">
              <button type="button" className="px-1 hover:text-ink-100 disabled:opacity-30 cursor-pointer" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
              <button type="button" className="px-1 hover:text-ink-100 disabled:opacity-30 cursor-pointer" disabled={i === value.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
              <button type="button" className="px-1 hover:text-rust cursor-pointer" onClick={() => onChange(value.filter((_, j) => j !== i))} title="Remove stage">×</button>
            </div>
          </div>
          {s.stage === "plan" ? (
            <div className="mt-2 flex items-center gap-1.5 text-[11px]">
              <span className="text-ink-500">debate plan:</span>
              {([["default", "default"], [true, "on"], [false, "off"]] as const).map(([val, label]) => {
                const active = s.debate === undefined ? val === "default" : typeof s.debate === "object" ? val === true : s.debate === val;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => set(i, { debate: val === "default" ? undefined : val })}
                    className={`rounded border px-1.5 py-0.5 font-mono cursor-pointer ${active ? "border-iris/60 bg-iris/10 text-iris" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}
                    title={val === "default" ? "Follow Settings → Plan debate" : val === true ? "A second model critiques this plan before code" : "No debate for this stage"}
                  >
                    {label}
                  </button>
                );
              })}
              {typeof s.debate === "object" ? <span className="font-mono text-iris">critic: {s.debate.model}</span> : null}
            </div>
          ) : null}
          {s.stage === "custom" || s.prompt ? (
            <textarea
              className={`${inputCls} mt-2 min-h-[52px] text-[12.5px]`}
              placeholder={s.stage === "custom" ? "Instructions for this stage" : "Extra instructions (optional)"}
              value={s.prompt ?? ""}
              onChange={(e) => set(i, { prompt: e.target.value || undefined })}
            />
          ) : (
            <button type="button" className="mt-1.5 text-[11px] text-ink-400 hover:text-ink-200 cursor-pointer" onClick={() => set(i, { prompt: " " })}>
              + custom prompt
            </button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex-1 rounded-lg border border-dashed border-ink-600 py-1.5 text-[12px] text-ink-300 hover:border-ink-400 hover:text-ink-100 cursor-pointer"
          onClick={() => onChange([...value, { stage: "code", model: models[1]?.id ?? models[0]?.id ?? "claude-opus-5", effort: DEFAULT_EFFORT }])}
        >
          + stage
        </button>
        <span className="flex items-center gap-1 text-[11px] text-ink-500">
          ↯ fast mode <FastHelp status={fastStatus} />
        </span>
      </div>
    </div>
  );
}
