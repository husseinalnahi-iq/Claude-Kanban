import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { removeTemp } from "./helpers.ts";

test("a new board allows 500 turns and $20 per stage, and $60 per task (D402)", () => {
  const s = new Repo(openDb(":memory:")).getSettings();
  assert.equal(s.maxTurnsPerStage, 500);
  assert.equal(s.maxCostPerStageUsd, 20);
  assert.equal(s.maxCostPerTaskUsd, 60);
});

test("a board still on the old ceilings takes the new ones once, and a ceiling someone chose stays (D402)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kceil-"));
  const file = join(dir, "kanban.db");
  try {
    const old = openDb(file);
    // As a board from before D402 would be: the old defaults, one of them changed by hand.
    const set = old.prepare("UPDATE settings SET value = ? WHERE key = ?");
    set.run("60", "maxTurnsPerStage");
    set.run("5", "maxCostPerStageUsd");
    set.run("40", "maxCostPerTaskUsd");
    old.prepare("DELETE FROM settings WHERE key IN ('ceilingsRaisedD402', 'taskCeiling60D402')").run();
    old.close();

    const upgraded = new Repo(openDb(file));
    let s = upgraded.getSettings();
    assert.equal(s.maxTurnsPerStage, 500);
    assert.equal(s.maxCostPerStageUsd, 20);
    assert.equal(s.maxCostPerTaskUsd, 40, "a value someone chose is kept");

    // Set back to 60 on purpose afterwards: the next start leaves it.
    upgraded.updateSettings({ maxTurnsPerStage: 60 });
    s = new Repo(openDb(file)).getSettings();
    assert.equal(s.maxTurnsPerStage, 60);
  } finally {
    await removeTemp(dir).catch(() => {});
  }
});
