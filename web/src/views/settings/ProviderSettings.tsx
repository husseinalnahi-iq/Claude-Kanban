import { useEffect, useState } from "react";
import type { Provider, ProviderModel, ProviderTestResult } from "../../../../server/src/types.ts";
import { api, type ProviderPreset, type ProviderRow } from "../../lib/api.ts";
import { Button, ErrorLine, Field, inputCls, useAction } from "../../components/ui.tsx";
import { useCatalog } from "../../lib/catalog.ts";
import { useAppData } from "../../lib/store.tsx";
import { isLocal } from "../../../../server/src/engine/providers/catalog.ts";
import { LocalModelsGuide } from "./LocalModelsGuide.tsx";
import { ProviderPicker } from "../../components/ProviderPicker.tsx";
import { OutChip, ProviderUsageCard } from "../../components/ProviderUsage.tsx";
import { useProviderUsage } from "../../lib/providerUsage.ts";

const KIND_LABEL: Record<Provider["kind"], string> = {
  "anthropic-compatible": "Claude Code on another endpoint — every board tool and guardrail works",
  "openai-compatible": "plain chat API — text only, plan and review stages",
  cli: "another agent's CLI in the task's workspace",
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-5">
      <h2 className="text-[13px] font-semibold text-ink-100">{title}</h2>
      {hint ? <p className="mt-0.5 mb-4 text-[12px] text-ink-400">{hint}</p> : <div className="mb-4" />}
      {children}
    </section>
  );
}

/** The key field: write-only. The board only ever says whether one is set. */
function SecretField({ provider, hasSecret, onChanged }: { provider: Provider; hasSecret: boolean; onChanged: () => void }) {
  const [value, setValue] = useState("");
  const [showLocal, setShowLocal] = useState(false);
  const { busy, error, run } = useAction();
  if (!provider.authRef) return <div className="text-[11.5px] text-ink-500">No key needed (this provider uses its own login).</div>;
  // Ollama and LM Studio run on this computer: nothing to paste unless you locked LM Studio with a token.
  if (isLocal(provider) && !showLocal) {
    return (
      <div className="text-[11.5px] text-ink-400">
        <span className="text-moss">No key needed</span> — it runs on this computer.{" "}
        <button type="button" className="cursor-pointer text-ink-500 underline-offset-2 hover:text-ink-200 hover:underline" onClick={() => setShowLocal(true)}>
          Turned on “Require authentication”? Paste its token
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          className={`${inputCls} font-mono`}
          placeholder={hasSecret ? "•••••••• (set — paste to replace)" : `paste the key stored as ${provider.authRef}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button size="sm" busy={busy} disabled={!value.trim()} onClick={() => run(async () => { await api.setProviderSecret(provider.id, value.trim()); setValue(""); onChanged(); })}>
          Save key
        </Button>
        {hasSecret ? (
          <Button size="sm" variant="ghost" busy={busy} onClick={() => run(async () => { await api.deleteProviderSecret(provider.id); onChanged(); })}>
            Clear
          </Button>
        ) : null}
      </div>
      <div className="mt-1 text-[11px] text-ink-500">
        {hasSecret ? <span className="text-moss">Key is set.</span> : <span className="text-amber">No key yet.</span>}{" "}
        Stored in the board's own secrets file, never in settings; the environment variable <span className="font-mono">{provider.authRef}</span> works too.
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function TestResult({ r }: { r: ProviderTestResult }) {
  return (
    <div className={`mt-2 rounded-md border px-3 py-2 text-[11.5px] ${r.ok ? "border-moss/40 text-ink-300" : "border-rust/50 text-rust"}`}>
      {r.ok ? (
        <>
          <span className="text-moss">Works</span> · {r.latencyMs} ms · model reported as <span className="font-mono">{r.modelEcho ?? "?"}</span> · usage {r.usageReported ? "yes" : "no"} ·
          cost from the API {r.costReported ? "yes" : "no — priced from your table"}
        </>
      ) : (
        <>Failed{r.latencyMs ? ` after ${r.latencyMs} ms` : ""}: {r.error}</>
      )}
    </div>
  );
}

/**
 * What happens when this provider runs out mid-task (D194): by default the task waits for it to come
 * back (a usage window) or asks you (credit that ran out). A fallback carries the stage on instead.
 */
function RunsOut({ p, onChange }: { p: Provider; onChange: (p: Provider) => void }) {
  const { settings } = useAppData();
  if (!settings) return null;
  const others = settings.providers.filter((x) => x.id !== p.id);
  const fb = p.fallback ?? null;
  return (
    <div className="mt-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-500">When it runs out</div>
      <div className="mt-1 flex flex-col gap-1.5 text-[12px] text-ink-200">
        <label className="flex cursor-pointer items-start gap-2">
          <input type="radio" className="mt-0.5 accent-amber" checked={!fb} onChange={() => onChange({ ...p, fallback: null })} />
          <span>
            Wait for it, or ask me
            <span className="block text-[11px] text-ink-500">
              A used-up usage window: the task pauses and carries on by itself when it resets. Credit that ran out: the task waits for you to switch
              provider or top up.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            className="mt-0.5 accent-amber"
            checked={Boolean(fb)}
            onChange={() => onChange({ ...p, fallback: { provider: "anthropic", model: settings.tiers.balanced.provider === "anthropic" ? settings.tiers.balanced.model : settings.models[0]?.id ?? "" } })}
          />
          <span className="flex-1">
            Carry the stage on elsewhere, straight away
            <span className="block text-[11px] text-ink-500">The next model is told what this one did and finds its changes in place.</span>
          </span>
        </label>
        {fb ? (
          <div className="ml-6 max-w-[460px]">
            <ProviderPicker value={fb} onChange={(v) => onChange({ ...p, fallback: v })} models={settings.models} providers={others} compact />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProviderCard({ p, hasSecret, onChange, onRemove, onSecretChanged }: { p: Provider; hasSecret: boolean; onChange: (p: Provider) => void; onRemove: () => void; onSecretChanged: () => void }) {
  const usage = useProviderUsage().rows?.find((u) => u.provider_id === p.id);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [testModel, setTestModel] = useState(p.models[0]?.id ?? "");
  // Test goes through the saved settings, so an unsaved card cannot be tested yet.
  const savedCopy = useAppData().settings?.providers.find((x) => x.id === p.id);
  const unsaved = !savedCopy || JSON.stringify(savedCopy) !== JSON.stringify(p);
  // A provider with an empty list (LM Studio) is tested on what it says it has.
  const { result: live } = useCatalog(p.enabled && !p.models.length ? p : undefined);
  const testIds = p.models.length ? p.models.map((m) => m.id).filter(Boolean) : (live?.models ?? []).filter((m) => m.installed !== false).map((m) => m.id);
  const setModel = (i: number, patch: Partial<ProviderModel>) => onChange({ ...p, models: p.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const num = (v: string) => (v.trim() === "" ? undefined : Math.max(0, Number(v) || 0));
  return (
    <div className={`rounded-lg border p-3 ${p.enabled ? "border-ink-700 bg-ink-850/60" : "border-ink-800 bg-ink-900/40 opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] text-iris">{p.id}</span>
        <input className={`${inputCls} max-w-[200px]`} value={p.label} onChange={(e) => onChange({ ...p, label: e.target.value })} />
        <span className="text-[11px] text-ink-500" title={KIND_LABEL[p.kind]}>{p.kind}</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-300">
          <input type="checkbox" className="accent-amber" checked={p.enabled} onChange={(e) => onChange({ ...p, enabled: e.target.checked })} /> enabled
        </label>
        <button className="px-1.5 text-ink-400 hover:text-rust cursor-pointer" onClick={onRemove} title="Remove provider">×</button>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-500">{KIND_LABEL[p.kind]}.</p>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {p.kind !== "cli" ? (
          <Field label="Base URL">
            <input className={`${inputCls} font-mono`} value={p.baseUrl ?? ""} onChange={(e) => onChange({ ...p, baseUrl: e.target.value.trim() })} />
          </Field>
        ) : (
          <Field label="CLI preset">
            <select className={`${inputCls} font-mono`} value={p.cli?.preset ?? "custom"} onChange={(e) => onChange({ ...p, cli: { ...(p.cli ?? {}), preset: e.target.value as NonNullable<Provider["cli"]>["preset"] } })}>
              {["codex", "gemini", "kimi", "opencode", "custom"].map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
        )}
        <Field label="Secret name" hint="The name the key is stored under (and the env var that can supply it).">
          <input className={`${inputCls} font-mono`} value={p.authRef} placeholder="e.g. ZAI_API_KEY" onChange={(e) => onChange({ ...p, authRef: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })} />
        </Field>
      </div>
      {p.kind === "cli" && p.cli?.preset === "custom" ? (
        <Field label="Command" hint="Placeholders: {prompt_file} {cwd} {model} {mode}. stdout is the result.">
          <input className={`${inputCls} font-mono`} value={p.cli.command ?? ""} onChange={(e) => onChange({ ...p, cli: { ...p.cli!, command: e.target.value } })} />
        </Field>
      ) : null}
      {p.kind === "cli" && (p.cli?.preset === "custom" || p.cli?.preset === "opencode") ? (
        <Field label="Pass these environment variables through" hint="Comma-separated names the CLI needs (e.g. OPENROUTER_API_KEY). Never an ANTHROPIC_* one.">
          <input
            className={`${inputCls} font-mono`}
            value={(p.cli?.envPassthrough ?? []).join(", ")}
            onChange={(e) => onChange({ ...p, cli: { ...p.cli!, envPassthrough: e.target.value.split(",").map((x) => x.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "")).filter(Boolean) } })}
          />
        </Field>
      ) : null}
      {p.kind === "cli" ? (
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
          <input type="checkbox" className="mt-1 accent-amber" checked={p.mayEditFiles} onChange={(e) => onChange({ ...p, mayEditFiles: e.target.checked })} />
          <span>
            May edit files (run code stages)
            <span className="block text-[11.5px] text-ink-400">
              Off: this CLI only runs plan and review stages, launched read-only. On: it may run code stages, but only for autonomous tasks
              (in a worktree) — the board cannot approve or block what another CLI does.
            </span>
          </span>
        </label>
      ) : null}

      <div className="mt-3">
        <div className="text-[11px] uppercase tracking-wider text-ink-500">Key</div>
        <SecretField provider={p} hasSecret={hasSecret} onChanged={onSecretChanged} />
        {p.kind === "anthropic-compatible" && !isLocal(p) ? (
          <label className="mt-1.5 flex items-center gap-2 text-[11.5px] text-ink-400">
            Sent as
            <select className={`${inputCls} h-7 w-auto! py-0 text-[11.5px]`} value={p.authStyle ?? "bearer"} onChange={(e) => onChange({ ...p, authStyle: e.target.value as Provider["authStyle"] })}>
              <option value="bearer">a bearer token (most providers)</option>
              <option value="api-key">an API key (Kimi Code)</option>
            </select>
          </label>
        ) : null}
      </div>

      <RunsOut p={p} onChange={onChange} />
      {usage ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-ink-500">Usage</span>
            <OutChip out={usage.out} />
            {usage.plan ? <span className="font-mono text-[10.5px] text-ink-500">{usage.plan}</span> : null}
          </div>
          <ProviderUsageCard u={usage} compact />
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-wider text-ink-500">Models</span>
          <span className="text-[11px] text-ink-500">USD per million tokens; leave prices empty for a subscription (shown as such, tokens still counted).</span>
        </div>
        {!p.models.length ? (
          <p className="mb-1 text-[11.5px] text-ink-400">None listed: the stage picker shows what this provider says it has. Add one here only to pin it or give it a price.</p>
        ) : null}
        <div className="space-y-1">
          {p.models.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_130px_80px_80px_90px_auto] items-center gap-1.5">
              <input className={`${inputCls} font-mono`} value={m.id} onChange={(e) => setModel(i, { id: e.target.value.trim() })} />
              <input className={inputCls} value={m.label} onChange={(e) => setModel(i, { label: e.target.value })} />
              <input className={`${inputCls} font-mono`} type="number" min={0} step={0.01} placeholder="in $" value={m.inputPer1M ?? ""} onChange={(e) => setModel(i, { inputPer1M: num(e.target.value) })} />
              <input className={`${inputCls} font-mono`} type="number" min={0} step={0.01} placeholder="out $" value={m.outputPer1M ?? ""} onChange={(e) => setModel(i, { outputPer1M: num(e.target.value) })} />
              <input className={`${inputCls} font-mono`} type="number" min={0} step={1000} placeholder="context" value={m.contextWindow ?? ""} onChange={(e) => setModel(i, { contextWindow: num(e.target.value) })} />
              <button className="px-1.5 text-ink-400 hover:text-rust cursor-pointer" onClick={() => onChange({ ...p, models: p.models.filter((_, j) => j !== i) })} title="Remove">×</button>
            </div>
          ))}
          <button type="button" className="text-[11px] text-ink-400 hover:text-ink-200 cursor-pointer" onClick={() => onChange({ ...p, models: [...p.models, { id: "", label: "" }] })}>
            + model
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <select className={`${inputCls} max-w-[220px] font-mono`} value={testModel} onChange={(e) => setTestModel(e.target.value)}>
          {testIds.length ? null : <option value="">first model it reports</option>}
          {testIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <Button
          size="sm"
          busy={testing}
          disabled={!p.enabled || unsaved}
          title={unsaved ? "Click Save settings (top right) first" : "One tiny call through exactly the path a stage would use."}
          onClick={() =>
            void (async () => {
              setTesting(true);
              try {
                setResult(await api.testProvider(p.id, testModel || undefined));
              } catch (err) {
                setResult({ ok: false, latencyMs: 0, modelEcho: null, usageReported: false, costReported: false, error: err instanceof Error ? err.message : String(err) });
              } finally {
                setTesting(false);
              }
            })()
          }
        >
          Test
        </Button>
        {unsaved ? (
          <span className="text-[11px] text-amber">Unsaved changes: click <b>Save settings</b> (top right) first.</span>
        ) : (
          <span className="text-[11px] text-ink-500">sends one tiny message</span>
        )}
      </div>
      {result ? <TestResult r={result} /> : null}
    </div>
  );
}

export function ProviderSettings({ providers, onChange }: { providers: Provider[]; onChange: (p: Provider[]) => void }) {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [pick, setPick] = useState("");
  const reload = () => void api.providers().then(setRows).catch(() => null);
  useEffect(() => {
    reload();
    void api.providerPresets().then(setPresets).catch(() => null);
  }, []);
  const has = (id: string) => rows.find((r) => r.id === id)?.hasSecret ?? false;

  const add = async () => {
    const preset = presets.find((p) => p.id === pick);
    if (!preset) return;
    let id = preset.id;
    for (let n = 2; providers.some((p) => p.id === id); n++) id = `${preset.id}-${n}`;
    const { blurb: _b, help: _h, seedSecret: _s, ...rest } = preset;
    const next = [...providers, { ...rest, id, enabled: true }];
    onChange(next);
    setPick("");
    // Saved straight away, so Test and the stage pickers work without hunting for the Save button.
    // A preset with a placeholder token (Ollama, LM Studio) gets it stored server-side on this save.
    await api.patchSettings({ providers: next }).catch(() => null);
    reload();
  };

  return (
    <>
      <Section
        title="Providers"
        hint="Other places a stage can run: a cheaper model, a local one, or another agent that is better at some kind of work. Pick one per stage in any pipeline editor; Claude stays the default."
      >
        <LocalModelsGuide providers={providers} presets={presets} />
        <div className="flex items-center gap-2">
          <select className={`${inputCls} max-w-[320px]`} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Add from a preset…</option>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.label} — {p.kind}</option>)}
          </select>
          <Button size="sm" disabled={!pick} onClick={() => void add()}>Add</Button>
        </div>
        {pick ? <p className="mt-2 text-[11.5px] text-ink-400">{presets.find((p) => p.id === pick)?.blurb} <span className="text-ink-500">{presets.find((p) => p.id === pick)?.help}</span></p> : null}
        {providers.length ? (
          <div className="mt-4 space-y-3">
            {providers.map((p, i) => (
              <ProviderCard
                key={p.id}
                p={p}
                hasSecret={has(p.id)}
                onChange={(np) => onChange(providers.map((x, j) => (j === i ? np : x)))}
                onRemove={() => onChange(providers.filter((_, j) => j !== i))}
                onSecretChanged={reload}
              />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-[12px] text-ink-500">None yet. Every stage runs on Claude through your Claude Code login.</p>
        )}
        <p className="mt-4 text-[11.5px] text-ink-500">
          <b className="text-ink-400">What stays the same:</b> Claude Code on another endpoint keeps the board tools, approvals, worktrees and
          blocked-command list. <b className="text-ink-400">What changes:</b> costs are estimated from the prices you enter, Claude's usage
          windows do not apply, and effort / fast mode are Claude-only controls. A text-only provider gets the diff or the file list in its
          prompt instead of tools, so it can plan or review but not implement. <b className="text-ink-400">Usage:</b> z.ai, Kimi Code,
          OpenRouter and the Kimi API report what is left of your plan or credit, shown here and in the top bar's usage panel; for the others
          the board counts what it sent.
        </p>
      </Section>
    </>
  );
}
