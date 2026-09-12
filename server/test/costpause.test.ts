import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";

const TWO: Stage[] = [
  { stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" },
  { stage: "review", model: "claude-haiku-4-5-20251001", effort: "low" },
];

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every stage costs `cost`; the first `budgetStops` stages end with the SDK's own budget stop. */
function stageCosting(cost: number, budgetStops = 0): QueryFn {
  let n = 0;
  return (params) =>
    (async function* () {
      for await (const _ of params.prompt) {
        /* drain */
      }
      const stop = n++ < budgetStops;
      yield { type: "system", subtype: "init", session_id: "s1" } as any;
      yield {
        type: "result", subtype: stop ? "error_max_budget_usd" : "success", is_error: stop, result: "DONE", errors: stop ? ["budget"] : [],
        total_cost_usd: cost, session_id: "s1", modelUsage: {},
      } as any;
    })();
}

function setup(fn: QueryFn) {
  const dir = mkdtempSync(join(tmpdir(), "kcost-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "c", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } as any });
  const runner = new TaskRunner({ repo, bus, queryFn: fn });
  return { repo, project, runner, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("reaching the task ceiling pauses for a decision instead of failing; Continue grants one stage ceiling and resumes", async () => {
  const s = setup(stageCosting(1.0));
  try {
    s.repo.updateSettings({ maxCostPerTaskUsd: 0.5, maxCostPerStageUsd: 2 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    const paused = s.repo.getTask(task.id)!;
    assert.equal(paused.pause_reason, "cost");
    assert.equal(paused.resume_at, null);
    assert.equal(paused.error, null);
    assert.match(paused.note ?? "", /\$1\.00/);
    assert.match(paused.note ?? "", /\$2\.00 more/);
    assert.equal(s.repo.runsForTask(task.id).length, 1, "the first stage finished; the second never started");

    s.runner.continueTask(task.id);
    assert.equal(s.repo.getTask(task.id)!.budget_extra_usd, 2);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(s.repo.runsForTask(task.id).length, 2);
  } finally {
    s.cleanup();
  }
});

test("the SDK's own per-stage budget stop pauses too, keeps the session, and Stop fails it with the reason kept", async () => {
  const s = setup(stageCosting(0.3, 1));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    assert.equal(s.repo.getTask(task.id)!.pause_reason, "cost");
    assert.match(s.repo.getTask(task.id)!.note ?? "", /its own ceiling/);
    assert.equal(s.repo.runsForTask(task.id)[0].session_id, "s1");
    assert.throws(() => s.runner.resumeNow(task.id), /Continue/);

    s.runner.stopPaused(task.id);
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed");
    assert.equal(t.pause_reason, null);
    assert.match(t.error ?? "", /ceiling/);
  } finally {
    s.cleanup();
  }
});

test("Continue after the SDK budget stop retries the same stage in the same session", async () => {
  const s = setup(stageCosting(0.3, 1));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    s.runner.continueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const runs = s.repo.runsForTask(task.id);
    assert.deepEqual(runs.map((r) => r.stage), ["code", "code", "review"]);
  } finally {
    s.cleanup();
  }
});

test("a cost pause is left alone by the usage-limit resume timer", async () => {
  const s = setup(stageCosting(1.0));
  try {
    s.repo.updateSettings({ maxCostPerTaskUsd: 0.5 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    assert.deepEqual(s.runner.resumeDue(Date.now() + 1e9), []);
    assert.equal(s.repo.getTask(task.id)!.status, "paused");
    assert.equal(s.runner.limitedUntil(), null, "a cost pause does not hold the queue for a usage window");
  } finally {
    s.cleanup();
  }
});
