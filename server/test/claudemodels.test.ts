import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";
import { buildChecks } from "../src/setup/checks.ts";
import { badClaudePicks, claudeModelStatus, fromSdk, type SdkModelInfo } from "../src/engine/claudeModels.ts";
import type { ClaudeModelsResult } from "../src/types.ts";

/** What Claude Code 2026-09 reports for a Max login (trimmed). */
const SDK: SdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
];

const live = (): ClaudeModelsResult => ({ source: "live", models: fromSdk(SDK), checked_at: new Date().toISOString() });

test("one row per model, with the id stages use, its name, what it is for and its effort levels", () => {
  const models = fromSdk(SDK);
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  const opus = models[0];
  assert.equal(opus.label, "Opus 5", "the model's own name, not “Default (recommended)”");
  assert.equal(opus.blurb, "Best for everyday, complex tasks");
  assert.deepEqual(opus.aliases.sort(), ["default", "opus", "opus[1m]"]);
  assert.deepEqual(models[2].efforts, ["low", "medium", "high"]);
  assert.deepEqual(models[3].efforts, [], "Haiku has no effort setting");
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
  assert.equal(a.models.length, 4);
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
    assert.equal(res.json().models[0].id, "claude-opus-5");

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
