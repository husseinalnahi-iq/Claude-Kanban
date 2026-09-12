import type { Repo } from "../../repo.ts";
import type { SecretStore } from "../../secrets.ts";
import { ANTHROPIC_PROVIDER_ID, type Effort, type Mode, type Provider, type Settings, type Stage, type StageName } from "../../types.ts";
import { anthropicAdapter, anthropicCompatibleAdapter } from "./anthropicCompatible.ts";
import { openaiCompatibleAdapter } from "./openaiCompatible.ts";
import { cliAdapter } from "./cli/index.ts";
import type { ProviderAdapter, Resolved } from "./types.ts";

/** The request names a provider that cannot run this (HTTP 409). Same class the runner maps. */
export class ProviderError extends Error {}

/** Adapters for the non-SDK kinds register themselves here (openai-compatible in Phase B, cli in Phase C). */
const ADAPTERS: Partial<Record<Provider["kind"], ProviderAdapter>> = {
  "anthropic-compatible": anthropicCompatibleAdapter,
  "openai-compatible": openaiCompatibleAdapter,
  cli: cliAdapter,
};

export function registerAdapter(kind: Provider["kind"], adapter: ProviderAdapter): void {
  ADAPTERS[kind] = adapter;
}

const ANTHROPIC: Resolved = { id: ANTHROPIC_PROVIDER_ID, provider: null, adapter: anthropicAdapter, secret: null, label: "Claude" };

export class ProviderRegistry {
  constructor(private repo: Repo, private secrets: SecretStore) {}

  /** null / "anthropic" → Claude through your login. Anything else must be an enabled provider. */
  resolve(id: string | null | undefined): Resolved {
    if (!id || id === ANTHROPIC_PROVIDER_ID) return ANTHROPIC;
    const provider = this.repo.getSettings().providers.find((p) => p.id === id);
    if (!provider) throw new ProviderError(`Provider "${id}" does not exist (Settings → Providers).`);
    if (!provider.enabled) throw new ProviderError(`Provider "${provider.label}" is switched off (Settings → Providers).`);
    const adapter = ADAPTERS[provider.kind];
    if (!adapter) throw new ProviderError(`Provider "${provider.label}" is of a kind this board cannot run yet (${provider.kind}).`);
    return { id, provider, adapter, secret: this.secrets.get(provider.authRef), label: provider.label };
  }

  /**
   * Which stages a provider may run, and in which mode (docs/DECISIONS.md D128, D129).
   * Returns the reason it may not, or null when it may.
   */
  allowedOn(res: Resolved, stage: StageName, mode: Mode): string | null {
    const { adapter, provider } = res;
    const agentic = stage === "code" || stage === "custom";
    if (!adapter.hasTools && agentic) {
      return `${res.label} has no tools, so it can plan or review but not implement. Use it on a plan or review stage.`;
    }
    if (adapter.kind === "cli" && agentic) {
      if (!provider?.mayEditFiles) return `${res.label} is read-only on this board (Settings → Providers → "may edit files"), so it cannot run a ${stage} stage.`;
      if (mode !== "autonomous") return `${res.label} cannot ask for approvals, so it may only run a ${stage} stage in autonomous mode (in a worktree). Switch the task to autonomous, or use a Claude stage.`;
    }
    return null;
  }

  /** Throws when any stage of the pipeline names a provider that cannot run it. */
  assertPipeline(pipeline: Stage[], mode: Mode): void {
    pipeline.forEach((stage, i) => {
      const res = this.resolve(stage.provider);
      const why = this.allowedOn(res, stage.stage, mode);
      if (why) throw new ProviderError(`Stage #${i + 1} (${stage.stage}): ${why}`);
      if (stage.stage === "plan" && stage.debate && typeof stage.debate === "object") this.resolve(stage.debate.provider);
    });
  }

  /** Who critiques this plan stage, or null when no debate is wanted. */
  debateFor(stage: Stage, settings: Settings): { provider: string; model: string; effort: Effort } | null {
    if (stage.stage !== "plan" || stage.debate === false) return null;
    if (stage.debate && typeof stage.debate === "object") return { effort: settings.debate.critic.effort, ...stage.debate };
    return settings.debate.enabled ? settings.debate.critic : null;
  }
}
