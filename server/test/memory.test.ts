import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_FULL_PCT, MEMORY_KEEP_DAYS, MEMORY_WARM_MIN, memoryFacts, type MemoryInput } from "../src/engine/memory.ts";
import { splitAtFirstEdit } from "../src/engine/explore.ts";
import { fakeQuery, setup, until } from "./helpers.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const card = (over: Partial<NonNullable<MemoryInput["session"]>> = {}, status: MemoryInput["status"] = "done"): MemoryInput => ({
  status,
  session: { id: "s1", model: "opus", endedAt: ago(10), running: false, contextTokens: 60_000, contextWindow: 200_000, exploreWeight: 150_000, canResume: true, ...over },
  usdPerWeight: 0.000004,
});

test("a done card whose memory is still warm gets its follow-up as a new round", () => {
  const f = memoryFacts(card(), NOW);
  assert.equal(f.memory, "warm");
  assert.equal(f.recommendation, "new_round");
  assert.deepEqual(f.can, ["new_round", "fork", "fresh"]);
  assert.ok(f.continueWeight < f.freshWeight);
  assert.equal(f.warmUntil, new Date(NOW - 10 * 60_000 + MEMORY_WARM_MIN * 60_000).toISOString());
});

test("a cooled memory is continued only while reading it again costs less than a fresh card", () => {
  const small = memoryFacts(card({ endedAt: ago(MEMORY_WARM_MIN + 30), contextTokens: 50_000, exploreWeight: 200_000 }), NOW);
  assert.equal(small.memory, "cool");
  assert.equal(small.recommendation, "new_round");
  const big = memoryFacts(card({ endedAt: ago(MEMORY_WARM_MIN + 30), contextTokens: 110_000, exploreWeight: 90_000 }), NOW);
  assert.equal(big.recommendation, "fresh");
  assert.match(big.why, /cooled and is big/);
});

test("a memory past the full mark goes to a fresh card even while warm", () => {
  const f = memoryFacts(card({ contextTokens: (MEMORY_FULL_PCT / 100) * 200_000 + 1 }), NOW);
  assert.equal(f.memory, "warm");
  assert.equal(f.recommendation, "fresh");
});

test("a session older than Claude Code keeps, or one that cannot be continued, is gone and leaves only a fresh card", () => {
  const old = memoryFacts(card({ endedAt: ago(MEMORY_KEEP_DAYS * 24 * 60 + 1) }), NOW);
  assert.equal(old.memory, "gone");
  assert.deepEqual(old.can, ["fresh"]);
  assert.match(old.why, /deleted after 30 days/);
  const cli = memoryFacts(card({ canResume: false }), NOW);
  assert.equal(cli.memory, "gone");
  assert.equal(cli.recommendation, "fresh");
});

test("a card waiting in review takes the follow-up into its unapproved round, and a running one is steered", () => {
  assert.equal(memoryFacts(card({}, "review"), NOW).recommendation, "add_to_round");
  assert.equal(memoryFacts(card({ running: true, endedAt: null }, "running"), NOW).recommendation, "steer");
  const waiting = memoryFacts(card({}, "approval"), NOW);
  assert.equal(waiting.recommendation, null);
  assert.match(waiting.why, /waiting for you first/);
});

test("costs are shown in dollars only when your own runs give the model a price", () => {
  assert.ok(memoryFacts(card(), NOW).continueUsd! >= 0);
  const unpriced = memoryFacts({ ...card(), usdPerWeight: null }, NOW);
  assert.equal(unpriced.continueUsd, null);
  assert.equal(unpriced.freshUsd, null);
});

test("what a run spent before its first edit stops at the turn that makes the edit", () => {
  const turn = (id: string, output: number, tool?: string) => ({ type: "assistant", message: { id, usage: { output_tokens: output }, content: tool ? [{ type: "tool_use", name: tool }] : [] } });
  const r = splitAtFirstEdit([turn("a", 10, "Read"), turn("a", 10, "Grep"), turn("b", 20, "Edit"), turn("c", 30), { type: "user" }]);
  assert.equal(r.beforeEdit, 50);
  assert.equal(r.total, 300);
  assert.equal(r.edited, true);
});

test("a finished code stage records what finding its way cost, and the board learns the model's price from it", async () => {
  const f = fakeQuery({
    extra: [
      { type: "assistant", message: { id: "m1", usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
      { type: "assistant", message: { id: "m2", usage: { input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 50 }, content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.ts" } }] } },
    ],
  });
  const s = setup(f.fn);
  try {
    const t = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [{ stage: "code", model: "m", effort: "low" }] });
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "review" && !s.runner.isBusy(t.id));
    assert.equal(s.repo.workRun(t.id)!.explore_weight, 1500);
    assert.equal(s.repo.exploreWeight(t.id), 1500);
    assert.ok(s.repo.usdPerWeight("m")! > 0);
    const input = s.runner.memoryInput(t.id);
    assert.equal(input.session?.id, "s1");
    assert.equal(memoryFacts(input).recommendation, "add_to_round");
  } finally {
    await s.cleanup();
  }
});
