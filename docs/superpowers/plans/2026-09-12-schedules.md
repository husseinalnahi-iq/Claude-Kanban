# Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards can start at a set time, after the usage window resets, or on repeating days, and the PC stays awake while work is pending, so work runs overnight.

**Architecture:**
- A `Scheduler` (in `server/src/engine/scheduler.ts`) ticks every 20 s. It queues one-time cards whose `start_at` is due, and turns due repeating `schedules` into fresh cards.
- Everything is queued through `runner.queueTask`, so caps, dependencies, limits and approvals still apply.
- `KeepAwake` (in `server/src/engine/keepAwake.ts`) holds an OS sleep inhibitor while anything is queued, running or scheduled. The inhibitor dies with the server.
- On the web side:
  - a `WhenPicker` in the new-task form and task drawer
  - a clock badge on cards
  - a Schedules slide-over panel on the board

**Tech stack:** Node 24 `node:sqlite`, Fastify + zod, React + Tailwind, `node --test` with tsx.

---

## File map
| File | What it does |
|---|---|
| `server/src/engine/scheduler.ts` (new) | `nextOccurrence`, `resetTime`, and the `Scheduler` class (tick, start/stop, run a schedule now, keep-awake decision) |
| `server/src/engine/keepAwake.ts` (new) | `keepAwakeCommand(platform, pid)` (pure) and the `KeepAwake` class (`set(on)`, `stop()`) |
| `server/src/schema.sql` | `schedules` table |
| `server/src/db.ts` | the `tasks.start_at` migration and the `keepAwake` seed |
| `server/src/types.ts` | `Task.start_at`, `Schedule`, `Settings.keepAwake`, and the `schedule.updated` / `schedule.deleted` WS events |
| `server/src/repo.ts` | `start_at` column mapping, `scheduledTasks()`, and schedule CRUD |
| `server/src/routes/schedules.ts` (new) | `POST/DELETE /tasks/:id/schedule`, `GET /projects/:id/schedules`, `POST /schedules`, `PATCH/DELETE /schedules/:id`, `POST /schedules/:id/run` |
| `server/src/app.ts`, `server/src/index.ts` | wiring, plus `scheduler.start()` |
| `server/src/routes/settings.ts` | the `keepAwake` field |
| `server/test/schedules.test.ts` (new) | tests |
| `web/src/lib/api.ts` | client calls |
| `web/src/components/WhenPicker.tsx` (new) | Now / Later / After reset / Repeat |
| `web/src/components/SchedulesPanel.tsx` (new) | the slide-over list |
| `web/src/components/forms.tsx`, `web/src/views/Board.tsx`, `web/src/views/TaskDrawer.tsx`, `web/src/views/Settings.tsx` | UI hooks |
| `web/src/index.css` | `slide-in-right` and `fade-out` animations |
| `web/src/components/tour/features.ts`, `README.md` | guidance |

## Tasks

### Task 1: Pure time maths (TDD)
- [ ] Test `nextOccurrence(days, "HH:MM", from)` against these cases:
  - later the same day
  - the next matching weekday
  - the week wrapping around
  - exactly the current minute counts as "next week", not now
  - empty `days` returns null
- [ ] Test `resetTime(limits, now)`:
  - a five-hour `resets_at` in the future, plus 90 s
  - otherwise `now`
- [ ] Implement both in `scheduler.ts`, using local-time `Date` setters so DST is handled.

### Task 2: Data
- [ ] `schedules` table:
  - `id`, `project_id` (FK cascade), `title`, `spec_md`, `mode`, `type`, `priority`
  - `pipeline_json`, `skills_json`, `days_json`, `time`
  - `enabled`, `next_run_at`, `last_run_at`, `last_task_id`, `created_at`
- [ ] Add the `tasks.start_at` column in `LATER_COLUMNS`.
- [ ] Seed `keepAwake=true`.
- [ ] Repo methods:
  - `listSchedules(projectId?)`, `getSchedule`, `createSchedule`, `updateSchedule`, `deleteSchedule`
  - `scheduledTasks()` returns tasks with `start_at` set
  - `TASK_COLUMNS.start_at`

### Task 3: Scheduler tick (TDD with fakeQuery setup)
- [ ] Test: a card with `start_at` in the past, when ticked, has status queued and `start_at` null.
- [ ] Test: a card with `start_at` in the future stays in backlog.
- [ ] Test: a card whose `start_at` was set but which was started by hand has `start_at` cleared and isn't queued again.
- [ ] Test: queueing a blocked card doesn't throw. The card keeps its backlog status with a note, and `start_at` is cleared.
- [ ] Test: a schedule with `next_run_at` in the past creates one new card, titled "`<title> · <day date>`", and queues it. Then:
  - `next_run_at` becomes the next occurrence after now
  - a second tick does nothing
  - three missed days still produce only one card
- [ ] Test: `runNow(schedule)` creates a card without changing `next_run_at`.
- [ ] Implement `Scheduler({repo, bus, runner, keepAwake?, now?})`:
  - `tick()`
  - `start(intervalMs=20000)`, which ticks once immediately (catch-up)
  - `stop()`
  - `runNow(id)`
  - `wantAwake()`

### Task 4: Keep awake (TDD on the pure part)
- [ ] Test `keepAwakeCommand`:
  - win32 gives powershell with `SetThreadExecutionState` and a loop that watches the parent pid
  - darwin gives `caffeinate -i -w pid`
  - linux gives `systemd-inhibit ... tail --pid`
- [ ] Implement `KeepAwake.set(on)`: it spawns once, kills when off, and never throws.
- [ ] Scheduler calls `keepAwake.set(settings.keepAwake && wantAwake())` on every tick.

### Task 5: Routes and wiring
- [ ] `routes/schedules.ts` with zod:
  - `days` is an array of integers 0–6, 1 to 7 entries
  - `time` matches `^\d{2}:\d{2}$`
  - `start_at` is an ISO datetime, "reset", or null
- [ ] Setting `start_at` needs a card in backlog or failed. Every change publishes the event and ticks.
- [ ] Route test through `buildApp` inject: create a schedule, list it, patch `enabled`, delete it.
- [ ] Wire into `buildApp` (creating a Scheduler when `deps.scheduler` is absent) and into `index.ts` (create, `start()`, stop on exit).
- [ ] Add `keepAwake` to the settings route.

### Task 6: Web
- [ ] Add to `api.ts`: `scheduleTask`, `unscheduleTask`, `schedules`, `createSchedule`, `patchSchedule`, `deleteSchedule`, `runSchedule`.
- [ ] `WhenPicker`: a segmented control; Later shows `datetime-local`; Repeat shows day chips and a time input; plain-language hints.
- [ ] `NewTaskForm`: add the When field, with a submit label that follows the choice. Repeat creates a schedule instead of a card.
- [ ] Card badge on backlog cards with `start_at` ("⏰ Tue 02:00" / "⏰ after limit resets"), with **now** and **×** actions.
- [ ] Board header: a **Schedules** button with a count, opening `SchedulesPanel` (slide-in-right). Rows rise in and fade out on delete. It shows repeating schedules (switch, days, time, next run, Run now, Delete) and one-time starts.
- [ ] TaskDrawer: a **Schedule…** button (backlog or failed) opening a modal with `WhenPicker` (without Now). Repeat there becomes "Repeat this card".
- [ ] Settings → Runs & limits: the **Keep this computer awake** checkbox, with the lid caveat.

### Task 7: Guidance
- [ ] `features.ts`: a `schedule` feature (headline); update SHORTCUTS if needed.
- [ ] README newcomer section "Let it work while you sleep", plus a troubleshooting line about the lid and sleep.

### Task 8: Verify
- [ ] `npm test -w server`, the web tsc typecheck, and the build.
- [ ] Live check in the browser preview:
  - schedule a card 1 minute ahead and watch it queue
  - create a repeat schedule and press Run now
  - screenshot the result
