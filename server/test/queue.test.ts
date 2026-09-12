import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { RunQueue, type QueueItem } from "../src/engine/queue.ts";
import type { Provider, Stage } from "../src/types.ts";
import { fakeQuery, setup, until } from "./helpers.ts";

const CODE: Stage[] = [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }];

/** A queue whose starts never settle on their own, so a test can decide when a slot frees. */
function manual(opts: Partial<ConstructorParameters<typeof RunQueue>[0]> = {}) {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const q = new RunQueue({
    globalCap: () => 1,
    projectCap: () => 8,
    forcedCap: () => 3,
    start: (item: QueueItem) =>
      new Promise<void>((resolve) => {
        started.push(item.taskId);
        finish.set(item.taskId, resolve);
      }),
    ...opts,
  });
  return { q, started, done: (id: string) => finish.get(id)!() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- caps

test("serial cap runs one at a time, in order", async () => {
  const { q, started, done } = manual();
  for (const id of ["a", "b", "c"]) q.enqueue({ taskId: id, projectId: "p" });

  assert.deepEqual(started, ["a"]);
  done("a");
  await tick();
  assert.deepEqual(started, ["a", "b"]);
  done("b");
  await tick();
  assert.deepEqual(started, ["a", "b", "c"]);
});

test("a forced task starts alongside, and does not eat the serial slot", async () => {
  const { q, started, done } = manual();
  q.enqueue({ taskId: "a", projectId: "p" });
  q.enqueue({ taskId: "urgent", projectId: "p", force: true });
  q.enqueue({ taskId: "b", projectId: "p" });

  // "a" holds the one ordinary slot; "urgent" runs beside it; "b" still waits its turn.
  assert.deepEqual(started, ["a", "urgent"]);
  assert.deepEqual(q.snapshot().waiting, ["b"]);

  // The forced run finishing must not release the ordinary lane.
  done("urgent");
  await tick();
  assert.deepEqual(started, ["a", "urgent"]);

  done("a");
  await tick();
  assert.deepEqual(started, ["a", "urgent", "b"]);
});

test("forced runs answer to their own ceiling", async () => {
  const { q, started } = manual({ forcedCap: () => 2 });
  for (const id of ["f1", "f2", "f3"]) q.enqueue({ taskId: id, projectId: "p", force: true });
  assert.deepEqual(started, ["f1", "f2"]);
  assert.deepEqual(q.snapshot().waiting, ["f3"]);
});

test("a second enqueue promotes a waiting task to forced, never back", async () => {
  const { q, started } = manual();
  q.enqueue({ taskId: "a", projectId: "p" });
  q.enqueue({ taskId: "b", projectId: "p" });
  assert.deepEqual(q.snapshot().waiting, ["b"]);

  q.enqueue({ taskId: "b", projectId: "p", force: true });
  assert.deepEqual(started, ["a", "b"]);
});

test("the per-project cap still applies below the global one", async () => {
  const { q, started } = manual({ globalCap: () => 8, projectCap: (pid) => (pid === "tight" ? 1 : 8) });
  q.enqueue({ taskId: "t1", projectId: "tight" });
  q.enqueue({ taskId: "t2", projectId: "tight" });
  q.enqueue({ taskId: "o1", projectId: "other" });
  assert.deepEqual(started, ["t1", "o1"]);
  assert.deepEqual(q.snapshot().waiting, ["t2"]);
});

test("canStart holds an item without consuming a slot", async () => {
  let open = false;
  const { q, started } = manual({ globalCap: () => 8, canStart: (i) => open || i.taskId !== "held" });
  q.enqueue({ taskId: "held", projectId: "p" });
  q.enqueue({ taskId: "free", projectId: "p" });

  assert.deepEqual(started, ["free"]);
  assert.deepEqual(q.snapshot().waiting, ["held"]);

  open = true;
  q.pump();
  assert.deepEqual(started, ["free", "held"]);
});

// ---------------------------------------------------------------- the usage-limit gate

/** A paused task with a reset time in the future is what "the Claude window is shut" looks like. */
function pauseOne(repo: Repo, projectId: string, minutes = 30): string {
  const t = repo.createTask({ project_id: projectId, title: "hit the wall", spec_md: "", pipeline: CODE } as never);
  repo.updateTask(t.id, { status: "paused", resume_at: new Date(Date.now() + minutes * 60_000).toISOString() });
  return t.id;
}

const OLLAMA: Provider = {
  id: "ollama", label: "Ollama", kind: "anthropic-compatible", enabled: true,
  baseUrl: "http://localhost:11434", authRef: "OLLAMA_TOKEN",
  models: [{ id: "qwen3-coder", label: "qwen3-coder" }], mayEditFiles: false,
};

test("Claude work waits out the window; delegated work keeps going", async () => {
  const { repo, project, runner, cleanup } = setup(fakeQuery().fn);
  try {
    repo.updateSettings({ providers: [OLLAMA] } as never);
    pauseOne(repo, project.id);

    const onClaude = repo.createTask({ project_id: project.id, title: "claude", spec_md: "x", pipeline: CODE } as never);
    const delegated = repo.createTask({
      project_id: project.id, title: "delegated", spec_md: "x",
      pipeline: [{ ...CODE[0], provider: "ollama", model: "qwen3-coder" }],
    } as never);

    runner.queueTask(onClaude.id);
    runner.queueTask(delegated.id);

    await until(() => repo.getTask(delegated.id)!.status === "review");
    assert.equal(repo.getTask(onClaude.id)!.status, "queued", "Claude work should still be waiting for the window");
    assert.ok(runner.queue.snapshot().waiting.includes(onClaude.id));
  } finally {
    cleanup();
  }
});

test("a delegated plan stage with a Claude critic counts as Claude work", async () => {
  const { repo, project, runner, cleanup } = setup(fakeQuery().fn);
  try {
    repo.updateSettings({
      providers: [OLLAMA],
      debate: { enabled: true, critic: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" } },
    } as never);
    pauseOne(repo, project.id);

    const t = repo.createTask({
      project_id: project.id, title: "debated", spec_md: "x",
      pipeline: [{ stage: "plan", model: "qwen3-coder", effort: "low", provider: "ollama" }],
    } as never);
    runner.queueTask(t.id);

    await tick();
    assert.equal(repo.getTask(t.id)!.status, "queued");
    assert.ok(runner.queue.snapshot().waiting.includes(t.id));
  } finally {
    cleanup();
  }
});

test("when the window reopens, held tasks start", async () => {
  const { repo, project, runner, cleanup } = setup(fakeQuery().fn);
  try {
    const pausedId = pauseOne(repo, project.id);
    const held = repo.createTask({ project_id: project.id, title: "held", spec_md: "x", pipeline: CODE } as never);
    runner.queueTask(held.id);
    await tick();
    assert.equal(repo.getTask(held.id)!.status, "queued");

    // The window passes: the paused task's own time comes, and the gate opens with it.
    repo.updateTask(pausedId, { resume_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(runner.limitedUntil(), null);
    runner.resumeDue();

    await until(() => repo.getTask(held.id)!.status === "review");
  } finally {
    cleanup();
  }
});

test("Run now does not force Claude work into a shut window", async () => {
  const { repo, project, runner, cleanup } = setup(fakeQuery().fn);
  try {
    pauseOne(repo, project.id);
    const t = repo.createTask({ project_id: project.id, title: "urgent", spec_md: "x", pipeline: CODE } as never);
    runner.queueTask(t.id, { fromStage: 0 }, true);

    await tick();
    assert.equal(repo.getTask(t.id)!.status, "queued", "forcing skips the caps, not the limit");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- the serial default

test("serial is on for a new board and left off for an existing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "kdb-"));
  try {
    const file = join(dir, "board.db");
    const fresh = openDb(file);
    assert.equal(new Repo(fresh).getSettings().serial, true, "a fresh state directory runs one at a time");
    // An upgrade: settings already exist, but this key has never been seen.
    fresh.prepare("DELETE FROM settings WHERE key = 'serial'").run();
    fresh.close();

    const upgraded = openDb(file);
    assert.equal(new Repo(upgraded).getSettings().serial, false, "an existing board keeps behaving as it did");
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
