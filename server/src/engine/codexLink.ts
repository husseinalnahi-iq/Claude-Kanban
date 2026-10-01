import type { CatalogModel, Provider, Settings } from "../types.ts";
import { PROVIDER_PRESETS } from "./providers/presets.ts";
import { codexAuth, criticModel } from "./providers/codexLocal.ts";
import { POLLINATIONS_KEY_REF } from "./images.ts";

/** The critic the board shipped, in each spelling it has had: only that one is moved, never one you chose (D299). */
const SHIPPED_CRITICS = ["claude-sonnet-5-5", "claude-sonnet-5"];
const untouchedCritic = (d: Settings["debate"]) =>
  (d.critic.provider === "anthropic" || !d.critic.provider) && SHIPPED_CRITICS.includes(d.critic.model) && d.critic.effort === "medium";

/** The board's Codex-on-a-ChatGPT-plan entry, if it has one. */
export function codexPlanProvider(s: Pick<Settings, "providers">, hasKey: (name: string) => boolean): Provider | undefined {
  return s.providers.find((p) => p.kind === "cli" && p.cli?.preset === "codex" && codexAuth(p, hasKey) === "login");
}

/**
 * Pure: what one click on "Use Codex" changes (D296, D299, D297) — the subscription entry added (or
 * switched on), the plan-debate critic moved to Codex at high effort if it is still the shipped one, and
 * pictures moved to Codex from the old shipped Pollinations without a key — with each change in words.
 */
export function linkCodexPatch(s: Settings, rows: Pick<CatalogModel, "id">[], hasKey: (name: string) => boolean): { patch: Partial<Settings>; changed: string[]; providerId: string } {
  const patch: Partial<Settings> = {};
  const changed: string[] = [];
  let p = codexPlanProvider(s, hasKey);
  if (!p) {
    const { blurb: _b, help: _h, seedSecret: _s, ...preset } = PROVIDER_PRESETS.find((x) => x.id === "codex")!;
    let id = preset.id;
    for (let n = 2; s.providers.some((x) => x.id === id); n++) id = `${preset.id}-${n}`;
    p = { ...preset, id, enabled: true };
    patch.providers = [...s.providers, p];
    changed.push(`Added “${p.label}” to Settings → Providers.`);
  } else if (!p.enabled) {
    patch.providers = s.providers.map((x) => (x.id === p!.id ? { ...x, enabled: true } : x));
    changed.push(`Switched “${p.label}” on.`);
  }
  const critic = criticModel(rows);
  if (critic && untouchedCritic(s.debate)) {
    patch.debate = { ...s.debate, critic: { provider: p.id, model: critic, effort: "high" } };
    changed.push(`The plan-debate critic is now Codex ${critic} at high effort.`);
  }
  if (s.imageProvider === "pollinations" && !hasKey(POLLINATIONS_KEY_REF)) {
    patch.imageProvider = "codex";
    changed.push("Pictures are now made by Codex.");
  }
  return { patch, changed, providerId: p.id };
}
