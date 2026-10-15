import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { mayReachLive, readLock, releaseForBoard, releaseForSession, takeForBoard, takeForSession, LOCK_DIR, STALE_MS } from "../src/engine/liveLock.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";
import { setup, until } from "./helpers.ts";

function lockedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "klock-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, LOCK_DIR), { recursive: true });
  return dir;
}

test("a command that runs a program or touches a key file may reach a live system; git, ls and grep cannot (D432)", () => {
  assert.equal(mayReachLive("Bash", "python scripts/move_sidebar.py --apply"), true);
  assert.equal(mayReachLive("Bash", 'cd "C:/p" && python - <<EOF\nprint(1)\nEOF'), true);
  assert.equal(mayReachLive("PowerShell", "Invoke-RestMethod https://erp.example.com/api"), true);
  assert.equal(mayReachLive("Bash", "grep -n api .codex-secrets/erp.json"), true, "it touches a key file");
  assert.equal(mayReachLive("Bash", "git status && ls docs"), false);
  assert.equal(mayReachLive("Read", "python x.py"), false, "only commands");
});

test("a card and your Claude Code session take turns on the live lock; a dead or quiet holder does not keep it (D432)", () => {
  const dir = lockedProject();
  try {
    const card = { id: "t_1", title: "Move invoices" };
    assert.equal(takeForBoard(dir, card, process.pid), null);
    assert.equal(takeForBoard(dir, { id: "t_2", title: "Other card" }, process.pid), null, "the board's cards share it");
    assert.deepEqual(takeForSession(dir, "s1")?.tasks?.map((t) => t.title), ["Move invoices", "Other card"], "your session sees which cards hold it");
    releaseForBoard(dir, "t_1", process.pid);
    assert.ok(takeForSession(dir, "s1"), "still held by the other card");
    releaseForBoard(dir, "t_2", process.pid);
    assert.equal(readLock(dir), null);

    assert.equal(takeForSession(dir, "s1"), null);
    assert.equal(takeForBoard(dir, card, process.pid)?.session, "s1", "the card waits for your session");
    assert.equal(takeForBoard(dir, card, process.pid, Date.now() + STALE_MS + 1), null, "a session quiet for half an hour no longer holds it");
    releaseForBoard(dir, card.id, process.pid);

    // A board that died with the lock: its pid is gone.
    assert.equal(takeForBoard(dir, card, 999_999_999), null);
    assert.equal(takeForSession(dir, "s1"), null);
    releaseForSession(dir, "s1");
    assert.equal(readLock(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Claude Code hook asks you first while a card holds the lock, and gives your lock back when the reply ends (D432)", () => {
  const dir = lockedProject();
  const hook = (event: string, input: object) =>
    execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "..", "src", "engine", "liveLockHook.ts"), event], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, KANBAN_TASK_ID: "" },
    });
  const pre = { session_id: "s1", cwd: dir, tool_name: "Bash", tool_input: { command: "python scripts/move.py" } };
  try {
    takeForBoard(dir, { id: "t_1", title: "Move invoices" }, process.pid);
    const out = JSON.parse(hook("pre", pre));
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /“Move invoices”/);
    assert.equal(hook("pre", { ...pre, tool_input: { command: "git status" } }), "", "a command that cannot reach a live system is not held up");

    releaseForBoard(dir, "t_1", process.pid);
    assert.equal(hook("pre", pre), "");
    assert.equal(readLock(dir)?.session, "s1", "your session now holds it");
    hook("stop", { session_id: "s1", cwd: dir });
    assert.equal(readLock(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a card's live command waits while your Claude Code session holds the lock, and goes on when it is free (D432)", async () => {
  const CODE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
  let ran = false;
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) break;
      const o = params.options as Options;
      yield { type: "system", subtype: "init", session_id: "s" } as never;
      const signal = { signal: new AbortController().signal };
      await Promise.all(o.hooks!.PreToolUse!.flatMap((m) => m.hooks.map((h) => h({ tool_name: "Bash", tool_input: { command: "python move.py" } } as never, "t1", signal))));
      ran = true;
      yield { type: "result", subtype: "success", is_error: false, result: "moved", total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const s = setup(fn);
  try {
    mkdirSync(join(s.dir, LOCK_DIR), { recursive: true });
    takeForSession(s.dir, "yours");
    const task = s.repo.createTask({ project_id: s.project.id, title: "Move invoices", mode: "autonomous", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.summary?.startsWith("Waiting for your Claude Code session") ?? false);
    assert.equal(ran, false);
    releaseForSession(s.dir, "yours");
    await until(() => ran, 20_000);
    await until(() => !s.runner.isBusy(task.id));
    assert.equal(readLock(s.dir), null, "the card gives the lock back when its stage ends");
  } finally {
    await s.cleanup();
  }
});
