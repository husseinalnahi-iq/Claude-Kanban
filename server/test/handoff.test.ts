import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { formatRounds, measureChatHandoff, measureRounds, normPath } from "../scripts/measure-chat-handoff.ts";

const PROJECT = "C:\\work\\proj";
const WT = "C:\\work\\proj\\.kanban\\wt\\t1";

function board() {
  const db = openDb(":memory:");
  const repo = new Repo(db);
  const project = repo.createProject({ name: "proj", path: PROJECT, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
  const chat = repo.createChat({ project_id: project.id, title: "chat", model: "claude-sonnet-5-5", effort: "medium" });
  const card = () => repo.createTask({ project_id: project.id, title: "Fix the order total", chat_id: chat.id } as Parameters<Repo["createTask"]>[0]);
  const run = (taskId: string, stage: "plan" | "code", cost: number) => {
    const r = repo.createRun({ task_id: taskId, stage, stage_index: stage === "plan" ? 0 : 1, model: "claude-sonnet-5-5", effort: "medium" });
    repo.updateRun(r.id, { cost_usd: cost, status: "success" });
    return r.id;
  };
  const turn = (runId: string, id: string, usage: Record<string, number>, ...tools: [string, string, Record<string, unknown>][]) =>
    repo.insertEvent(runId, "assistant", { type: "assistant", message: { id, usage, content: tools.map(([tid, name, input]) => ({ type: "tool_use", id: tid, name, input })) } });
  const result = (runId: string, toolUseId: string, text: string) =>
    repo.insertEvent(runId, "user", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] } });
  return { db, repo, chat, card, run, turn, result };
}

test("a path reads the same from the project, a task's worktree, or a removed worktree", () => {
  assert.equal(normPath("C:\\work\\proj\\src\\App.ts", [PROJECT]), "src/app.ts");
  assert.equal(normPath(WT + "\\src\\app.ts", [WT, PROJECT]), "src/app.ts");
  assert.equal(normPath(WT + "\\src\\app.ts", [PROJECT]), "src/app.ts");
});

test("a card from a chat counts the files and searches the chat had already done before it existed", () => {
  const b = board();
  b.repo.addChatMessage({ chat_id: b.chat.id, role: "tool", text: "read src/app.ts" });
  b.repo.addChatMessage({ chat_id: b.chat.id, role: "tool", text: "searched the code for “orderTotal”" });
  const t = b.card();
  // Looked at after the card was made: the card could not have been told about it.
  const late = b.repo.addChatMessage({ chat_id: b.chat.id, role: "tool", text: "read src/other.ts" });
  b.db.prepare("UPDATE chat_messages SET ts = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(late.id);

  const r = b.run(t.id, "code", 1);
  b.turn(r, "m1", { input_tokens: 1000, output_tokens: 100 }, ["tu1", "Read", { file_path: WT + "\\src\\app.ts" }], ["tu2", "Grep", { pattern: "orderTotal" }]);
  b.result(r, "tu1", "x".repeat(400));
  b.turn(r, "m2", { input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 50 }, ["tu3", "Read", { file_path: WT + "\\src\\other.ts" }]);
  b.turn(r, "m3", { input_tokens: 0, cache_read_input_tokens: 3000, output_tokens: 300 }, ["tu4", "Edit", { file_path: WT + "\\src\\app.ts" }]);

  const [m] = measureChatHandoff(b.db).cards;
  assert.ok(m);
  assert.equal(m.card_reads, 2);
  assert.equal(m.reads_chat_had, 1);
  assert.deepEqual(m.repeated, ["src/app.ts"]);
  assert.equal(m.searches_chat_had, 1);
  assert.equal(m.reread_tokens, 100);
  // Weights: m1 1000 + 500 = 1500, m2 200 + 250 = 450, m3 300 + 1500 = 1800 → reading is 1950 / 3750.
  assert.equal(m.reading_usd.toFixed(3), (1950 / 3750).toFixed(3));
});

test("a later stage reading what an earlier stage of the same card read counts as a stage re-read", () => {
  const b = board();
  const t = b.card();
  const plan = b.run(t.id, "plan", 0.5);
  b.turn(plan, "p1", { input_tokens: 10 }, ["a", "Read", { file_path: PROJECT + "\\src\\app.ts" }]);
  const code = b.run(t.id, "code", 0.5);
  b.turn(code, "c1", { input_tokens: 10 }, ["b", "Read", { file_path: WT + "\\src\\app.ts" }], ["c", "Read", { file_path: WT + "\\src\\new.ts" }]);

  const [m] = measureChatHandoff(b.db).cards;
  assert.equal(m?.stage_rereads, 1);
  assert.equal(m?.reads_chat_had, 0);
});

test("parallel tool calls that share one message are billed once", () => {
  const b = board();
  const t = b.card();
  const r = b.run(t.id, "code", 1);
  b.turn(r, "m1", { output_tokens: 100 }, ["a", "Read", { file_path: WT + "\\a.ts" }]);
  b.turn(r, "m1", { output_tokens: 100 }, ["b", "Edit", { file_path: WT + "\\a.ts" }]);
  b.turn(r, "m2", { output_tokens: 100 });

  assert.equal(measureChatHandoff(b.db).cards[0]?.reading_usd, 0.5);
});

test("a file read too big to keep whole in the transcript still counts as a repeat, and a big write still ends the reading", () => {
  const b = board();
  b.repo.addChatMessage({ chat_id: b.chat.id, role: "tool", text: "read src/app.ts" });
  const t = b.card();
  const r = b.run(t.id, "code", 1);
  b.turn(r, "msg_1", { output_tokens: 100 }, ["tu1", "Read", { file_path: WT + "\\src\\app.ts" }]);
  b.result(r, "tu1", "line\n".repeat(10_000));
  b.turn(r, "msg_2", { output_tokens: 100 }, ["tu2", "Write", { file_path: WT + "\\src\\app.ts", content: "y".repeat(30_000) }]);
  b.turn(r, "msg_3", { output_tokens: 100 });

  const [m] = measureChatHandoff(b.db).cards;
  assert.equal(m?.reads_chat_had, 1);
  assert.ok(m!.reread_tokens > 10_000, `counted ${m?.reread_tokens} tokens`);
  assert.equal(m?.cut_turns, 1);
  // msg_2's usage is past the cut: msg_1 is the reading, msg_3 the writing.
  assert.equal(m?.reading_usd, 0.5);
});

test("a card whose transcript was pruned is counted apart, not measured as no repeats", () => {
  const b = board();
  b.repo.addChatMessage({ chat_id: b.chat.id, role: "tool", text: "read src/app.ts" });
  const t = b.card();
  b.run(t.id, "code", 1);

  const report = measureChatHandoff(b.db);
  assert.equal(report.cards.length, 0);
  assert.equal(report.pruned, 1);
});

test("a round that found its memory in the cache on its first turn is told apart from one that started fresh", () => {
  const b = board();
  const t = b.card();
  b.run(t.id, "code", 1);
  b.db.prepare("UPDATE tasks SET round = 2 WHERE id = ?").run(t.id);
  b.repo.addRound({ task_id: t.id, round: 2, request: "Blue", review: false, checklist_from: 0 });
  const r2 = b.run(t.id, "code", 0.1);
  b.turn(r2, "m1", { cache_read_input_tokens: 70_000, cache_creation_input_tokens: 800, output_tokens: 10 });

  const [m] = measureRounds(b.db);
  assert.deepEqual({ round: m!.round, read: m!.first_read, write: m!.first_write, cost: m!.cost_usd, first: m!.round1_usd, fell: m!.fell_back }, { round: 2, read: 70_000, write: 800, cost: 0.1, first: 1, fell: false });
  assert.match(formatRounds([m!]), /found their memory in the cache on the first turn: 1 {2}\(100%\)/);
});
