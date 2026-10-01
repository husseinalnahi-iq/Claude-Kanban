import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import type { Stage, WsMessage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const POLICY = { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } as const;

function fresh() {
  const repo = new Repo(openDb(":memory:"));
  const project = repo.createProject({ name: "p", path: "C:\\work\\proj", policy: POLICY });
  return { repo, project };
}

test("settings are remembered between reads, and any change to them — even one made straight in the database — is seen at once", () => {
  const { repo } = fresh();
  assert.equal(repo.getSettings().globalCap, 8);

  assert.equal(repo.updateSettings({ globalCap: 4 }).globalCap, 4);
  assert.equal(repo.getSettings().globalCap, 4);

  repo.db.prepare("UPDATE settings SET value = '2' WHERE key = 'globalCap'").run();
  assert.equal(repo.getSettings().globalCap, 2, "an update behind the repo's back");
  repo.db.prepare("DELETE FROM settings WHERE key = 'globalCap'").run();
  assert.equal(repo.getSettings().globalCap, 8, "a deleted row falls back to the default");
  repo.db.prepare("INSERT INTO settings(key, value) VALUES ('globalCap', '6')").run();
  assert.equal(repo.getSettings().globalCap, 6);

  const mine = repo.getSettings();
  mine.models.length = 0;
  mine.tiers.cheap.model = "changed";
  assert.ok(repo.getSettings().models.length > 0, "what a caller does to its copy stays with that caller");
  assert.notEqual(repo.getSettings().tiers.cheap.model, "changed");
  repo.db.close();
});

test("where the board keeps its files follows the folder it was started from", () => {
  const { repo } = fresh();
  repo.setStateDir("D:\\moved\\claude-kanban");
  assert.equal(repo.getSettings().stateDir, "D:\\moved\\claude-kanban");
  assert.equal(repo.updateSettings({ stateDir: "C:\\somewhere\\else" } as never).stateDir, "D:\\moved\\claude-kanban", "and it is still not something a settings save can change");
  repo.db.close();
});

test("a board's cards carry everything about a task except its spec", () => {
  const { repo, project } = fresh();
  const task = repo.createTask({ project_id: project.id, title: "T", spec_md: "a long spec ".repeat(500), pipeline: ONE, labels: ["ui"], depends_on: [] });
  repo.updateTask(task.id, { status: "done", summary: "did it", questions: [], checkout: { at: "now", dirtyAtStart: ["a"], touched: null } });
  const [card] = repo.taskCards(project.id);
  const { cost_usd, stage_states, ...rest } = card;
  assert.deepEqual(rest, { ...repo.getTask(task.id)!, spec_md: "" });
  assert.deepEqual([cost_usd, stage_states], [0, ["idle"]]);
  repo.db.close();
});

test("the lookups that run all the time use an index instead of reading every row", () => {
  const { repo } = fresh();
  const plan = (sql: string) => (repo.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT * FROM tasks WHERE start_at IS NOT NULL ORDER BY start_at"), /tasks_start_at/, "the scheduler's tick");
  assert.match(plan("SELECT * FROM tasks WHERE status IN ('paused') ORDER BY updated_at"), /tasks_status/, "paused and queued cards");
  assert.match(plan("SELECT * FROM approvals WHERE decision IS NULL ORDER BY created_at"), /approvals_pending/, "the approvals inbox");
  const drawer = plan("SELECT rowid AS rid, * FROM messages WHERE task_id = 'a' OR from_task_id = 'a' ORDER BY rid DESC LIMIT 200");
  assert.match(drawer, /messages_task/);
  assert.match(drawer, /messages_from/, "a task's sent messages, without reading every message on the board");
  repo.db.close();
});

test("a write that is refused once does not spoil the same write the next time", () => {
  const { repo } = fresh();
  // Statements are kept and reused; one that failed must come back clean.
  assert.throws(() => repo.createProject({ name: "again", path: "C:\\work\\proj", policy: POLICY }), /UNIQUE/);
  assert.equal(repo.createProject({ name: "other", path: "C:\\work\\other", policy: POLICY }).name, "other");
  assert.throws(() => repo.createTask({ project_id: "p_missing", title: "orphan", pipeline: ONE }), /FOREIGN KEY/);
  assert.equal(repo.listProjects().length, 2);
  repo.db.close();
});

test("ids are long enough that two never meet", () => {
  assert.match(newId("a"), /^a_[0-9a-f]{16}$/);
  assert.equal(new Set(Array.from({ length: 5000 }, () => newId("a"))).size, 5000);
});

test("a message going to many tabs is turned into text once, and not at all when nobody takes it", () => {
  const bus = new Bus();
  let written = 0;
  // Counts how often the message is serialised: JSON.stringify calls toJSON each time it runs.
  const counted = { type: "task.deleted", taskId: { toJSON: () => (written++, "t_1") } } as unknown as WsMessage;

  bus.subscribe(() => {});
  bus.publish(counted);
  assert.equal(written, 0);

  const got: string[] = [];
  for (let tab = 0; tab < 3; tab++) bus.subscribe((_m, wire) => got.push(wire()));
  bus.publish(counted);
  assert.equal(written, 1);
  assert.deepEqual(got, Array(3).fill('{"type":"task.deleted","taskId":"t_1"}'));
});
