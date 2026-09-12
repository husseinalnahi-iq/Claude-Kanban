import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";

test("migrations are idempotent and settings are seeded once", () => {
  const file = join(mkdtempSync(join(tmpdir(), "kdb-")), "k.db");
  const a = openDb(file);
  a.prepare("UPDATE settings SET value=? WHERE key='globalCap'").run("5");
  a.close();

  const b = openDb(file); // second open re-runs migrations
  const tables = (b.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ["projects", "tasks", "runs", "events", "messages", "approvals", "milestones", "settings"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  const cap = b.prepare("SELECT value FROM settings WHERE key='globalCap'").get() as { value: string };
  assert.equal(cap.value, "5", "seed must not overwrite an edited setting");
  const models = JSON.parse((b.prepare("SELECT value FROM settings WHERE key='models'").get() as { value: string }).value);
  assert.deepEqual(
    models.map((m: { id: string }) => m.id),
    ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  );
  b.close();
});

test("tasks table has the columns the engine relies on", () => {
  const db = openDb(":memory:");
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["summary", "note", "error", "base_sha", "skills_json", "branch", "worktree_path", "pipeline_json"]) {
    assert.ok(cols.includes(c), `tasks.${c} missing`);
  }
  db.close();
});
