import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyMcp, READ_ONLY_TOOLS } from "../src/engine/gate.ts";
import { chatBoardHandlers } from "../src/engine/chatBoard.ts";
import { SEED_PIPELINE } from "../src/db.ts";
import { sameStage, type QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";
import { setup, until, type Call } from "./helpers.ts";

const PLANNED: Stage[] = [
  { stage: "plan", model: "claude-opus-5-5", effort: "high" },
  { stage: "code", model: "claude-opus-5-5", effort: "high" },
  { stage: "review", model: "claude-sonnet-5-5", effort: "high" },
];
const CODE_REVIEW: Stage[] = PLANNED.slice(1);

/** A fake SDK whose run waits until `release` is called, so a test can act while a stage is running. */
function heldQuery(act?: (i: number, o: any) => Promise<void>) {
  const calls: Call[] = [];
  let release: () => void = () => {};
  const gate = () => new Promise<void>((r) => (release = r));
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const i = calls.length;
      calls.push({ prompt, options: params.options as Record<string, any> });
      yield { type: "system", subtype: "init", session_id: `s${i}` } as any;
      await act?.(i, params.options);
      if (i === 0) await gate();
      yield {
        type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01, session_id: `s${i}`,
        modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      } as any;
    })();
  return { fn, calls, release: () => release() };
}

test("a supervised task updates its to-do list without an approval card (D363)", async () => {
  const decisions: string[] = [];
  const q = heldQuery(async (i, o) => {
    if (i !== 0) return;
    const opts = { signal: new AbortController().signal, toolUseID: "t" };
    for (const name of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) {
      decisions.push((await o.canUseTool(name, { subject: "1. Check", taskId: "1", status: "in_progress" }, opts)).behavior);
    }
  });
  const s = setup(q.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [PLANNED[1]] });
    s.runner.queueTask(task.id);
    await until(() => decisions.length === 4);
    assert.deepEqual(decisions, ["allow", "allow", "allow", "allow"]);
    assert.equal(s.repo.pendingApprovals(task.id).length, 0, "not one card for the run's own checklist");
    for (const name of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) assert.ok(READ_ONLY_TOOLS.has(name), name);
    q.release();
    await until(() => s.repo.getTask(task.id)!.status === "review");
  } finally {
    await s.cleanup();
  }
});

test("a connector tool whose name only reads runs without a card; anything that could write still asks (D363)", () => {
  for (const name of [
    "mcp__claude_ai_Google_Sheets__get_values",
    "mcp__claude_ai_Google_Sheets__get_spreadsheet",
    "mcp__claude_ai_Slack__slack_search_public_and_private",
    "mcp__claude_ai_Slack__slack_read_thread",
    "mcp__gmail__search_threads",
    "mcp__calendar__list_events",
    "mcp__supabase__list_tables",
    "mcp__supabase__query_logs",
    "mcp__linear__get_issue",
  ]) {
    assert.equal(isReadOnlyMcp(name), true, name);
  }
  for (const name of [
    "mcp__supabase__execute_sql",
    "mcp__supabase__apply_migration",
    "mcp__gmail__send_message",
    "mcp__claude_ai_Google_Sheets__update_values",
    "mcp__claude_ai_Slack__slack_send_message",
    "mcp__x__get_or_create_record",
    "mcp__x__find_and_delete",
    "mcp__x__query",
    "mcp__computer-use__read_clipboard",
    "mcp__claude-in-chrome__read_page",
    "mcp__claude-in-chrome__get_page_text",
    "Write",
  ]) {
    assert.equal(isReadOnlyMcp(name), false, name);
  }
});

test("a supervised run reads a connector without a card, and the switch for read-only work turns that off (D363)", async () => {
  const decisions: string[] = [];
  // Every run reads the sheet: the first without a card, the retry (switch off) on one.
  const q = heldQuery(async (_i, o) => {
    const opts = { signal: new AbortController().signal, toolUseID: "t" };
    decisions.push((await o.canUseTool("mcp__claude_ai_Google_Sheets__get_values", { range: "Cash!A1:L6" }, opts)).behavior);
  });
  const s = setup(q.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: [PLANNED[1]] });
    s.runner.queueTask(task.id);
    await until(() => decisions.length === 1);
    assert.deepEqual(decisions, ["allow"]);
    assert.ok(s.repo.eventsAfter(s.repo.latestRun(task.id)!.id).some((e) => e.type === "board:auto-allowed"), "the transcript says the board allowed it");
    q.release();
    await until(() => s.repo.getTask(task.id)!.status === "review");

    s.repo.updateSettings({ autoAllowReadOnly: false });
    decisions.length = 0;
    s.runner.retryTask(task.id, 0);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    assert.equal(s.repo.pendingApprovals(task.id)[0].tool_name, "mcp__claude_ai_Google_Sheets__get_values");
    s.runner.stopTask(task.id);
  } finally {
    await s.cleanup();
  }
});

test("a running task can change the model of a step that hasn't started, and that step runs on it (D364)", async () => {
  const q = heldQuery();
  const s = setup(q.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE_REVIEW });
    s.runner.queueTask(task.id);
    await until(() => q.calls.length === 1);
    assert.ok(s.runner.isBusy(task.id));
    const next = [CODE_REVIEW[0], { ...CODE_REVIEW[1], model: "claude-opus-5-5", effort: "max" as const }];
    s.runner.assertReconfigurable(s.repo.getTask(task.id)!, { pipeline: next });
    s.repo.updateTask(task.id, { pipeline: next });
    q.release();
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(q.calls[1].options.model, "claude-opus-5-5", "the review ran on the model picked mid-run");
    assert.equal(q.calls[1].options.effort, "max");
  } finally {
    await s.cleanup();
  }
});

test("a running task can't change a step that already started, nor its mode (D364)", async () => {
  const q = heldQuery();
  const s = setup(q.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE_REVIEW });
    s.runner.queueTask(task.id);
    await until(() => q.calls.length === 1);
    const t = s.repo.getTask(task.id)!;
    assert.throws(() => s.runner.assertReconfigurable(t, { pipeline: [{ ...CODE_REVIEW[0], effort: "max" }, CODE_REVIEW[1]] }), /already started/);
    assert.throws(() => s.runner.assertReconfigurable(t, { pipeline: [] }), /already started/, "removing the running step is changing it");
    assert.throws(() => s.runner.assertReconfigurable(t, { mode: "autonomous" }), /Mode can't change while the task runs/);
    s.runner.assertReconfigurable(t, { mode: "supervised" });
    assert.ok(sameStage({ stage: "code", model: "m", effort: "high" }, { effort: "high", model: "m", stage: "code" }), "key order does not matter");
    q.release();
    await until(() => s.repo.getTask(task.id)!.status === "review");
  } finally {
    await s.cleanup();
  }
});

test("a planned card the chat made waits for its setup to be confirmed before it queues (D365)", async () => {
  const q = heldQuery();
  const s = setup(q.fn);
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
  const read = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  try {
    const made = read(h.createTask({ title: "Fix the payment", spec_md: "x" }));
    const t = s.repo.getTask(made.created.id)!;
    assert.equal(t.setup_pending, true, "the default pipeline has a plan");
    assert.equal(t.mode, "autonomous", "the board's default run style: Autonomous + asks me");
    assert.equal(t.may_ask, true);
    assert.match(made.note, /setup card/);

    const waiting = read(h.queueTask({ task_id: t.id }));
    assert.match(waiting.note, /waits on its setup card/);
    assert.equal(s.repo.getTask(t.id)!.status, "backlog", "the chat cannot start it");
    assert.throws(() => s.runner.queueTask(t.id), /setup card/, "nor can anything else");
    assert.equal((h.scheduleTask({ task_id: t.id, start_at: new Date(Date.now() + 3_600_000).toISOString() }) as any).isError, true, "a start time would skip the check too");

    s.repo.updateTask(t.id, { setup_pending: false, mode: "supervised", may_ask: false });
    s.runner.queueTask(t.id);
    assert.equal(s.repo.getTask(t.id)!.status, "queued", "Start on the card lets it go");
    s.runner.stopTask(t.id);
  } finally {
    await s.cleanup();
  }
});

test("a quick change from the chat, and a card made anywhere else, queue without a setup card (D365)", async () => {
  const s = setup(heldQuery().fn);
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
  const read = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  try {
    const quick = read(h.createTask({ title: "Rename a label", spec_md: "x", stages: [{ stage: "code" }] }));
    assert.equal(s.repo.getTask(quick.created.id)!.setup_pending, false, "no plan stage, nothing to review");
    const sub = s.repo.createTask({ project_id: s.project.id, title: "a subtask", mode: "supervised", pipeline: PLANNED });
    assert.equal(sub.setup_pending, false, "subtasks, schedules and re-runs are not asked again");
    s.repo.updateSettings({ confirmSetup: false });
    const off = read(h.createTask({ title: "Planned, switch off", spec_md: "x" }));
    assert.equal(s.repo.getTask(off.created.id)!.setup_pending, false, "the setting turns the check off");
  } finally {
    await s.cleanup();
  }
});

test("new cards default to high effort at every step and to Autonomous + asks me, and both settings save (D365, D366)", async () => {
  assert.deepEqual(SEED_PIPELINE.map((x) => x.effort), ["high", "high", "high"]);
  const s = setup(heldQuery().fn);
  try {
    assert.deepEqual(s.repo.getSettings().defaultPipeline.map((x) => x.effort), ["high", "high", "high"]);
    assert.equal(s.repo.getSettings().defaultRunStyle, "ask");
    assert.equal(s.repo.getSettings().confirmSetup, true);
    s.repo.updateSettings({ defaultRunStyle: "supervised", confirmSetup: false });
    assert.equal(s.repo.getSettings().defaultRunStyle, "supervised", "it saves and reads back");
    assert.equal(s.repo.getSettings().confirmSetup, false);
  } finally {
    await s.cleanup();
  }
});
