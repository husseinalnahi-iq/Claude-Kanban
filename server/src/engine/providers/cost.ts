import type { CostSource, Provider } from "../../types.ts";
import type { TokenUsage } from "./types.ts";

/**
 * What a foreign run cost, from the price you entered for that model (USD per million tokens).
 * The SDK prices unknown model ids as $0, so its own figure is useless here. With no price at all the
 * run is treated as a subscription: $0, tokens still counted (docs/DECISIONS.md D123).
 * `fallback` is the provider's own list price, used only when your table has no price for the model.
 */
export function estimateCost(
  provider: Provider, model: string, u: TokenUsage, fallback?: { inputPer1M?: number; outputPer1M?: number },
): { usd: number; source: CostSource } {
  const own = provider.models.find((m) => m.id === model);
  const price = own && (own.inputPer1M || own.outputPer1M) ? own : fallback;
  const inPrice = price?.inputPer1M ?? 0;
  const outPrice = price?.outputPer1M ?? 0;
  if (!inPrice && !outPrice) return { usd: 0, source: "subscription" };
  const inTok = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
  const usd = (inTok / 1_000_000) * inPrice + ((u.outputTokens ?? 0) / 1_000_000) * outPrice;
  return { usd: Number(usd.toFixed(6)), source: "estimated" };
}

/** Sums the SDK's per-model usage table into one TokenUsage. */
export function sumUsage(modelUsage: Record<string, Partial<TokenUsage>> | undefined): TokenUsage {
  const out: TokenUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 };
  for (const u of Object.values(modelUsage ?? {})) {
    out.inputTokens += u.inputTokens ?? 0;
    out.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    out.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
    out.outputTokens += u.outputTokens ?? 0;
  }
  return out;
}
