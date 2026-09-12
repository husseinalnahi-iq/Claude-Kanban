import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }];

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ksteer-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "s", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } as any });
  return { dir, repo, bus, project, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("messagesAfter returns only messages posted after the cursor", () => {
  const s = setup();
  try {
    const t = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "", mode: "supervised", pipeline: [] });
    const before = s.repo.lastMessageRow(t.id);
    assert.equal(before, 0);
    s.repo.insertMessage({ task_id: t.id, from_task_id: null, from_run_id: null, body: "one" });
    const mid = s.repo.lastMessageRow(t.id);
    s.repo.insertMessage({ task_id: t.id, from_task_id: null, from_run_id: null, body: "two" });
    assert.deepEqual(s.repo.messagesAfter(t.id, mid).map((m) => m.body), ["two"]);
    assert.deepEqual(s.repo.messagesAfter(t.id, before).map((m) => m.body), ["one", "two"]);
  } finally {
    s.cleanup();
  }
});

/** A fake SDK that pauses mid-stage so the test can post a message, then drives the hooks the way Claude Code would. */
function pausableQuery(contexts: string[], stops: unknown[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) {
        /* drain */
      }
      yield { type: "system", subtype: "init", session_id: "s1" } as any;
      await gate;
      const post = params.options.hooks!.PostToolUse![0].hooks[0];
      const stop = params.options.hooks!.Stop![0].hooks[0];
      for (let i = 0; i < 2; i++) {
        const out = await post({ hook_event_name: "PostToolUse", tool_name: "Read" } as any, "tu1", { signal: new AbortController().signal });
        const ctx = (out as any).hookSpecificOutput?.additionalContext;
        if (ctx) contexts.push(ctx);
      }
      stops.push(await stop({ hook_event_name: "Stop" } as any, undefined, { signal: new AbortController().signal }));
      yield { type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0.01, session_id: "s1", modelUsage: {} } as any;
    })();
  return { fn, release: () => release() };
}

test("a message posted while a stage runs reaches Claude through the PostToolUse hook, once", async () => {
  const s = setup();
  const contexts: string[] = [];
  const stops: unknown[] = [];
  const q = pausableQuery(contexts, stops);
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: q.fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: ONE_STAGE });
    runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "running");
    runner.chat(task.id, "Use tabs, not spaces");
    q.release();
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(contexts.length, 1, "delivered exactly once");
    assert.match(contexts[0], /Use tabs, not spaces/);
    assert.deepEqual(stops, [{}], "nothing left for the Stop hook to hold the turn for");
    assert.equal(s.repo.messagesForTask(task.id).length, 1);
    const events = s.repo.eventsAfter(s.repo.runsForTask(task.id)[0].id);
    assert.ok(events.some((e) => e.type === "user:chat"), "the message shows in the transcript");
    assert.ok(events.some((e) => e.type === "board:steer"), "delivery is recorded");
  } finally {
    s.cleanup();
  }
});

test("a message that arrives with no tool call left blocks the turn's end so it is still read", async () => {
  const s = setup();
  const contexts: string[] = [];
  const stops: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) {
        /* drain */
      }
      yield { type: "system", subtype: "init", session_id: "s1" } as any;
      await gate;
      const stop = params.options.hooks!.Stop![0].hooks[0];
      stops.push(await stop({ hook_event_name: "Stop" } as any, undefined, { signal: new AbortController().signal }));
      yield { type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0.01, session_id: "s1", modelUsage: {} } as any;
    })();
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: ONE_STAGE });
    runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "running");
    runner.chat(task.id, "Also rename foo to bar");
    release();
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(contexts.length, 0);
    const out = stops[0] as { decision?: string; reason?: string };
    assert.equal(out.decision, "block");
    assert.match(out.reason ?? "", /rename foo to bar/);
  } finally {
    s.cleanup();
  }
});

test("chat after the run has finished still resumes the session as before", async () => {
  const s = setup();
  const prompts: string[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      let p = "";
      for await (const m of params.prompt) p += typeof m.message.content === "string" ? m.message.content : "";
      prompts.push(p);
      yield { type: "system", subtype: "init", session_id: "s1" } as any;
      yield { type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0.01, session_id: "s1", modelUsage: {} } as any;
    })();
  const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: fn });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: ONE_STAGE });
    runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    runner.chat(task.id, "one more thing");
    await until(() => prompts.length === 2);
    assert.equal(prompts[1], "one more thing");
    await until(() => s.repo.getTask(task.id)!.status === "review");
  } finally {
    s.cleanup();
  }
});
