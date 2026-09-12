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

const TWO_STAGE: Stage[] = [
  { stage: "plan", model: "m", effort: "low" },
  { stage: "code", model: "m", effort: "low" },
];

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** What the CLI actually sends, captured from a real call: the numbers are inside unifiedWindows. */
const rateLimitEvent = (fiveHour: number, status: "allowed" | "rejected", resetsAt: number) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status,
    resetsAt,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt },
      seven_day: { utilization: 0.13, resetsAt: resetsAt + 5 * 86_400 },
    },
  },
});

function setup(queryFn: QueryFn) {
  const dir = mkdtempSync(join(tmpdir(), "kresume-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  return { repo, bus, project, runner: new TaskRunner({ repo, bus, queryFn }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("both windows are recorded with their percentages — the numbers live in unifiedWindows", () => {
  const s = setup(() => (async function* () {})());
  try {
    const resets = Math.floor(Date.now() / 1000) + 3600;
    s.runner.recordRateLimit(rateLimitEvent(0.33, "allowed", resets) as never);
    const byType = new Map(s.repo.usageLimits().map((l) => [l.type, l]));
    assert.equal(byType.get("five_hour")?.utilization, 0.33, "the five-hour window has its percentage, not null");
    assert.equal(byType.get("seven_day")?.utilization, 0.13, "and the weekly window is recorded at all");
    assert.equal(byType.get("five_hour")?.resets_at, resets);
  } finally {
    s.cleanup();
  }
});

test("a run stopped by the usage limit pauses instead of failing, with a resume time from the window", async () => {
  const resets = Math.floor(Date.now() / 1000) + 2 * 3600;
  let calls = 0;
  const q: QueryFn = () =>
    (async function* () {
      calls++;
      if (calls === 1) {
        yield { type: "result", subtype: "success", is_error: false, result: "the plan", total_cost_usd: 0.01, session_id: "s-plan", modelUsage: {} } as never;
        return;
      }
      // The code stage runs into the wall.
      yield { type: "system", subtype: "init", session_id: "s-code" } as never;
      yield rateLimitEvent(1, "rejected", resets) as never;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Claude usage limit reached"], total_cost_usd: 0, session_id: "s-code", modelUsage: {} } as never;
    })();
  const s = setup(q);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "long job", mode: "supervised", pipeline: TWO_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.error, null, "a limit is not a failure");
    assert.match(t.note ?? "", /Paused by your Claude usage limit/);
    const at = Date.parse(t.resume_at!);
    assert.ok(at >= resets * 1000 && at <= resets * 1000 + 5 * 60_000, "it resumes just after the window resets, not before");
  } finally {
    s.cleanup();
  }
});

test("when the window reopens the task resumes from the stage it was on, in the same session", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const prompts: { stage: string; resume?: string }[] = [];
  let calls = 0;
  const q: QueryFn = (params) =>
    (async function* () {
      calls++;
      let text = "";
      for await (const m of params.prompt) text += typeof m.message.content === "string" ? m.message.content : "";
      prompts.push({ stage: /# Stage: (\w+)/.exec(text)?.[1] ?? "?", resume: params.options.resume as string | undefined });
      if (calls === 1) {
        yield { type: "result", subtype: "success", is_error: false, result: "the plan", total_cost_usd: 0.01, session_id: "s-plan", modelUsage: {} } as never;
      } else if (calls === 2) {
        yield { type: "system", subtype: "init", session_id: "s-code" } as never;
        yield rateLimitEvent(1, "rejected", resets) as never;
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["usage limit reached"], total_cost_usd: 0, session_id: "s-code", modelUsage: {} } as never;
      } else {
        yield { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01, session_id: "s-code", modelUsage: {} } as never;
      }
    })();
  const s = setup(q);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "long job", mode: "supervised", pipeline: TWO_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");

    // Nothing happens before the reset…
    assert.deepEqual(s.runner.resumeDue(Date.now()), [], "not due yet");
    // …and as soon as it has passed, the task continues by itself.
    const resumed = s.runner.resumeDue(resets * 1000 + 10 * 60_000);
    assert.deepEqual(resumed, [task.id]);
    await until(() => s.repo.getTask(task.id)!.status === "review");

    assert.deepEqual(prompts.map((p) => p.stage), ["plan", "code", "code"], "the finished plan stage is not redone");
    assert.equal(prompts[2].resume, "s-code", "the code stage resumes its own session rather than starting over");
    assert.ok(!s.repo.usageLimits().some((l) => l.status === "rejected"), "the stale 'limit reached' is cleared once it has reset");
  } finally {
    s.cleanup();
  }
});

test("an ordinary failure still fails, and auto-resume can be switched off", async () => {
  const q: QueryFn = () =>
    (async function* () {
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["TypeError: cannot read x of undefined"], total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const s = setup(q);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "bug", mode: "supervised", pipeline: [TWO_STAGE[1]] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    assert.match(s.repo.getTask(task.id)!.error ?? "", /TypeError/, "a real error is never disguised as a pause");
  } finally {
    s.cleanup();
  }

  const resets = Math.floor(Date.now() / 1000) + 3600;
  const limited: QueryFn = () =>
    (async function* () {
      yield rateLimitEvent(1, "rejected", resets) as never;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["usage limit reached"], total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const s2 = setup(limited);
  try {
    s2.repo.updateSettings({ autoResume: false } as never);
    const task = s2.repo.createTask({ project_id: s2.project.id, title: "x", mode: "supervised", pipeline: [TWO_STAGE[1]] });
    s2.runner.queueTask(task.id);
    await until(() => s2.repo.getTask(task.id)!.status === "failed");
    assert.equal(s2.repo.getTask(task.id)!.resume_at, null, "with auto-resume off it fails and waits for Retry, as before");
  } finally {
    s2.cleanup();
  }
});

test("a paused task survives a restart: recover() resumes anything already due", async () => {
  const q: QueryFn = () =>
    (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const s = setup(q);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [TWO_STAGE[1]] });
    // As if the server was off when the window reset.
    s.repo.updateTask(task.id, { status: "paused", resume_at: new Date(Date.now() - 60_000).toISOString() });
    s.runner.recover();
    await until(() => s.repo.getTask(task.id)!.status === "review");
  } finally {
    s.cleanup();
  }
});
