import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup, until } from "./helpers.ts";
import { isProgressing, stageProgress } from "../src/engine/progress.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";

const CODE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const TWO: Stage[] = [{ stage: "code", model: "m", effort: "low" }, { stage: "review", model: "m", effort: "low" }];

/** An assistant message that edits a file: what a working code stage looks like in the record. */
const EDIT = { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }] } };

/**
 * Every stage costs `cost`; the first `budgetStops` calls end with the SDK's own budget stop, after
 * `working` edits each. Records what each call was asked to resume.
 */
function costing(cost: number, budgetStops: number, working: boolean): { fn: QueryFn; resumes: (string | undefined)[] } {
  let n = 0;
  const resumes: (string | undefined)[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) {
        /* drain */
      }
      resumes.push(params.options.resume);
      const stop = n++ < budgetStops;
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      if (working) yield { ...EDIT, session_id: "s1" } as never;
      yield {
        type: "result", subtype: stop ? "error_max_budget_usd" : "success", is_error: stop, result: "DONE", errors: stop ? ["budget"] : [],
        total_cost_usd: cost, session_id: "s1", modelUsage: {},
      } as never;
    })();
  return { fn, resumes };
}

test("progress is edits or a moving to-do list for a stage that writes, and any tool call for one that only reads", () => {
  const ev = (payload: unknown, id: number) => ({ id, run_id: "r", ts: "t", type: "assistant", payload });
  const read = ev({ message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }, 1);
  const sub = ev({ parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } }, 2);
  const edit = ev(EDIT, 3);
  const todo = ev({ message: { content: [{ type: "tool_use", name: "TodoWrite", input: {} }] } }, 4);
  assert.deepEqual(stageProgress([read, sub]), { edits: 0, tools: 1, checklist: false }, "a subagent's edit is not the stage's");
  assert.equal(isProgressing(stageProgress([read]), "code"), false, "reading alone is not progress for a code stage");
  assert.equal(isProgressing(stageProgress([read]), "plan"), true, "but it is for a plan");
  assert.equal(isProgressing(stageProgress([edit]), "code"), true);
  assert.equal(isProgressing(stageProgress([todo]), "custom"), true);
  assert.deepEqual(stageProgress([read, edit], 1), { edits: 1, tools: 1, checklist: false }, "only events after the mark count");
});

test("a stage that keeps editing is continued past the turn limit for as long as it does (D412)", async () => {
  const f = fakeQuery({ sessionId: "s-code", byCall: (i) => (i < 4 ? { maxTurns: true, extra: [EDIT] } : undefined) });
  const s = setup(f.fn);
  try {
    s.repo.updateSettings({ autoContinueTurns: 1 } as never);
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    assert.equal(f.calls.length, 5, "four continues — one by the setting, three because it kept editing");
    assert.ok(f.calls.slice(1).every((c) => c.options.resume === "s-code"), "all in the same session");
    const run = s.repo.stageRuns(task.id)[3];
    const ev = s.repo.eventsAfter(run.id).find((e) => e.type === "turns:continued");
    assert.equal((ev!.payload as { working: boolean }).working, true);
  } finally {
    await s.cleanup();
  }
});

test("a stage out of turns that made no changes stops after the set continues, as before", async () => {
  const f = fakeQuery({ sessionId: "s-code", maxTurns: true });
  const s = setup(f.fn);
  try {
    s.repo.updateSettings({ autoContinueTurns: 1, autoRecover: false } as never);
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed" && !s.runner.isBusy(task.id));
    assert.equal(f.calls.length, 2);
  } finally {
    await s.cleanup();
  }
});

test("a stage that hits its budget while editing gets another ceiling from the board and carries on in its session", async () => {
  const c = costing(0.3, 1, true);
  const s = setup(c.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.budget_extra_usd, 20, "one stage ceiling, granted by the board");
    assert.match(t.note ?? "", /still making changes, so it carries on/);
    assert.deepEqual(s.repo.runsForTask(task.id).map((r) => r.stage), ["code", "code", "review"]);
    assert.equal(c.resumes[1], "s1", "the same session");
    const first = s.repo.stageRuns(task.id)[0];
    assert.ok(s.repo.eventsAfter(first.id).some((e) => e.type === "cost:auto_granted"));
  } finally {
    await s.cleanup();
  }
});

test("a stage that hits its budget without making changes pauses and asks, as before", async () => {
  const c = costing(0.3, 1, false);
  const s = setup(c.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    assert.equal(s.repo.getTask(task.id)!.pause_reason, "cost");
    assert.equal(s.repo.getTask(task.id)!.budget_extra_usd, 0);
  } finally {
    await s.cleanup();
  }
});

test("the board stops granting at twice the task ceiling and asks", async () => {
  const c = costing(0.3, 99, true);
  const s = setup(c.fn);
  try {
    s.repo.updateSettings({ maxCostPerTaskUsd: 0.5, maxCostPerStageUsd: 0.2 } as never);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    const t = s.repo.getTask(task.id)!;
    // Ceiling 0.5, hard 1.0: granted to 0.7 and 0.9; the next grant would pass 1.0.
    assert.equal(Number(t.budget_extra_usd.toFixed(2)), 0.4);
    assert.equal(s.repo.runsForTask(task.id).length, 3);
    assert.match(t.note ?? "", /Stopped at/);
  } finally {
    await s.cleanup();
  }
});

test("a task over its ceiling between stages carries on into the next stage while under the hard ceiling", async () => {
  const c = costing(1.0, 0, false);
  const s = setup(c.fn);
  try {
    s.repo.updateSettings({ maxCostPerTaskUsd: 1.0, maxCostPerStageUsd: 0.5 } as never);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.budget_extra_usd, 0.5);
    assert.match(t.note ?? "", /a stage finished and the next one is waiting/);
    assert.equal(s.repo.runsForTask(task.id).length, 2);
  } finally {
    await s.cleanup();
  }
});

test("with the setting off, the ceilings stop and ask as they always did", async () => {
  const c = costing(0.3, 1, true);
  const s = setup(c.fn);
  try {
    s.repo.updateSettings({ autoContinueWhileProgressing: false } as never);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    assert.equal(s.repo.getTask(task.id)!.budget_extra_usd, 0);
  } finally {
    await s.cleanup();
  }
});
