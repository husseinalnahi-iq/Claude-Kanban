import type { Provider, QuotaWindow } from "../../types.ts";
import { safeHost } from "./limits.ts";

/**
 * How much of a provider's plan is left, asked from the provider itself where it will say
 * (docs/DECISIONS.md D195). Every one of these is a read: nothing is sent to a model, so it is free.
 *
 * - z.ai / Zhipu (GLM Coding Plan): the same 5-hour and weekly percentages its own usage page shows.
 * - Kimi Code: the 5-hour window and the weekly quota.
 * - OpenRouter: credit left on the account.
 * - Moonshot (Kimi API): the account balance.
 * Anyone else (Ollama's cloud, Alibaba, MiniMax…) has no public way to ask; the board's own count
 * of what its runs sent there is shown instead.
 */
export type QuotaSource = "zai" | "kimi" | "openrouter" | "moonshot";

export interface LiveQuota {
  windows: QuotaWindow[];
  balance: { amount: number; currency: string; label: string } | null;
  plan: string | null;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function quotaSource(p: Provider): QuotaSource | null {
  if (p.kind === "cli") return null;
  const host = safeHost(p.baseUrl);
  if (/(^|\.)z\.ai$|bigmodel\.cn$/i.test(host)) return "zai";
  if (/^api\.kimi\.com$/i.test(host)) return "kimi";
  if (/openrouter\.ai$/i.test(host)) return "openrouter";
  if (/moonshot\.(ai|cn)$/i.test(host)) return "moonshot";
  return null;
}

const iso = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/** Name a window by how far away its reset is, when the provider does not name it. */
function windowName(resetMs: number | null, now: number): string {
  if (!resetMs) return "Usage";
  const h = (resetMs - now) / 3_600_000;
  return h <= 6 ? "5-hour window" : h <= 8 * 24 ? "Weekly" : "Monthly";
}

interface ZaiLimit { type?: string; percentage?: number; nextResetTime?: number; usage?: number; currentValue?: number }

export function parseZai(body: unknown, now = Date.now()): LiveQuota {
  const data = (body as { data?: { limits?: ZaiLimit[]; level?: string; planName?: string } })?.data;
  if (!data || !Array.isArray(data.limits)) throw new Error("z.ai sent no usage figures");
  const windows: QuotaWindow[] = [];
  for (const l of data.limits) {
    const pct = num(l.percentage);
    const used = Number.isFinite(pct) ? Math.max(0, pct) / 100 : null;
    if (l.type === "TOKENS_LIMIT") windows.push({ label: windowName(l.nextResetTime ?? null, now), used, resets_at: iso(l.nextResetTime) });
    else if (l.type === "TIME_LIMIT") windows.push({ label: "Web tools (monthly)", used, resets_at: iso(l.nextResetTime), soft: true });
  }
  // Soonest reset first; the web-tool count, with no reset, last.
  windows.sort((a, b) => (a.resets_at ? Date.parse(a.resets_at) : Infinity) - (b.resets_at ? Date.parse(b.resets_at) : Infinity));
  const plan = data.planName ?? data.level ?? null;
  return { windows, balance: null, plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null };
}

interface KimiDetail { limit?: string | number; used?: string | number; remaining?: string | number; resetTime?: string }

export function parseKimi(body: unknown): LiveQuota {
  const b = body as { user?: { membership?: { level?: string } }; usage?: KimiDetail; limits?: { window?: { duration?: number; timeUnit?: string }; detail?: KimiDetail }[] };
  if (!b || (!b.usage && !Array.isArray(b.limits))) throw new Error("Kimi sent no usage figures");
  const share = (d: KimiDetail) => {
    const limit = num(d.limit);
    const used = num(d.used);
    return limit > 0 && Number.isFinite(used) ? used / limit : null;
  };
  const windows: QuotaWindow[] = [];
  for (const l of b.limits ?? []) {
    if (!l.detail) continue;
    const minutes = (l.window?.duration ?? 0) * (/HOUR/.test(l.window?.timeUnit ?? "") ? 60 : /DAY/.test(l.window?.timeUnit ?? "") ? 1440 : 1);
    const label = minutes && minutes < 1440 ? `${Math.round(minutes / 60)}-hour window` : minutes ? `${Math.round(minutes / 1440)}-day window` : "Window";
    windows.push({ label, used: share(l.detail), resets_at: l.detail.resetTime ?? null });
  }
  if (b.usage) windows.push({ label: "Weekly", used: share(b.usage), resets_at: b.usage.resetTime ?? null });
  const level = b.user?.membership?.level?.replace(/^LEVEL_/, "").toLowerCase() ?? null;
  return { windows, balance: null, plan: level ? level[0].toUpperCase() + level.slice(1) : null };
}

export function parseOpenRouter(credits: unknown): LiveQuota {
  const d = (credits as { data?: { total_credits?: number; total_usage?: number } })?.data;
  if (!d || typeof d.total_credits !== "number") throw new Error("OpenRouter sent no credit figures");
  return { windows: [], balance: { amount: d.total_credits - (d.total_usage ?? 0), currency: "USD", label: "credit left" }, plan: null };
}

export function parseMoonshot(body: unknown, currency: string): LiveQuota {
  const d = (body as { data?: { available_balance?: number } })?.data;
  if (!d || typeof d.available_balance !== "number") throw new Error("Moonshot sent no balance");
  return { windows: [], balance: { amount: d.available_balance, currency, label: "balance" }, plan: null };
}

const realFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Asks each provider at most every five minutes (a minute after a failure); "Check now" forces it.
 * Keys only ever go to the provider's own host.
 */
export class QuotaReader {
  private cache = new Map<string, { at: number; ttl: number; value: LiveQuota | Error }>();

  constructor(private fetchFn: FetchLike = realFetch, private now: () => number = Date.now) {}

  async read(p: Provider, secret: string | null, force = false): Promise<LiveQuota | null> {
    const source = quotaSource(p);
    if (!source) return null;
    if (!secret) throw new Error(`No key saved for ${p.label}, so its usage cannot be read.`);
    const key = `${p.id}|${p.baseUrl ?? ""}`;
    const hit = this.cache.get(key);
    if (!force && hit && this.now() - hit.at < hit.ttl) {
      if (hit.value instanceof Error) throw hit.value;
      return hit.value;
    }
    try {
      const value = await this.ask(source, p, secret);
      this.cache.set(key, { at: this.now(), ttl: 5 * 60_000, value });
      return value;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.cache.set(key, { at: this.now(), ttl: 60_000, value: e });
      throw e;
    }
  }

  private async get(url: string, headers: Record<string, string>): Promise<unknown> {
    const res = await this.fetchFn(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "the key was refused when asking for usage" : `HTTP ${res.status} when asking for usage`);
    return res.json();
  }

  private async ask(source: QuotaSource, p: Provider, secret: string): Promise<LiveQuota> {
    const origin = new URL(p.baseUrl!).origin;
    switch (source) {
      // z.ai takes the key as it is, without "Bearer".
      case "zai":
        return parseZai(await this.get(`${origin}/api/monitor/usage/quota/limit`, { authorization: secret, "accept-language": "en-US,en" }), this.now());
      case "kimi":
        return parseKimi(await this.get(`${origin}/coding/v1/usages`, { authorization: `Bearer ${secret}` }));
      case "openrouter":
        return parseOpenRouter(await this.get("https://openrouter.ai/api/v1/credits", { authorization: `Bearer ${secret}` }));
      case "moonshot":
        return parseMoonshot(await this.get(`${origin}/v1/users/me/balance`, { authorization: `Bearer ${secret}` }), /\.cn$/.test(new URL(origin).host) ? "CNY" : "USD");
    }
  }
}
