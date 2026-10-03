import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup, until } from "./helpers.ts";
import { parseCritique, extractRevisedPlan, extractRevisionAnswers, debateRoundLimit } from "../src/engine/debate.ts";
import { DEBATE_ROUND_CEILING, type DebateSettings, type Stage } from "../src/types.ts";

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

function withDebate(s: ReturnType<typeof setup>, over: Partial<DebateSettings> = {}) {
  s.repo.updateSettings({ debate: { enabled: true, critic: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" }, mode: "once", rounds: 3, ...over } });
}

/**
 * A debate that keeps going: call 0 = plan, then critic / revision pairs. The critic objects every
 * round except `agreeAt`, where it answers "No objections."; each revision is "PLAN v<round+1>".
 */
function loopFake(agreeAt?: number) {
  return fakeQuery({
    byCall: (i) => {
      if (i === 0) return { sessionId: "s-plan", result: "PLAN v1" };
      const round = Math.ceil(i / 2);
      if (i % 2 === 1) return { sessionId: `s-critic-${round}`, result: round === agreeAt ? "No objections." : CRITIQUE };
      return { sessionId: "s-plan", result: `ACCEPT 1 — round ${round}.\nREBUT 2 — still fine.\n\n## Revised plan\nPLAN v${round + 1}` };
    },
  });
}

async function gated(s: ReturnType<typeof setup>) {
  const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "spec", mode: "supervised", pipeline: PIPE });
  s.runner.queueTask(task.id);
  await until(() => ["approval", "review"].includes(s.repo.getTask(task.id)!.status));
  return s.repo.getTask(task.id)!;
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
    const critic = f.calls[1].options;
    assert.deepEqual(critic.settingSources, ["project"], "a critique reads a plan: none of your plugins");
    assert.deepEqual(critic.skills, []);
    assert.equal(critic.strictMcpConfig, true);
    assert.equal(critic.mcpServers.playwright, undefined, "nothing to look at");
    assert.ok(critic.maxTurns <= 20 && critic.maxBudgetUsd <= 1, "a critique is short and cheap");
    assert.equal(f.calls[2].options.resume, "s-plan", "the planner revises in its own session");
    assert.match(f.calls[2].prompt, /skips the migration/);
    assert.doesNotMatch(f.calls[2].prompt, /## Your plan/, "a resumable planner already holds its plan");

    const t = s.repo.getTask(task.id)!;
    assert.equal(t.plan_gate!.original, "PLAN v1");
    assert.equal(t.plan_gate!.revised, "PLAN v2 with migration");
    assert.equal(t.plan_gate!.critique!.objections.length, 2);
    assert.equal(t.plan_gate!.critique!.objections[0].severity, "high");
    assert.equal(t.plan_gate!.critic!.model, "claude-sonnet-5");
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

test("a one-time debate tells both models there is no second round", async () => {
  const f = debateFake();
  const s = setup(f.fn);
  try {
    withDebate(s, { mode: "once" });
    const t = await gated(s);
    assert.equal(t.status, "approval");
    assert.match(f.calls[1].prompt, /one-time debate/);
    assert.match(f.calls[2].prompt, /one-time debate/);
    assert.doesNotMatch(f.calls[1].prompt, /Round 1 of/);
    assert.equal(t.plan_gate!.rounds, 1);
    assert.equal(t.plan_gate!.agreed, false);
  } finally {
    s.cleanup();
  }
});

test("a fixed number of rounds: each round sees the revised plan and the planner's answers, and the last round says so", async () => {
  const f = loopFake();
  const s = setup(f.fn);
  try {
    withDebate(s, { mode: "rounds", rounds: 3 });
    const t = await gated(s);
    assert.equal(t.status, "approval");
    assert.equal(f.calls.length, 7, "plan, then three critic / revision pairs");
    assert.match(f.calls[1].prompt, /Round 1 of 3\./);
    assert.match(f.calls[3].prompt, /Round 2 of 3\./);
    assert.match(f.calls[3].prompt, /## The revised plan\nPLAN v2/, "the second critic reads the revised plan");
    assert.match(f.calls[3].prompt, /answers to the previous round[\s\S]*ACCEPT 1 — round 1/, "and the planner's answers");
    assert.match(f.calls[5].prompt, /Round 3 of 3: this is the last round/);
    assert.match(f.calls[6].prompt, /Round 3 of 3: this is the last round/, "the planner knows its revision is final");
    assert.equal(f.calls[6].options.resume, "s-plan", "every revision happens in the planner's own session");
    assert.equal(t.plan_gate!.original, "PLAN v1");
    assert.equal(t.plan_gate!.revised, "PLAN v4");
    assert.equal(t.plan_gate!.rounds, 3);
    assert.equal(t.plan_gate!.agreed, false);
    assert.equal(s.repo.runsForTask(t.id).filter((r) => r.role === "critic").length, 3);
    assert.equal(s.repo.stageRuns(t.id).length, 1, "the plan run is still the one stage run");
    const planRun = s.repo.stageRuns(t.id)[0];
    assert.equal(s.repo.eventsAfter(planRun.id).filter((e) => e.type === "debate:round").length, 3);
  } finally {
    s.cleanup();
  }
});

test("a debate ends early when the critic has no objections left, and the gate says they agreed", async () => {
  for (const mode of ["rounds", "until_agree"] as const) {
    const f = loopFake(3);
    const s = setup(f.fn);
    try {
      withDebate(s, { mode, rounds: 5 });
      const t = await gated(s);
      assert.equal(t.status, "approval");
      assert.equal(f.calls.length, 6, "plan, two argued rounds, then a critic with nothing to say");
      if (mode === "until_agree") {
        assert.match(f.calls[1].prompt, /until you have no objections left/);
        assert.doesNotMatch(f.calls[1].prompt, /of \d/);
      }
      assert.equal(t.plan_gate!.revised, "PLAN v3");
      assert.equal(t.plan_gate!.rounds, 2);
      assert.equal(t.plan_gate!.agreed, true);
      assert.match(t.note ?? "", /until the critic agreed/);
      assert.equal(t.plan_gate!.critique!.objections.length, 2, "the last objections raised, not the empty final answer");
    } finally {
      s.cleanup();
    }
  }
});

test("a debate until agreement still stops at the ceiling", async () => {
  const f = loopFake();
  const s = setup(f.fn);
  try {
    withDebate(s, { mode: "until_agree" });
    const t = await gated(s);
    assert.equal(t.status, "approval");
    assert.equal(f.calls.length, 1 + 2 * DEBATE_ROUND_CEILING);
    assert.equal(t.plan_gate!.rounds, DEBATE_ROUND_CEILING);
    assert.equal(t.plan_gate!.agreed, false);
    assert.match(t.note ?? "", /without agreement/);
  } finally {
    s.cleanup();
  }
});

test("a critic that breaks on a later round keeps the rounds before it", async () => {
  const f = fakeQuery({ byCall: (i) => ({ 0: { sessionId: "s-plan", result: "PLAN v1" }, 1: { result: CRITIQUE }, 2: { sessionId: "s-plan", result: REVISION }, 3: { fail: true } } as Record<number, any>)[i] });
  const s = setup(f.fn);
  try {
    withDebate(s, { mode: "rounds", rounds: 3 });
    const t = await gated(s);
    assert.equal(t.status, "approval");
    assert.equal(f.calls.length, 4);
    assert.equal(t.plan_gate!.revised, "PLAN v2 with migration");
    assert.equal(t.plan_gate!.rounds, 1);
  } finally {
    s.cleanup();
  }
});

test("debateRoundLimit: one round unless told otherwise, never past the ceiling, no limit until they agree", () => {
  assert.equal(debateRoundLimit({ mode: "once", rounds: 5 }), 1);
  assert.equal(debateRoundLimit({}), 1);
  assert.equal(debateRoundLimit({ mode: "rounds", rounds: 4 }), 4);
  assert.equal(debateRoundLimit({ mode: "rounds", rounds: 99 }), DEBATE_ROUND_CEILING);
  assert.equal(debateRoundLimit({ mode: "until_agree" }), undefined);
  assert.equal(extractRevisionAnswers(REVISION), "ACCEPT 1 — yes.\nREBUT 2 — fine as is.");
  assert.equal(extractRevisionAnswers("just text"), "");
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
