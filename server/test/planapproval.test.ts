import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup, until } from "./helpers.ts";

const PIPE = [
  { stage: "plan", model: "claude-opus-5", effort: "high" },
  { stage: "code", model: "claude-sonnet-5", effort: "high" },
  { stage: "review", model: "claude-sonnet-5", effort: "medium" },
] as const;

test("plan approval: the task waits after its plan, and Approve carries on to code (D200)", async () => {
  const f = fakeQuery({ byCall: (i) => (i === 0 ? { result: "## Execution steps\n1. do it" } : undefined) });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [...PIPE] as never, plan_approval: true });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "approval");
    const gated = s.repo.getTask(task.id)!;
    assert.equal(gated.plan_gate?.kind, "approval");
    assert.match(gated.plan_gate!.original, /Execution steps/);
    assert.equal(f.calls.length, 1, "nothing after the plan runs until it is approved");

    s.runner.decidePlan(task.id, "original");
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 3);
    assert.equal(s.repo.getTask(task.id)!.plan_gate, null);
    assert.match(f.calls[1].prompt, /## The plan \(previous stage\)[\s\S]*do it/);
  } finally {
    s.cleanup();
  }
});

test("plan approval: an edited plan is what the code stage gets; Settings turn it on, a task can turn it off", async () => {
  const f = fakeQuery({ byCall: (i) => (i === 0 ? { result: "PLAN A" } : undefined) });
  const s = setup(f.fn);
  try {
    s.repo.updateSettings({ planApproval: true });
    const t1 = s.repo.createTask({ project_id: s.project.id, title: "a", mode: "supervised", pipeline: [...PIPE] as never });
    s.runner.queueTask(t1.id);
    await until(() => s.repo.getTask(t1.id)!.status === "approval");
    s.runner.decidePlan(t1.id, "custom", "PLAN B, edited by me");
    await until(() => s.repo.getTask(t1.id)!.status === "review" && f.calls.length === 3);
    assert.match(f.calls[1].prompt, /PLAN B, edited by me/);
    assert.doesNotMatch(f.calls[1].prompt, /PLAN A/);

    const t2 = s.repo.createTask({ project_id: s.project.id, title: "b", mode: "supervised", pipeline: [...PIPE] as never, plan_approval: false });
    s.runner.queueTask(t2.id);
    await until(() => s.repo.getTask(t2.id)!.status === "review");
    assert.equal(s.repo.getTask(t2.id)!.plan_gate, null, "the task's own choice beats Settings");
  } finally {
    s.cleanup();
  }
});

test("plan approval: Send back returns the task to Backlog with the note", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [...PIPE] as never, plan_approval: true });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "approval");
    s.runner.rejectTask(task.id, "Wrong approach: reuse the existing role.");
    const back = s.repo.getTask(task.id)!;
    assert.equal(back.status, "backlog");
    assert.equal(back.plan_gate, null);
    assert.match(back.note ?? "", /reuse the existing role/);
  } finally {
    s.cleanup();
  }
});

test("a live task: plan approval is forced on and review runs on the live review model (D202)", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [...PIPE] as never, live: true, plan_approval: false });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "approval");
    s.runner.decidePlan(task.id, "original");
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 3);
    const review = s.repo.runsForTask(task.id).find((r) => r.stage === "review")!;
    assert.equal(review.model, "claude-opus-5");
    assert.equal(review.effort, "high");
    assert.equal(f.calls[2].options.model, "claude-opus-5");
    assert.match(f.calls[2].prompt, /## Live system[\s\S]*read the live system yourself/);
    assert.match(f.calls[1].prompt, /## Live system[\s\S]*dry-run before every live change/);
  } finally {
    s.cleanup();
  }
});

test("a stage that runs out of turns carries on in the same session, then stops after the limit (D201)", async () => {
  const f = fakeQuery({ sessionId: "sess-code", byCall: (i) => (i === 0 ? { maxTurns: true } : undefined) });
  const s = setup(f.fn);
  try {
    const one = [{ stage: "code", model: "claude-sonnet-5", effort: "high" }];
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: one as never });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].options.resume, "sess-code", "the second call resumes the first session");
    assert.match(f.calls[1].prompt, /reached this stage's turn limit/);
    assert.doesNotMatch(f.calls[1].prompt, /# Stage: code/, "not the whole stage prompt again");

    const g = fakeQuery({ maxTurns: true });
    const s2 = setup(g.fn);
    try {
      s2.repo.updateSettings({ autoContinueTurns: 1 });
      const t2 = s2.repo.createTask({ project_id: s2.project.id, title: "y", mode: "supervised", pipeline: one as never });
      s2.runner.queueTask(t2.id);
      await until(() => s2.repo.getTask(t2.id)!.status === "failed");
      assert.equal(g.calls.length, 2, "one automatic continue, then it fails as before");
      assert.match(s2.repo.getTask(t2.id)!.error ?? "", /maximum number of turns/);
    } finally {
      s2.cleanup();
    }
  } finally {
    s.cleanup();
  }
});
