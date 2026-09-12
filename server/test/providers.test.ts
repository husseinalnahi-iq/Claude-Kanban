import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup, until } from "./helpers.ts";
import { sizedPipeline } from "../src/engine/runner.ts";
import { ProviderError } from "../src/engine/providers/registry.ts";
import { estimateCost } from "../src/engine/providers/cost.ts";
import { PROVIDER_PRESETS } from "../src/engine/providers/presets.ts";
import type { Provider, Stage } from "../src/types.ts";

const ZAI: Provider = {
  id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic", authRef: "ZAI_API_KEY",
  models: [{ id: "glm-4.7", label: "GLM 4.7", inputPer1M: 0.6, outputPer1M: 2.2 }, { id: "glm-free", label: "free" }],
  mayEditFiles: true,
};

function withZai(s: ReturnType<typeof setup>, patch: Partial<Provider> = {}) {
  s.repo.updateSettings({ providers: [{ ...ZAI, ...patch }] });
  s.secrets.set("ZAI_API_KEY", "sk-test-secret-value");
}

test("a stage on an Anthropic-compatible provider runs the real SDK with env overrides and no Claude-only flags", async () => {
  const f = fakeQuery({ cost: 0, modelUsage: { "glm-4.7": { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  const s = setup(f.fn);
  try {
    withZai(s);
    const pipeline: Stage[] = [{ stage: "code", model: "glm-4.7", effort: "high", fast: true, provider: "zai" }];
    const task = s.repo.createTask({ project_id: s.project.id, title: "on glm", spec_md: "x", mode: "supervised", pipeline });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");

    const o = f.calls[0].options;
    assert.equal(o.model, "glm-4.7");
    assert.equal(o.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(o.env.ANTHROPIC_AUTH_TOKEN, "sk-test-secret-value");
    assert.equal(o.env.ANTHROPIC_API_KEY, "");
    assert.equal(o.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-4.7");
    assert.equal(o.env.CLAUDE_CODE_SUBAGENT_MODEL, "glm-4.7");
    assert.equal(o.effort, undefined, "effort is a Claude control");
    assert.equal(o.settings, undefined, "fast mode is a Claude control");
    assert.equal(o.maxBudgetUsd, undefined, "the SDK would price this model as Claude; the board meters it instead");
    assert.ok(o.canUseTool && o.hooks && o.mcpServers.board, "every board guardrail is still attached");

    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.provider, "zai");
    assert.equal(run.cost_source, "estimated");
    assert.ok(Math.abs(run.cost_usd - 0.82) < 1e-6, `cost ${run.cost_usd}`);
    assert.equal(run.input_tokens, 1_000_000);
    // The default provider is untouched.
    const types = s.repo.eventsAfter(run.id).map((e) => e.type);
    assert.deepEqual(types, ["user:prompt", "system:init", "assistant", "result:success"]);
  } finally {
    s.cleanup();
  }
});

test("a model with no price is a subscription: $0, tokens still counted; Claude keeps the SDK figure", async () => {
  const f = fakeQuery({ cost: 0, modelUsage: { "glm-free": { inputTokens: 5000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  const s = setup(f.fn);
  try {
    withZai(s);
    const t1 = s.repo.createTask({ project_id: s.project.id, title: "sub", spec_md: "x", mode: "supervised", pipeline: [{ stage: "code", model: "glm-free", effort: "low", provider: "zai" }] });
    s.runner.queueTask(t1.id);
    await until(() => s.repo.getTask(t1.id)!.status === "review");
    const [r1] = s.repo.runsForTask(t1.id);
    assert.equal(r1.cost_source, "subscription");
    assert.equal(r1.cost_usd, 0);
    assert.equal(r1.input_tokens, 5000);

    const g = fakeQuery();
    const s2 = setup(g.fn);
    try {
      const t2 = s2.repo.createTask({ project_id: s2.project.id, title: "claude", spec_md: "x", mode: "supervised", pipeline: [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }] });
      s2.runner.queueTask(t2.id);
      await until(() => s2.repo.getTask(t2.id)!.status === "review");
      const [r2] = s2.repo.runsForTask(t2.id);
      assert.equal(r2.cost_source, "sdk");
      assert.equal(r2.cost_usd, 0.01);
      assert.equal(r2.provider, null);
      assert.equal(g.calls[0].options.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL, "no override for Claude");
    } finally {
      s2.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("the board meters a foreign stage itself and stops it past the per-stage ceiling", async () => {
  const turn = { type: "assistant", message: { content: [{ type: "text", text: "…" }], usage: { input_tokens: 2_000_000, output_tokens: 0 } } };
  const f = fakeQuery({ extra: [turn, turn, turn, turn, turn], cost: 0 });
  const s = setup(f.fn);
  try {
    withZai(s, { models: [{ id: "glm-4.7", label: "x", inputPer1M: 5, outputPer1M: 5 }] });
    s.repo.updateSettings({ maxCostPerStageUsd: 25 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "pricey", spec_md: "x", mode: "supervised", pipeline: [{ stage: "code", model: "glm-4.7", effort: "low", provider: "zai" }] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    assert.match(s.repo.getTask(task.id)!.error ?? "", /estimated cost passed the per-stage ceiling/);
    assert.ok(f.calls[0].options.abortController.signal.aborted, "the session was aborted");
  } finally {
    s.cleanup();
  }
});

test("a stage naming a missing or disabled provider is refused at queue time", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "gone", spec_md: "x", mode: "supervised", pipeline: [{ stage: "code", model: "m", effort: "low", provider: "gone" }] });
    assert.throws(() => s.runner.queueTask(task.id), (e: Error) => e instanceof ProviderError && /"gone" does not exist/.test(e.message));
    assert.equal(s.repo.getTask(task.id)!.status, "backlog");

    withZai(s, { enabled: false });
    const t2 = s.repo.createTask({ project_id: s.project.id, title: "off", spec_md: "x", mode: "supervised", pipeline: [{ stage: "code", model: "glm-4.7", effort: "low", provider: "zai" }] });
    assert.throws(() => s.runner.queueTask(t2.id), /switched off/);
    assert.equal(f.calls.length, 0);
  } finally {
    s.cleanup();
  }
});

test("a foreign 429 fails the task instead of pausing it, and its rate-limit events are ignored", async () => {
  const f = fakeQuery({
    fail: "429 quota exceeded" as never,
    extra: [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 100 } } } }],
  });
  const s = setup(f.fn);
  try {
    withZai(s);
    s.repo.updateSettings({ autoResume: true });
    const task = s.repo.createTask({ project_id: s.project.id, title: "limit", spec_md: "x", mode: "supervised", pipeline: [{ stage: "code", model: "glm-4.7", effort: "low", provider: "zai" }] });
    s.runner.queueTask(task.id);
    await until(() => ["failed", "paused"].includes(s.repo.getTask(task.id)!.status));
    assert.equal(s.repo.getTask(task.id)!.status, "failed");
    assert.equal(s.repo.usageLimits().length, 0, "no Claude window was recorded from a foreign endpoint");
    assert.equal(s.repo.runsForTask(task.id)[0].limit_before, null);
  } finally {
    s.cleanup();
  }
});

test("old string tiers are read as Claude tiers, and a foreign tier sizes a stage with its provider", () => {
  const s = setup(fakeQuery().fn);
  try {
    s.repo.db.prepare("UPDATE settings SET value = ? WHERE key = 'tiers'").run(JSON.stringify({ cheap: "claude-haiku-4-5-20251001", balanced: "claude-sonnet-5", strong: "claude-opus-5" }));
    assert.deepEqual(s.repo.getSettings().tiers.cheap, { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    const tiers = { ...s.repo.getSettings().tiers, strong: { provider: "zai", model: "glm-4.7" } };
    assert.deepEqual(sizedPipeline({ stages: [{ stage: "code", tier: "strong", effort: "high" }, { stage: "review", tier: "cheap", effort: "low" }], reason: "" }, tiers), [
      { stage: "code", model: "glm-4.7", effort: "high", provider: "zai" },
      { stage: "review", model: "claude-haiku-4-5-20251001", effort: "low" },
    ]);
  } finally {
    s.cleanup();
  }
});

test("chat continues an Anthropic-compatible session; the previous result is labelled as another model's", async () => {
  const f = fakeQuery({ sessionId: "s-glm", result: "PLAN FROM GLM" });
  const s = setup(f.fn);
  try {
    withZai(s);
    const task = s.repo.createTask({
      project_id: s.project.id, title: "two", spec_md: "x", mode: "supervised",
      pipeline: [{ stage: "plan", model: "glm-4.7", effort: "low", provider: "zai" }, { stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }],
    });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.match(f.calls[1].prompt, /produced by another model \(glm-4\.7 via zai\)/);
    assert.match(f.calls[1].prompt, /PLAN FROM GLM/);
    s.runner.chat(task.id, "and now?");
    await until(() => f.calls.length === 3);
    assert.equal(f.calls[2].options.resume, "s-glm");
  } finally {
    s.cleanup();
  }
});

test("estimateCost prices from the model's table; presets are well-formed", () => {
  assert.deepEqual(estimateCost(ZAI, "glm-4.7", { inputTokens: 500_000, cacheReadInputTokens: 500_000, cacheCreationInputTokens: 0, outputTokens: 1_000_000 }), { usd: 2.8, source: "estimated" });
  assert.deepEqual(estimateCost(ZAI, "unknown", { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1 }), { usd: 0, source: "subscription" });
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  for (const p of PROVIDER_PRESETS) {
    // LM Studio has no sensible default: the picker lists what you downloaded.
    if (p.id !== "lmstudio") assert.ok(p.models.length, `${p.id} has models`);
    if (p.kind !== "cli") assert.match(p.baseUrl ?? "", /^https?:\/\//, `${p.id} has a base URL`);
    else assert.ok(p.cli?.preset, `${p.id} has a cli preset`);
  }
});
