import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { questionResult } from "../src/engine/runner.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import type { Stage, WsMessage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const Q = {
  questions: [{
    question: "Which colour should the button be?",
    header: "Colour",
    multiSelect: false,
    options: [{ label: "Blue", description: "Matches the logo" }, { label: "Green", description: "Reads as go" }],
  }],
};

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A session that asks one question, then finishes; records what the permission callback returned. */
function asking() {
  const results: any[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) void _;
      yield { type: "system", subtype: "init", session_id: "s1", model: "m" } as any;
      const r = await params.options.canUseTool!("AskUserQuestion", Q, { signal: params.options.abortController?.signal ?? new AbortController().signal, toolUseID: "tu", requestId: "rq" } as any);
      results.push(r);
      yield { type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as any;
    })();
  return { fn, results };
}

test("a question becomes a card, and your answer goes back in the tool's own answers field", async () => {
  for (const mode of ["supervised", "autonomous"] as const) {
    const q = asking();
    const s = setup(q.fn);
    try {
      // autonomous runs work in a git worktree, so the project must be a repository with a commit
      const git = (...a: string[]) => execFileSync("git", a, { cwd: s.dir });
      git("init", "-q", "-b", "main");
      writeFileSync(join(s.dir, "a.txt"), "a");
      git("add", "-A");
      git("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "init");
      const task = s.repo.createTask({ project_id: s.project.id, title: `ask ${mode}`, mode, pipeline: ONE });
      s.runner.queueTask(task.id);
      await until(() => s.repo.pendingApprovals(task.id).length === 1);
      const card = s.repo.pendingApprovals(task.id)[0];
      assert.equal(card.tool_name, "AskUserQuestion");
      assert.equal(s.repo.getTask(task.id)!.status, "approval", `${mode}: the card says it needs you`);
      assert.ok(s.seen.some((m: WsMessage) => m.type === "approval.requested"), "and it alerts like an approval");

      assert.throws(() => s.runner.decideApproval(card.id, "allow"), /needs an answer/);
      const answered = s.runner.answerQuestion(card.id, { "Which colour should the button be?": "Green" });
      assert.equal(answered.decision, "answered");
      assert.deepEqual(answered.answers, { "Which colour should the button be?": "Green" });
      await until(() => q.results.length === 1);
      assert.equal(q.results[0].behavior, "allow");
      assert.deepEqual(q.results[0].updatedInput.answers, { "Which colour should the button be?": "Green" });
      assert.deepEqual(q.results[0].updatedInput.questions, Q.questions, "the questions themselves are passed back unchanged");
    } finally {
      s.cleanup();
    }
  }
});

test("by default a question waits for you: no timer, still pending", async () => {
  const q = asking();
  const s = setup(q.fn);
  try {
    assert.equal(s.repo.getSettings().questionWaitMin, 0);
    const task = s.repo.createTask({ project_id: s.project.id, title: "waits", pipeline: ONE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(q.results.length, 0, "still waiting");
    s.runner.stopTask(task.id);
    await until(() => q.results.length === 1);
    assert.equal(q.results[0].behavior, "deny", "stopping the task expires the card");
    assert.equal(s.repo.approvalsForTask(task.id)[0].decision, "expired");
  } finally {
    s.cleanup();
  }
});

test("skipping a question, or no answer in time, tells Claude to decide and say so", () => {
  const skip = questionResult(Q, "deny", "you pick", undefined, 0) as { behavior: string; message: string };
  assert.equal(skip.behavior, "deny");
  assert.match(skip.message, /chose not to answer \(you pick\)/);
  assert.match(skip.message, /say which one/);
  const late = questionResult(Q, "expired", "no answer", undefined, 30) as { message: string };
  assert.match(late.message, /No answer after 30 minutes/);
  assert.equal(questionResult(Q, "answered", null, {}, 0).behavior, "deny", "an empty answer is no answer");
});

test("with a wait set, an unanswered question times out and the task carries on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const q = asking();
  const s = setup(q.fn);
  try {
    s.repo.updateSettings({ questionWaitMin: 5 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "late", pipeline: ONE });
    s.runner.queueTask(task.id);
    // mocked timers: advance in small steps so the pipeline's own awaits can run in between
    for (let i = 0; i < 400 && s.repo.pendingApprovals(task.id).length === 0; i++) {
      t.mock.timers.tick(10);
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(s.repo.pendingApprovals(task.id).length, 1);
    t.mock.timers.tick(5 * 60_000);
    for (let i = 0; i < 200 && !q.results.length; i++) await new Promise((r) => setImmediate(r));
    assert.equal(q.results[0].behavior, "deny");
    assert.match(q.results[0].message, /No answer after 5 minutes/);
    const row = s.repo.approvalsForTask(task.id)[0];
    assert.equal(row.decision, "expired");
    assert.match(row.note ?? "", /Claude decided/);
  } finally {
    t.mock.timers.reset();
    s.cleanup();
  }
});
