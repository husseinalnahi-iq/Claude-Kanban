import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, PolicyError, verdictOf, type QueryFn } from "../src/engine/runner.ts";
import { boardHandlers } from "../src/engine/boardMcp.ts";
import type { Stage, WsMessage } from "../src/types.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }];

type Call = { prompt: string; options: Record<string, any> };

/** Fake SDK: records calls, optionally asks permission for a Write, then returns a result. */
function fakeQuery(opts: { sessionId?: string; fail?: boolean; askWrite?: boolean; result?: string } = {}) {
  const calls: Call[] = [];
  const decisions: any[] = [];
  const fn: QueryFn = (params) => {
    return (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      calls.push({ prompt, options: params.options as Record<string, any> });
      const session_id = opts.sessionId ?? "s1";
      yield { type: "system", subtype: "init", session_id } as any;
      if (opts.askWrite) {
        const d = await params.options.canUseTool!("Write", { file_path: "x.txt", content: "hi" }, {
          signal: new AbortController().signal, toolUseID: "tu1", title: "Claude wants to write x.txt",
        } as any);
        decisions.push(d);
      }
      yield { type: "assistant", session_id, message: { content: [{ type: "text", text: "working" }] } } as any;
      if (opts.fail) {
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], total_cost_usd: 0.002, session_id, modelUsage: {} } as any;
        throw new Error("Claude Code process exited with code 1");
      }
      yield {
        type: "result", subtype: "success", is_error: false, result: opts.result ?? "DONE", total_cost_usd: 0.01, session_id,
        modelUsage: { m: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      } as any;
    })();
  };
  return { fn, calls, decisions };
}

function setup(queryFn: QueryFn, policy: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "krun-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const seen: WsMessage[] = [];
  bus.subscribe((m) => seen.push(m));
  const project = repo.createProject({
    name: "scratch", path: dir,
    policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3, ...policy } as any,
  });
  const runner = new TaskRunner({ repo, bus, queryFn });
  return { dir, repo, bus, seen, project, runner, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("supervised one-stage run records session, cost, events and ends in review", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "Say hi", spec_md: "say hi", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.status, "success");
    assert.equal(run.session_id, "s1");
    assert.equal(run.cost_usd, 0.01);
    assert.equal(run.input_tokens, 105);
    assert.equal(run.output_tokens, 20);
    assert.equal(run.result_md, "DONE");
    const events = s.repo.eventsAfter(run.id);
    assert.deepEqual(events.map((e) => e.type), ["user:prompt", "system:init", "assistant", "result:success"]);
    assert.match((events[0].payload as { text: string }).text, /# Stage: code/, "the prompt we sent is stored for the transcript");
    assert.equal(f.calls[0].options.permissionMode, "default");
    assert.equal(f.calls[0].options.cwd, s.dir);
    assert.equal(f.calls[0].options.model, "claude-haiku-4-5-20251001");
    assert.ok(f.calls[0].options.mcpServers.board, "board MCP attached");
    assert.match(f.calls[0].prompt, /# Stage: code/);
    assert.ok(s.seen.some((m) => m.type === "run.finished"));
  } finally {
    s.cleanup();
  }
});

test("autonomous task in a project that forbids it is refused with a clear error", () => {
  const s = setup(fakeQuery().fn, { autonomous: "forbidden", worktrees: "forbidden" });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "autonomous", pipeline: ONE_STAGE });
    assert.throws(() => s.runner.queueTask(task.id), (e: unknown) => e instanceof PolicyError && /forbids autonomous/.test((e as Error).message));
    assert.equal(s.repo.getTask(task.id)!.status, "backlog");
  } finally {
    s.cleanup();
  }
});

test("supervised approval gate: deny flows back to the SDK and status returns", async () => {
  const f = fakeQuery({ askWrite: true });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "Write", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    assert.equal(s.repo.getTask(task.id)!.status, "approval");
    const [a] = s.repo.pendingApprovals(task.id);
    assert.equal(a.tool_name, "Write");
    assert.equal(a.title, "Claude wants to write x.txt");
    s.runner.decideApproval(a.id, "deny", "not now");
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(f.decisions[0].behavior, "deny");
    assert.match(f.decisions[0].message, /not now/);
    assert.equal(s.repo.getApproval(a.id)!.decision, "deny");
  } finally {
    s.cleanup();
  }
});

test("failure marks task failed; retry resumes the failed stage's session", async () => {
  const f1 = fakeQuery({ fail: true, sessionId: "s-fail" });
  const f2 = fakeQuery({ sessionId: "s-fail" });
  let n = 0;
  const s = setup((p) => (n++ === 0 ? f1.fn(p) : f2.fn(p)));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "Flaky", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    const failedRun = s.repo.latestRun(task.id)!;
    assert.equal(failedRun.status, "failed");
    assert.match(failedRun.error ?? "", /boom/);
    assert.equal(failedRun.cost_usd, 0.002);

    s.runner.retryTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(f2.calls[0].options.resume, "s-fail");
    assert.equal(s.repo.runsForTask(task.id).length, 2);
  } finally {
    s.cleanup();
  }
});

test("recover() fails interrupted runs and their tasks", () => {
  const s = setup(fakeQuery().fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: ONE_STAGE });
    s.repo.updateTask(task.id, { status: "running" });
    const run = s.repo.createRun({ task_id: task.id, stage: "code", stage_index: 0, model: "m", effort: "low" });
    s.runner.recover();
    assert.equal(s.repo.getRun(run.id)!.status, "failed");
    assert.equal(s.repo.getRun(run.id)!.error, "interrupted");
    assert.equal(s.repo.getTask(task.id)!.status, "failed");
  } finally {
    s.cleanup();
  }
});

test("a review that asks for changes fails the task instead of passing it to Approve", async () => {
  const f = fakeQuery({ result: "Found a bug in the retry path.\n\nVERDICT: CHANGES_NEEDED" });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({
      project_id: s.project.id, title: "x", mode: "supervised",
      pipeline: [{ stage: "review", model: "m", effort: "low" }],
    });
    s.runner.queueTask(task.id);
    // "review" is also the status while the review stage runs, so wait for the pipeline itself to end.
    await until(() => ["failed", "review"].includes(s.repo.getTask(task.id)!.status) && !s.runner.isBusy(task.id));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /Review asked for changes/);
    assert.equal(s.repo.latestRun(task.id)!.status, "success", "the run itself succeeded");
  } finally {
    s.cleanup();
  }
});

test("verdictOf reads the line in the shapes models actually write", () => {
  assert.equal(verdictOf("VERDICT: APPROVE"), "APPROVE");
  assert.equal(verdictOf("blah\n**VERDICT:** CHANGES_NEEDED\nreasons"), "CHANGES_NEEDED");
  assert.equal(verdictOf("verdict: approve"), "APPROVE");
  assert.equal(verdictOf("no verdict here"), null);
  assert.equal(verdictOf(null), null);
});

test("a failed chat leaves the completed stage's run intact", async () => {
  const ok = fakeQuery({ sessionId: "s1" });
  const bad = fakeQuery({ fail: true, sessionId: "s1" });
  let n = 0;
  const s = setup((p) => (n++ === 0 ? ok.fn(p) : bad.fn(p)));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    s.runner.chat(task.id, "one more thing");
    await until(() => !s.runner.isBusy(task.id) && s.repo.getTask(task.id)!.status === "failed");
    const run = s.repo.latestRun(task.id)!;
    assert.equal(run.status, "success", "stage run keeps its successful status");
    assert.equal(run.result_md, "DONE", "and its result");
    assert.match(s.repo.getTask(task.id)!.error ?? "", /boom/);
  } finally {
    s.cleanup();
  }
});

test("a task is not done until the project's verify command passes", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    // A verify command that fails, then succeeds once a marker file exists.
    const marker = join(s.dir, "fixed.txt"); // the verify command runs with cwd = the project folder
    s.repo.updateProject(s.project.id, {
      env: { worktreeInclude: [], setupCommand: null, labels: [], onboarding: null, verifyCommand: `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"` },
    });
    const task = s.repo.createTask({ project_id: s.project.id, title: "needs verifying", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    assert.match(s.repo.getTask(task.id)!.error ?? "", /Verification failed/);

    // The failure output is handed back to the next attempt.
    writeFileSync(marker, "fixed");
    s.runner.retryTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.match(f.calls.at(-1)!.prompt, /last attempt failed verification/i);
    assert.ok(f.calls.at(-1)!.options.hooks.Stop, "the code stage runs behind a Stop hook gate");
  } finally {
    s.cleanup();
  }
});

test("project memory is capped, de-duplicated and injected into later prompts", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    assert.equal(s.repo.addNote({ project_id: s.project.id, text: "short" }), null, "trivial notes are refused");
    s.repo.addNote({ project_id: s.project.id, text: "Use pnpm, not npm, in this repo." });
    s.repo.addNote({ project_id: s.project.id, text: "use   PNPM, not npm, in this repo." });
    assert.equal(s.repo.notes(s.project.id).length, 1, "same note twice stays one line");
    const long = s.repo.addNote({ project_id: s.project.id, text: "x".repeat(1000) })!;
    assert.ok(long.text.length <= 280);
    for (let i = 0; i < 70; i++) s.repo.addNote({ project_id: s.project.id, text: `Convention number ${i} for this project.` });
    assert.ok(s.repo.notes(s.project.id).length <= 60, "memory cannot grow without bound");

    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.match(f.calls[0].prompt, /## Decisions from earlier tasks/);
  } finally {
    s.cleanup();
  }
});

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/** Fake git module: every call succeeds; addWorktree / mergeTask can be held open. */
function fakeGit(holds: { add?: Promise<void>; merge?: Promise<void> } = {}, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const git = {
    isGitRepo: async () => true,
    currentBranch: async () => "main",
    isDirty: async () => false,
    aheadBehind: async () => ({ ahead: 1, behind: 0 }),
    updateFromBase: async () => (calls.push("update"), { ok: true, pulled: 0, conflicts: [] }),
    addWorktree: async (_p: string, id: string) => {
      calls.push("add");
      await holds.add;
      return { path: _p, branch: `kanban/${id}`, baseSha: "a".repeat(40) };
    },
    commitAll: async () => (calls.push("commit"), false),
    mergeTask: async () => {
      calls.push("merge");
      await holds.merge;
    },
    removeWorktree: async () => void calls.push("remove"),
    diffTask: async () => [],
    ...over,
  };
  return { git: git as any, calls };
}

test("stop during worktree setup is honoured (no 409, no stage runs)", async () => {
  const f = fakeQuery();
  const hold = gate();
  const g = fakeGit({ add: hold.p });
  const s = setup(f.fn);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn, git: g.git });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: ONE_STAGE });
    runner.queueTask(task.id);
    await until(() => g.calls.includes("add"));
    runner.stopTask(task.id); // between queue start and the first query
    hold.open();
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    assert.equal(s.repo.getTask(task.id)!.error, "stopped by user");
    assert.equal(f.calls.length, 0, "no stage started after stop");
  } finally {
    s.cleanup();
  }
});

test("approve holds the task busy while git works; double approve is refused", async () => {
  const hold = gate();
  const g = fakeGit({ merge: hold.p });
  const s = setup(fakeQuery().fn);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: g.git });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: ONE_STAGE });
    s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, base_sha: "a".repeat(40) });
    const approving = runner.approveTask(task.id);
    await until(() => g.calls.includes("merge"));
    assert.throws(() => runner.queueTask(task.id), /busy|mid-action/);
    await assert.rejects(runner.approveTask(task.id), /busy/);
    hold.open();
    const done = await approving;
    assert.equal(done.status, "done");
    assert.deepEqual(g.calls.filter((c) => c === "merge"), ["merge"]);
  } finally {
    s.cleanup();
  }
});

test("chat that fixes a failed first stage does not jump to review", async () => {
  const f1 = fakeQuery({ fail: true, sessionId: "s-plan" });
  const f2 = fakeQuery({ sessionId: "s-plan" });
  let n = 0;
  const s = setup((p) => (n++ === 0 ? f1.fn(p) : f2.fn(p)));
  try {
    const two: Stage[] = [{ stage: "plan", model: "m", effort: "low" }, { stage: "code", model: "m", effort: "low" }];
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: two });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    s.runner.chat(task.id, "try again please");
    await until(() => !s.runner.isBusy(task.id) && s.repo.latestRun(task.id)!.status === "success");
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /incomplete.*#2/);
    assert.equal(f2.calls[0].options.resume, "s-plan");
  } finally {
    s.cleanup();
  }
});

test("supervised runs force approval for writes via a PreToolUse ask hook; questions reach you", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const opts = f.calls[0].options;
    assert.ok(!opts.disallowedTools.includes("AskUserQuestion"), "Claude may ask you a question");
    const hook = opts.hooks.PreToolUse[0].hooks[0];
    const ask = await hook({ tool_name: "Write" }, "tu", { signal: new AbortController().signal });
    assert.equal(ask.hookSpecificOutput.permissionDecision, "ask");
    assert.deepEqual(await hook({ tool_name: "Read" }, "tu", { signal: new AbortController().signal }), {});
    assert.deepEqual(await hook({ tool_name: "mcp__board__board_set_summary" }, "tu", { signal: new AbortController().signal }), {});
  } finally {
    s.cleanup();
  }
});

test("board tools: subtasks inherit parent, messages default to the parent, summary updates the card", () => {
  const s = setup(fakeQuery().fn, { autonomous: "forbidden" });
  try {
    const parent = s.repo.createTask({ project_id: s.project.id, title: "Big", spec_md: "big spec", mode: "supervised", pipeline: ONE_STAGE });
    const h = boardHandlers(s.repo, s.bus, { taskId: parent.id, runId: "r_x" });
    h.createSubtasks({ subtasks: [{ title: "A", spec_md: "a", mode: "autonomous" }, { title: "B", spec_md: "b" }] });
    const kids = s.repo.children(parent.id);
    assert.deepEqual(kids.map((k) => [k.title, k.status, k.mode]), [["A", "backlog", "supervised"], ["B", "backlog", "supervised"]]);
    assert.deepEqual(kids[0].pipeline, ONE_STAGE);

    const hk = boardHandlers(s.repo, s.bus, { taskId: kids[0].id, runId: "r_y" });
    hk.postMessage({ body: "A is done" });
    assert.deepEqual(s.repo.inboundMessages(parent.id).map((m) => m.body), ["A is done"]);
    const sib = JSON.parse(hk.listSiblings().content[0].text);
    assert.equal(sib.parent.spec_md, "big spec");
    assert.deepEqual(sib.siblings.map((x: any) => x.title), ["B"]);
    hk.setSummary({ text: "halfway" });
    assert.equal(s.repo.getTask(kids[0].id)!.summary, "halfway");
  } finally {
    s.cleanup();
  }
});

test("landing refuses to touch a dirty checkout, or the wrong branch, and never merges after a conflict", async () => {
  // 1. Uncommitted work in the project folder: merging would entangle it in the merge commit.
  {
    const g = fakeGit({}, { isDirty: async () => true });
    const s = setup(fakeQuery().fn);
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: g.git });
    try {
      const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: ONE_STAGE });
      s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, base_sha: "a".repeat(40) });
      await assert.rejects(runner.approveTask(task.id), /uncommitted changes/);
      assert.equal(g.calls.includes("merge"), false, "nothing was merged");
      assert.equal(s.repo.getTask(task.id)!.status, "review", "the task is untouched");
    } finally {
      s.cleanup();
    }
  }

  // 2. The project lands on "main" but the checkout is on something else.
  {
    const g = fakeGit({}, { currentBranch: async () => "some-other-branch" });
    const s = setup(fakeQuery().fn);
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: g.git });
    try {
      s.repo.updateProject(s.project.id, { merge: { ...s.project.merge, baseBranch: "main" } });
      const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: ONE_STAGE });
      s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, base_sha: "a".repeat(40) });
      await assert.rejects(runner.approveTask(task.id), /lands work on "main".*some-other-branch/s);
      assert.equal(g.calls.includes("merge"), false);
    } finally {
      s.cleanup();
    }
  }

  // 3. The base conflicts with the task: report it, merge nothing, leave the worktree alone.
  {
    const g = fakeGit({}, { updateFromBase: async () => ({ ok: false, pulled: 0, conflicts: ["src/app.ts"] }) });
    const s = setup(fakeQuery().fn);
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: g.git });
    try {
      const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: ONE_STAGE });
      s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, worktree_path: s.dir, base_sha: "a".repeat(40) });
      await assert.rejects(runner.approveTask(task.id), /src\/app\.ts/);
      assert.equal(g.calls.includes("merge"), false, "a conflict must never fall through to a merge");
      assert.equal(g.calls.includes("remove"), false, "and the worktree holding the work is kept");
    } finally {
      s.cleanup();
    }
  }
});
