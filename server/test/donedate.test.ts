import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { board } from "./board.ts";
import type { Stage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const daysAgo = (n: number, plusHours = 0) => new Date(Date.now() - n * 86_400_000 + plusHours * 3_600_000).toISOString();
const day = (iso: string) => iso.slice(0, 10);

test("finishing a task dates it; archiving or editing it later does not move the date; reopening it clears it", async () => {
  const repo = new Repo(openDb(":memory:"));
  const project = repo.createProject({ name: "p", path: "C:\\work\\proj", policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  const task = repo.createTask({ project_id: project.id, title: "T", pipeline: ONE });
  assert.equal(task.done_at, null);

  const done = repo.updateTask(task.id, { status: "done" });
  assert.ok(done.done_at);
  await new Promise((r) => setTimeout(r, 15));

  const archived = repo.updateTask(task.id, { archived_at: new Date().toISOString(), labels: ["tidy"] });
  assert.equal(archived.done_at, done.done_at);
  assert.notEqual(archived.updated_at, done.updated_at, "it was touched again, and that is a different fact");
  assert.equal(repo.updateTask(task.id, { status: "done" }).done_at, done.done_at, "saying done twice keeps the first date");

  assert.equal(repo.updateTask(task.id, { status: "review" }).done_at, null);
  repo.db.close();
});

test("the dashboard counts a finished task on the day it was finished, however much later it is tidied away", async () => {
  const b = await board();
  try {
    const task = b.repo.createTask({ project_id: b.project.id, title: "Shipped last week", pipeline: ONE });
    const run = b.repo.createRun({ task_id: task.id, stage: "code", stage_index: 0, model: "m", effort: "low" });
    b.repo.updateRun(run.id, { status: "success", ended_at: daysAgo(5, 2) });
    b.repo.updateTask(task.id, { status: "done" });
    // As if it had all happened five days ago: two hours from first run to done.
    b.repo.db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(daysAgo(5), run.id);
    b.repo.db.prepare("UPDATE tasks SET done_at = ? WHERE id = ?").run(daysAgo(5, 2), task.id);

    const tidy = await b.app.inject({ method: "POST", url: "/api/tasks/archive-done", payload: { project_id: b.project.id } });
    assert.deepEqual(tidy.json().archived, [task.id]);

    const a = await b.get(`/api/analytics?project=${b.project.id}&days=30`);
    const on = (date: string) => a.daily.find((d: { date: string }) => d.date === date)?.done;
    assert.equal(on(day(daysAgo(5, 2))), 1, "counted where it belongs");
    if (day(daysAgo(0)) !== day(daysAgo(5, 2))) assert.equal(on(day(daysAgo(0))), 0, "not on the day someone pressed tidy");
    assert.equal(a.totals.medianCycleHours, 2, "and how long it took is measured to when it was finished");
  } finally {
    await b.close();
  }
});

test("tidying the Done column goes by when a task was finished, not by when it was last edited", async () => {
  const b = await board();
  try {
    const old = b.repo.createTask({ project_id: b.project.id, title: "Old, relabelled today", pipeline: ONE });
    const fresh = b.repo.createTask({ project_id: b.project.id, title: "Finished today", pipeline: ONE });
    for (const t of [old, fresh]) b.repo.updateTask(t.id, { status: "done" });
    b.repo.db.prepare("UPDATE tasks SET done_at = ? WHERE id = ?").run(daysAgo(10), old.id);
    b.repo.updateTask(old.id, { labels: ["edited"] });

    const res = await b.app.inject({ method: "POST", url: "/api/tasks/archive-done", payload: { project_id: b.project.id, olderThanDays: 7 } });
    assert.deepEqual(res.json().archived, [old.id]);
  } finally {
    await b.close();
  }
});

test("a board from before finished dates were kept gets each finished task's last-touched date", () => {
  const dir = mkdtempSync(join(tmpdir(), "kdone-"));
  const file = join(dir, "k.db");
  try {
    const before = openDb(file);
    const repo = new Repo(before);
    const project = repo.createProject({ name: "p", path: "C:\\work\\proj", policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
    const done = repo.updateTask(repo.createTask({ project_id: project.id, title: "Done", pipeline: ONE }).id, { status: "done" });
    const open = repo.createTask({ project_id: project.id, title: "Open", pipeline: ONE });
    before.exec("ALTER TABLE tasks DROP COLUMN done_at"); // the board as it was before the update
    before.close();

    const after = new Repo(openDb(file));
    assert.equal(after.getTask(done.id)!.done_at, done.updated_at);
    assert.equal(after.getTask(open.id)!.done_at, null);
    after.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
