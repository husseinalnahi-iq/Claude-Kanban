# Steer a running task, and pause at the cost ceiling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) A message typed on a task while it is working reaches Claude at its next step, without stopping the run. (2) A task that reaches a cost ceiling pauses and asks "Continue with $N more?" instead of failing.

**Architecture:**
- Steering: messages already live in the `messages` table and are read into the *next* stage's prompt. A `PostToolUse` hook now also reads any message that arrived after the stage started and hands it to Claude as `additionalContext`; a `Stop` hook blocks the turn's end while an undelivered message is waiting, so nothing typed is lost. A cursor on the run's `Active` record (the last message rowid seen) decides "new". `chat()` stores the message instead of refusing while a Claude SDK stage is live.
- Cost pause: the three places that fail a task for money (task ceiling at a stage boundary, the SDK's `error_max_budget_usd`, the board's own metering of a foreign provider) call `pauseForCost()` instead. It sets `status: paused` with `pause_reason: "cost"` and no `resume_at`, so the existing limit-resume timer ignores it. **Continue** adds one per-stage ceiling to the task's own `budget_extra_usd` and retries the stage in the same session. **Stop** marks it failed as before.
- No new alert kind: a cost pause is reported as "needs you" (the `approval` kind) because that is what it is.

**Tech Stack:** Node 24 `node:sqlite`, Fastify + zod, `@anthropic-ai/claude-agent-sdk` 0.3.268 hooks, React + Tailwind, `node --test` with tsx.

---

## File map

| File | Change |
|---|---|
| `server/src/repo.ts` | `lastMessageRow(taskId)`, `messagesAfter(taskId, row)`, `pause_reason` / `budget_extra_usd` mapping |
| `server/src/db.ts` | two `LATER_COLUMNS` rows |
| `server/src/types.ts` | `Task.pause_reason`, `Task.budget_extra_usd` |
| `server/src/engine/runner.ts` | `Active.messageCursor`, `steerHooks()`, `chat()` while live, `pauseForCost()`, `continueTask()`, the three fail sites |
| `server/src/routes/tasks.ts` | `POST /tasks/:id/continue` |
| `server/test/steer.test.ts` (new) | steering tests |
| `server/test/costpause.test.ts` (new) | cost-pause tests |
| `web/src/lib/api.ts` | `continueTask` |
| `web/src/views/TaskDrawer.tsx` | Chat box open while running; Continue / Stop buttons |
| `web/src/views/Board.tsx` | card badge and Continue button for a cost pause |
| `web/src/lib/alerts.ts`, `web/src/lib/format.ts` | cost pause reads as "needs you" |
| `web/src/components/tour/features.ts`, `web/src/views/Tour.tsx`, `README.md`, `docs/DECISIONS.md` | guidance |

---

### Task 1: Repo — message cursor and new task columns

**Files:**
- Modify: `server/src/repo.ts` (messages section ~line 684; `toTask` ~line 87; column map ~line 228)
- Modify: `server/src/db.ts` `LATER_COLUMNS`
- Modify: `server/src/types.ts` `Task`
- Test: `server/test/steer.test.ts`

- [ ] **Step 1: Failing test**

```ts
// server/test/steer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

test("messagesAfter returns only messages posted after the cursor", () => {
  const repo = new Repo(openDb(":memory:"));
  const p = repo.createProject({ name: "p", path: "/tmp/x", policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } as any });
  const t = repo.createTask({ project_id: p.id, title: "t", spec_md: "", mode: "supervised", pipeline: [] });
  const before = repo.lastMessageRow(t.id);
  assert.equal(before, 0);
  repo.insertMessage({ task_id: t.id, from_task_id: null, from_run_id: null, body: "one" });
  const mid = repo.lastMessageRow(t.id);
  repo.insertMessage({ task_id: t.id, from_task_id: null, from_run_id: null, body: "two" });
  assert.deepEqual(repo.messagesAfter(t.id, mid).map((m) => m.body), ["two"]);
  assert.deepEqual(repo.messagesAfter(t.id, before).map((m) => m.body), ["one", "two"]);
});
```

- [ ] **Step 2: Run** `cd server && node --test --import tsx test/steer.test.ts` → FAIL: `repo.lastMessageRow is not a function`.

- [ ] **Step 3: Implement** in `repo.ts` after `inboundMessages`:

```ts
  /** The rowid of the newest message to this task, or 0. A run notes it at start to know what is "new". */
  lastMessageRow(taskId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM messages WHERE task_id = ?").get(taskId) as { m: number };
    return Number(r.m);
  }

  /** Messages to a task that arrived after `row`, oldest first, with the newest rowid so the caller can advance. */
  messagesAfter(taskId: string, row: number): (Message & { rid: number })[] {
    const rows = this.db.prepare("SELECT rowid AS rid, * FROM messages WHERE task_id = ? AND rowid > ? ORDER BY rowid").all(taskId, row) as Row[];
    return rows.map((r) => ({ ...toMessage(r), rid: Number(r.rid) }));
  }
```

Then in `types.ts` `Task`, after `resume_at`:

```ts
  /** Why the task is paused: a usage limit (resumes by itself) or a cost ceiling (waits for Continue). */
  pause_reason: "limit" | "cost" | null;
  /** Extra dollars granted to this task by pressing Continue, on top of the global per-task ceiling. */
  budget_extra_usd: number;
```

In `db.ts` `LATER_COLUMNS` append:

```ts
  { table: "tasks", column: "pause_reason", ddl: "pause_reason TEXT" },
  { table: "tasks", column: "budget_extra_usd", ddl: "budget_extra_usd REAL NOT NULL DEFAULT 0" },
```

In `repo.ts` `toTask` add `pause_reason: (r.pause_reason as Task["pause_reason"]) ?? null, budget_extra_usd: Number(r.budget_extra_usd ?? 0),` and in the update column map (line ~228) add `pause_reason: str, budget_extra_usd: num` (use whatever helper the map uses for numbers; check `cost_usd` handling in the runs map).

- [ ] **Step 4: Run** the test and `npm run typecheck` → PASS (fix any `createTask` sites that build a Task literal in tests).

---

### Task 2: Runner — steer hooks and `chat()` while live

**Files:**
- Modify: `server/src/engine/runner.ts` (`Active` line 70; `runQuery` options ~line 795; `this.active.set` line 735; `chat()` line 1619)
- Test: `server/test/steer.test.ts`

- [ ] **Step 1: Failing test** — a fake query whose "assistant" step calls the PostToolUse hook, and asserts the message arrives as `additionalContext`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }];
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 5)); }
}

test("a message posted while a stage runs reaches Claude through the PostToolUse hook, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksteer-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "s", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } as any });
  const contexts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fn: QueryFn = (params) => (async function* () {
    for await (const _ of params.prompt) { /* drain */ }
    yield { type: "system", subtype: "init", session_id: "s1" } as any;
    await gate; // the test posts a message here
    const hook = params.options.hooks!.PostToolUse![0].hooks[0];
    for (let i = 0; i < 2; i++) {
      const out = await hook({ hook_event_name: "PostToolUse", tool_name: "Read" } as any, "tu1", { signal: new AbortController().signal });
      const ctx = (out as any).hookSpecificOutput?.additionalContext;
      if (ctx) contexts.push(ctx);
    }
    yield { type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0.01, session_id: "s1", modelUsage: {} } as any;
  })();
  const runner = new TaskRunner({ repo, bus, queryFn: fn });
  try {
    const task = repo.createTask({ project_id: project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: ONE_STAGE });
    runner.queueTask(task.id);
    await until(() => repo.getTask(task.id)!.status === "running");
    runner.chat(task.id, "Use tabs, not spaces");
    release();
    await until(() => repo.getTask(task.id)!.status === "review");
    assert.equal(contexts.length, 1);
    assert.match(contexts[0], /Use tabs, not spaces/);
    assert.equal(repo.messagesForTask(task.id).length, 1);
    const events = repo.eventsForRun(repo.runsForTask(task.id)[0].id, 0, 100);
    assert.ok(events.some((e) => e.type === "user:chat"), "the message shows in the transcript");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

(Check the exact name of the events reader in `repo.ts` — the `SELECT * FROM events WHERE run_id = ? AND id > ?` method — and use it.)

- [ ] **Step 2: Run** → FAIL with `ConflictError: Task is busy`.

- [ ] **Step 3: Implement.**

`Active`:

```ts
interface Active {
  runId: string;
  abort: AbortController;
  stageStatus: TaskStatus;
  /** Newest message rowid already in this stage's prompt; anything later is handed over live. */
  messageCursor: number;
  /** True for a Claude SDK run, whose hooks can carry a message in. CLI / HTTP providers cannot. */
  steerable: boolean;
}
```

At `this.active.set(...)` (line 735) use `{ runId: run.id, abort, stageStatus: a.stageStatus, messageCursor: this.repo.lastMessageRow(task.id), steerable: !(res.adapter.run && res.provider) }` — move the `res` resolution above it if needed (it is computed a few lines later; hoist it).

New private method next to `verifyStopHook`:

```ts
  /**
   * Live steering: a message posted while a stage runs is handed to Claude at its next tool call as
   * extra context, and a turn is not allowed to end while one is still waiting. The cursor advances
   * synchronously before any await, so parallel tool calls cannot deliver the same message twice.
   */
  private steerHooks(taskId: string, runId: string): { PostToolUse: HookCallbackMatcher[]; Stop: HookCallbackMatcher[] } {
    const take = (): string | null => {
      const active = this.active.get(taskId);
      if (!active) return null;
      const fresh = this.repo.messagesAfter(taskId, active.messageCursor);
      if (!fresh.length) return null;
      active.messageCursor = fresh[fresh.length - 1].rid;
      const lines = fresh.map((m) => {
        const from = m.from_task_id ? `task ${m.from_task_id} (${this.repo.getTask(m.from_task_id)?.title ?? "?"})` : "the user";
        return `From ${from}, sent while you were working:\n${m.body}`;
      });
      const event = this.repo.insertEvent(runId, "board:steer", { type: "steer", count: fresh.length });
      this.bus.publish({ type: "event", runId, taskId, event });
      return `${lines.join("\n\n")}\n\nTake this into account from here on. Reply to it in your next message.`;
    };
    return {
      PostToolUse: [{ hooks: [async () => { const ctx = take(); return ctx ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } } : {}; }] }],
      Stop: [{ hooks: [async () => { const ctx = take(); return ctx ? { decision: "block" as const, reason: ctx } : {}; }] }],
    };
  }
```

In `baseOptions.hooks`, add the steer hooks and merge the Stop array with the verify one:

```ts
      hooks: (() => {
        const steer = this.steerHooks(task.id, run.id);
        return {
          ...(autonomous ? {} : { PreToolUse: FORCE_ASK }),
          PostToolUse: steer.PostToolUse,
          // A message waiting is checked first; then the deterministic verify gate.
          Stop: [...steer.Stop, ...(a.verifyCommand ? this.verifyStopHook(a.verifyCommand, a.cwd, run.id, task.id) : [])],
        };
      })(),
```

`chat()` — replace the busy refusal at the top:

```ts
  chat(taskId: string, text: string): Run {
    const { task, project } = this.load(taskId);
    const live = this.active.get(taskId);
    if (live) {
      // The stage is running: store the message and let the hooks hand it over at the next step.
      if (!live.steerable) throw new ConflictError("This stage runs on another provider, which cannot take a message mid-run. Wait for it to finish, or Stop it.");
      this.repo.insertMessage({ task_id: taskId, from_task_id: null, from_run_id: null, body: text });
      const run = this.repo.getRun(live.runId)!;
      const event = this.repo.insertEvent(run.id, "user:chat", { type: "user_chat", text, live: true });
      this.bus.publish({ type: "event", runId: run.id, taskId, event });
      return run;
    }
    if (this.isBusy(taskId)) throw new ConflictError("Task is busy; wait for the current run to finish.");
    // ... unchanged from here
```

- [ ] **Step 4: Run** steer test + `runner.test.ts` + `usage.test.ts` → PASS. `npm run typecheck` → clean.

---

### Task 3: Runner — pause at the cost ceiling, Continue, Stop

**Files:**
- Modify: `server/src/engine/runner.ts` (task ceiling ~line 455; result handling ~line 921; foreign metering ~line 880; `pauseForLimit` ~line 1448; `resumeDue` ~1520)
- Modify: `server/src/routes/tasks.ts`
- Test: `server/test/costpause.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// server/test/costpause.test.ts
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

const TWO: Stage[] = [
  { stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" },
  { stage: "review", model: "claude-haiku-4-5-20251001", effort: "low" },
];
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 5)); }
}
function stageCosting(cost: number, subtype: "success" | "error_max_budget_usd" = "success"): QueryFn {
  return (params) => (async function* () {
    for await (const _ of params.prompt) { /* drain */ }
    yield { type: "system", subtype: "init", session_id: "s1" } as any;
    yield { type: "result", subtype, is_error: subtype !== "success", result: "DONE", errors: subtype === "success" ? [] : ["budget"], total_cost_usd: cost, session_id: "s1", modelUsage: {} } as any;
  })();
}
function setup(fn: QueryFn) {
  const dir = mkdtempSync(join(tmpdir(), "kcost-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "c", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } as any });
  const runner = new TaskRunner({ repo, bus, queryFn: fn });
  return { repo, project, runner, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("reaching the task ceiling pauses for a decision instead of failing; Continue grants one stage ceiling and resumes", async () => {
  const s = setup(stageCosting(1.0));
  try {
    s.repo.updateSettings({ maxCostPerTaskUsd: 0.5, maxCostPerStageUsd: 2 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    const paused = s.repo.getTask(task.id)!;
    assert.equal(paused.pause_reason, "cost");
    assert.equal(paused.resume_at, null);
    assert.match(paused.note ?? "", /\$1\.00/);
    s.runner.continueTask(task.id);
    assert.equal(s.repo.getTask(task.id)!.budget_extra_usd, 2);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(s.repo.runsForTask(task.id).length, 2);
  } finally { s.cleanup(); }
});

test("the SDK's own per-stage budget stop pauses too, and Stop fails it with the reason kept", async () => {
  const s = setup(stageCosting(0.3, "error_max_budget_usd"));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    assert.equal(s.repo.getTask(task.id)!.pause_reason, "cost");
    s.runner.stopPaused(task.id);
    const t = s.repo.getTask(task.id)!;
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /ceiling/);
  } finally { s.cleanup(); }
});

test("a cost pause is left alone by the usage-limit resume timer", async () => {
  const s = setup(stageCosting(1.0));
  try {
    s.repo.updateSettings({ maxCostPerTaskUsd: 0.5 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "paused");
    assert.deepEqual(s.runner.resumeDue(Date.now() + 1e9), []);
    assert.equal(s.repo.getTask(task.id)!.status, "paused");
  } finally { s.cleanup(); }
});
```

(Check the real name of the settings writer in `repo.ts` — `updateSettings` or `setSettings` — and the settings key names.)

- [ ] **Step 2: Run** → FAIL (`continueTask is not a function`, status is `failed`).

- [ ] **Step 3: Implement.**

Helper next to `pauseForLimit`:

```ts
  /** The per-task ceiling for this task: the global figure plus whatever Continue has granted it. */
  private taskCeiling(task: Task): number {
    return this.repo.getSettings().maxCostPerTaskUsd + (task.budget_extra_usd ?? 0);
  }

  /**
   * Money ran out: pause for a decision rather than fail. Unlike a usage limit there is no resume
   * time — the person picks Continue (one more stage ceiling) or Stop. `stageIndex` is where Retry
   * resumes from; the session is kept, so nothing done so far is redone.
   */
  private pauseForCost(taskId: string, spent: number, ceiling: number, detail: string): void {
    const grant = this.repo.getSettings().maxCostPerStageUsd;
    this.setTask(taskId, {
      status: "paused",
      pause_reason: "cost",
      resume_at: null,
      error: null,
      note: `Stopped at $${spent.toFixed(2)}: ${detail} (ceiling $${ceiling.toFixed(2)}). Continue lets it spend up to $${grant.toFixed(2)} more, in the same session; Stop keeps what it did so far.`,
    });
  }

  /** Continue a task paused at its cost ceiling: grant one more stage ceiling and resume where it stopped. */
  continueTask(taskId: string): Task {
    const { task } = this.load(taskId);
    if (task.status !== "paused" || task.pause_reason !== "cost") throw new ConflictError("Only a task paused at its cost ceiling can be continued.");
    const grant = this.repo.getSettings().maxCostPerStageUsd;
    this.setTask(taskId, { status: "backlog", pause_reason: null, note: null, budget_extra_usd: (task.budget_extra_usd ?? 0) + grant });
    return this.retryTask(taskId);
  }

  /** Give up on a task paused at its cost ceiling: it fails with the reason, so Retry and Back to backlog work as usual. */
  stopPaused(taskId: string): Task {
    const { task } = this.load(taskId);
    if (task.status !== "paused" || task.pause_reason !== "cost") throw new ConflictError("Only a task paused at its cost ceiling can be stopped this way.");
    return this.setTask(taskId, { status: "failed", pause_reason: null, error: task.note ?? "Stopped at its cost ceiling.", note: null });
  }
```

`pauseForLimit`: add `pause_reason: "limit"` to its `setTask`. `resumeDue` and `limitedUntil` already skip tasks with no `resume_at`; in `resumeDue` also clear `pause_reason: null`. Also in `resumeDue`, `resumeNow` guard `task.pause_reason === "cost"` → throw `ConflictError("This task is waiting on Continue, not on a usage window.")`.

Task ceiling at the stage boundary (line ~455):

```ts
        const capped = this.taskCeiling(task);
        const spent = this.repo.taskCost(taskId);
        if (spent >= capped) {
          this.pauseForCost(taskId, spent, capped, "this task reached its ceiling");
          return;
        }
```

After `runQuery` returns in the stage loop, before `pauseForLimit`:

```ts
        if (!outcome.ok) {
          if (outcome.budgetStop) {
            this.pauseForCost(taskId, this.repo.taskCost(taskId), this.taskCeiling(task), outcome.error ?? "the stage reached its ceiling");
            return;
          }
          if (outcome.providerId === ANTHROPIC_PROVIDER_ID && this.pauseForLimit(taskId, outcome.error)) return;
```

`runQuery` return type gains `budgetStop: boolean`. In the result branch: `const budgetStop = r.subtype === "error_max_budget_usd";` and carry it in `result`. In the foreign metering `thrown = ...` branch set a local `let budgetStop = true`. Final: `return { ok: !error, error, providerId: res.id, budgetStop: Boolean(budgetStop) && !a.ctl.stopped }`. Write the error text for the SDK case as `` `this stage reached its own ceiling of $${settings.maxCostPerStageUsd.toFixed(2)}` `` so the note reads well.

Route in `tasks.ts` after `/resume`:

```ts
  app.post("/tasks/:id/continue", async (req) => runner.continueTask(idOf(req)));
  app.post("/tasks/:id/stop-paused", async (req) => runner.stopPaused(idOf(req)));
```

- [ ] **Step 4: Run** `costpause`, `usage`, `runner`, `resume` tests → PASS. Typecheck clean.

---

### Task 4: Web — chat while running, Continue / Stop, card badge, alerts

**Files:**
- Modify: `web/src/lib/api.ts`, `web/src/views/TaskDrawer.tsx` (`TranscriptTab` ~line 320, actions ~line 495), `web/src/views/Board.tsx` (`phase()` line 38, paused block line 173), `web/src/lib/alerts.ts` line 197, `web/src/lib/format.ts` line 79

- [ ] **Step 1: api.ts**

```ts
  continueTask: (id: string) => req<Task>("POST", `/tasks/${id}/continue`),
  stopPaused: (id: string) => req<Task>("POST", `/tasks/${id}/stop-paused`),
```

- [ ] **Step 2: TaskDrawer chat box.** In `TranscriptTab` (chat mode): the hint line becomes

```tsx
        <div className="text-[12px] text-ink-400">
          {d.busy
            ? <>It is working right now. <b className="text-ink-200">Type what you want it to know</b> — it reads it at its next step and carries on.</>
            : <>Continue this session (<span className="font-mono">{run?.stage} · {run && modelLabel(run)}</span>) with your message.</>}
        </div>
```

The textarea placeholder: `d.busy ? "Tell it something while it works… (Ctrl+Enter)" : "Continue this session… (Ctrl+Enter to send)"`. The Send button: `disabled={!d.busy && !latest?.session_id}` (busy no longer disables). A server refusal (another provider) shows through the existing `ErrorLine`.

- [ ] **Step 3: TaskDrawer actions.** After the `live` Stop button add:

```tsx
        {t.status === "paused" && t.pause_reason === "cost" && !live ? (
          <>
            <Button variant="go" busy={busy} onClick={() => run(() => api.continueTask(t.id))} title={`Let it spend up to $${(settings?.maxCostPerStageUsd ?? 0).toFixed(2)} more, in the same session`}>
              ▶ Continue (+${(settings?.maxCostPerStageUsd ?? 0).toFixed(2)})
            </Button>
            <Button variant="danger" busy={busy} onClick={() => run(() => api.stopPaused(t.id))} title="Stop here. What it did so far is kept; Retry is still possible later.">■ Stop</Button>
          </>
        ) : null}
```

Where `settings` is not in scope, read `maxCostPerStageUsd` from the settings hook already used for `settings?.serial` (line ~503).

- [ ] **Step 4: Board.tsx.** In `phase()`, before the paused line:

```ts
  if (card.status === "paused" && card.pause_reason === "cost") return { text: "needs you · cost", tone: "border-rose/60 text-rose", title: "It reached its cost ceiling — open the task and press Continue or Stop" };
```

Replace the paused block's condition with `card.status === "paused" && card.pause_reason !== "cost" && card.resume_at` and add a sibling:

```tsx
      {card.status === "paused" && card.pause_reason === "cost" ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-rose/40 bg-rose/5 px-2 py-1 text-[11.5px] text-rose">
          <span title={card.note ?? undefined}>reached its cost ceiling</span>
          <button className="ml-auto cursor-pointer rounded border border-rose/40 px-1.5 py-px font-mono text-[10.5px] hover:bg-rose/10" title="Let it spend one more stage's worth and carry on" onClick={(e) => act(e, () => api.continueTask(card.id))}>continue</button>
        </div>
      ) : null}
```

Sorting (line ~289): a cost pause should sort with "needs you", not last — find the comparator and treat `paused && pause_reason === "cost"` like `approval`.

- [ ] **Step 5: alerts.ts** line 197:

```ts
    else if (cur === "paused" && t.pause_reason === "cost") taskAlert("approval", t, "reached its cost ceiling — Continue or Stop");
    else if (cur === "paused") taskAlert("paused", t, ...unchanged);
```

`format.ts` line 79 label stays; the card badge already says which.

- [ ] **Step 6:** `npm run typecheck`, then `npm run dev` and check in the browser: open a running task's Chat tab, send a message, see it in the transcript; set the per-task ceiling to $0.01 in Settings, queue a task, see the rose "needs you · cost" card, press Continue.

---

### Task 5: Guidance — Tour, README, DECISIONS

**Files:**
- Modify: `web/src/components/tour/features.ts` (group "You stay in charge" ~line 122; feature `cost` ~line 184; `recall` ~line 204)
- Modify: `web/src/views/Tour.tsx` lines 66 and 175
- Modify: `README.md` (Sessions section ~line 597; Guardrails cost-ceiling bullet ~line 512; "What a task costs" ~line 553)
- Modify: `docs/DECISIONS.md` (also resolve the stray conflict markers at lines 319–357)

- [ ] **Step 1: features.ts** — add to "You stay in charge", after `modes`:

```ts
      {
        id: "steer",
        icon: "✎",
        color: "var(--color-amber)",
        title: "Talk to it while it works",
        pitch: "Open a running task's Chat tab and type — \"use the blue from the header\", \"skip the tests for now\". It reads it at its next step and carries on.",
        why: "You do not have to stop a task and pay for a restart just to change one thing. What you typed shows in the transcript, so you can see it was heard.",
        where: "Any running task · Chat tab",
        headline: true,
      },
```

Update `cost`'s pitch: `"Tokens, dollars and time per stage. A task that reaches its cost ceiling pauses and asks — Continue with a bit more, or Stop — instead of throwing the work away."`

- [ ] **Step 2: Tour.tsx** line 66: `"The bell calls you when it needs a decision: something to allow, a plan to pick, or a task that reached its cost ceiling. Approve what lands; Retry or Chat what doesn't."` Line 175: prepend `While it is running, Chat delivers your message live.`

- [ ] **Step 3: README** — in *Sessions: continue one, or start a new task?* add after the first paragraph:

```md
**While a stage is running, Chat still works.** Type on the Chat tab and the message is handed to Claude at
its next step — it does not stop, and nothing already done is redone. Use it for "use the header's blue", "skip
the tests for now", "also rename that". Your message appears in the transcript, so you can see it was read.
Stages delegated to another provider's CLI or HTTP API cannot take a message mid-run; the box says so.
```

In *Guardrails*, the per-task ceiling bullet becomes: `**A per-task cost ceiling** on top of the per-stage one. Three stages at $5 was already $15. Reaching either ceiling **pauses the task and asks you** — *Continue* lets it spend one more stage's worth in the same session; *Stop* keeps what it did. Nothing is thrown away for money.`

In *What a task costs* add a line: `A task that hits a ceiling shows **needs you · cost** in rose on the board with the amount spent; Continue on the card or in the task carries on from the same session.`

- [ ] **Step 4: DECISIONS.md** — resolve the conflict markers (keep both sections in order, drop the marker lines), then append:

```md
## Steering and the cost ceiling (2026-09-12)

| # | Decision | Why |
|---|---|---|
| D184 | A message typed on a running task is delivered by a **PostToolUse hook as `additionalContext`**, and a **Stop hook blocks the turn's end** while one is undelivered; a cursor on the run's active record decides what is new | The SDK's streaming input cannot interrupt a turn in progress; hooks are the one path that reaches the model mid-turn without restarting the session. The Stop guard means a message never waits for a tool call that never comes |
| D185 | Cost ceilings **pause for a decision** (`pause_reason: "cost"`, no `resume_at`) instead of failing; Continue grants **one per-stage ceiling** to the task and resumes the same session | A task stopped at 90 % for money and thrown away is the most expensive outcome there is. Granting one stage at a time keeps the decision small and repeatable; keeping the session means nothing finished is redone |
| D186 | A cost pause is reported as **needs you**, not as a paused-by-limit event | It waits for a person; the limit pause does not. The colour and sound should say which |
```

- [ ] **Step 5:** `npm test` and `npm run typecheck` → all green. Do not commit: the working tree also carries the uncommitted schedules work; report both to the user.
