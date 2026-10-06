import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { mergeSchema, stageSchema } from "./projects.ts";
import { ANTHROPIC_PROVIDER_ID, DEBATE_MODES, DEBATE_ROUND_CEILING, EFFORTS, HELPER_MODELS, IMAGE_PROVIDERS, MODEL_SURFACES, type DebateMode, type ModelSurface } from "../types.ts";
import { PROVIDER_PRESETS } from "../engine/providers/presets.ts";
import { fileURLToPath } from "node:url";
import { siteHost } from "../engine/browser.ts";
import { openSignIn } from "../engine/signIn.ts";
import { realProbe } from "../setup/probe.ts";

/** A real screenshot with text in it, shipped with the board (the README's approval card). */
const VISION_SAMPLE = fileURLToPath(new URL("../../../docs/images/approval.png", import.meta.url));

const tierRef = z.object({ provider: z.string().trim().min(1).max(40), model: z.string().trim().min(1) });

const providerModel = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(80),
  inputPer1M: z.number().min(0).max(1000).optional(),
  outputPer1M: z.number().min(0).max(1000).optional(),
  contextWindow: z.number().int().min(0).max(100_000_000).optional(),
});

export const providerSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/, "lowercase letters, digits and dashes").refine((v) => v !== ANTHROPIC_PROVIDER_ID, "reserved"),
    label: z.string().trim().min(1).max(60),
    kind: z.enum(["anthropic-compatible", "openai-compatible", "cli"]),
    enabled: z.boolean(),
    baseUrl: z.string().trim().url().optional(),
    authRef: z.string().trim().regex(/^[A-Z0-9_]{0,64}$/, "an environment-variable style name"),
    models: z.array(providerModel).max(60),
    cli: z
      .object({
        preset: z.enum(["codex", "gemini", "kimi", "opencode", "custom"]),
        command: z.string().trim().max(2000).optional(),
        extraArgs: z.array(z.string().max(200)).max(30).optional(),
        envPassthrough: z.array(z.string().regex(/^(?!ANTHROPIC_|KANBAN_STATE)[A-Z0-9_]{1,64}$/)).max(20).optional(),
        auth: z.enum(["login", "api-key"]).optional(),
      })
      .optional(),
    mayEditFiles: z.boolean(),
    authStyle: z.enum(["bearer", "api-key"]).optional(),
    fallback: tierRef.nullable().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.kind !== "cli" && !p.baseUrl) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "an HTTP provider needs a base URL" });
    if (p.kind === "cli" && !p.cli) ctx.addIssue({ code: "custom", path: ["cli"], message: "a CLI provider needs a preset" });
    if (p.kind === "cli" && p.cli?.preset === "custom" && !p.cli.command?.includes("{prompt_file}")) {
      ctx.addIssue({ code: "custom", path: ["cli", "command"], message: "a custom command must contain {prompt_file}" });
    }
    if (p.fallback && p.fallback.provider === p.id) ctx.addIssue({ code: "custom", path: ["fallback"], message: "a provider cannot fall back to itself" });
  });

const patchSchema = z.object({
  models: z.array(z.object({ id: z.string().trim().min(1), label: z.string().trim().min(1), note: z.string().optional() })).optional(),
  defaultPipeline: z.array(stageSchema).optional(),
  globalCap: z.number().int().min(1).max(32).optional(),
  serial: z.boolean().optional(),
  maxForcedParallel: z.number().int().min(1).max(8).optional(),
  defaultMaxConcurrent: z.number().int().min(1).max(8).optional(),
  disabledSkills: z.array(z.string()).optional(),
  maxTurnsPerStage: z.number().int().min(1).max(500).optional(),
  maxCostPerStageUsd: z.number().min(0.05).max(100).optional(),
  maxSubagentDepth: z.number().int().min(1).max(5).optional(),
  maxConcurrentSubagents: z.number().int().min(1).max(20).optional(),
  cacheableSystemPrompt: z.boolean().optional(),
  autoTriage: z.boolean().optional(),
  triageModel: z.string().trim().min(1).optional(),
  visionModel: z.string().trim().min(1).optional(),
  visionProvider: z.string().trim().min(1).max(64).optional(),
  imageProvider: z.enum(IMAGE_PROVIDERS).optional(),
  cloudflareAccountId: z.string().trim().max(64).regex(/^[A-Za-z0-9]*$/, "a Cloudflare account id is letters and digits only").optional(),
  imageModel: z.string().trim().max(120).optional(),
  hiddenModels: z.object(Object.fromEntries(MODEL_SURFACES.map((k) => [k, z.array(z.string().max(300)).max(2000)])) as Record<ModelSurface, z.ZodArray<z.ZodString>>).partial().optional(),
  tiers: z.object({ cheap: tierRef, balanced: tierRef, strong: tierRef }).optional(),
  providers: z.array(providerSchema).max(30).optional(),
  debate: z.object({
    enabled: z.boolean(),
    critic: tierRef.extend({ effort: z.enum(EFFORTS as [string, ...string[]]) }),
    // Older clients send only the two fields above; the shipped mode keeps them on one round.
    mode: z.enum(DEBATE_MODES as [DebateMode, ...DebateMode[]]).default("once"),
    rounds: z.number().int().min(2).max(DEBATE_ROUND_CEILING).default(3),
  }).optional(),
  delegateTimeoutMin: z.number().int().min(1).max(240).optional(),
  autoSizing: z.boolean().optional(),
  autoResume: z.boolean().optional(),
  claudeFallback: tierRef.nullable().refine((v) => !v || v.provider !== ANTHROPIC_PROVIDER_ID, "Claude cannot fall back to Claude").optional(),
  keepAwake: z.boolean().optional(),
  questionWaitMin: z.number().int().min(0).max(24 * 60).optional(),
  askModeWaitMin: z.number().int().min(0).max(24 * 60).optional(),
  chatModel: z.string().trim().min(1).max(120).optional(),
  chatEffort: z.enum(EFFORTS as [string, ...string[]]).optional(),
  chatProvider: z.string().trim().min(1).max(64).optional(),
  chatKeepAlive: z.boolean().optional(),
  chatKeepAliveMessage: z.string().trim().min(1).max(300).optional(),
  chatKeepAliveMaxHours: z.number().int().min(1).max(72).optional(),
  nextStepsSuggestions: z.boolean().optional(),
  chatTools: z.boolean().optional(),
  followUpRouting: z.enum(["memory", "ask", "new"]).optional(),
  specModel: z.string().trim().min(1).max(120).optional(),
  specEffort: z.enum(EFFORTS as [string, ...string[]]).optional(),
  loadUserPlugins: z.boolean().optional(),
  claudeAutoMemory: z.boolean().optional(),
  autonomousLive: z.boolean().optional(),
  autonomousWorktree: z.boolean().optional(),
  browserChecks: z.boolean().optional(),
  chromeInSupervised: z.boolean().optional(),
  taskBrowser: z.enum(["board", "chrome"]).optional(),
  browserSites: z.array(z.string().trim().toLowerCase().min(3).max(200)).max(50).optional(),
  autoAllowReadOnly: z.boolean().optional(),
  markitdownInTasks: z.boolean().optional(),
  planApproval: z.boolean().optional(),
  defaultRunStyle: z.enum(["supervised", "autonomous", "ask"]).optional(),
  confirmSetup: z.boolean().optional(),
  autoContinueTurns: z.number().int().min(0).max(5).optional(),
  liveReviewModel: z.string().trim().min(1).max(120).optional(),
  followLatestModels: z.boolean().optional(),
  browserCheckModel: z.enum(HELPER_MODELS as [string, ...string[]]).optional(),
  autoUpdateEngine: z.boolean().optional(),
  liveView: z.boolean().optional(),
  maxCostPerTaskUsd: z.number().min(0.1).max(500).optional(),
  maxRepeatedToolCalls: z.number().int().min(2).max(50).optional(),
  eventRetentionDays: z.number().int().min(1).max(365).optional(),
  blockedCommands: z.array(z.string().trim().toLowerCase().min(2)).max(80).optional(),
  defaultMerge: mergeSchema.optional(),
  onboardingChecklist: z.string().max(8000).optional(),
});

export async function settingsRoutes(app: FastifyInstance, { repo, bus, runner }: AppDeps) {
  app.get("/settings", async () => repo.getSettings());

  /**
   * Settings → Browser for tasks → Sign in to a site: opens the board browser's saved profile at that
   * site for you to sign in, and lets autonomous runs open it from now on (D389).
   */
  app.post("/browser/sign-in", async (req, reply) => {
    const { url } = z.object({ url: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
    const host = siteHost(url);
    if (!host) return reply.code(400).send({ error: "That is not a web address. Type one like erp.example.com." });
    const opened = openSignIn(repo.getSettings().stateDir, /^https?:\/\//i.test(url) ? url : `https://${url}`, realProbe);
    if (!opened.ok) return reply.code(409).send({ error: opened.error });
    const sites = [...new Set([...repo.getSettings().browserSites, host])].slice(0, 50);
    const settings = repo.updateSettings({ browserSites: sites } as never);
    bus.publish({ type: "settings.updated", settings });
    return { host, sites };
  });

  /**
   * Intake models → Try it: the README's approval screenshot, described by exactly this provider and
   * model (no fallback), so you know it can see before an attachment depends on it.
   */
  app.post("/settings/vision/test", async (req) => {
    const { provider, model } = z.object({ provider: z.string().trim().min(1).max(64), model: z.string().trim().min(1).max(200) }).parse(req.body ?? {});
    return runner.testVision(provider, model, VISION_SAMPLE);
  });
  app.patch("/settings", async (req) => {
    const patch = patchSchema.parse(req.body);
    // Some endpoints want a fixed placeholder token (Ollama ignores it). It is not a secret, so a
    // provider added from such a preset gets it the first time it is saved, unless a key is already set.
    for (const p of patch.providers ?? []) {
      const preset = PROVIDER_PRESETS.find((x) => x.seedSecret && x.baseUrl && x.baseUrl === p.baseUrl && x.authRef === p.authRef);
      if (preset?.seedSecret && p.authRef && !runner.secrets.has(p.authRef)) runner.secrets.set(p.authRef, preset.seedSecret);
    }
    const settings = repo.updateSettings(patch as never);
    bus.publish({ type: "settings.updated", settings });
    return settings;
  });
}
