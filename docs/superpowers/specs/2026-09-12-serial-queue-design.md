# Serial queue, forced parallel runs, and a usage-limit gate

## Context

The board already has a queue. `RunQueue` (`server/src/engine/queue.ts`) is a per-project FIFO with
two caps — `globalCap` (settings, seeded 8) and `project.policy.maxConcurrent` (seeded 3) — and the
runner holds a slot for the whole pipeline. Setting the global cap to 1 already produces serial
execution, so the feature the user asked for is mostly a naming and surfacing problem.

Three things are genuinely missing.

1. **The knob is an integer buried in Settings → Runs.** The user's mental model is a switch: one at
   a time, or in parallel.
2. **There is no per-task override.** No way to say "this one runs now regardless of the cap".
3. **A cascade bug.** When a run hits a Claude usage limit, `pauseForLimit` sets the task `paused`
   with a `resume_at` and the pipeline promise settles, which frees the queue slot. The queue then
   starts the next task, which hits the same wall and pauses too. In serial mode the whole backlog
   would walk itself into `paused` within a minute. Serial mode alone does not solve the user's
   stated goal (not hitting the limit); it only slows the burn rate.

Decisions taken with the user:

- Forced tasks take an **extra slot and start now**, outside both caps, bounded by a ceiling.
- While a Claude limit window is open, hold **Claude work only**; tasks whose next stage is
  delegated to another provider keep running.
- Serial becomes the default for **new state directories only**; existing boards keep today's
  behaviour until the user flips the switch.

Non-goals: reordering the FIFO (a separate "move to front" control), per-project serial mode,
pausing delegated providers on their own rate limits, persisting the forced flag across a restart.

---

## 1. Usage-limit gate

`RunQueue` gains one hook:

```ts
canStart?: (item: QueueItem) => boolean;   // consulted in pump(); false leaves the item waiting
```

The runner implements it:

```ts
private claudeLimitedUntil(): number | null   // max future resume_at among paused tasks, else null
private nextStageNeedsClaude(task: Task): boolean
private mayStartNow(taskId: string): boolean
```

`claudeLimitedUntil` derives the window from the paused tasks the runner itself created, not from
`usage_limits`: `pauseForLimit` already computed the reset time through `resumeTime()`, and the state
clears itself when `resumeDue()` un-pauses everything. No new table, no new column.

`nextStageNeedsClaude` looks at **the stage the task would start from** —
`startOpts.get(id)?.fromStage ?? defaultStart(task).fromStage` — and returns true when that stage's
provider is Anthropic, or when its debate critic is (`ProviderRegistry.debateFor`). Only the next
stage: a task whose first stage is delegated and whose second is Claude still starts, makes real
progress, and pauses at stage two. That is strictly better than not starting, and it is the existing
behaviour for a task already running.

`resumeDue()` calls `queue.pump()` at the end so held items start even when no paused task was
successfully re-queued (e.g. every `retryTask` threw).

**Forced tasks do not bypass this gate**, only the caps. Forcing Claude work into an exhausted window
does not run it; it pauses it two seconds later. The UI says "held until 14:30" instead of pretending.

## 2. Serial mode

New boolean setting `serial`. The queue's global cap becomes:

```ts
globalCap: () => (s.serial ? 1 : s.globalCap)
```

The stored number is untouched, so flipping back restores the user's value — no second "remembered
cap" field, no lossy toggle.

Seeding must not change an existing board. `openDb` counts the `settings` rows **before** seeding; a
fresh database seeds `serial = "true"`, an existing one seeds `"false"`.

The slot is released when the pipeline finishes, which is after the last stage's `commitWorktree`.
The next task therefore starts once the previous one's work is committed to its worktree branch, not
when the human approves and merges it. Otherwise the board would stall on the review column.

## 3. Run now

- `QueueItem` gains `force?: boolean`.
- `RunQueue` counts forced and normal runs separately. Forced items ignore `globalCap` and
  `projectCap`, and do not count toward them — otherwise one forced task would occupy the single
  serial slot and block the normal lane forever. They are bounded by a new `forcedCap()`.
- New setting `maxForcedParallel` (default 3, 1..8).
- `runner.queueTask(taskId, opts, force = false)`.
- `POST /tasks/:id/queue { force?: boolean }`.
- Web: **Run now** beside Queue in the task drawer, and on the board card's hover action when the
  board is serial. `api.queue(id, force?)`.

## 4. UI

- **Board header**: a switch, "Run one at a time", writing `settings.serial`. It is a global setting
  shown on a project board, so it is labelled as applying everywhere.
- **Banner**: while `claudeLimitedUntil` is set and any task is queued, one line — *Claude limit
  reached. Claude work resumes at 14:30; delegated tasks keep running.* Derived on the client from
  the paused tasks `UsageMeters` already fetches; no new endpoint.
- **Settings → Runs → Concurrency**: the switch again, the existing two numbers, and
  "Forced runs at once".

## 5. Tests (`server/test/queue.test.ts`, extending `runner.test.ts`)

- serial cap runs tasks strictly one after another, in FIFO order
- a forced item starts while the serial slot is occupied, and does not consume it
- the forced ceiling holds
- with a paused, limited task present: a Claude-next task stays `queued`; a task whose next stage is
  a delegated provider starts
- a plan stage with a Claude critic counts as Claude work
- `resumeDue()` releases held items
- fresh DB seeds `serial` true; a DB that already has settings seeds it false
