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
type FakeOpts = { sessionId?: string; fail?: boolean; askWrite?: boolean; result?: string };
function fakeQuery(base: FakeOpts & { byCall?: (index: number) => FakeOpts | undefined } = {}) {
  const calls: Call[] = [];
  const decisions: any[] = [];
  const fn: QueryFn = (params) => {
    return (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const opts = { ...base, ...(base.byCall?.(calls.length) ?? {}) };
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
    await s.cleanup();
  }
});

test("autonomous task in a project that forbids it is refused with a clear error", async () => {
  const s = setup(fakeQuery().fn, { autonomous: "forbidden", worktrees: "forbidden" });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "autonomous", pipeline: ONE_STAGE });
    assert.throws(() => s.runner.queueTask(task.id), (e: unknown) => e instanceof PolicyError && /forbids autonomous/.test((e as Error).message));
    assert.equal(s.repo.getTask(task.id)!.status, "backlog");
  } finally {
    await s.cleanup();
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
    await s.cleanup();
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
    await s.cleanup();
  }
});

// recover()'s carry-on after an ordinary restart (D411) is covered end-to-end in hardening.test.ts,
// on a real git repo; it is not repeated here, where a non-git temp dir trips the Windows cleanup flake.

test("a board restart closes every waiting card with a decided event, so no pop-up waits for ever", async () => {
  const s = setup(fakeQuery().fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "waiting", mode: "supervised", pipeline: ONE_STAGE });
    s.repo.updateTask(task.id, { status: "approval" });
    const run = s.repo.createRun({ task_id: task.id, stage: "code", stage_index: 0, model: "m", effort: "low" });
    const card = s.repo.createApproval({ run_id: run.id, task_id: task.id, tool_name: "Bash", input: { command: "ls" } });
    s.runner.recover();
    assert.equal(s.repo.getApproval(card.id)!.decision, "expired");
    const decided = s.seen.filter((m) => m.type === "approval.decided");
    assert.equal(decided.length, 1);
    assert.equal((decided[0] as any).approval.id, card.id);
    assert.equal((decided[0] as any).approval.task_title, "waiting");
  } finally {
    await s.cleanup();
  }
});

test("a review that asks for changes sends the work back to the code stage's own session with the findings, then reviews again (D410)", async () => {
  const f = fakeQuery({
    byCall: (i) => (i === 1 ? { result: "Found a bug in the retry path.\n\nVERDICT: CHANGES_NEEDED — the retry never backs off" } : i === 3 ? { result: "VERDICT: APPROVE" } : { result: "done" }),
  });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({
      project_id: s.project.id, title: "x", mode: "supervised",
      pipeline: [{ stage: "code", model: "m", effort: "low" }, { stage: "review", model: "m", effort: "low" }],
    });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id));
    const t = s.repo.getTask(task.id)!;
    assert.equal(f.calls.length, 4, "code, review, the fix, review again");
    assert.equal(f.calls[2].options.resume, "s1", "the fix runs in the code stage's own session");
    assert.match(f.calls[2].prompt, /## The review asked for changes \(fix 1\)/);
    assert.match(f.calls[2].prompt, /the retry never backs off/);
    assert.match(f.calls[3].prompt, /# Stage: review/);
    assert.equal(t.note, null, "the review is satisfied: nothing left to warn about");
    assert.equal(t.error, null);
    assert.equal(s.repo.runsForTask(task.id).filter((r) => r.role === "stage").length, 4);
  } finally {
    await s.cleanup();
  }
});

test("a review still unhappy after two fixes reaches Review with its findings on the card, not failed", async () => {
  const f = fakeQuery({
    byCall: (i) => (i % 2 === 1 ? { result: "VERDICT: CHANGES_NEEDED — still missing the how-to" } : { result: "done" }),
  });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({
      project_id: s.project.id, title: "x", mode: "supervised",
      pipeline: [{ stage: "code", model: "m", effort: "low" }, { stage: "review", model: "m", effort: "low" }],
    });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && !s.runner.isBusy(task.id), 10_000);
    const t = s.repo.getTask(task.id)!;
    assert.equal(f.calls.length, 6, "code, review, fix, review, fix, review");
    assert.match(t.note ?? "", /still asks for changes after 2 fixes/);
    assert.match(t.note ?? "", /still missing the how-to/);
    assert.equal(t.status, "review");
  } finally {
    await s.cleanup();
  }
});

test("a review alone, with no stage before it to fix things, reaches Review with the findings on the card", async () => {
  const f = fakeQuery({ result: "Found a bug in the retry path.\n\nVERDICT: CHANGES_NEEDED" });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({
      project_id: s.project.id, title: "x", mode: "supervised",
      pipeline: [{ stage: "review", model: "m", effort: "low" }],
    });
    s.runner.queueTask(task.id);
    await until(() => ["failed", "review"].includes(s.repo.getTask(task.id)!.status) && !s.runner.isBusy(task.id));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "review");
    assert.match(t.note ?? "", /still asks for changes/);
    assert.equal(f.calls.length, 1);
  } finally {
    await s.cleanup();
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
    await s.cleanup();
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
    await s.cleanup();
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
    await s.cleanup();
  }
});

test("a stage prompt carries the project memory about its own task, not only the newest notes", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    s.repo.addNote({ project_id: s.project.id, text: "Invoices are exported as CSV with a semicolon separator." });
    for (let i = 0; i < 30; i++) s.repo.addNote({ project_id: s.project.id, text: `Dashboard widget ${i} uses the shared colour tokens.` });
    const task = s.repo.createTask({ project_id: s.project.id, title: "Add a PDF option to the invoice export", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.match(f.calls[0].prompt, /## Decisions from earlier tasks[\s\S]*semicolon separator/);
  } finally {
    await s.cleanup();
  }
});

test("runs leave Claude Code's own memory out unless the setting lets them use it", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    assert.equal(s.repo.getSettings().claudeAutoMemory, false, "off on a new board");
    const first = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(first.id);
    await until(() => s.repo.getTask(first.id)!.status === "review");
    assert.equal(f.calls[0].options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

    s.repo.updateSettings({ claudeAutoMemory: true });
    const second = s.repo.createTask({ project_id: s.project.id, title: "y", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(second.id);
    await until(() => s.repo.getTask(second.id)!.status === "review");
    assert.equal(f.calls[1].options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "the board adds nothing of its own");
  } finally {
    await s.cleanup();
  }
});

test("an approved task is remembered as what it did, and a later task about the same thing sees it with its id", async () => {
  const f = fakeQuery({ result: "Added a semicolon-separated CSV export for invoices." });
  const s = setup(f.fn);
  try {
    const first = s.repo.createTask({ project_id: s.project.id, title: "Invoice export", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(first.id);
    await until(() => s.repo.getTask(first.id)!.status === "review");
    await s.runner.approveTask(first.id);
    const [note] = s.repo.notes(s.project.id);
    assert.equal(note.kind, "outcome");

    const second = s.repo.createTask({ project_id: s.project.id, title: "Add totals to the invoice export", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(second.id);
    await until(() => s.repo.getTask(second.id)!.status === "review");
    const prompt = f.calls.at(-1)!.prompt;
    assert.match(prompt, new RegExp(`## Earlier tasks in this project that look related[\\s\\S]*Invoice export: [\\s\\S]*\\(\`${first.id}\`\\)`));
    assert.doesNotMatch(prompt, /## Decisions from earlier tasks/, "an outcome is not presented as a rule");
  } finally {
    await s.cleanup();
  }
});

test("approving or sending back a task is counted on every note its prompts carried, and a run can flag one", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    s.repo.addNote({ project_id: s.project.id, text: "Money is stored in integer cents, never as floats." });
    const sent = s.repo.createTask({ project_id: s.project.id, title: "Totals", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(sent.id);
    await until(() => s.repo.getTask(sent.id)!.status === "review");
    s.runner.rejectTask(sent.id, "Wrong rounding.");
    const kept = s.repo.createTask({ project_id: s.project.id, title: "Tax", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(kept.id);
    await until(() => s.repo.getTask(kept.id)!.status === "review");
    await s.runner.approveTask(kept.id);
    const money = s.repo.notes(s.project.id).find((n) => n.text.startsWith("Money"))!;
    assert.deepEqual([money.approved, money.sentBack], [1, 1]);

    const h = boardHandlers(s.repo, s.bus, { taskId: kept.id, runId: "r_x" });
    const out = h.flagMemory({ note: "Money is stored in integer cents", reason: "Prices are decimals in the new schema." });
    assert.ok(!("isError" in out));
    assert.equal(s.repo.notes(s.project.id).find((n) => n.id === money.id)!.flag?.reason, "Prices are decimals in the new schema.");
    assert.ok("isError" in h.flagMemory({ note: "Nothing like this was ever noted", reason: "a reason" }));
  } finally {
    await s.cleanup();
  }
});

test("a Reject note reaches every stage of the next run, and only that run", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    // Queueing clears the card's note; the prompt used to read it after that, so this never arrived.
    s.runner.rejectTask(task.id, "Add the role-preservation guard before --apply.");
    s.runner.retryTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 2);
    assert.match(f.calls[1].prompt, /## Why this was sent back[\s\S]*role-preservation guard/);

    s.runner.retryTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 3);
    assert.doesNotMatch(f.calls[2].prompt, /Why this was sent back/, "a later plain retry carries no stale reason");
  } finally {
    await s.cleanup();
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
    isAncestor: async () => false,
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
    headSha: async () => null,
    changedSince: async () => [],
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
    await s.cleanup();
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
    await s.cleanup();
  }
});

test("Approve marks the task done once the merge lands; a clean-up that fails is a note, not a task stuck in Review", async () => {
  const asked: unknown[] = [];
  const g = fakeGit({}, {
    removeWorktree: async (_p: string, _id: string, opts: unknown) => {
      asked.push(opts);
      throw new Error("git worktree remove failed: Permission denied");
    },
  });
  const s = setup(fakeQuery().fn);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: g.git });
  try {
    const review = (title: string) => {
      const task = s.repo.createTask({ project_id: s.project.id, title, mode: "autonomous", pipeline: ONE_STAGE });
      return s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, base_sha: "a".repeat(40) });
    };
    const done = await runner.approveTask(review("merge").id);
    assert.equal(done.status, "done", "the work is merged, so the task is done");
    assert.equal(done.branch, null);
    assert.match(done.note ?? "", /^Merged\. The board could not remove the task's worktree or its branch/);
    await assert.rejects(runner.approveTask(done.id), /Only tasks in review/, "nothing invites a second merge");

    s.repo.updateProject(s.project.id, { merge: { ...s.project.merge, strategy: "squash" } });
    await runner.approveTask(review("squash").id);
    assert.deepEqual(asked, [{ deleteBranch: "safe" }, { deleteBranch: "force" }], "only a squash, whose branch git never counts as merged, is deleted by force");
  } finally {
    await s.cleanup();
  }
});

test("a supervised task on its own branch gets a worktree, still asks for every write, and lands on Approve (D234)", async () => {
  const f = fakeQuery({ askWrite: true });
  const g = fakeGit();
  const s = setup(f.fn);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn, git: g.git });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "own branch", mode: "supervised", own_branch: true, pipeline: ONE_STAGE });
    runner.queueTask(task.id);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    assert.ok(g.calls.includes("add"), "a worktree was made for a supervised task");
    assert.equal(s.repo.getTask(task.id)!.branch, `kanban/${task.id}`);
    runner.decideApproval(s.repo.pendingApprovals(task.id)[0].id, "allow", null);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(f.decisions[0].behavior, "allow", "the write went through its approval card");
    assert.ok(g.calls.includes("commit"), "the board commits the stage's work to the branch");
    assert.match(f.calls[0].prompt, /## Working directory[\s\S]*kanban\//);
    const done = await runner.approveTask(task.id);
    assert.equal(done.status, "done");
    assert.ok(g.calls.includes("merge"), "Approve merges the branch");
  } finally {
    await s.cleanup();
  }

  const s2 = setup(fakeQuery().fn, { worktrees: "forbidden" });
  try {
    const t2 = s2.repo.createTask({ project_id: s2.project.id, title: "x", mode: "supervised", own_branch: true, pipeline: ONE_STAGE });
    assert.throws(() => s2.runner.queueTask(t2.id), (e: unknown) => e instanceof PolicyError && /forbids worktrees/.test((e as Error).message));
    const plain = s2.repo.createTask({ project_id: s2.project.id, title: "y", mode: "supervised", pipeline: ONE_STAGE });
    assert.doesNotThrow(() => s2.runner.queueTask(plain.id), "a plain supervised task is unaffected");
  } finally {
    await s2.cleanup();
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
    await s.cleanup();
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
    await s.cleanup();
  }
});

test("board tools: subtasks inherit parent, messages default to the parent, summary updates the card", async () => {
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
    await s.cleanup();
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
      await s.cleanup();
    }
  }

  // 1b. Nothing on the branch that the base lacks (it changed only a live system, then took the base's
  //     commits in): approving closes it without a merge, uncommitted work or not (D428).
  {
    const g = fakeGit({}, { isDirty: async () => true, isAncestor: async () => true });
    const s = setup(fakeQuery().fn);
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: g.git });
    try {
      const task = s.repo.createTask({ project_id: s.project.id, title: "live only", mode: "autonomous", pipeline: ONE_STAGE });
      s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, base_sha: "a".repeat(40) });
      assert.equal((await runner.approveTask(task.id)).status, "done");
      assert.equal(g.calls.includes("merge"), false, "nothing was merged into the dirty checkout");
    } finally {
      await s.cleanup();
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
      await s.cleanup();
    }
  }

  // 3. The base conflicts with the task and the project says "stop and tell me": report it, merge
  //    nothing, leave the worktree alone.
  {
    const g = fakeGit({}, { updateFromBase: async () => ({ ok: false, pulled: 0, conflicts: ["src/app.ts"] }) });
    const s = setup(fakeQuery().fn);
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: g.git });
    try {
      s.repo.updateProject(s.project.id, { merge: { ...s.project.merge, onConflict: "ask" } });
      const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: ONE_STAGE });
      s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, worktree_path: s.dir, base_sha: "a".repeat(40) });
      await assert.rejects(runner.approveTask(task.id), /src\/app\.ts/);
      assert.equal(g.calls.includes("merge"), false, "a conflict must never fall through to a merge");
      assert.equal(g.calls.includes("remove"), false, "and the worktree holding the work is kept");
    } finally {
      await s.cleanup();
    }
  }
});

test("a run can search its project's earlier work, and finds neither its own task nor another project's", async () => {
  const f = fakeQuery({ result: "Moved the CSV writer into exportInvoices() in billing/export.ts." });
  const s = setup(f.fn);
  try {
    const earlier = s.repo.createTask({ project_id: s.project.id, title: "Invoice CSV", mode: "supervised", pipeline: ONE_STAGE });
    s.runner.queueTask(earlier.id);
    await until(() => s.repo.getTask(earlier.id)!.status === "review");
    const elsewhere = s.repo.createProject({ name: "other", path: s.dir + "-other", policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } as any });
    s.repo.createTask({ project_id: elsewhere.id, title: "exportInvoices() in the other app", mode: "supervised", pipeline: ONE_STAGE });
    const now = s.repo.createTask({ project_id: s.project.id, title: "Rename exportInvoices()", mode: "supervised", pipeline: ONE_STAGE });

    const h = boardHandlers(s.repo, s.bus, { taskId: now.id, runId: "r_x" });
    const found = JSON.parse(h.searchPastWork({ query: "exportInvoices" }).content[0].text) as { results: { task_id: string; where: string }[] };
    assert.ok(found.results.length > 0);
    assert.ok(found.results.every((r) => r.task_id === earlier.id), "only the earlier task of this project");
    assert.ok(found.results.some((r) => r.where.endsWith("result")), "a stage's result is searched");
    assert.deepEqual(JSON.parse(h.searchPastWork({ query: "nothing like this anywhere" }).content[0].text).results, []);
  } finally {
    await s.cleanup();
  }
});
