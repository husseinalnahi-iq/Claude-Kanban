import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setup, until, type Call } from "./helpers.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { addWorktree, commitAll, headSha } from "../src/git/worktree.ts";
import type { Stage, Task } from "../src/types.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }];

const read = (...p: string[]) => readFileSync(join(...p), "utf8").split("\r\n").join("\n");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const BOTH = "import base\nimport tax\nimport discount\n\nrun()\n";
const OURS = "import base\nimport tax\n\nrun()\n";

/**
 * A fake Claude that acts: a resolution prompt gets `resolve(attempt)` written into the conflicted
 * file (null leaves the markers), a review prompt gets `review(n)` as its answer.
 */
function actor(o: { resolve: (attempt: number) => string | null; review?: (n: number) => string }) {
  const calls: (Call & { cwd: string })[] = [];
  let resolves = 0;
  let reviews = 0;
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const cwd = String(params.options.cwd);
      calls.push({ prompt, options: params.options as Record<string, any>, cwd });
      yield { type: "system", subtype: "init", session_id: "s1", model: params.options.model } as any;
      let text = "DONE";
      if (prompt.includes("VERDICT: BOTH KEPT")) {
        text = o.review?.(++reviews) ?? "Both imports are there.\nVERDICT: BOTH KEPT";
      } else if (prompt.includes("The merge is already in progress")) {
        const body = o.resolve(++resolves);
        if (body !== null) writeFileSync(join(cwd, "app.ts"), body);
        text = "app.ts: kept import tax from this task and import discount from the other side.";
      }
      yield {
        type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "s1",
        modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      } as any;
    })();
  return { fn, calls, resolverCalls: () => calls.filter((c) => c.prompt.includes("The merge is already in progress")), reviewCalls: () => calls.filter((c) => c.prompt.includes("VERDICT: BOTH KEPT")) };
}

/**
 * A real repo as the project, one task in Review whose branch adds `import tax`, and another task that
 * has meanwhile landed `import discount` on the same line of main — plus a change git merges by itself.
 */
async function scene(fn: QueryFn, merge: Record<string, unknown> = {}) {
  const s = setup(fn);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"], ["config", "core.autocrlf", "false"]]) git(s.dir, ...args);
  writeFileSync(join(s.dir, "app.ts"), "import base\n\nrun()\n");
  writeFileSync(join(s.dir, "notes.txt"), "one\n");
  git(s.dir, "add", "-A");
  git(s.dir, "commit", "-q", "-m", "init");
  s.repo.updateProject(s.project.id, { merge: { ...s.project.merge, onConflict: "claude", ...merge } });

  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fn });
  const other = s.repo.createTask({ project_id: s.project.id, title: "Add a discount", mode: "autonomous", pipeline: ONE_STAGE });
  s.repo.updateTask(other.id, { status: "done", summary: "Invoices take a discount, imported in app.ts." });

  const task = s.repo.createTask({ project_id: s.project.id, title: "Add tax", mode: "autonomous", pipeline: ONE_STAGE });
  const wt = await addWorktree(s.dir, task.id);
  writeFileSync(join(wt.path, "app.ts"), OURS);
  await commitAll(wt.path, "kanban: Add tax");
  s.repo.updateTask(task.id, { status: "review", branch: wt.branch, worktree_path: wt.path, base_sha: wt.baseSha });
  const run = s.repo.createRun({ task_id: task.id, stage: "code", stage_index: 0, model: "claude-haiku-4-5-20251001", effort: "low" });
  s.repo.updateRun(run.id, { status: "success", session_id: "s1", result_md: "Added tax." });

  writeFileSync(join(s.dir, "app.ts"), "import base\nimport discount\n\nrun()\n");
  writeFileSync(join(s.dir, "notes.txt"), "the discount's note\n");
  git(s.dir, "add", "-A");
  git(s.dir, "commit", "-q", "-m", `Merge kanban/${other.id}: Add a discount`);
  const pre = (await headSha(wt.path))!;
  return { ...s, runner, task, wt, pre, get: (): Task => s.repo.getTask(task.id)! };
}

const settled = (t: Task) => !!t.resolution && ["resolved", "failed"].includes(t.resolution.state) && t.status !== "running";

test("Approve on a conflicting task: Claude combines both sides, every check passes, and it lands by itself", async () => {
  const a = actor({ resolve: () => BOTH });
  const s = await scene(a.fn);
  try {
    const t = await s.runner.approveTask(s.task.id);
    assert.equal(t.status, "running", "Approve hands the conflict to Claude instead of failing");
    assert.equal(t.resolution?.state, "resolving");
    await until(() => s.get().status === "done");

    assert.equal(read(s.dir, "app.ts"), BOTH, "both tasks' lines are on main");
    assert.equal(read(s.dir, "notes.txt"), "the discount's note\n", "and git's own merge of the rest stands");
    assert.equal(git(s.dir, "status", "--porcelain"), "", "the project's checkout is clean");

    const r = s.get().resolution!;
    assert.equal(r.state, "resolved");
    assert.deepEqual(r.conflicts, ["app.ts"]);
    assert.deepEqual(r.others, ["Add a discount"]);
    assert.equal(r.verdict, "kept");
    assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks));
    assert.deepEqual(r.checks.map((c) => c.id), ["history", "markers", "files", "lines", "review"]);
    assert.match(r.report ?? "", /kept import tax/);

    const prompt = a.resolverCalls()[0].prompt;
    assert.match(prompt, /Add a discount\n  Invoices take a discount/, "the resolver is told what the other side was for");
    assert.match(prompt, /Do not commit, abort, rebase or reset/);
    const review = a.reviewCalls()[0];
    assert.match(review.prompt, /\+import discount/, "the reviewer sees the other side's change");
    assert.ok(review.options.disallowedTools.includes("Edit"), "the reviewer changes nothing");
    assert.equal(s.repo.getRun(s.repo.latestRun(s.task.id)!.id)!.result_md, "Added tax.", "the stage's own result is kept");
  } finally {
    await s.cleanup();
  }
});

test("a resolution that drops a side is set aside, and the second try is told exactly what was lost", async () => {
  const a = actor({ resolve: (n) => (n === 1 ? OURS : BOTH), review: (n) => (n === 1 ? "import discount is gone.\nVERDICT: LOST" : "VERDICT: BOTH KEPT") });
  const s = await scene(a.fn);
  try {
    await s.runner.approveTask(s.task.id);
    await until(() => s.get().status === "done");
    assert.equal(read(s.dir, "app.ts"), BOTH);
    assert.equal(s.get().resolution!.attempt, 2);
    const second = a.resolverCalls()[1].prompt;
    assert.match(second, /set aside/);
    assert.match(second, /import discount/, "the lost line is named");
    assert.match(second, /The reviewer said: import discount is gone/);
  } finally {
    await s.cleanup();
  }
});

test("when no try passes, nothing lands, the branch is back where it was, and the card says why", async () => {
  const a = actor({ resolve: () => null }); // leaves the conflict markers both times
  const s = await scene(a.fn);
  try {
    const mainBefore = git(s.dir, "rev-parse", "HEAD");
    await s.runner.approveTask(s.task.id);
    await until(() => settled(s.get()));
    const t = s.get();
    assert.equal(t.status, "review");
    assert.equal(t.resolution!.state, "failed");
    assert.equal(t.resolution!.attempt, 2);
    assert.match(t.resolution!.error ?? "", /Conflict markers/);
    assert.match(t.note ?? "", /Nothing was merged/);
    assert.equal(git(s.dir, "rev-parse", "HEAD"), mainBefore, "main did not move");
    assert.equal(await headSha(s.wt.path), s.pre, "the task's branch is exactly where it was");
    assert.equal(read(s.wt.path, "app.ts"), OURS, "with the task's own work intact");
    assert.equal(git(s.wt.path, "status", "--porcelain"), "");
    assert.equal(a.reviewCalls().length, 0, "a resolution that fails the board's checks never costs a review");
  } finally {
    await s.cleanup();
  }
});

test("with automatic landing off, a resolved conflict waits in Review for Approve", async () => {
  const a = actor({ resolve: () => BOTH });
  const s = await scene(a.fn, { autoLandResolved: false });
  try {
    await s.runner.approveTask(s.task.id);
    await until(() => settled(s.get()));
    assert.equal(s.get().status, "review");
    assert.equal(s.get().resolution!.state, "resolved");
    assert.match(s.get().note ?? "", /Approve to land it/);
    assert.notEqual(read(s.dir, "app.ts"), BOTH, "nothing landed yet");

    await s.runner.approveTask(s.task.id);
    assert.equal(s.get().status, "done");
    assert.equal(read(s.dir, "app.ts"), BOTH);
  } finally {
    await s.cleanup();
  }
});

test("a conflict the board foresees is shown on the card, and Fix now resolves it without landing", async () => {
  const a = actor({ resolve: () => BOTH });
  const s = await scene(a.fn);
  try {
    await s.runner.refreshConflictRisk(s.project.id);
    assert.deepEqual(s.get().conflict_risk?.files, ["app.ts"]);
    assert.equal(s.get().conflict_risk?.base, "main");

    await s.runner.resolveConflict(s.task.id);
    await until(() => settled(s.get()));
    const t = s.get();
    assert.equal(t.status, "review", "nobody approved it, so it waits");
    assert.equal(t.resolution!.land_after, false);
    assert.equal(t.conflict_risk, null);
    assert.equal(read(s.wt.path, "app.ts"), BOTH, "the task's branch now holds the combined code");
    assert.notEqual(read(s.dir, "app.ts"), BOTH, "main is untouched");

    await s.runner.approveTask(s.task.id);
    assert.equal(s.get().status, "done", "and it now lands without a conflict");
    assert.equal(read(s.dir, "app.ts"), BOTH);
  } finally {
    await s.cleanup();
  }
});

test("the project's verify command must pass on the combined code", async () => {
  const a = actor({ resolve: () => OURS, review: () => "VERDICT: BOTH KEPT" }); // a reviewer that misses it
  const s = await scene(a.fn);
  try {
    s.repo.updateProject(s.project.id, { env: { ...s.repo.getProject(s.project.id)!.env, verifyCommand: "git grep -q discount -- app.ts" } });
    await s.runner.approveTask(s.task.id);
    await until(() => settled(s.get()));
    const r = s.get().resolution!;
    assert.equal(r.state, "failed");
    assert.equal(r.checks.find((c) => c.id === "verify")?.ok, false);
    assert.equal(a.reviewCalls().length, 0, "verification failing stops before the review");
  } finally {
    await s.cleanup();
  }
});

test("the reviewer runs on the model the project names, or else the one that wrote the task", async () => {
  const a = actor({ resolve: () => BOTH });
  const s = await scene(a.fn, { resolveReviewer: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" } });
  try {
    await s.runner.approveTask(s.task.id);
    await until(() => s.get().status === "done");
    assert.equal(a.reviewCalls()[0].options.model, "claude-sonnet-5-5");
  } finally {
    await s.cleanup();
  }
  const b = actor({ resolve: () => BOTH });
  const s2 = await scene(b.fn);
  try {
    await s2.runner.approveTask(s2.task.id);
    await until(() => s2.get().status === "done");
    assert.equal(b.reviewCalls()[0].options.model, "claude-haiku-4-5-20251001");
  } finally {
    await s2.cleanup();
  }
});

test("Stop during a resolution sets it aside and leaves the branch as it was", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = actor({ resolve: () => BOTH });
  const slow: QueryFn = (params) =>
    (async function* () {
      await gate;
      yield* a.fn(params) as AsyncIterable<any>;
    })() as any;
  const s = await scene(slow);
  try {
    await s.runner.approveTask(s.task.id);
    await until(() => s.get().resolution?.attempt === 1);
    s.runner.stopTask(s.task.id);
    release();
    await until(() => settled(s.get()));
    assert.equal(s.get().resolution!.state, "failed");
    assert.match(s.get().resolution!.error ?? "", /Stopped by you/);
    assert.equal(await headSha(s.wt.path), s.pre);
    assert.equal(git(s.wt.path, "status", "--porcelain"), "");
  } finally {
    await s.cleanup();
  }
});

test("the reviewer's verdict is read from its last VERDICT line, and none at all is not a pass", async () => {
  const { parseReviewVerdict } = await import("../src/engine/conflictResolve.ts");
  assert.equal(parseReviewVerdict("All good.\nVERDICT: BOTH KEPT"), "kept");
  assert.equal(parseReviewVerdict("**VERDICT: LOST** — discount gone"), "lost");
  assert.equal(parseReviewVerdict("I first thought VERDICT: LOST, but no.\nVERDICT: BOTH KEPT"), "kept");
  assert.equal(parseReviewVerdict("Looks fine to me."), null);
  assert.equal(parseReviewVerdict(null), null);
});

test("lines a diff adds are read per file, and a deleted file adds none", async () => {
  const { addedLines } = await import("../src/git/worktree.ts");
  const patch = [
    "diff --git a/app.ts b/app.ts", "--- a/app.ts", "+++ b/app.ts", "@@ -1,0 +2 @@", "+import tax",
    "diff --git a/old.ts b/old.ts", "--- a/old.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone",
    "diff --git a/my file.md b/my file.md", "--- a/my file.md", "+++ b/my file.md", "@@ -0,0 +1,2 @@", "+one", "++plus",
  ].join("\n");
  assert.deepEqual([...addedLines(patch)], [["app.ts", ["import tax"]], ["my file.md", ["one", "+plus"]]]);
});

test("Stop while the result is being reviewed sets it aside: a resolution nobody finished checking never lands", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = actor({ resolve: () => BOTH });
  // The resolver answers at once; the reviewer waits until the test has pressed Stop.
  const slowReview: QueryFn = (params) =>
    (async function* () {
      const it = a.fn(params) as AsyncIterable<any>;
      for await (const m of it) {
        if (m.type === "result" && a.reviewCalls().length) await gate;
        yield m;
      }
    })() as any;
  const s = await scene(slowReview);
  try {
    const mainBefore = git(s.dir, "rev-parse", "HEAD");
    await s.runner.approveTask(s.task.id);
    await until(() => s.get().resolution?.state === "reviewing" && a.reviewCalls().length === 1);
    s.runner.stopTask(s.task.id);
    release();
    await until(() => settled(s.get()));
    assert.equal(s.get().resolution!.state, "failed");
    assert.match(s.get().resolution!.error ?? "", /Stopped by you/);
    assert.equal(git(s.dir, "rev-parse", "HEAD"), mainBefore, "nothing landed");
    assert.equal(await headSha(s.wt.path), s.pre, "and the branch is back where it was");
  } finally {
    await s.cleanup();
  }
});
