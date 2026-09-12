import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SEED_PIPELINE } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { DEFAULT_EFFORT, EFFORT_NOTES, EFFORTS, supportsFastMode, type Stage } from "../src/types.ts";

async function until(cond: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(queryFn: QueryFn) {
  const dir = mkdtempSync(join(tmpdir(), "kfast-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  return { repo, bus, project, runner: new TaskRunner({ repo, bus, queryFn }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("effort uses Claude's own names and notes, with Claude's default", () => {
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(EFFORT_NOTES.low, "Fastest and cheapest");
  assert.equal(EFFORT_NOTES.medium, "Reduces token usage");
  assert.equal(EFFORT_NOTES.high, "Default on most models");
  assert.equal(EFFORT_NOTES.xhigh, "Deeper reasoning at higher token spend");
  assert.equal(EFFORT_NOTES.max, "Demanding tasks needing maximum reasoning");
  assert.equal(DEFAULT_EFFORT, "high", "Claude's default, and what new stages start with");
  assert.ok(SEED_PIPELINE.every((s) => !s.fast), "fast mode is off by default, as it is in Claude");
});

test("fast mode is recognised for Opus 5 and Opus 4.8 only", () => {
  for (const m of ["claude-opus-5", "claude-opus-5-1", "claude-opus-4-8", "claude-opus-4-8-20260101"]) assert.ok(supportsFastMode(m), m);
  for (const m of ["claude-opus-4-7", "claude-opus-50", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"]) {
    assert.ok(!supportsFastMode(m), m);
  }
});

test("a ↯ stage on Opus asks the SDK for fast mode; the same flag on another model is never sent", async () => {
  const seen: { model: string; settings: unknown }[] = [];
  const q: QueryFn = (params) =>
    (async function* () {
      seen.push({ model: String(params.options.model), settings: params.options.settings });
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const s = setup(q);
  try {
    const pipeline: Stage[] = [
      { stage: "code", model: "claude-opus-5", effort: "low", fast: true },
      // Moved to Sonnet but still flagged: fast mode must not be requested, or the stage would fail.
      { stage: "review", model: "claude-sonnet-5", effort: "medium", fast: true },
      { stage: "custom", model: "claude-opus-5", effort: "high" },
    ];
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline });
    s.runner.queueTask(task.id);
    // "review" is also the status while the review stage runs, so wait for the pipeline itself to end.
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    assert.deepEqual(seen[0].settings, { fastMode: true }, "Opus + ↯ → fast mode requested");
    assert.equal(seen[1].settings, undefined, "Sonnet + ↯ → nothing sent");
    assert.equal(seen[2].settings, undefined, "Opus without ↯ → standard speed");
  } finally {
    s.cleanup();
  }
});

test("fast-mode availability is read from the init message, before any model call, and explained", async () => {
  let reachedModel = false;
  const q: QueryFn = (params) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "s", fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" } as never;
      if (params.options.abortController?.signal.aborted) return;
      reachedModel = true;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.3, session_id: "s", modelUsage: {} } as never;
    })();
  const s = setup(q);
  try {
    const status = await s.runner.fastModeStatus();
    assert.equal(status.state, "off");
    assert.equal(status.reason, "extra_usage_disabled");
    assert.match(status.message, /billed as extra usage, and extra usage is turned off/);
    assert.equal(reachedModel, false, "the check stops at the init message, so it costs nothing");
  } finally {
    s.cleanup();
  }
});
