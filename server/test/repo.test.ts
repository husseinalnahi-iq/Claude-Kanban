import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Adds notes oldest first, each a minute apart, so "newest" never depends on two landing in the same millisecond. */
function addNotes(repo: Repo, projectId: string, texts: string[]) {
  const start = Date.parse("2026-01-01T00:00:00Z");
  return texts.map((text, i) => {
    const n = repo.addNote({ project_id: projectId, text })!;
    repo.db.prepare("UPDATE notes SET ts = ? WHERE id = ?").run(new Date(start + i * 60_000).toISOString(), n.id);
    return n;
  });
}

test("a prompt's memory carries the note about its task even when thirty newer ones are about other things", () => {
  const { repo, project } = fresh();
  addNotes(repo, project.id, [
    "Invoices are exported as CSV with a semicolon separator, because the accounting tool rejects commas.",
    ...Array.from({ length: 30 }, (_, i) => `Dashboard widget ${i} uses the shared colour tokens.`),
  ]);
  const picked = repo.notesFor(project.id, "Add a PDF option next to the invoice export", 12).map((n) => n.text);
  assert.equal(picked.length, 12);
  assert.ok(picked.some((t) => t.startsWith("Invoices are exported")), "the matching note, by its stem (invoice → invoices)");
  for (const i of [29, 28, 27]) assert.ok(picked.includes(`Dashboard widget ${i} uses the shared colour tokens.`), `the newest notes stay: ${i}`);
});

test("a task with nothing in common with memory gets the newest notes, as before", () => {
  const { repo, project } = fresh();
  addNotes(repo, project.id, Array.from({ length: 20 }, (_, i) => `Convention number ${i} for this project.`));
  const picked = repo.notesFor(project.id, "zzz qqq", 12).map((n) => n.text);
  assert.deepEqual(picked, Array.from({ length: 12 }, (_, i) => `Convention number ${19 - i} for this project.`));
});

test("whatever a task's text holds, choosing its memory never fails and never reaches into another project", () => {
  const { repo, project } = fresh();
  const other = repo.createProject({ name: "q", path: "C:\\work\\other", policy: POLICY });
  addNotes(repo, other.id, ["The invoice export runs nightly in the other project."]);
  addNotes(repo, project.id, ["Invoice numbers are never reused, even after a delete."]);
  const tricky = `invoice" OR * NEAR( AND -x ^ {col}: 'quote' \u0000 ${"word ".repeat(500)}`;
  const picked = repo.notesFor(project.id, tricky, 12).map((n) => n.text);
  assert.deepEqual(picked, ["Invoice numbers are never reused, even after a delete."]);
  assert.deepEqual(repo.notesFor(project.id, "", 12).length, 1);
});

test("a forgotten note is never chosen again", () => {
  const { repo, project } = fresh();
  const [gone] = addNotes(repo, project.id, ["Deploys go through the staging branch first.", ...Array.from({ length: 5 }, (_, i) => `Filler note ${i} here.`)]);
  repo.deleteNote(gone.id);
  assert.ok(!repo.notesFor(project.id, "staging deploys", 12).some((n) => n.id === gone.id));
});

test("on a board from before the memory search, the notes it already had are found after the upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "knotes-"));
  try {
    const file = join(dir, "kanban.db");
    const before = openDb(file);
    const repo = new Repo(before);
    const { id: projectId } = repo.createProject({ name: "p", path: "C:\\work\\proj", policy: POLICY });
    // What an older board looks like: no index, and notes it was never told about.
    before.exec("DROP TRIGGER notes_fts_insert; DROP TRIGGER notes_fts_delete; DROP TRIGGER notes_fts_update; DROP TABLE notes_fts");
    addNotes(repo, projectId, ["Invoices are exported as CSV with a semicolon separator.", ...Array.from({ length: 20 }, (_, i) => `Filler note ${i} here.`)]);
    before.close();

    const after = new Repo(openDb(file));
    assert.ok(after.notesFor(projectId, "invoice export", 12).some((n) => n.text.startsWith("Invoices are exported")));
    after.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Same as addNotes, for outcomes: what approved tasks did. */
function addOutcomes(repo: Repo, projectId: string, texts: string[], from = Date.parse("2026-02-01T00:00:00Z")) {
  return texts.map((text, i) => {
    const n = repo.addNote({ project_id: projectId, text, source: "board", kind: "outcome" })!;
    repo.db.prepare("UPDATE notes SET ts = ? WHERE id = ?").run(new Date(from + i * 60_000).toISOString(), n.id);
    return n;
  });
}

test("what earlier tasks did only reaches a prompt when it matches the task, and never more than four of it", () => {
  const { repo, project } = fresh();
  addNotes(repo, project.id, ["Money is stored in integer cents, never as floats."]);
  addOutcomes(repo, project.id, [
    ...Array.from({ length: 6 }, (_, i) => `Invoice export ${i}: added a column to the invoice CSV.`),
    ...Array.from({ length: 20 }, (_, i) => `Dashboard widget ${i}: restyled the widget.`),
  ]);
  const unrelated = repo.notesFor(project.id, "Fix the login redirect", 12);
  assert.deepEqual(unrelated.map((n) => n.text), ["Money is stored in integer cents, never as floats."], "newer outcomes do not fill the prompt");

  const related = repo.notesFor(project.id, "Add a PDF option to the invoice export", 12);
  const outcomes = related.filter((n) => n.kind === "outcome");
  assert.equal(outcomes.length, 4);
  assert.ok(outcomes.every((n) => n.text.startsWith("Invoice export")));
  assert.ok(related.some((n) => n.kind === "lesson"), "the lesson is still there");
});

test("however many tasks are approved, the project's rules and lessons are never pruned to make room", () => {
  const { repo, project } = fresh();
  addNotes(repo, project.id, ["Money is stored in integer cents, never as floats."]);
  addOutcomes(repo, project.id, Array.from({ length: 100 }, (_, i) => `Task number ${i}: did its thing.`));
  const kept = repo.notes(project.id);
  assert.ok(kept.some((n) => n.text.startsWith("Money is stored")));
  assert.equal(kept.filter((n) => n.kind === "outcome").length, 60, "outcomes keep their own cap");
});

test("a line written again as something to follow becomes a lesson, and an outcome never demotes one", () => {
  const { repo, project } = fresh();
  const [o] = addOutcomes(repo, project.id, ["Payments now retry three times before declining."]);
  assert.equal(repo.addNote({ project_id: project.id, text: "Payments now retry three times before declining.", source: "user" })!.kind, "lesson");
  assert.equal(repo.addNote({ project_id: project.id, text: "payments now retry three times before declining.", kind: "outcome" })!.kind, "lesson");
  assert.equal(repo.notes(project.id).length, 1);
  assert.equal(repo.notes(project.id)[0].id, o.id);
});

test("on a board from before kinds, approval lines become outcomes and the verify-command note stays a lesson", () => {
  const dir = mkdtempSync(join(tmpdir(), "kkinds-"));
  try {
    const file = join(dir, "kanban.db");
    const before = openDb(file);
    const repo = new Repo(before);
    const { id: projectId } = repo.createProject({ name: "p", path: "C:\\work\\proj", policy: POLICY });
    before.exec("ALTER TABLE notes DROP COLUMN kind");
    const add = before.prepare("INSERT INTO notes(id, project_id, task_id, text, source, ts) VALUES (?, ?, NULL, ?, ?, ?)");
    add.run("n1", projectId, "Checkout page: added Apple Pay.", "board", "2026-01-01T00:00:00Z");
    add.run("n2", projectId, "Verify command set to `npm test` from CLAUDE.md", "board", "2026-01-01T00:01:00Z");
    add.run("n3", projectId, "Use pnpm, not npm.", "agent", "2026-01-01T00:02:00Z");
    add.run("n4", projectId, "Never deploy on Fridays.", "user", "2026-01-01T00:03:00Z");
    before.close();

    const after = new Repo(openDb(file));
    const kinds = Object.fromEntries(after.notes(projectId).map((n) => [n.id, n.kind]));
    assert.deepEqual(kinds, { n1: "outcome", n2: "lesson", n3: "lesson", n4: "lesson" });
    after.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a note counts the tasks it was given to by how they ended, and the last verdict on a task is the one that counts", () => {
  const { repo, project } = fresh();
  const [n] = addNotes(repo, project.id, ["Money is stored in integer cents, never as floats."]);
  repo.recordNoteUses("t_a", [n.id]);
  repo.recordNoteUses("t_a", [n.id]);
  repo.recordNoteUses("t_b", [n.id]);
  repo.recordNoteUses("t_c", [n.id]);
  repo.settleNoteUses("t_a", "rejected");
  repo.settleNoteUses("t_a", "approved");
  repo.settleNoteUses("t_b", "rejected");
  const [read] = repo.notes(project.id);
  assert.equal(read.approved, 1);
  assert.equal(read.sentBack, 1, "t_c has not ended yet");

  repo.deleteNote(n.id);
  assert.equal((repo.db.prepare("SELECT COUNT(*) AS c FROM note_uses").get() as { c: number }).c, 0, "a forgotten note takes its counts with it");
});

test("a note a run flags as wrong leaves the prompts until you keep it", () => {
  const { repo, project } = fresh();
  const other = repo.createProject({ name: "q", path: "C:\\work\\other", policy: POLICY });
  addNotes(repo, other.id, ["The invoice export uses commas between fields."]);
  addNotes(repo, project.id, ["The invoice export uses commas between fields.", "Money is stored in integer cents, never as floats."]);

  assert.equal(repo.flagNote(project.id, "invoice", "too short to say which", "t_x"), null);
  assert.equal(repo.flagNote(project.id, "A note nobody ever wrote down", "not there", "t_x"), null);
  const flagged = repo.flagNote(project.id, "- The invoice export uses", "It uses semicolons since the accounting import changed.", "t_x")!;
  assert.equal(flagged.flag?.task_id, "t_x");
  assert.ok(!repo.notesFor(project.id, "invoice export", 12).some((n) => n.id === flagged.id));
  assert.ok(!repo.notes(other.id)[0].flag, "only this project's note is flagged");

  repo.keepNote(flagged.id);
  assert.ok(repo.notesFor(project.id, "invoice export", 12).some((n) => n.id === flagged.id));
  assert.equal(repo.keepNote("n_missing"), null);
});
