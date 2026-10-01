import { ANTHROPIC_PROVIDER_ID, EFFORTS, type ClaudeModel, type ClaudeModelStatus, type ClaudeModelsResult, type Effort, type ModelEntry, type ModelMove, type Settings } from "../types.ts";

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

/**
 * One row per model (the "default" row and "opus[1m]" both point at Opus), in Claude Code's order.
 * Claude Code has described a row two ways: "Sonnet 5 · Efficient for routine tasks" with the name in
 * the description, and (newer) the name in displayName with the description only saying what it is
 * for. The "default" row never names itself: its name is "Default (recommended)".
 */
export function fromSdk(infos: SdkModelInfo[]): ClaudeModel[] {
  const byId = new Map<string, ClaudeModel>();
  /** Ids whose label came from a row that names the model, not from the "default" row. */
  const named = new Set<string>();
  for (const m of infos) {
    const id = plain(m.resolvedModel || m.value);
    if (!id) continue;
    const isDefault = m.value === "default";
    const parts = m.description.split(" · ");
    const inDescription = parts.length > 1;
    // Newer "default" rows put the model's name where the blurb goes: "Fable 5.1".
    const label = inDescription ? parts[0].replace(/\s+with\s+.*$/i, "").trim() : isDefault ? m.description.trim() : m.displayName.trim();
    const blurb = inDescription ? parts.slice(1).join(" · ").trim() : isDefault ? "" : m.description.trim();
    const efforts = (m.supportedEffortLevels ?? []).filter((e): e is Effort => (EFFORTS as string[]).includes(e));
    const aliases = [m.value, plain(m.value)].filter((a) => a && a !== id);
    const names = inDescription || !isDefault;
    const seen = byId.get(id);
    if (seen) {
      seen.aliases = [...new Set([...seen.aliases, ...aliases])];
      if (!seen.efforts.length) seen.efforts = efforts;
      if (names && !named.has(id)) {
        seen.label = label || seen.label;
        seen.blurb = blurb || seen.blurb;
        named.add(id);
      }
      continue;
    }
    if (names) named.add(id);
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

/** "claude-opus-5-5" → opus 5.5; "claude-haiku-4-5-20251001" → haiku 4.5. null for a short name or another shape. */
export function modelFamily(id: string): { family: string; version: number } | null {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(plain(id ?? ""));
  return m ? { family: m[1].toLowerCase(), version: Number(m[2]) + Number(m[3] ?? 0) / 100 } : null;
}

/** The newest model of the same family on your login, when it is newer than `id` (Opus 5 → Opus 5.5). */
export function newerClaudeModel(id: string, r: ClaudeModelsResult | null | undefined): ClaudeModel | undefined {
  const mine = modelFamily(id);
  if (!mine || !r || r.source !== "live") return undefined;
  let best: { model: ClaudeModel; version: number } | undefined;
  for (const model of r.models) {
    const f = modelFamily(model.id);
    if (f && f.family === mine.family && f.version > mine.version && (!best || f.version > best.version)) best = { model, version: f.version };
  }
  return best?.model;
}

type FollowSettings = PickSettings & Partial<Pick<Settings, "liveReviewModel">>;

/**
 * Every Claude pick that has a newer model of its own family on your login, and the settings patch
 * that moves each one. A pick on another provider, a short name ("opus" already follows) and an id of
 * another shape are left alone. Your Claude list keeps its order, labels you typed and notes.
 */
export function claudeUpgrades(s: FollowSettings, r: ClaudeModelsResult | null | undefined): { moves: ModelMove[]; patch: Partial<Settings> } {
  const moves: ModelMove[] = [];
  const patch: Partial<Settings> = {};
  const up = (where: string, id: string | undefined): string | undefined => {
    const newer = id ? newerClaudeModel(id, r) : undefined;
    if (!newer || !id) return undefined;
    moves.push({ where, from: id, to: newer.id, label: newer.label });
    return newer.id;
  };

  const models: ModelEntry[] = [];
  let listChanged = false;
  for (const m of s.models) {
    const to = up("your Claude list", m.id);
    if (!to) {
      models.push(m);
      continue;
    }
    listChanged = true;
    // Already listed: the older row just goes.
    if (s.models.some((x) => x.id === to) || models.some((x) => x.id === to)) continue;
    const was = findClaudeModel(m.id, r);
    const now = findClaudeModel(to, r)!;
    // A label you typed stays; one that only named the old model follows it.
    const auto = !was || m.label === was.label || modelFamily(m.id)?.family === m.label.toLowerCase().split(" ")[0];
    models.push({ ...m, id: to, label: auto ? now.label : m.label });
  }
  if (listChanged) patch.models = models;

  const pipeline = s.defaultPipeline.map((st, i) => {
    const to = onClaude(st.provider) ? up(`default pipeline, stage ${i + 1} (${st.stage})`, st.model) : undefined;
    return to ? { ...st, model: to } : st;
  });
  if (pipeline.some((st, i) => st !== s.defaultPipeline[i])) patch.defaultPipeline = pipeline;

  const tiers = { ...s.tiers };
  for (const k of ["cheap", "balanced", "strong"] as const) {
    const to = onClaude(tiers[k].provider) ? up(`right-sizing, ${k}`, tiers[k].model) : undefined;
    if (to) tiers[k] = { ...tiers[k], model: to };
  }
  if ((["cheap", "balanced", "strong"] as const).some((k) => tiers[k] !== s.tiers[k])) patch.tiers = tiers;

  const critic = onClaude(s.debate.critic.provider) ? up("plan debate critic", s.debate.critic.model) : undefined;
  if (critic) patch.debate = { ...s.debate, critic: { ...s.debate.critic, model: critic } };

  const single = (key: "triageModel" | "chatModel" | "specModel" | "liveReviewModel", where: string) => {
    const to = up(where, s[key]);
    if (to) patch[key] = to;
  };
  single("triageModel", "triage model");
  single("chatModel", "side chat model");
  single("specModel", "spec rewrite model");
  single("liveReviewModel", "live review model");
  const vision = onClaude(s.visionProvider) ? up("vision model", s.visionModel) : undefined;
  if (vision) patch.visionModel = vision;
  return { moves, patch };
}
