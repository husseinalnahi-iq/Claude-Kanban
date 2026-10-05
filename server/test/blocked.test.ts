import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_BLOCK_AFTER, verdictOf, type QueryFn } from "../src/engine/runner.ts";
import { boardHandlers } from "../src/engine/boardMcp.ts";
import { stoppedBy, supervisedFrom, type Stage } from "../src/types.ts";
import { setup, until, type Call } from "./helpers.ts";

const PLAN_CODE_REVIEW: Stage[] = [
  { stage: "plan", model: "claude-opus-5", effort: "high" },
  { stage: "code", model: "claude-opus-5", effort: "high" },
  { stage: "review", model: "claude-sonnet-5", effort: "medium" },
];

type Ctx = { repo: ReturnType<typeof setup>["repo"]; bus: ReturnType<typeof setup>["bus"]; dir: string };

/**
 * A fake session that can act like a real one: `act(index, ctx)` runs inside the session, so it can
 * call a board tool for the current run, or ask the permission gate, before the result arrives.
 */
function scripted(results: (index: number) => string, act?: (index: number, o: any, board: () => ReturnType<typeof boardHandlers>) => Promise<void>) {
  const calls: Call[] = [];
  const holder: { ctx?: Ctx; taskId?: string } = {};
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const index = calls.length;
      calls.push({ prompt, options: params.options as Record<string, any> });
      yield { type: "system", subtype: "init", session_id: `s${index}` } as any;
      const board = () => {
        const run = holder.ctx!.repo.latestRun(holder.taskId!)!;
        return boardHandlers(holder.ctx!.repo, holder.ctx!.bus, { taskId: holder.taskId!, runId: run.id });
      };
      await act?.(index, params.options, board);
      if (params.options.abortController?.signal.aborted) throw new Error("aborted");
      yield {
        type: "result", subtype: "success", is_error: false, result: results(index), total_cost_usd: 0.01, session_id: `s${index}`,
        modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      } as any;
    })();
  return { fn, calls, holder };
}

function gitInit(dir: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

test("a stage that reports itself blocked stops the pipeline: no success, no next stage, no Approve (D184)", async () => {
  const f = scripted(
    () => "Plan: blocked — the script is only in live BizApp.",
    async (i, _o, board) => {
      if (i === 0) board().reportBlocked({ reason: "The account filter lives only in live BizApp.", needs: "supervised", ask: "Run it supervised." });
    },
  );
  const s = setup(f.fn);
  f.holder.ctx = s;
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "Allow 40100", mode: "supervised", pipeline: PLAN_CODE_REVIEW });
    f.holder.taskId = task.id;
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    const t = s.repo.getTask(task.id)!;
    assert.equal(f.calls.length, 1, "the code stage never ran on a blocked plan");
    assert.equal(t.blocked?.needs, "supervised");
    assert.equal(t.blocked?.stage_index, 0);
    assert.equal(t.blocked?.ask, "Run it supervised.");
    assert.match(t.error ?? "", /^Blocked at stage #1 \(plan\): The account filter lives only in live BizApp\./);
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.status, "failed", "a blocked stage is not counted as done");
    assert.match(run.error ?? "", /^blocked:/);
    assert.equal(run.result_md, "Plan: blocked — the script is only in live BizApp.", "its report is kept");
    await assert.rejects(s.runner.approveTask(task.id), /Only tasks in review/);
  } finally {
    await s.cleanup();
  }
});

test("retrying a blocked task clears the block, starts at the blocked stage and says what stopped it", async () => {
  const f = scripted(
    (i) => (i === 0 ? "plan" : "done"),
    async (i, _o, board) => {
      if (i === 1) board().reportBlocked({ reason: "Needs the live BizApp token.", needs: "supervised" });
    },
  );
  const s = setup(f.fn);
  f.holder.ctx = s;
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE_REVIEW });
    f.holder.taskId = task.id;
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    assert.equal(s.repo.getTask(task.id)!.blocked?.stage_index, 1);

    s.runner.retryTask(task.id);
    assert.equal(s.repo.getTask(task.id)!.blocked, null, "queuing clears the block");
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(f.calls.length, 4, "plan once, code twice, review once");
    assert.match(f.calls[2].prompt, /# Stage: code/, "the retry starts at the blocked stage");
    assert.match(f.calls[2].prompt, /## What stopped the last attempt\nNeeds the live BizApp token\./);
    assert.doesNotMatch(f.calls[2].prompt, /It now runs supervised/, "it was supervised all along: nothing about its access changed");
    assert.doesNotMatch(f.calls[3].prompt, /What stopped the last attempt/, "only the rerun of that attempt is told");
  } finally {
    await s.cleanup();
  }
});

test("a review that ends VERDICT: BLOCKED blocks the task; the last verdict line is the one that counts", async () => {
  assert.equal(verdictOf("VERDICT: APPROVE\n…later…\nVERDICT: CHANGES_NEEDED — missing the how-to"), "CHANGES_NEEDED");
  assert.equal(verdictOf("**VERDICT:** BLOCKED — needs live access"), "BLOCKED");
  const f = scripted((i) => (i === 2 ? "Checklist …\nVERDICT: BLOCKED — the list lives in live BizApp, which this run cannot reach" : "ok"));
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE_REVIEW });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.blocked?.stage_index, 2);
    assert.equal(t.blocked?.needs, "input");
    assert.equal(t.blocked?.reason, "the list lives in live BizApp, which this run cannot reach");
  } finally {
    await s.cleanup();
  }
});

test("an autonomous stage that keeps hitting the sandbox is stopped and marked blocked by the board (D186)", async () => {
  const replies: string[] = [];
  const f = scripted(
    () => "should not matter",
    async (_i, o) => {
      for (let n = 0; n < AUTO_BLOCK_AFTER + 2 && !o.abortController.signal.aborted; n++) {
        const d = await o.canUseTool("Bash", { command: `type "C:\\elsewhere\\secret-${n}.json"` }, { signal: new AbortController().signal, toolUseID: `t${n}` });
        replies.push(d.message ?? "");
      }
    },
  );
  const s = setup(f.fn);
  f.holder.ctx = s;
  gitInit(s.dir);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "autonomous", pipeline: [PLAN_CODE_REVIEW[1]] });
    f.holder.taskId = task.id;
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed", 10_000);
    const t = s.repo.getTask(task.id)!;
    assert.equal(replies.length, AUTO_BLOCK_AFTER, "the run is aborted at the limit");
    assert.match(replies[0], /outside the worktree[\s\S]*board_report_blocked/);
    assert.match(replies[2], /refusal number 3/);
    assert.equal(t.blocked?.source, "board");
    assert.equal(t.blocked?.needs, "supervised");
    assert.match(t.blocked?.reason ?? "", new RegExp(`refused ${AUTO_BLOCK_AFTER} attempts`));
  } finally {
    await s.runner.discardTask(s.repo.listTasks({ project_id: s.project.id })[0].id).catch(() => undefined);
    await s.cleanup();
  }
});

test("autonomous reads are guarded by a hook too, since a read may never reach canUseTool (D187)", async () => {
  const f = scripted(() => "ok");
  const s = setup(f.fn);
  gitInit(s.dir);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "autonomous", pipeline: [PLAN_CODE_REVIEW[1]] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review", 10_000);
    const hook = f.calls[0].options.hooks.PreToolUse[0].hooks[0];
    const outside = await hook({ tool_name: "Read", tool_input: { file_path: join(s.dir, ".env") } });
    assert.equal(outside.hookSpecificOutput?.permissionDecision, "deny", "the main checkout is outside the worktree");
    const inside = await hook({ tool_name: "Read", tool_input: { file_path: "README.md" } });
    assert.deepEqual(inside, {});
  } finally {
    await s.runner.discardTask(s.repo.listTasks({ project_id: s.project.id })[0].id).catch(() => undefined);
    await s.cleanup();
  }
});

test("an autonomous run that needs a supervised run says so on the card and carries on to review (D382)", async () => {
  const f = scripted(
    (i) => (i === 0 ? "plan: 1. write the verifier 2. **(supervised run)** deploy it" : i === 1 ? "verifier written\n## Left for a supervised run\n1. deploy it" : "VERDICT: APPROVE"),
    async (i, _o, board) => {
      if (i === 0) board().reportBlocked({ reason: "Deploying needs live BizApp.", needs: "supervised", ask: "Switch to supervised for the deploy." });
    },
  );
  const s = setup(f.fn);
  f.holder.ctx = s;
  gitInit(s.dir);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "autonomous", pipeline: PLAN_CODE_REVIEW });
    f.holder.taskId = task.id;
    s.runner.queueTask(task.id);
    // "review" is also the review stage's own status: done is when the board lets go of the task.
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id), 10_000);
    const t = s.repo.getTask(task.id)!;
    assert.equal(f.calls.length, 3, "the code and review stages ran after the suggestion");
    assert.equal(t.blocked?.advisory, true);
    assert.equal(t.blocked?.stage_index, 0);
    assert.equal(t.blocked?.ask, "Switch to supervised for the deploy.");
    assert.equal(stoppedBy(t), null, "a suggestion is not a stop");
    assert.ok(s.repo.runsForTask(task.id).every((r) => r.status === "success"), "every stage counts as done");
    assert.match(f.calls[1].prompt, /## Left for a supervised run/, "the code stage is told to do the rest and list what is left");
    assert.match(f.calls[2].prompt, /are not defects of this run/, "review does not fail it for the steps left");

    const queued = await s.runner.escalateToSupervised(task.id);
    assert.equal(queued.mode, "supervised");
    await until(() => f.calls.length > 3, 10_000);
    assert.match(f.calls[3].prompt, /# Stage: code/, "the plan finished: the switch reruns the code stage, not the plan");
    assert.match(f.calls[3].prompt, /## What the last attempt left for a supervised run\nDeploying needs live BizApp\./);
    assert.match(f.calls[3].prompt, /It now runs supervised, in the main checkout/);
    await until(() => !s.runner.isBusy(task.id));
  } finally {
    await s.cleanup();
  }
});

test("a review that still blocks after a suggestion stops the task and asks for the supervised run", async () => {
  const f = scripted(
    (i) => (i === 2 ? "VERDICT: BLOCKED — nothing can be checked without the live system" : "ok"),
    async (i, _o, board) => {
      if (i === 0) board().reportBlocked({ reason: "The data is only in live BizApp.", needs: "supervised" });
    },
  );
  const s = setup(f.fn);
  f.holder.ctx = s;
  gitInit(s.dir);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "autonomous", pipeline: PLAN_CODE_REVIEW });
    f.holder.taskId = task.id;
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed", 10_000);
    const t = s.repo.getTask(task.id)!;
    assert.equal(stoppedBy(t)?.stage_index, 2);
    assert.equal(t.blocked?.needs, "supervised", "the way on is the supervised run it already suggested");
  } finally {
    await s.runner.discardTask(s.repo.listTasks({ project_id: s.project.id })[0].id).catch(() => undefined);
    await s.cleanup();
  }
});

test("a supervised rerun after a suggestion starts at the stage that changes things", () => {
  const p = PLAN_CODE_REVIEW;
  assert.equal(supervisedFrom(p, 0), 1, "from the plan: the code stage");
  assert.equal(supervisedFrom(p, 1), 1, "from the code stage: that stage");
  assert.equal(supervisedFrom(p, 2), 1, "from review: the code stage before it");
  assert.equal(supervisedFrom([p[0], p[2]], 1), 1, "no stage that writes: the one that suggested it");
});

test("Switch to supervised on a stopped task: drops the worktree, re-runs from the blocked stage in the main checkout (D185)", async () => {
  const f = scripted(
    (i) => (i === 0 ? "plan: find the live script" : "done"),
    async (i, o) => {
      // The board's own stop: a stage that kept trying to read the main checkout from its worktree.
      for (let n = 0; i === 1 && n < AUTO_BLOCK_AFTER && !o.abortController.signal.aborted; n++) {
        await o.canUseTool("Read", { file_path: join(f.holder.ctx!.dir, `secret-${n}.json`) }, { signal: new AbortController().signal, toolUseID: `t${n}` });
      }
    },
  );
  const s = setup(f.fn);
  f.holder.ctx = s;
  gitInit(s.dir);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "autonomous", pipeline: PLAN_CODE_REVIEW });
    f.holder.taskId = task.id;
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed", 10_000);
    assert.equal(stoppedBy(s.repo.getTask(task.id)!)?.stage_index, 1);
    const wt = s.repo.getTask(task.id)!.worktree_path!;
    assert.ok(existsSync(wt));

    const queued = await s.runner.escalateToSupervised(task.id);
    assert.equal(queued.mode, "supervised");
    assert.equal(queued.branch, null);
    assert.ok(!existsSync(wt), "the sandboxed work is discarded");
    await until(() => s.repo.getTask(task.id)!.status === "review", 10_000);
    assert.equal(f.calls[2].options.cwd, s.dir, "it now runs in the main checkout");
    assert.match(f.calls[2].prompt, /# Stage: code/, "from the blocked stage, not from the plan again");
    assert.match(f.calls[2].prompt, /## What stopped the last attempt/);
    assert.match(f.calls[2].prompt, /It now runs supervised, in the main checkout/);
    assert.match(f.calls[2].prompt, /plan: find the live script/, "the plan is handed on");
    await until(() => !s.runner.isBusy(task.id));
    await assert.rejects(s.runner.escalateToSupervised(task.id), /already supervised/);
  } finally {
    await s.cleanup();
  }
});

test("a Reject's reason reaches the next run, and Discard keeps it (D196)", async () => {
  const f = scripted(() => "done");
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [PLAN_CODE_REVIEW[1]] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    s.runner.rejectTask(task.id, "The how-to steps are missing.");
    const discarded = await s.runner.discardTask(task.id);
    assert.equal(discarded.note, "The how-to steps are missing. — work discarded", "discarding does not erase why it was rejected");

    s.runner.queueTask(task.id);
    assert.equal(s.repo.getTask(task.id)!.note, null, "the card's note clears on queue, as before");
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.match(f.calls[1].prompt, /## Why this was sent back\nA human rejected the previous attempt: The how-to steps are missing\./);
  } finally {
    await s.cleanup();
  }
});
