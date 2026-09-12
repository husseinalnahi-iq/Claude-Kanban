import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup, until } from "./helpers.ts";
import { parseCritique, extractRevisedPlan } from "../src/engine/debate.ts";
import type { Stage } from "../src/types.ts";

const CRITIQUE = [
  "1. Severity: high",
  "   Claim: The plan skips the migration, so old rows break.",
  "   Change: Add a LATER_COLUMNS entry first.",
  "2. Severity: low",
  "   Claim: The test name is vague.",
  "   Change: Name it after the behaviour.",
].join("\n");

const REVISION = "ACCEPT 1 — yes.\nREBUT 2 — fine as is.\n\n## Revised plan\nPLAN v2 with migration";

const PIPE: Stage[] = [
  { stage: "plan", model: "claude-opus-5", effort: "high" },
  { stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" },
];

/** Call 0 = plan, 1 = critic, 2 = revision, 3 = code. */
function debateFake(over: Record<number, Parameters<typeof fakeQuery>[0]> = {}) {
  return fakeQuery({
    byCall: (i) => ({ 0: { sessionId: "s-plan", result: "PLAN v1" }, 1: { sessionId: "s-critic", result: CRITIQUE }, 2: { sessionId: "s-plan", result: REVISION }, 3: { sessionId: "s-code", result: "coded" } }[i] && { ...({ 0: { sessionId: "s-plan", result: "PLAN v1" }, 1: { sessionId: "s-critic", result: CRITIQUE }, 2: { sessionId: "s-plan", result: REVISION }, 3: { sessionId: "s-code", result: "coded" } } as Record<number, any>)[i], ...(over[i] ?? {}) }),
  });
}

function withDebate(s: ReturnType<typeof setup>) {
  s.repo.updateSettings({ debate: { enabled: true, critic: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" } } });
}

test("plan → critic → revision in the planner's own session, then the task waits for a decision", async () => {
  const f = debateFake();
  const s = setup(f.fn);
  try {
    withDebate(s);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "spec", mode: "supervised", pipeline: PIPE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "approval");
    assert.equal(f.calls.length, 3, "no code stage yet");
    assert.match(f.calls[1].prompt, /# Plan critique/);
    assert.match(f.calls[1].prompt, /PLAN v1/);
    assert.equal(f.calls[1].options.model, "claude-sonnet-5");
    assert.equal(f.calls[1].options.resume, undefined);
    assert.equal(f.calls[2].options.resume, "s-plan", "the planner revises in its own session");
    assert.match(f.calls[2].prompt, /skips the migration/);
    assert.doesNotMatch(f.calls[2].prompt, /## Your plan/, "a resumable planner already holds its plan");

    const t = s.repo.getTask(task.id)!;
    assert.equal(t.plan_gate!.original, "PLAN v1");
    assert.equal(t.plan_gate!.revised, "PLAN v2 with migration");
    assert.equal(t.plan_gate!.critique.objections.length, 2);
    assert.equal(t.plan_gate!.critique.objections[0].severity, "high");
    assert.equal(t.plan_gate!.critic.model, "claude-sonnet-5");
    const runs = s.repo.runsForTask(task.id);
    assert.equal(runs.length, 2);
    assert.equal(runs.find((r) => r.role === "critic")!.status, "success");
    assert.equal(s.repo.stageRuns(task.id).length, 1);
    assert.equal(s.repo.latestRun(task.id)!.session_id, "s-plan", "the critic never becomes the latest run");
    const events = s.repo.eventsAfter(runs[0].id).map((e) => e.type);
    assert.equal(events.filter((e) => e === "user:prompt").length, 2, "the revision prompt is recorded on the plan run");

    // Decide: revised → code runs with the revised plan and the task ends in review.
    s.runner.decidePlan(task.id, "revised");
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(f.calls.length, 4);
    assert.match(f.calls[3].prompt, /PLAN v2 with migration/);
    assert.doesNotMatch(f.calls[3].prompt, /PLAN v1/);
    assert.equal(s.repo.getTask(task.id)!.plan_gate, null);
    const cards = s.repo.taskCards(s.project.id);
    assert.deepEqual(cards[0].stage_states, ["success", "success"]);
    assert.ok(s.repo.eventsAfter(runs[0].id).some((e) => e.type === "debate:decision"));
  } finally {
    s.cleanup();
  }
});

test("a custom plan text is what the code stage receives", async () => {
  const f = debateFake();
  const s = setup(f.fn);
  try {
    withDebate(s);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "spec", mode: "supervised", pipeline: PIPE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "approval");
    assert.throws(() => s.runner.decidePlan(task.id, "custom", "  "), /empty/);
    s.runner.decidePlan(task.id, "custom", "MY OWN PLAN");
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.match(f.calls[3].prompt, /MY OWN PLAN/);
  } finally {
    s.cleanup();
  }
});

test("a failed critic or no objections means no gate: the pipeline just continues", async () => {
  for (const over of [{ 1: { fail: true } }, { 1: { result: "No objections." } }] as const) {
    const f = debateFake(over as never);
    const s = setup(f.fn);
    try {
      withDebate(s);
      const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "spec", mode: "supervised", pipeline: PIPE });
      s.runner.queueTask(task.id);
      await until(() => s.repo.getTask(task.id)!.status === "review");
      assert.equal(s.repo.getTask(task.id)!.plan_gate, null);
      assert.equal(f.calls.length, 3, "plan, critic, code — no revision");
      assert.match(f.calls[2].prompt, /PLAN v1/);
      const planRun = s.repo.stageRuns(task.id)[0];
      assert.ok(s.repo.eventsAfter(planRun.id).some((e) => e.type === "debate:skipped"));
    } finally {
      s.cleanup();
    }
  }
});

test("stop and reject clear the gate; recover() leaves a gated task waiting", async () => {
  const f = debateFake();
  const s = setup(f.fn);
  try {
    withDebate(s);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "spec", mode: "supervised", pipeline: PIPE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "approval");
    s.runner.recover();
    assert.equal(s.repo.getTask(task.id)!.status, "approval", "nothing was running; the gate survives a restart");
    s.runner.stopTask(task.id);
    assert.equal(s.repo.getTask(task.id)!.status, "failed");
    assert.equal(s.repo.getTask(task.id)!.plan_gate, null);
    assert.throws(() => s.runner.decidePlan(task.id, "original"), /not waiting/);

    const t2 = s.repo.createTask({ project_id: s.project.id, title: "u", spec_md: "spec", mode: "supervised", pipeline: PIPE });
    s.runner.queueTask(t2.id);
    await until(() => s.repo.getTask(t2.id)!.status === "approval");
    s.runner.rejectTask(t2.id, "no");
    assert.equal(s.repo.getTask(t2.id)!.status, "backlog");
    assert.equal(s.repo.getTask(t2.id)!.plan_gate, null);
  } finally {
    s.cleanup();
  }
});

test("a stage can switch the debate off, or name its own critic", async () => {
  const f = debateFake();
  const s = setup(f.fn);
  try {
    withDebate(s);
    const off = s.repo.createTask({ project_id: s.project.id, title: "off", spec_md: "spec", mode: "supervised", pipeline: [{ ...PIPE[0], debate: false }, PIPE[1]] });
    s.runner.queueTask(off.id);
    await until(() => s.repo.getTask(off.id)!.status === "review");
    assert.equal(f.calls.length, 2, "plan then code, no critic");

    const g = debateFake();
    const s2 = setup(g.fn);
    try {
      // Global debate off; the stage asks for it with a specific critic.
      const own = s2.repo.createTask({ project_id: s2.project.id, title: "own", spec_md: "spec", mode: "supervised", pipeline: [{ ...PIPE[0], debate: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } }, PIPE[1]] });
      s2.runner.queueTask(own.id);
      await until(() => s2.repo.getTask(own.id)!.status === "approval");
      assert.equal(g.calls[1].options.model, "claude-haiku-4-5-20251001");
    } finally {
      s2.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("parseCritique reads numbered, bulleted and bold variants; garbage becomes one objection", () => {
  assert.equal(parseCritique(CRITIQUE).objections.length, 2);
  const bold = "- **Severity:** medium\n  **Claim:** X is wrong.\n  **Change:** Do Y.\n- **Severity:** high\n  **Claim:** Z.\n  **Change:** W.";
  const b = parseCritique(bold).objections;
  assert.equal(b.length, 2);
  assert.equal(b[0].severity, "medium");
  assert.equal(b[0].claim, "X is wrong.");
  assert.equal(b[0].change, "Do Y.");
  assert.equal(parseCritique("No objections.").objections.length, 0);
  assert.equal(parseCritique("").objections.length, 0);
  const g = parseCritique("I think the whole approach is off.").objections;
  assert.equal(g.length, 1);
  assert.equal(g[0].severity, "medium");
  assert.equal(extractRevisedPlan(REVISION), "PLAN v2 with migration");
  assert.equal(extractRevisedPlan("just text"), "just text");
});
