import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SEED_PIPELINE } from "../src/db.ts";

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
    ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"],
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

test("a board still on a default the board used to ship moves to the new one; a default you edited stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "kdb-"));
  const pipe = (file: string) => JSON.parse((openDbOnce(file).prepare("SELECT value FROM settings WHERE key='defaultPipeline'").get() as { value: string }).value);
  const openDbOnce = (file: string) => {
    const db = openDb(file);
    after.push(db);
    return db;
  };
  const after: ReturnType<typeof openDb>[] = [];
  const set = (file: string, value: unknown) => {
    const db = openDb(file);
    db.prepare("UPDATE settings SET value=? WHERE key='defaultPipeline'").run(JSON.stringify(value));
    db.close();
  };
  try {
    const old = join(dir, "old.db");
    set(old, [
      { stage: "plan", model: "claude-fable-5-1", effort: "high" },
      { stage: "code", model: "claude-opus-5", effort: "high" },
      { stage: "review", model: "claude-sonnet-5", effort: "medium" },
    ]);
    assert.deepEqual(pipe(old), SEED_PIPELINE);
    assert.deepEqual(SEED_PIPELINE.map((s) => `${s.model}/${s.effort}`), ["claude-opus-5-5/high", "claude-opus-5-5/high", "claude-sonnet-5-5/high"]);
    // D270's medium-effort default, never touched, moves up to high (D366).
    const d270 = join(dir, "d270.db");
    set(d270, [
      { stage: "plan", model: "claude-opus-5-5", effort: "high" },
      { stage: "code", model: "claude-opus-5-5", effort: "medium" },
      { stage: "review", model: "claude-sonnet-5-5", effort: "medium" },
    ]);
    assert.deepEqual(pipe(d270), SEED_PIPELINE);

    const mine = join(dir, "mine.db");
    const edited = [
      { stage: "plan", model: "claude-fable-5-1", effort: "xhigh" },
      { stage: "code", model: "claude-opus-5-5", effort: "high" },
      { stage: "review", model: "claude-sonnet-5-5", effort: "medium" },
    ];
    set(mine, edited);
    assert.deepEqual(pipe(mine), edited, "one you changed is yours");
  } finally {
    for (const db of after) db.close();
  }
});
