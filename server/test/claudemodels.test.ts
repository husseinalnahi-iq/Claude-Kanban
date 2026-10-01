import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";
import { buildChecks } from "../src/setup/checks.ts";
import { badClaudePicks, claudeModelStatus, claudeUpgrades, fromSdk, modelFamily, newerClaudeModel, type SdkModelInfo } from "../src/engine/claudeModels.ts";
import type { ClaudeModelsResult } from "../src/types.ts";

const ALL = ["low", "medium", "high", "xhigh", "max"];

/** What Claude Code 2.1.285 reports for a Max login (trimmed): the name is in displayName. */
const SDK: SdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-fable-5-1", displayName: "Default (recommended)", description: "Fable 5.1", supportedEffortLevels: ALL },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Best for everyday, complex tasks", supportedEffortLevels: ALL },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "Most capable for your hardest and longest-running tasks", supportedEffortLevels: ALL },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Efficient for routine tasks", supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Efficient for routine tasks", supportedEffortLevels: ALL },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "Best for everyday, complex tasks", supportedEffortLevels: ALL },
];

/** What Claude Code 2.1.268 reported: the name inside the description, before a " · ". */
const SDK_OLD: SdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", supportedEffortLevels: ALL },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", supportedEffortLevels: ALL },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks", supportedEffortLevels: ALL },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
];

const live = (sdk = SDK): ClaudeModelsResult => ({ source: "live", models: fromSdk(sdk), checked_at: new Date().toISOString() });

test("one row per model, with the id stages use, its name, what it is for and its effort levels", () => {
  const models = fromSdk(SDK);
  assert.deepEqual(models.map((m) => m.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"]);
  const fable = models[0];
  assert.equal(fable.label, "Fable 5.1", "the model's own name, not “Default (recommended)”");
  assert.equal(fable.blurb, "Most capable for your hardest and longest-running tasks");
  assert.deepEqual(fable.aliases, ["default"]);
  assert.deepEqual(models[1].aliases, ["opus"]);
  assert.equal(models[1].label, "Opus 5.5");
  assert.deepEqual(models[2].efforts, ["low", "medium", "high"]);
  assert.deepEqual(models[3].efforts, [], "Haiku has no effort setting");
});

test("an older Claude Code, which names the model inside the description, reads the same way", () => {
  const models = fromSdk(SDK_OLD);
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  assert.equal(models[0].label, "Opus 5", "not “Default (recommended)”, and not “Opus (1M context)”");
  assert.equal(models[0].blurb, "Best for everyday, complex tasks");
  assert.deepEqual(models[0].aliases.sort(), ["default", "opus", "opus[1m]"]);
  assert.equal(models[1].label, "Fable 5.1");
});

test("an id is ok, unlisted (probably a typo), invalid (not a Claude id) or unchecked", () => {
  const r = live();
  assert.equal(claudeModelStatus("claude-sonnet-5", r), "ok");
  assert.equal(claudeModelStatus("sonnet", r), "ok", "short names count");
  assert.equal(claudeModelStatus("claude-opus-5[1m]", r), "ok");
  assert.equal(claudeModelStatus("claude-sonet-5", r), "unlisted");
  assert.equal(claudeModelStatus("test", r), "invalid");
  assert.equal(claudeModelStatus("gpt-5", r), "invalid");
  assert.equal(claudeModelStatus("claude-sonet-5", { source: "unavailable", models: [], checked_at: "" }), "unchecked");
  assert.equal(claudeModelStatus("test", null), "invalid", "the shape is checked even without the list");
});

test("the picks a run would fail on are found, with where they are", () => {
  const s = new Repo(openDb(":memory:")).getSettings();
  const settings = {
    ...s,
    models: [...s.models, { id: "test", label: "test1" }],
    defaultPipeline: [
      { stage: "plan" as const, model: "claude-fable-5-1", effort: "high" as const },
      { stage: "code" as const, model: "claude-opus-5-typo", effort: "high" as const },
      { stage: "review" as const, model: "qwen3-coder", effort: "high" as const, provider: "ollama" },
    ],
  };
  const bad = badClaudePicks(settings, live());
  assert.deepEqual(bad.map((b) => [b.where, b.id, b.status]), [
    ["your Claude list", "test", "invalid"],
    ["default pipeline, stage 2 (code)", "claude-opus-5-typo", "unlisted"],
  ], "another provider's model is not judged against Claude's list");
});

test("a setting an older server does not send yet is skipped, not a crash that blanks Settings", () => {
  const s = new Repo(openDb(":memory:")).getSettings();
  const older = { ...s, chatModel: undefined, visionModel: undefined, liveReviewModel: undefined } as unknown as typeof s;
  assert.doesNotThrow(() => badClaudePicks(older, live()));
  assert.doesNotThrow(() => claudeUpgrades(older, live()));
  assert.equal(claudeModelStatus(undefined as unknown as string, live()), "invalid", "the model picker shows it as unset");
});

test("a newer model of the same family is found; other families, short names and other shapes are left alone", () => {
  const r = live();
  assert.deepEqual(modelFamily("claude-haiku-4-5-20251001"), { family: "haiku", version: 4.05 });
  assert.equal(newerClaudeModel("claude-opus-5", r)?.id, "claude-opus-5-5");
  assert.equal(newerClaudeModel("claude-opus-4-8", r)?.id, "claude-opus-5-5", "the newest, not the next");
  assert.equal(newerClaudeModel("claude-opus-5[1m]", r)?.id, "claude-opus-5-5");
  assert.equal(newerClaudeModel("claude-opus-5-5", r), undefined, "already the newest");
  assert.equal(newerClaudeModel("claude-fable-5-1", r), undefined, "there is no newer Fable");
  assert.equal(newerClaudeModel("opus", r), undefined, "a short name already follows");
  assert.equal(newerClaudeModel("claude-3-5-sonnet-20241022", r), undefined);
  assert.equal(newerClaudeModel("claude-opus-5", { source: "unavailable", models: [], checked_at: "" }), undefined);
});

test("every pick on an older model moves, the list keeps your own labels, and other providers are untouched", () => {
  const s = new Repo(openDb(":memory:")).getSettings();
  const older = {
    ...s,
    models: [
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-opus-5", label: "Opus 5", note: "execution (default)" },
      { id: "claude-sonnet-5", label: "my reviewer" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    ],
    defaultPipeline: [
      { stage: "plan" as const, model: "claude-fable-5-1", effort: "high" as const },
      { stage: "code" as const, model: "claude-opus-5", effort: "high" as const },
      { stage: "review" as const, model: "claude-opus-5", effort: "high" as const, provider: "openrouter" },
    ],
    tiers: { ...s.tiers, strong: { provider: "anthropic", model: "claude-opus-5" } },
    chatModel: "claude-sonnet-5",
    liveReviewModel: "claude-opus-5",
  };
  const { moves, patch } = claudeUpgrades(older, live());
  assert.deepEqual(patch.models, [
    { id: "claude-fable-5-1", label: "Fable 5.1" },
    { id: "claude-opus-5-5", label: "Opus 5.5", note: "execution (default)" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  ], "Opus follows with its new name; the older Sonnet row goes because the newer one is already listed");
  assert.equal(patch.defaultPipeline![1].model, "claude-opus-5-5");
  assert.equal(patch.defaultPipeline![2].model, "claude-opus-5", "a stage on another provider keeps its model");
  assert.equal(patch.tiers!.strong.model, "claude-opus-5-5");
  assert.equal(patch.chatModel, "claude-sonnet-5-5");
  assert.equal(patch.liveReviewModel, "claude-opus-5-5");
  assert.equal(patch.triageModel, undefined, "Haiku 4.5 is still the newest Haiku");
  assert.ok(moves.some((m) => m.where === "default pipeline, stage 2 (code)" && m.label === "Opus 5.5"));
  assert.deepEqual(claudeUpgrades(s, live()).moves, [], "a fresh board is already on the newest");
});

test("GET /api/version: a server started after its code last changed is not stale", async () => {
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: listing(SDK).fn }), allowedHosts: ["localhost:80"] });
  try {
    const res = await app.inject({ method: "GET", url: "/api/version" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().stale, false);
    assert.ok(Date.parse(res.json().startedAt));
  } finally {
    await app.close();
  }
});

/** A fake session that answers the model question, like Claude Code's startup handshake. */
function listing(answer: SdkModelInfo[] | Error) {
  let asked = 0;
  let closed = 0;
  const fn = ((params: { options: { abortController?: AbortController } }) => {
    const gen = (async function* () {})();
    return Object.assign(gen, {
      supportedModels: async () => {
        asked++;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      close: () => {
        closed++;
        params.options.abortController?.abort();
      },
    });
  }) as unknown as QueryFn;
  return { fn, asked: () => asked, closed: () => closed };
}

test("the runner asks Claude Code once, closes the session, and keeps the answer", async () => {
  const repo = new Repo(openDb(":memory:"));
  const q = listing(SDK);
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q.fn });
  const [a, b] = await Promise.all([runner.claudeModels(), runner.claudeModels()]);
  assert.equal(a.source, "live");
  assert.equal(a.models.length, 6);
  assert.equal(b, a, "two pickers opening at once share one question");
  await runner.claudeModels();
  assert.equal(q.asked(), 1, "cached");
  assert.equal(q.closed(), 1, "the session is closed: no prompt is ever sent");
  await runner.claudeModels(true);
  assert.equal(q.asked(), 2, "Refresh asks again");
});

test("when Claude Code cannot answer, the list says so and nothing is marked wrong but shape", async () => {
  const repo = new Repo(openDb(":memory:"));
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: listing(new Error("not logged in")).fn });
  const r = await runner.claudeModels();
  assert.equal(r.source, "unavailable");
  assert.match(r.error!, /not logged in/);
  // An SDK too old to list models is the same.
  const old = new TaskRunner({ repo, bus: new Bus(), queryFn: (() => (async function* () {})()) as unknown as QueryFn });
  assert.match((await old.claudeModels()).error!, /cannot list/);
});

test("API and Setup: GET /api/claude/models, and a Setup row naming each bad pick", async () => {
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const runner = new TaskRunner({ repo, bus, queryFn: listing(SDK).fn });
  const app = await buildApp({ repo, bus, runner, allowedHosts: ["localhost:80"] });
  try {
    const res = await app.inject({ method: "GET", url: "/api/claude/models" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().models[0].id, "claude-fable-5-1");

    const check = (settings = repo.getSettings()) =>
      buildChecks(settings).find((c) => c.id === "claude-models")!.detect({ settings, probe: {} as never, hasSecret: () => false, claudeModels: () => runner.claudeModels() });
    const fine = await check();
    assert.equal(fine.ok, true, fine.detail);
    repo.updateSettings({ models: [...repo.getSettings().models, { id: "test", label: "test1" }] });
    const bad = await check();
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /your Claude list: “test”/);
  } finally {
    await app.close();
  }
});

test("when your login gets a newer model, the settings move to it and say so; switched off, they stay", async () => {
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  repo.updateSettings({ chatModel: "claude-sonnet-5", tiers: { ...repo.getSettings().tiers, strong: { provider: "anthropic", model: "claude-opus-5" } } });
  const seen: string[] = [];
  bus.subscribe((m) => seen.push(m.type));
  // The older Claude Code does not know 5.5. The fresh board's own 5.5 picks are not moved back.
  await new TaskRunner({ repo, bus, queryFn: listing(SDK_OLD).fn }).claudeModels();
  assert.equal(repo.getSettings().chatModel, "claude-sonnet-5");
  assert.equal(repo.getSettings().lastModelMove, null);

  repo.updateSettings({ followLatestModels: false });
  await new TaskRunner({ repo, bus, queryFn: listing(SDK).fn }).claudeModels();
  assert.equal(repo.getSettings().chatModel, "claude-sonnet-5", "switched off: Settings only offers the move");

  repo.updateSettings({ followLatestModels: true });
  await new TaskRunner({ repo, bus, queryFn: listing(SDK).fn }).claudeModels();
  const after = repo.getSettings();
  assert.equal(after.chatModel, "claude-sonnet-5-5");
  assert.equal(after.tiers.strong.model, "claude-opus-5-5");
  assert.deepEqual(after.lastModelMove?.moves.map((m) => m.to).sort(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.ok(seen.includes("settings.updated"), "open pages get the new settings");
});
