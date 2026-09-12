import type { CatalogModel, ModelCatalogResult, Provider, ProviderModel } from "../../types.ts";

export type FetchJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

const TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 30_000;
const TIMEOUT_MS = 8_000;
/** Claude Code's system prompt and tools alone take ~25k tokens; less than this and a stage fails early. */
export const MIN_AGENT_CONTEXT = 32_000;

const realFetchJson: FetchJson = async (url, headers = {}) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
};

export const isOllama = (p: Provider) => p.kind !== "cli" && (/^ollama/.test(p.id) || /:11434(\/|$)/.test(p.baseUrl ?? ""));
export const isLmStudio = (p: Provider) => p.kind !== "cli" && (/^lmstudio/.test(p.id) || /:1234(\/|$)/.test(p.baseUrl ?? ""));
export const isOpenRouter = (p: Provider) => p.kind !== "cli" && /openrouter\.ai/i.test(p.baseUrl ?? "");
/** Runs on this computer and wants no real key. */
export const isLocal = (p: Provider) => isOllama(p) || isLmStudio(p);

/** "qwen3-coder:latest" and "qwen3-coder" are the same Ollama model. */
const bare = (id: string) => id.replace(/:latest$/, "");

/**
 * The name your Ollama runs a cloud model under: a size tag gets "-cloud" (gemma4:31b → gemma4:31b-cloud),
 * anything else is the family's ":cloud" tag (glm-5.3 → glm-5.3:cloud, deepseek-v4-flash:0731 → deepseek-v4-flash:cloud).
 */
export function cloudId(name: string): string {
  const [base, tag] = name.split(":");
  return tag && /^\d+(\.\d+)?[bm]$/i.test(tag) ? `${base}:${tag}-cloud` : `${base}:cloud`;
}

interface OllamaTags {
  models?: { name: string; size?: number; remote_host?: string; remote_model?: string; details?: { parameter_size?: string } }[];
}

interface OpenRouterModels {
  data?: {
    id: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string };
    architecture?: { output_modalities?: string[]; modality?: string };
    supported_parameters?: string[];
  }[];
}

interface LmStudioModels {
  models?: {
    type?: string;
    key: string;
    display_name?: string;
    size_bytes?: number;
    params_string?: string;
    quantization?: { name?: string };
    max_context_length?: number;
    loaded_instances?: { id: string; config?: { context_length?: number } }[];
    capabilities?: { trained_for_tool_use?: boolean };
  }[];
}

const gb = (bytes?: number) => (bytes ? `${bytes >= 1e9 ? (bytes / 1e9).toFixed(1) : (bytes / 1e9).toFixed(2)} GB` : "");
const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" · ");

/** Ollama's cloud: a free tier with hourly and weekly limits; some models need a paid plan. */
const CLOUD_LABEL = "Ollama's servers · free tier limits, some need a paid plan";

function fromOllama(tags: OllamaTags): CatalogModel[] {
  return (tags.models ?? []).map((m) => {
    const id = bare(m.name);
    const cloud = Boolean(m.remote_host || m.remote_model) || /[-:]cloud$/.test(id);
    return cloud
      ? { id, label: CLOUD_LABEL, group: "cloud", installed: true }
      : { id, label: join(m.details?.parameter_size, gb(m.size)) || id, group: "local", installed: true };
  });
}

/** Ollama's cloud models you have not pulled yet (pulling one only fetches a small manifest). */
function fromOllamaCloud(tags: OllamaTags, have: Set<string>): CatalogModel[] {
  const out = new Map<string, CatalogModel>();
  for (const m of tags.models ?? []) {
    const id = cloudId(m.name);
    if (!have.has(id) && !out.has(id)) out.set(id, { id, label: CLOUD_LABEL, group: "cloud", installed: false });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function fromLmStudio(body: LmStudioModels): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const m of body.models ?? []) {
    if (m.type && m.type !== "llm" && m.type !== "vlm") continue;
    const loaded = m.loaded_instances?.[0];
    const ctx = loaded?.config?.context_length;
    const warning = loaded && ctx && ctx < MIN_AGENT_CONTEXT
      ? `loaded with ${Math.round(ctx / 1000)}k context — reload it with 32k+`
      : m.capabilities?.trained_for_tool_use === false ? "not trained for tools" : undefined;
    out.push({
      id: loaded?.id ?? m.key,
      label: join(m.display_name, m.params_string, m.quantization?.name, gb(m.size_bytes)),
      group: loaded ? "loaded" : "downloaded",
      ...(m.max_context_length ? { contextWindow: m.max_context_length } : {}),
      ...(warning ? { warning } : {}),
    });
  }
  return out.sort((a, b) => (a.group === b.group ? a.id.localeCompare(b.id) : a.group === "loaded" ? -1 : 1));
}

/** OpenRouter prices are USD per token as strings; the board keeps USD per million tokens. */
const perMillion = (s: string | undefined) => {
  const n = Number(s ?? "0");
  return Number.isFinite(n) ? Number((n * 1_000_000).toFixed(6)) : NaN;
};

function fromOpenRouter(body: OpenRouterModels, needTools: boolean): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const m of body.data ?? []) {
    const outputs = m.architecture?.output_modalities ?? (m.architecture?.modality ? [m.architecture.modality.split("->")[1] ?? ""] : ["text"]);
    if (!outputs.includes("text")) continue;
    if (needTools && !(m.supported_parameters ?? []).includes("tools")) continue;
    const inputPer1M = perMillion(m.pricing?.prompt);
    const outputPer1M = perMillion(m.pricing?.completion);
    // Routers (openrouter/auto…) report -1: the price depends on where they send you.
    if (!(inputPer1M >= 0) || !(outputPer1M >= 0)) continue;
    const free = inputPer1M === 0 && outputPer1M === 0;
    out.push({
      id: m.id, label: m.name ?? m.id, group: free ? "free" : "paid",
      ...(free ? {} : { inputPer1M, outputPer1M }),
      ...(m.context_length ? { contextWindow: m.context_length } : {}),
    });
  }
  return out.sort((a, b) => (a.group === b.group ? a.id.localeCompare(b.id) : a.group === "free" ? -1 : 1));
}

const saved = (m: ProviderModel, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id: m.id, label: m.label || m.id, group: "saved",
  ...(m.inputPer1M !== undefined ? { inputPer1M: m.inputPer1M } : {}),
  ...(m.outputPer1M !== undefined ? { outputPer1M: m.outputPer1M } : {}),
  ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
  ...extra,
});

/**
 * What a provider can actually run right now: what Ollama has pulled plus its cloud list, what LM
 * Studio has downloaded, or OpenRouter's whole list with prices. Providers with no list to ask keep
 * the models typed into Settings → Providers.
 */
export class ModelCatalog {
  private cache = new Map<string, { at: number; ttl: number; value: ModelCatalogResult }>();

  constructor(private fetchJson: FetchJson = realFetchJson, private now: () => number = Date.now) {}

  /** `secret` is sent only to a local LM Studio, which asks for one when "Require authentication" is on. */
  async list(provider: Provider, secret?: string | null): Promise<ModelCatalogResult> {
    const key = `${provider.id}|${provider.kind}|${provider.baseUrl ?? ""}`;
    const hit = this.cache.get(key);
    const merge = (r: ModelCatalogResult) => this.withSaved(provider, r);
    if (hit && this.now() - hit.at < hit.ttl) return merge(hit.value);

    let value: ModelCatalogResult;
    let ttl = TTL_MS;
    try {
      const models = await this.ask(provider, secret);
      value = models ? { source: "live", models } : { source: "saved", models: [] };
    } catch (err) {
      ttl = FAIL_TTL_MS;
      const why = err instanceof Error ? err.message : String(err);
      value = { source: "saved", models: [], error: isLocal(provider) ? why : `Could not list ${provider.label}'s models: ${why}` };
    }
    this.cache.set(key, { at: this.now(), ttl, value });
    return merge(value);
  }

  private async ask(provider: Provider, secret?: string | null): Promise<CatalogModel[] | null> {
    const origin = (fallback: string) => new URL(provider.baseUrl || fallback).origin;
    if (isOllama(provider)) {
      const at = origin("http://localhost:11434");
      // The public cloud list is a bonus: if ollama.com cannot be reached, your pulled models still show.
      const cloud = this.fetchJson("https://ollama.com/api/tags").catch(() => ({}) as OllamaTags);
      let tags: OllamaTags;
      try {
        tags = (await this.fetchJson(`${at}/api/tags`)) as OllamaTags;
      } catch {
        throw new Error(`Ollama is not answering at ${at}. Start it to see the models you have pulled.`);
      }
      const pulled = fromOllama(tags);
      return [...pulled, ...fromOllamaCloud((await cloud) as OllamaTags, new Set(pulled.map((m) => m.id)))];
    }
    if (isLmStudio(provider)) {
      const at = origin("http://localhost:1234");
      try {
        return fromLmStudio((await this.fetchJson(`${at}/api/v1/models`, secret ? { authorization: `Bearer ${secret}` } : {})) as LmStudioModels);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (/HTTP 401|HTTP 403/.test(why)) throw new Error(`LM Studio at ${at} wants a token: paste the one from LM Studio → Developer → Server settings as this provider's key.`);
        throw new Error(`LM Studio is not answering at ${at}. Open LM Studio → Developer and start the server.`);
      }
    }
    if (isOpenRouter(provider)) {
      return fromOpenRouter((await this.fetchJson("https://openrouter.ai/api/v1/models")) as OpenRouterModels, provider.kind === "anthropic-compatible");
    }
    return null;
  }

  /** A price the live list knows for a model your table has no price for (cached lists only; never fetches). */
  priceOf(provider: Provider, model: string): { inputPer1M?: number; outputPer1M?: number } | undefined {
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(`${provider.id}|`)) continue;
      const m = entry.value.models.find((x) => x.id === model);
      if (m) return { inputPer1M: m.inputPer1M ?? 0, outputPer1M: m.outputPer1M ?? 0 };
    }
    return undefined;
  }

  /** Models you typed in that the provider did not report stay pickable, so nothing disappears. */
  private withSaved(provider: Provider, r: ModelCatalogResult): ModelCatalogResult {
    const norm = (id: string) => (isOllama(provider) ? bare(id) : id);
    const have = new Set(r.models.map((m) => norm(m.id)));
    const extra = provider.models
      .filter((m) => m.id && !have.has(norm(m.id)))
      .map((m) => saved(m, r.source === "live" && isLocal(provider) ? { installed: false } : {}));
    return { ...r, models: [...r.models, ...extra] };
  }
}
