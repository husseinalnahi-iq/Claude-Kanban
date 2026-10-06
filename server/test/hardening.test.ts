import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskRunner, limitCovers, taskStateDir, type QueryFn } from "../src/engine/runner.ts";
import type { Provider, Stage } from "../src/types.ts";
import { fakeQuery, setup, until } from "./helpers.ts";

const SONNET: Stage[] = [{ stage: "code", model: "claude-sonnet-5", effort: "low" }];
const OPUS: Stage[] = [{ stage: "code", model: "claude-opus-5", effort: "low" }];
const PLAN_CODE: Stage[] = [
  { stage: "plan", model: "claude-sonnet-5", effort: "low" },
  { stage: "code", model: "claude-sonnet-5", effort: "low" },
];
const ZAI: Provider = {
  id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic",
  authRef: "ZAI_API_KEY", models: [{ id: "glm-5.3", label: "GLM 5.3", inputPer1M: 5, outputPer1M: 5 }], mayEditFiles: true,
};

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const hookCtx = { signal: new AbortController().signal };

/** What the CLI sends when a window is shut: the top-level status belongs to the window it names. */
const shutWindow = (type: string, resetsAt = inAnHour()) => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: type, resetsAt, unifiedWindows: { [type]: { utilization: 1, resetsAt } } },
});

/** A git that always succeeds, with the worktree in the project folder itself: no real repository needed. */
function fakeGit(over: Record<string, unknown> = {}) {
  return {
    isGitRepo: async () => true,
    currentBranch: async () => "main",
    isDirty: async () => false,
    headSha: async () => null,
    statusFiles: async () => [],
    updateFromBase: async () => ({ ok: true, pulled: 0, conflicts: [] }),
    addWorktree: async (path: string, id: string) => ({ path, branch: `kanban/${id}`, baseSha: "a".repeat(40) }),
    commitAll: async () => false,
    mergeTask: async () => {},
    removeWorktree: async () => {},
    diffTask: async () => [],
    ...over,
  } as never;
}

/** A session that ends at once with `result`, for tests that only need stages to pass. */
const ends = (result = "DONE", session = "s1") => ({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0, session_id: session, modelUsage: {} });

// ---------------------------------------------------------------- usage limit, told apart from a failure

test("a failure is a usage-limit pause only when a window covering that model was shut during the run (D116)", async () => {
  assert.equal(limitCovers("five_hour", "claude-sonnet-5"), true);
  assert.equal(limitCovers("seven_day", "claude-haiku-4-5-20251001"), true);
  assert.equal(limitCovers("seven_day_opus", "claude-opus-5"), true);
  assert.equal(limitCovers("seven_day_opus", "claude-sonnet-5"), false);
  assert.equal(limitCovers("seven_day_model:Opus 5", "sonnet"), false);
  assert.equal(limitCovers("seven_day_model:Sonnet 5", "claude-sonnet-5-5"), true);
  assert.equal(limitCovers("overage", "claude-sonnet-5"), true, "a window the board cannot place counts for the whole account");

  const broken: QueryFn = () =>
    (async function* () {
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["TypeError: cannot read x of undefined"], total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const s = setup(broken);
  try {
    // The weekly Opus window is full, and a five-hour "rejected" is left over from an hour ago.
    s.repo.upsertUsageLimit({ type: "seven_day_opus", status: "rejected", utilization: 1, resets_at: inAnHour() + 3 * 86_400 });
    s.repo.upsertUsageLimit({ type: "five_hour", status: "rejected", utilization: 1, resets_at: inAnHour() });
    s.repo.db.prepare("UPDATE usage_limits SET updated_at = ? WHERE type = 'five_hour'").run(new Date(Date.now() - 3_600_000).toISOString());

    const task = s.repo.createTask({ project_id: s.project.id, title: "a real bug", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => ["failed", "paused"].includes(s.repo.getTask(task.id)!.status));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed", "the work went wrong; nothing about this run said the limit was reached");
    assert.match(t.error ?? "", /TypeError/);
    assert.equal(s.runner.limitedUntil(), null, "so the queue is not held for a window nobody hit");
  } finally {
    await s.cleanup();
  }

  // The same window shut while an Opus stage ran is that stage's limit.
  const limited: QueryFn = () =>
    (async function* () {
      yield shutWindow("seven_day_opus") as never;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["the request was refused"], total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const s2 = setup(limited);
  try {
    const task = s2.repo.createTask({ project_id: s2.project.id, title: "on opus", mode: "supervised", pipeline: OPUS });
    s2.runner.queueTask(task.id);
    await until(() => ["failed", "paused"].includes(s2.repo.getTask(task.id)!.status));
    assert.equal(s2.repo.getTask(task.id)!.status, "paused");
    assert.equal(s2.repo.getTask(task.id)!.pause_reason, "limit");
  } finally {
    await s2.cleanup();
  }
});

test("a full Opus window does not send a Sonnet stage to the fallback provider", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    s.repo.updateSettings({ providers: [ZAI], claudeFallback: { provider: "zai", model: "glm-5.3" } });
    s.repo.upsertUsageLimit({ type: "seven_day_opus", status: "rejected", utilization: 1, resets_at: inAnHour() });

    const sonnet = s.repo.createTask({ project_id: s.project.id, title: "sonnet", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(sonnet.id);
    await until(() => s.repo.getTask(sonnet.id)!.status === "review");
    assert.equal(f.calls[0].options.model, "claude-sonnet-5", "Sonnet still has room, so it runs where it was asked to");
    assert.equal(s.repo.getTask(sonnet.id)!.pipeline[0].provider, undefined);

    const opus = s.repo.createTask({ project_id: s.project.id, title: "opus", mode: "supervised", pipeline: OPUS });
    s.runner.queueTask(opus.id);
    await until(() => s.repo.getTask(opus.id)!.status === "review");
    assert.equal(f.calls[1].options.model, "glm-5.3", "the Opus stage is the one that moves");
  } finally {
    await s.cleanup();
  }
});

test("a chat turn you stop yourself ends as stopped, not as paused by the usage limit", async () => {
  let n = 0;
  const q: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) {
        /* drain */
      }
      if (n++ === 0) {
        yield { type: "system", subtype: "init", session_id: "s1" } as never;
        yield ends() as never;
        return;
      }
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      yield shutWindow("five_hour") as never;
      await new Promise<void>((r) => params.options.abortController!.signal.addEventListener("abort", () => r(), { once: true }));
      throw new Error("aborted");
    })();
  const s = setup(q);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    s.runner.chat(task.id, "one more thing");
    await until(() => s.repo.usageLimits().some((l) => l.status === "rejected"));
    s.runner.stopTask(task.id);
    await until(() => !s.runner.isBusy(task.id));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed");
    assert.equal(t.error, "stopped by user");
    assert.equal(t.resume_at, null, "nothing was scheduled to resume by itself");
  } finally {
    await s.cleanup();
  }
});

test("Resume now on one task releases every task the usage limit paused", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const ids = ["a", "b"].map((title) => {
      const t = s.repo.createTask({ project_id: s.project.id, title, mode: "supervised", pipeline: SONNET });
      s.repo.updateTask(t.id, { status: "paused", pause_reason: "limit", resume_at: later });
      return t.id;
    });
    s.runner.resumeNow(ids[0]);
    // Alone, the first one sat in Queued: the queue holds Claude work while any task is still paused by the limit.
    await until(() => ids.every((id) => s.repo.getTask(id)!.status === "review"));
    assert.equal(f.calls.length, 2);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- the autonomous gate

test("an autonomous run's sandbox and blocked list are enforced by a hook too, since a settings allow-rule never reaches canUseTool", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  s.repo.updateSettings({ autonomousReach: "sandbox" } as never);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn, git: fakeGit() });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: SONNET });
    runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const hook = f.calls[0].options.hooks.PreToolUse[0].hooks[0];
    const ask = async (tool_name: string, tool_input: Record<string, unknown> = {}) => (await hook({ tool_name, tool_input }, "tu", hookCtx)).hookSpecificOutput;

    const push = await ask("Bash", { command: "git push origin main" });
    assert.equal(push.permissionDecision, "deny");
    assert.match(push.permissionDecisionReason, /managed by the board/);
    assert.match((await ask("Bash", { command: 'psql -c "DROP DATABASE prod"' })).permissionDecisionReason, /blocked-command list/);
    assert.match((await ask("PowerShell", { command: "taskkill /F /IM node.exe" })).permissionDecisionReason, /kills every process with that name/);
    assert.match((await ask("Write", { file_path: join(s.dir, "..", "elsewhere.txt"), content: "x" })).permissionDecisionReason, /only write inside the task worktree/);
    assert.match((await ask("mcp__supabase__execute_sql", { query: "select 1" })).permissionDecisionReason, /external MCP tools/);

    // Nothing else is decided here: canUseTool still answers, in its own words.
    assert.equal(await ask("Bash", { command: "npm test" }), undefined);
    assert.equal(await ask("Write", { file_path: "src/x.ts", content: "x" }), undefined);
    assert.equal(await ask("mcp__board__board_set_summary", { text: "x" }), undefined);
    assert.equal(await ask("AskUserQuestion", { questions: [] }), undefined);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- workspaces

test("Update from base brings a task's worktree up to date", async () => {
  const s = setup(fakeQuery().fn);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fakeQuery().fn, git: fakeGit({ updateFromBase: async () => ({ ok: true, pulled: 2, conflicts: [] }) }) });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: SONNET });
    s.repo.updateTask(task.id, { status: "review", branch: `kanban/${task.id}`, worktree_path: s.dir, base_sha: "a".repeat(40) });
    assert.deepEqual(await runner.updateTaskFromBase(task.id), { pulled: 2, conflicts: [], base: "main" });
    assert.match(s.repo.getTask(task.id)!.note ?? "", /Updated from "main" \(2 commits\)/);
    assert.equal(runner.isBusy(task.id), false);
  } finally {
    await s.cleanup();
  }
});

test("a worktree whose setup command failed is set up again on Retry, and only until it has worked", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn, git: fakeGit() });
  try {
    // Fails until ok.txt exists; counts its runs and notes the state folder it was given.
    const setupCommand = `node -e "const fs=require('fs');fs.appendFileSync('setup.log','x');fs.writeFileSync('setup-state.txt',process.env.KANBAN_STATE_DIR||'unset');process.exit(fs.existsSync('ok.txt')?0:1)"`;
    s.repo.updateProject(s.project.id, { env: { worktreeInclude: [], setupCommand, verifyCommand: null, labels: [], onboarding: null } });
    const task = s.repo.createTask({ project_id: s.project.id, title: "auto", mode: "autonomous", pipeline: SONNET });
    runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    assert.match(s.repo.getTask(task.id)!.error ?? "", /setup command failed/);
    assert.equal(f.calls.length, 0, "no stage starts in a workspace that was never set up");

    writeFileSync(join(s.dir, "ok.txt"), "now it works");
    runner.retryTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(readFileSync(join(s.dir, "setup.log"), "utf8"), "xx", "Retry ran the setup again instead of starting the stage without it");
    assert.equal(f.calls.length, 1);
    assert.equal(readFileSync(join(s.dir, "setup-state.txt"), "utf8"), taskStateDir(task.id), "the setup command is given the task's own state folder");

    runner.retryTask(task.id);
    await until(() => f.calls.length === 2 && s.repo.getTask(task.id)!.status === "review");
    assert.equal(readFileSync(join(s.dir, "setup.log"), "utf8"), "xx", "once it has worked it is not run again");
    assert.equal(existsSync(`${s.dir}.setup-pending`), false);
  } finally {
    await s.cleanup();
  }
});

test("a task's sessions and its verify command get a state folder of their own, never the board's", async () => {
  const before = process.env.KANBAN_STATE_DIR;
  process.env.KANBAN_STATE_DIR = join(process.cwd(), "the-live-board");
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const verifyCommand = `node -e "require('fs').writeFileSync('verify-state.txt',process.env.KANBAN_STATE_DIR||'unset')"`;
    s.repo.updateProject(s.project.id, { env: { worktreeInclude: [], setupCommand: null, verifyCommand, labels: [], onboarding: null } });
    const task = s.repo.createTask({ project_id: s.project.id, title: "works on the board itself", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const given = f.calls[0].options.env.KANBAN_STATE_DIR;
    assert.equal(given, taskStateDir(task.id));
    assert.notEqual(given, process.env.KANBAN_STATE_DIR, "a board started inside the task would otherwise open the live database");
    assert.ok(given.includes(task.id), "one folder per task");
    assert.equal(readFileSync(join(s.dir, "verify-state.txt"), "utf8"), taskStateDir(task.id));
  } finally {
    if (before === undefined) delete process.env.KANBAN_STATE_DIR;
    else process.env.KANBAN_STATE_DIR = before;
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- cost

test("a foreign stage the board stops for cost keeps what it spent, and a reply sent as several messages is counted once", async () => {
  // $5 per million tokens, a million tokens a reply: $5 each. The first reply arrives as three messages.
  const reply = (id: string) => ({ type: "assistant", message: { id, content: [{ type: "text", text: "…" }], usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
  const f = fakeQuery({ extra: [reply("m1"), reply("m1"), reply("m1"), reply("m2"), reply("m3"), reply("m4")], cost: 0 });
  const s = setup(f.fn);
  try {
    s.repo.updateSettings({ providers: [ZAI], maxCostPerStageUsd: 12 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "pricey", mode: "supervised", pipeline: [{ stage: "code", model: "glm-5.3", effort: "low", provider: "zai" }] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.cost_usd, 15, "three replies were paid for before the $12 ceiling stopped it — not five messages, and not $0");
    assert.equal(run.input_tokens, 3_000_000);
    assert.equal(run.cost_source, "estimated");
    assert.match(s.repo.getTask(task.id)!.note ?? "", /Stopped at \$15\.00/, "the pause card says what was really spent");
    assert.equal(s.repo.taskCost(task.id), 15, "and the task's ceiling counts it");
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- sessions that cannot start

test("a stage whose session cannot start fails cleanly: its run is closed and the task can be retried", async () => {
  const f = fakeQuery();
  let n = 0;
  const q: QueryFn = (p) => {
    if (n++ === 0) throw new Error("spawn claude ENOENT");
    return f.fn(p);
  };
  const s = setup(q);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.status, "failed", "not left 'running' for a restart to find");
    assert.match(run.error ?? "", /ENOENT/);
    assert.ok(run.ended_at);
    assert.match(s.repo.getTask(task.id)!.error ?? "", /ENOENT/);
    await until(() => !s.runner.isBusy(task.id));

    s.runner.retryTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
  } finally {
    await s.cleanup();
  }
});

test("a critic that cannot run never blocks the work: the plan stands and the code stage follows", async () => {
  const f = fakeQuery({ result: "PLAN v1" });
  const s = setup(f.fn);
  try {
    // The critic's provider was switched off after debate was set up; nothing checks that at queue time.
    s.repo.updateSettings({ providers: [{ ...ZAI, enabled: false }], debate: { enabled: true, critic: { provider: "zai", model: "glm-5.3", effort: "medium" }, mode: "once", rounds: 3 } });
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE });
    s.runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(s.repo.getTask(task.id)!.status) && !s.runner.isBusy(task.id));
    assert.equal(s.repo.getTask(task.id)!.status, "review");
    assert.equal(f.calls.length, 2, "plan and code; the critic never got a session");
    const critic = s.repo.runsForTask(task.id).find((r) => r.role === "critic")!;
    assert.equal(critic.status, "failed", "and its run is closed, not left running");
    const plan = s.repo.stageRuns(task.id)[0];
    assert.ok(s.repo.eventsAfter(plan.id).some((e) => e.type === "debate:skipped"));
  } finally {
    await s.cleanup();
  }
});

test("a message whose session cannot start fails the task with the reason and leaves the stage's result alone", async () => {
  const f = fakeQuery();
  let n = 0;
  const q: QueryFn = (p) => {
    if (n++ === 1) throw new Error("spawn claude ENOENT");
    return f.fn(p);
  };
  const s = setup(q);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    s.runner.chat(task.id, "one more thing");
    await until(() => !s.runner.isBusy(task.id));
    assert.equal(s.repo.getTask(task.id)!.status, "failed");
    assert.match(s.repo.getTask(task.id)!.error ?? "", /ENOENT/);
    const run = s.repo.latestRun(task.id)!;
    assert.equal(run.status, "success");
    assert.equal(run.result_md, "DONE");
  } finally {
    await s.cleanup();
  }
});

test("listing Claude's models survives a Claude Code that cannot start", async () => {
  const s = setup(() => {
    throw new Error("spawn claude ENOENT");
  });
  try {
    const list = await s.runner.claudeModels(true);
    assert.equal(list.source, "unavailable");
    assert.match(list.error ?? "", /ENOENT/);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- where a run starts

test("a message is refused while a task is paused, so it keeps its place", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");

    s.repo.updateTask(task.id, { status: "paused", pause_reason: "cost" });
    assert.throws(() => s.runner.chat(task.id, "hello?"), /paused at its cost ceiling — press Continue or Stop first/);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    s.repo.updateTask(task.id, { status: "paused", pause_reason: "limit", resume_at: later });
    assert.throws(() => s.runner.chat(task.id, "hello?"), /paused until it can run again — press Try now or Stop first/);
    const t = s.repo.getTask(task.id)!;
    assert.deepEqual([t.status, t.resume_at], ["paused", later], "still paused, still due to resume by itself");
    assert.equal(f.calls.length, 1, "no session was started");
  } finally {
    await s.cleanup();
  }
});

test("a task sent back from Review and still queued at a restart starts over, not at its last stage", async () => {
  const f = fakeQuery();
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    s.runner.rejectTask(task.id, "wrong approach");
    // Queued again from the start, then the board is closed before its turn comes.
    s.repo.updateTask(task.id, { status: "queued" });

    const restarted = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn });
    restarted.recover();
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 4);
    assert.match(f.calls[2].prompt, /# Stage: plan/, "every stage runs again");
    assert.equal(f.calls[2].options.resume, undefined, "in a fresh session");
    assert.match(f.calls[3].prompt, /# Stage: code/);
  } finally {
    await s.cleanup();
  }
});

/** The board died mid-stage: its newest code run is left "running", as a crash leaves it. */
function cutOffMidCode(s: ReturnType<typeof setup>, taskId: string): string {
  const code = s.repo.stageRuns(taskId).filter((r) => r.stage_index === 1).at(-1)!;
  s.repo.updateRun(code.id, { status: "running", ended_at: null, error: null });
  s.repo.updateTask(taskId, { status: "running" });
  return code.id;
}

test("after the board crashes, a stage it cut off carries on in its own session by itself", async () => {
  const f = fakeQuery({ sessionId: "sess" });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const cut = cutOffMidCode(s, task.id);

    new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn }).recover({ afterCrash: true });
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 3);
    assert.equal(s.repo.getRun(cut)!.error, "interrupted", "the cut-off run is still recorded as interrupted");
    assert.equal(f.calls[2].options.resume, "sess", "the code stage continued its session");
    const again = s.repo.stageRuns(task.id).at(-1)!;
    assert.equal(again.stage_index, 1, "from the code stage, not the plan");
    assert.ok(s.repo.eventsAfter(again.id).some((e) => JSON.stringify(e.payload).includes("stopped unexpectedly")), "the card says why it started again");
  } finally {
    await s.cleanup();
  }
});

test("after an ordinary restart too, a cut-off stage carries on in its own session (D411)", async () => {
  const f = fakeQuery({ sessionId: "sess" });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    cutOffMidCode(s, task.id);

    new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn }).recover();
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 3);
    assert.equal(f.calls[2].options.resume, "sess", "the code stage continued its session");
    const again = s.repo.stageRuns(task.id).at(-1)!;
    assert.ok(s.repo.eventsAfter(again.id).some((e) => JSON.stringify(e.payload).includes("The board restarted while this stage ran")), "the card says why, without calling it a crash");
  } finally {
    await s.cleanup();
  }
});

test("a stage the board crashed in three times within half an hour is left for you", async () => {
  const f = fakeQuery({ sessionId: "sess" });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: PLAN_CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    for (const calls of [3, 4]) {
      cutOffMidCode(s, task.id);
      new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn }).recover({ afterCrash: true });
      await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === calls);
    }
    cutOffMidCode(s, task.id);
    new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: f.fn }).recover({ afterCrash: true });
    await new Promise((r) => setTimeout(r, 100));
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /stopped 3 times in 30 minutes/);
    assert.equal(f.calls.length, 4, "the third crash did not start it again");
  } finally {
    await s.cleanup();
  }
});

test("a stage moved to another model after running out of turns gets its whole prompt, not 'carry on'", async () => {
  const f = fakeQuery({ sessionId: "sess", byCall: (i) => (i === 0 ? { maxTurns: true, extra: [shutWindow("five_hour")] } : undefined) });
  const s = setup(f.fn);
  try {
    s.repo.updateSettings({ providers: [ZAI], claudeFallback: { provider: "zai", model: "glm-5.3" } });
    const task = s.repo.createTask({ project_id: s.project.id, title: "Tidy the importer", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].options.model, "glm-5.3", "Claude's window shut, so the stage carried on at the fallback");
    assert.equal(f.calls[1].options.resume, undefined, "which has no session to carry on in");
    assert.match(f.calls[1].prompt, /# Stage: code/);
    assert.match(f.calls[1].prompt, /Tidy the importer/);
    assert.doesNotMatch(f.calls[1].prompt, /^You reached this stage's turn limit/);
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- verify, once

test("the verify command that passed as the stage ended is not run a second time by the board", async () => {
  const verifyCommand = `node -e "require('fs').appendFileSync('verify.log','x')"`;
  /** A code stage that ends behind its Stop hook; with `after`, it uses a tool once more before ending. */
  const session = (after: boolean): QueryFn => (params) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      const verify = params.options.hooks!.Stop!.at(-1)!.hooks[0];
      assert.deepEqual(await verify({ hook_event_name: "Stop" } as never, undefined, hookCtx), {}, "the check passes, so the turn may end");
      if (after) yield { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts" } }] } } as never;
      yield ends() as never;
    })();

  for (const [after, runs, why] of [[false, "x", "the Stop hook's pass stands"], [true, "xx", "something ran after the pass, so the board checks again"]] as const) {
    const s = setup(session(after));
    try {
      s.repo.updateProject(s.project.id, { env: { worktreeInclude: [], setupCommand: null, verifyCommand, labels: [], onboarding: null } });
      const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: SONNET });
      s.runner.queueTask(task.id);
      await until(() => s.repo.getTask(task.id)!.status === "review");
      assert.equal(readFileSync(join(s.dir, "verify.log"), "utf8"), runs, why);
    } finally {
      await s.cleanup();
    }
  }
});

// ---------------------------------------------------------------- less work per message, per pump, per probe

test("a run's growing context is broadcast about once a second, and its last value is always kept", async () => {
  const turns = Array.from({ length: 40 }, (_, i) => ({
    type: "assistant", message: { id: `m${i}`, content: [{ type: "text", text: "…" }], usage: { input_tokens: 1000 * (i + 1), output_tokens: 0 } },
  }));
  const f = fakeQuery({ extra: turns });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: SONNET });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.context_tokens, 40_000, "the final figure is the largest one seen");
    const updates = s.seen.filter((m) => m.type === "run.updated" && m.run.id === run.id).length;
    assert.ok(updates < 10, `forty messages in one burst used to be forty broadcasts of the whole run; got ${updates}`);
    const finished = s.seen.find((m) => m.type === "run.finished" && m.run.id === run.id);
    assert.equal(finished?.type === "run.finished" ? finished.run.context_tokens : null, 40_000);
  } finally {
    await s.cleanup();
  }
});

test("a pump of the queue reads the settings once, however many tasks are waiting", async () => {
  let open!: () => void;
  const held = new Promise<void>((r) => (open = r));
  const q: QueryFn = () =>
    (async function* () {
      await held;
      yield ends() as never;
    })();
  const s = setup(q);
  try {
    s.repo.updateSettings({ serial: true });
    const ids = Array.from({ length: 9 }, (_, i) => s.repo.createTask({ project_id: s.project.id, title: `t${i}`, mode: "supervised", pipeline: SONNET }).id);
    for (const id of ids) s.runner.queueTask(id);
    assert.equal(s.runner.queue.snapshot().waiting.length, 8, "one runs, eight wait their turn");

    let reads = 0;
    const getSettings = s.repo.getSettings.bind(s.repo);
    s.repo.getSettings = () => (reads++, getSettings());
    s.runner.queue.pump();
    assert.equal(reads, 1, "not once or more for each waiting task");
    s.repo.getSettings = getSettings;

    open();
    await until(() => ids.every((id) => s.repo.getTask(id)!.status === "review"));
  } finally {
    open();
    await s.cleanup();
  }
});

test("two screens asking what runs get, or whether fast mode is on, share one check", async () => {
  let sessions = 0;
  const q: QueryFn = (params) =>
    (async function* () {
      sessions++;
      await new Promise((r) => setTimeout(r, 20));
      yield { type: "system", subtype: "init", session_id: "s", fast_mode_state: "on", tools: [], mcp_servers: [], plugins: [] } as never;
      if (params.options.abortController?.signal.aborted) return;
      yield ends() as never;
    })();
  const s = setup(q);
  try {
    const [a, b] = await Promise.all([s.runner.fastModeStatus(), s.runner.fastModeStatus()]);
    assert.equal(sessions, 1);
    assert.equal(a.state, "on");
    assert.equal(a, b);

    sessions = 0;
    const [x, y] = await Promise.all([s.runner.sessionTools(), s.runner.sessionTools()]);
    assert.equal(sessions, 1);
    assert.equal(x, y);
    assert.equal(x.servers[0].name, "board");
  } finally {
    await s.cleanup();
  }
});
