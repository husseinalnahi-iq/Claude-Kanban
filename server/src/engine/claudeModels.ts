import { ANTHROPIC_PROVIDER_ID, EFFORTS, type ClaudeModel, type ClaudeModelStatus, type ClaudeModelsResult, type Effort, type Settings } from "../types.ts";

/**
 * The Claude models your login can use, as Claude Code reports them (the SDK's `supportedModels()`,
 * read at session start before any model call, so free). Settings fills its Claude list from this and
 * checks every Claude pick against it, so a typo is caught in Settings instead of by a failed run.
 * Pure: the web imports it too.
 */

/** The fields of the SDK's ModelInfo this reads. */
export interface SdkModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: string[];
}

/** "claude-opus-5[1m]" and "claude-opus-5" are the same model with a longer context; stages use the plain id. */
const plain = (id: string) => id.trim().replace(/\[1m\]$/i, "");

/** One row per model (the "default" row and "opus[1m]" both point at Opus), in Claude Code's order. */
export function fromSdk(infos: SdkModelInfo[]): ClaudeModel[] {
  const byId = new Map<string, ClaudeModel>();
  for (const m of infos) {
    const id = plain(m.resolvedModel || m.value);
    if (!id) continue;
    // "Sonnet 5 · Efficient for routine tasks"; "Opus 5 with 1M context · Best for everyday, complex tasks".
    const parts = m.description.split(" · ");
    const label = parts.length > 1 ? parts[0].replace(/\s+with\s+.*$/i, "").trim() : m.displayName;
    const blurb = parts.length > 1 ? parts.slice(1).join(" · ").trim() : m.description.trim();
    const efforts = (m.supportedEffortLevels ?? []).filter((e): e is Effort => (EFFORTS as string[]).includes(e));
    const aliases = [m.value, plain(m.value)].filter((a) => a && a !== id);
    const seen = byId.get(id);
    if (seen) {
      seen.aliases = [...new Set([...seen.aliases, ...aliases])];
      if (!seen.efforts.length) seen.efforts = efforts;
      // The "default" row's name is "Default (recommended)"; a model's own row names it better.
      if (m.value !== "default" && parts.length > 1) seen.label = label;
      continue;
    }
    byId.set(id, { id, label: label || id, blurb, efforts, aliases: [...new Set(aliases)] });
  }
  return [...byId.values()];
}

/** What a Claude model id looks like: claude-…, or one of Claude Code's short names. */
const CLAUDE_ID = /^(claude-[a-z0-9][a-z0-9.-]*|opus|sonnet|haiku|fable|default|opusplan)(\[1m\])?$/i;

export function findClaudeModel(id: string, r: ClaudeModelsResult | null | undefined): ClaudeModel | undefined {
  if (!r || r.source !== "live") return undefined;
  const want = plain(id).toLowerCase();
  return r.models.find((m) => m.id.toLowerCase() === want || m.aliases.some((a) => plain(a).toLowerCase() === want));
}

/**
 * ok: your login has it. unlisted: shaped like a Claude id but not on the list (a typo, or an older
 * model that may still work). invalid: not a Claude id at all — a run on it fails. unchecked: the list
 * could not be read, so only the shape was checked.
 */
export function claudeModelStatus(id: string, r: ClaudeModelsResult | null | undefined): ClaudeModelStatus {
  if (!CLAUDE_ID.test(id?.trim() ?? "")) return "invalid";
  if (!r || r.source !== "live") return "unchecked";
  return findClaudeModel(id, r) ? "ok" : "unlisted";
}

type PickSettings = Pick<Settings, "models" | "defaultPipeline" | "tiers" | "debate" | "triageModel" | "chatModel" | "visionModel" | "visionProvider"> & Partial<Pick<Settings, "specModel">>;
const onClaude = (provider: string | null | undefined) => !provider || provider === ANTHROPIC_PROVIDER_ID;

/** Every Claude model id your settings name, and where — for Setup and the warning by Save. */
export function claudePicks(s: PickSettings): { where: string; id: string }[] {
  const picks: { where: string; id: string }[] = [
    ...s.models.map((m) => ({ where: "your Claude list", id: m.id })),
    ...s.defaultPipeline.filter((st) => onClaude(st.provider)).map((st, i) => ({ where: `default pipeline, stage ${i + 1} (${st.stage})`, id: st.model })),
    ...(["cheap", "balanced", "strong"] as const).filter((k) => onClaude(s.tiers[k].provider)).map((k) => ({ where: `right-sizing, ${k}`, id: s.tiers[k].model })),
    ...(onClaude(s.debate.critic.provider) ? [{ where: "plan debate critic", id: s.debate.critic.model }] : []),
    { where: "triage model", id: s.triageModel },
    { where: "side chat model", id: s.chatModel },
    ...(s.specModel ? [{ where: "spec rewrite model", id: s.specModel }] : []),
    ...(onClaude(s.visionProvider) ? [{ where: "vision model", id: s.visionModel }] : []),
  ];
  // `?.`: a page newer than the server it talks to gets settings without the newest fields.
  return picks.filter((p) => p.id?.trim());
}

/** The picks a run would fail on (invalid) or that are probably typos (unlisted). */
export function badClaudePicks(s: PickSettings, r: ClaudeModelsResult | null | undefined) {
  return claudePicks(s)
    .map((p) => ({ ...p, status: claudeModelStatus(p.id, r) }))
    .filter((p) => p.status === "invalid" || p.status === "unlisted");
}

export const CLAUDE_STATUS_TEXT: Record<ClaudeModelStatus, string> = {
  ok: "Your Claude login has this model",
  unlisted: "Not on your Claude login's list — check the spelling. An older model can still work.",
  invalid: "Not a Claude model id (they start with “claude-”) — a run on it fails",
  unchecked: "Not checked: Claude Code could not be asked for its list",
};
