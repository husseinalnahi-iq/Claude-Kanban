import { ANTHROPIC_PROVIDER_ID, EFFORTS, type CatalogModel, type Effort, type ModelCatalogResult, type ModelEntry, type ModelSurface, type Provider, type TierRef } from "../../../server/src/types.ts";
import { useAppData } from "../lib/store.tsx";
import { providerVisibleIn, visibleIn } from "../lib/modelLists.ts";
import { EffortSelect } from "./ClaudeModelPicker.tsx";
import { useCatalog } from "../lib/catalog.ts";
import { claudeOptions, claudeWarning, useClaudeModels } from "../lib/claudeModels.ts";
import { claudeModelStatus } from "../../../server/src/engine/claudeModels.ts";
import { isLocal } from "../../../server/src/engine/providers/catalog.ts";
import { ModelCombobox, type ModelOption } from "./ModelCombobox.tsx";
import { Select } from "./ui.tsx";

const ADD_PROVIDER = "__add";

/** Where a provider's models run, so the provider box says which are Claude, local or someone else's cloud. */
type Place = "local" | "online" | "cli";
const PLACES: [Place, string][] = [
  ["local", "On this computer — free (Ollama also has cloud models)"],
  ["online", "Online — another company's models"],
  ["cli", "Another agent app"],
];
const placeOf = (p: Provider): Place => (p.kind === "cli" ? "cli" : isLocal(p) ? "local" : "online");

const money = (n: number) => `$${+n.toPrecision(3)}`;
const ctx = (n?: number) => (!n ? "" : n >= 1_000_000 ? `${+(n / 1_000_000).toPrecision(3)}M ctx` : `${Math.round(n / 1000)}k ctx`);
const priced = (m: { inputPer1M?: number; outputPer1M?: number }) => Boolean(m.inputPer1M || m.outputPer1M);
const meta = (m: CatalogModel) =>
  [priced(m) ? `${money(m.inputPer1M ?? 0)} / ${money(m.outputPer1M ?? 0)} per 1M` : "", ctx(m.contextWindow)].filter(Boolean).join(" · ");

function groupName(m: CatalogModel, r: ModelCatalogResult): string {
  switch (m.group) {
    case "local": return "On this computer · free";
    case "cloud": return m.installed === false ? "Ollama cloud · run “ollama pull <id>” once (a few KB)" : "Ollama cloud · ready";
    case "loaded": return "Loaded in LM Studio · free";
    case "downloaded": return "Downloaded in LM Studio · free (loads on first use)";
    case "free": return "Online · free";
    case "paid": return "Online · paid per use";
    case "plan": return "On your subscription · no per-token bill";
    default: return r.source === "live" && m.installed === false ? "Your list · not on this computer yet" : "Your list";
  }
}
const ORDER: CatalogModel["group"][] = ["plan", "local", "loaded", "downloaded", "cloud", "free", "paid", "saved"];

/** The provider's rows for the model picker: its live list when it has one, else what you typed in. */
function optionsFor(p: Provider, r: ModelCatalogResult | null): ModelOption[] {
  const models: CatalogModel[] = r ? r.models : p.models.map((m) => ({ ...m, label: m.label || m.id, group: "saved" as const }));
  const res = r ?? { source: "saved" as const, models };
  const rank = (m: CatalogModel) => ORDER.indexOf(m.group) * 2 + (m.installed === false ? 1 : 0);
  return [...models]
    .sort((a, b) => rank(a) - rank(b))
    .map((m) => ({
      id: m.id,
      label: m.label,
      group: groupName(m, res),
      meta: meta(m),
      tag: m.warning ?? (m.installed === false && m.group !== "cloud" ? "not on this computer" : undefined),
      free: m.group === "local" || m.group === "free" || m.group === "loaded" || m.group === "downloaded",
    }));
}

/** A provider's model that its live list does not have (a typo, or one that was removed). */
function providerWarning(p: Provider | undefined, r: ModelCatalogResult | null, model: string): { text: string; tone: "amber" } | undefined {
  if (!p || !r || r.source !== "live" || !model) return undefined;
  const m = r.models.find((x) => x.id === model);
  if (!m) return { text: `${p.label} does not list this model — check the spelling, or pick one from the list`, tone: "amber" };
  if (m.installed === false && m.group !== "cloud") return { text: "Not on this computer yet — download or pull it first", tone: "amber" };
  return undefined;
}

/**
 * Where a stage runs and on what: a provider (Claude, or one from Settings → Providers) and then a
 * model — from the provider's live list when it has one (Ollama, OpenRouter), else from your list.
 * Any id typed into the filter can be used as it is.
 */
export function ProviderPicker({
  value, onChange, models, providers, compact, stacked, surface,
}: {
  value: TierRef;
  onChange: (v: TierRef) => void;
  /** Claude models (Settings → Models). */
  models: ModelEntry[];
  providers: Provider[];
  compact?: boolean;
  /** Provider above model, for a column too narrow to show a whole model id beside it. */
  stacked?: boolean;
  /** Which picker this is, for Settings → Model lists (D300): what is hidden there is not offered. */
  surface?: ModelSurface;
}) {
  const { settings } = useAppData();
  const enabled = providers.filter((p) => p.enabled && (!surface || providerVisibleIn(settings, surface, p.id, value.provider)));
  const isClaude = !value.provider || value.provider === ANTHROPIC_PROVIDER_ID;
  const current = enabled.find((p) => p.id === value.provider);
  const { result, loading } = useCatalog(isClaude ? undefined : current);
  const claude = useClaudeModels();
  const options: ModelOption[] = (isClaude ? claudeOptions(models, claude.result) : current ? optionsFor(current, result) : []).filter(
    (o) => !surface || visibleIn(settings, surface, isClaude ? ANTHROPIC_PROVIDER_ID : value.provider, o.id, value.model),
  );
  const warn = isClaude ? claudeWarning(claudeModelStatus(value.model, claude.result)) : providerWarning(current, result, value.model);

  const pickProvider = (id: string) => {
    if (id === ADD_PROVIDER) {
      // A new tab, so a half-written task in this one is not lost; the list here updates when you save there.
      window.open(`${location.pathname}#/settings?tab=providers`, "_blank");
      return;
    }
    const p = enabled.find((x) => x.id === id);
    const first = id === ANTHROPIC_PROVIDER_ID ? models[1]?.id ?? models[0]?.id ?? "" : p?.models[0]?.id ?? "";
    onChange({ provider: id, model: first });
  };

  return (
    <div className={`grid gap-1 ${stacked ? "grid-cols-1" : compact ? "grid-cols-[104px_minmax(0,1fr)]" : "grid-cols-[140px_minmax(0,1fr)]"}`}>
      <Select
        wide
        className={`font-mono ${isClaude ? "" : "text-iris!"}`}
        value={isClaude ? ANTHROPIC_PROVIDER_ID : value.provider}
        onChange={(e) => pickProvider(e.target.value)}
        title={isClaude ? "Claude, through your Claude Code login" : (current?.label ?? value.provider)}
      >
        <optgroup label="Claude — your Claude plan">
          <option value={ANTHROPIC_PROVIDER_ID}>claude</option>
        </optgroup>
        {PLACES.map(([place, label]) => {
          const here = enabled.filter((p) => placeOf(p) === place);
          return here.length ? (
            <optgroup key={place} label={label}>
              {/* The short id fits the closed picker; the open list says which one it is ("Codex · ChatGPT subscription"). */}
              {here.map((p) => <option key={p.id} value={p.id} data-note={p.label !== p.id ? p.label : undefined}>{p.id}</option>)}
            </optgroup>
          ) : null;
        })}
        {!isClaude && !current ? <option value={value.provider}>{value.provider} (missing)</option> : null}
        <option value={ADD_PROVIDER}>+ Add a provider (LM Studio, Ollama, OpenRouter…)</option>
      </Select>
      <ModelCombobox
        value={value.model}
        onChange={(model) => onChange({ ...value, model })}
        options={options}
        warn={warn}
        loading={isClaude ? claude.loading && !claude.result : loading}
        note={
          isClaude
            ? claude.result?.error ? `Could not ask Claude Code for its models (${claude.result.error}). Showing your list.` : null
            : result?.error ? `${result.error.replace(/\.?$/, ".")} Showing your list from Settings → Providers.` : null
        }
      />
    </div>
  );
}

/** Codex and Claude take an effort; a Claude-compatible endpoint has it stripped by Claude Code (D298). */
export const takesEffort = (provider: string | null | undefined, providers: Provider[]): boolean => {
  if (!provider || provider === ANTHROPIC_PROVIDER_ID) return true;
  const p = providers.find((x) => x.id === provider);
  return Boolean(p && p.kind === "cli" && p.cli?.preset === "codex");
};

/**
 * Effort for a pick on any provider: Claude's levels from your login, a Codex model's own levels from
 * Codex's list (low to max), and none for an endpoint where it would not be sent (D298).
 */
export function ProviderEffort({
  provider, model, value, onChange, providers, notes, labelled, className,
}: {
  provider: string | null | undefined;
  model: string;
  value: Effort;
  onChange: (e: Effort) => void;
  providers: Provider[];
  notes?: boolean;
  labelled?: boolean;
  className?: string;
}) {
  const p = providers.find((x) => x.id === provider && x.enabled);
  const codex = p?.kind === "cli" && p.cli?.preset === "codex" ? p : undefined;
  const { result } = useCatalog(codex);
  const isClaude = !provider || provider === ANTHROPIC_PROVIDER_ID;
  if (isClaude) return <EffortSelect className={className} notes={notes} labelled={labelled} model={model} value={value} onChange={onChange} />;
  if (codex) {
    const levels = result?.models.find((m) => m.id === model)?.efforts ?? EFFORTS;
    return <EffortSelect className={className} notes={notes} labelled={labelled} model={model} value={value} onChange={onChange} levels={levels} />;
  }
  return (
    <span className="block min-w-0" title="Effort is not sent to this provider">
      <EffortSelect className={className} notes={notes} labelled={labelled} model={model} value={value} onChange={onChange} disabled />
    </span>
  );
}
