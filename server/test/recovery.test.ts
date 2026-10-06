import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup, until } from "./helpers.ts";
import { Scheduler } from "../src/engine/scheduler.ts";
import { KeepAwake } from "../src/engine/keepAwake.ts";
import { RecoveryService, eventLines } from "../src/engine/recovery.ts";
import { isTransient } from "../src/engine/providers/limits.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";

const CODE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const PLAN_CODE: Stage[] = [{ stage: "plan", model: "m", effort: "low" }, { stage: "code", model: "m", effort: "low" }];

/** A scheduler whose clock the test moves, and that never touches the computer's sleep. */
function clock(s: ReturnType<typeof setup>) {
  let now = Date.now();
  const keepAwake = Object.assign(new KeepAwake(), { set() {} });
  const scheduler = new Scheduler({ repo: s.repo, bus: s.bus, runner: s.runner, now: () => now, keepAwake });
  return { scheduler, advance: (ms: number) => (now += ms) };
}

/** The triage model's answer, as the fake SDK returns it. */
function judge(decision: Record<string, unknown> | ((n: number) => Record<string, unknown>)): { fn: QueryFn; prompts: string[] } {
  const prompts: string[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      prompts.push(prompt);
      const d = typeof decision === "function" ? decision(prompts.length) : decision;
      yield { type: "result", subtype: "success", is_error: false, result: JSON.stringify(d), structured_output: d, total_cost_usd: 0.004, session_id: "j", modelUsage: {} } as never;
    })();
  return { fn, prompts };
}

test("isTransient knows a dropped connection from a real failure", () => {
  for (const e of ["fetch failed", "read ECONNRESET", "socket hang up", "API Error: 529 overloaded_error", "Tool permission stream closed before response received", "503 Service Unavailable"]) {
    assert.ok(isTransient(e), e);
  }
  for (const e of ["stopped by user", "Blocked at stage #2: needs the live token", "Verification failed — npm test did not pass", "prompt is too long: maximum context length", "usage limit reached", "Python was not found", ""]) {
    assert.ok(!isTransient(e), e);
  }
});

test("a connection error tries the stage again in its own session after a wait, and the card does not say your turn", async () => {
  const f = fakeQuery({ sessionId: "s-code", byCall: (i) => (i === 0 ? { fail: "fetch failed" } : undefined) });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed" && !s.runner.isBusy(task.id));
    let t = s.repo.getTask(task.id)!;
    assert.ok(t.start_at, "a time to try again is set — which is what hides 'your turn' on the card");
    assert.match(t.note ?? "", /Trying again in 30 s — connection problem/);
    assert.deepEqual(t.recovery?.transient, { stage: 0, n: 1 });
    assert.equal(t.recovery?.last?.action, "transient");

    const { scheduler, advance } = clock(s);
    advance(60_000);
    scheduler.tick();
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].options.resume, "s-code", "the same session carries on");
    t = s.repo.getTask(task.id)!;
    assert.equal(t.recovery, null, "finished: the retries are history");
    assert.equal(t.start_at, null);
  } finally {
    await s.cleanup();
  }
});

test("after three connection failures on one stage the task is left for the person, with the waits growing", async () => {
  const f = fakeQuery({ sessionId: "s-code", fail: "read ECONNRESET" });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    const { scheduler, advance } = clock(s);
    s.runner.queueTask(task.id);
    const waits: string[] = [];
    for (let n = 1; n <= 3; n++) {
      await until(() => s.repo.getTask(task.id)!.status === "failed" && !s.runner.isBusy(task.id) && f.calls.length === n);
      const t = s.repo.getTask(task.id)!;
      assert.equal(t.recovery?.transient?.n, n);
      assert.ok(t.start_at, `try ${n} is scheduled`);
      waits.push(/Trying again in ([^—]+) —/.exec(t.note ?? "")?.[1]?.trim() ?? "?");
      advance(10 * 60_000);
      scheduler.tick();
    }
    assert.deepEqual(waits, ["30 s", "2 min", "5 min"]);
    await until(() => s.repo.getTask(task.id)!.status === "failed" && !s.runner.isBusy(task.id) && f.calls.length === 4);
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.start_at, null, "the fourth failure waits for the person");
    assert.match(t.error ?? "", /ECONNRESET/);
  } finally {
    await s.cleanup();
  }
});

test("a failed task scheduled to try again picks up where it stopped, in its session, instead of starting over", async () => {
  const f = fakeQuery({ sessionId: "s-code", byCall: (i) => (i === 1 ? { fail: "Python was not found" } : undefined) });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed" && !s.runner.isBusy(task.id));
    s.repo.updateTask(task.id, { start_at: new Date(Date.now() - 1000).toISOString() });
    const { scheduler } = clock(s);
    scheduler.tick();
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    assert.equal(f.calls.length, 3, "the plan did not run again");
    assert.match(f.calls[2].prompt, /# Stage: code/);
    assert.equal(f.calls[2].options.resume, "s-code");
  } finally {
    await s.cleanup();
  }
});

test("a failure the board's triage judges worth a retry runs the stage again by itself and says why on the card", async () => {
  const f = fakeQuery({ sessionId: "s-code", byCall: (i) => (i === 0 ? { fail: "Error: spawn EBUSY" } : undefined) });
  const s = setup(f.fn);
  const j = judge({ action: "retry_same", reason: "A command was busy for a moment; the stage can carry on." });
  const recovery = new RecoveryService({ repo: s.repo, bus: s.bus, runner: s.runner, queryFn: j.fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "Fix the export", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    assert.equal(f.calls.length, 2, "the stage ran again");
    assert.equal(f.calls[1].options.resume, "s-code", "in its own session");
    assert.equal(j.prompts.length, 1, "one look by the triage model");
    assert.match(j.prompts[0], /## The error\n[\s\S]*EBUSY/);
    assert.match(j.prompts[0], /Fix the export/);
    const run = s.repo.stageRuns(task.id)[0];
    const decided = s.repo.eventsAfter(run.id).find((e) => e.type === "recovery:decided");
    assert.ok(decided, "the decision is on the failed run");
    assert.equal((decided!.payload as { action: string }).action, "retry_same");
    assert.ok(s.repo.intakeCost(s.project.id).some((c) => c.kind === "recovery"), "its cost is counted as intake, not as the task's work");
    void recovery;
  } finally {
    await s.cleanup();
  }
});

test("retry_from runs the stage the triage names again, fresh, and the attempt is counted", async () => {
  const f = fakeQuery({ sessionId: "s-x", byCall: (i) => (i === 1 ? { fail: "the plan named a file that does not exist" } : undefined) });
  const s = setup(f.fn);
  const j = judge({ action: "retry_from", stage: 1, reason: "The plan pointed at a file that is not there; planning again." });
  new RecoveryService({ repo: s.repo, bus: s.bus, runner: s.runner, queryFn: j.fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id) && f.calls.length === 4);
    assert.match(f.calls[2].prompt, /# Stage: plan/, "from the plan, as the triage said");
    assert.equal(f.calls[2].options.resume, undefined, "fresh");
    assert.match(f.calls[3].prompt, /# Stage: code/);
  } finally {
    await s.cleanup();
  }
});

test("recovery stops after two attempts, and then the card says what was tried", async () => {
  const f = fakeQuery({ sessionId: "s-code", fail: "Error: spawn EBUSY" });
  const s = setup(f.fn);
  const j = judge({ action: "retry_same", reason: "Busy for a moment." });
  const recovery = new RecoveryService({ repo: s.repo, bus: s.bus, runner: s.runner, queryFn: j.fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => f.calls.length === 3 && s.repo.getTask(task.id)!.status === "failed" && !s.runner.isBusy(task.id));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await recovery.consider(task.id), null, "a third look is refused");
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.recovery?.attempts, 2);
    assert.equal(f.calls.length, 3, "two retries, no more");
    assert.equal(j.prompts.length, 2);
  } finally {
    await s.cleanup();
  }
});

test("needs_user leaves the task failed with the triage's words on the card, and costs no attempt", async () => {
  const f = fakeQuery({ sessionId: "s-code", fail: "Python was not found" });
  const s = setup(f.fn);
  const j = judge({ action: "needs_user", reason: "Python is not installed on this computer." });
  new RecoveryService({ repo: s.repo, bus: s.bus, runner: s.runner, queryFn: j.fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => /Needs you: Python is not installed/.test(s.repo.getTask(task.id)!.note ?? ""));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed");
    assert.equal(t.recovery?.attempts, 0);
    assert.equal(f.calls.length, 1);
  } finally {
    await s.cleanup();
  }
});

test("a task stopped by the person, or switched off in Settings, is never recovered", async () => {
  const f = fakeQuery({ sessionId: "s-code", fail: "Error: spawn EBUSY" });
  const s = setup(f.fn);
  const j = judge({ action: "retry_same", reason: "x" });
  const recovery = new RecoveryService({ repo: s.repo, bus: s.bus, runner: s.runner, queryFn: j.fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.repo.updateTask(task.id, { status: "failed", error: "stopped by user" });
    assert.equal(await recovery.consider(task.id), null);
    s.repo.updateTask(task.id, { error: "Error: spawn EBUSY" });
    s.repo.updateSettings({ autoRecover: false } as never);
    assert.equal(await recovery.consider(task.id), null);
    assert.equal(j.prompts.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("eventLines keeps the tool calls, the failed results and what the stage said, newest last", () => {
  const ev = (type: string, payload: unknown, id: number) => ({ id, run_id: "r", ts: "t", type, payload });
  const lines = eventLines([
    ev("assistant", { message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python x.py" } }, { type: "text", text: "Running the export." }] } }, 1),
    ev("user", { message: { content: [{ type: "tool_result", is_error: true, content: "Python was not found" }] } }, 2),
    ev("user", { message: { content: [{ type: "tool_result", content: "ok" }] } }, 3),
  ]);
  assert.deepEqual(lines, ['tool Bash {"command":"python x.py"}', "said: Running the export.", "result: Python was not found"]);
});
