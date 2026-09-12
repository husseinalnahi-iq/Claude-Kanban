import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup } from "./helpers.ts";
import { nextOccurrence, resetTime, Scheduler } from "../src/engine/scheduler.ts";
import { KeepAwake, keepAwakeCommand } from "../src/engine/keepAwake.ts";
import type { Stage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
/** Local time, as the user reads it: 2026-09-14 is a Monday. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("next occurrence: later today, the next matching day, and wrapping past the weekend", () => {
  const mon9 = at(2026, 9, 14, 9, 0);
  assert.deepEqual(nextOccurrence([1], "22:30", mon9), at(2026, 9, 14, 22, 30), "same day, later");
  assert.deepEqual(nextOccurrence([3], "03:00", mon9), at(2026, 9, 16, 3, 0), "Wednesday");
  assert.deepEqual(nextOccurrence([0], "08:00", at(2026, 9, 19, 12)), at(2026, 9, 20, 8, 0), "Saturday noon → Sunday");
  assert.deepEqual(nextOccurrence([5], "08:00", at(2026, 9, 19, 12)), at(2026, 9, 25, 8, 0), "Saturday → next Friday");
});

test("next occurrence: the minute it fires is not 'next' — that would fire twice", () => {
  const mon3 = at(2026, 9, 14, 3, 0);
  assert.deepEqual(nextOccurrence([1], "03:00", mon3), at(2026, 9, 21, 3, 0));
  assert.equal(nextOccurrence([], "03:00", mon3), null);
});

test("reset time: the five-hour window's reset plus a margin, or now when nothing is known", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  const resets = Math.floor(now / 1000) + 3600;
  assert.equal(resetTime([{ type: "five_hour", resets_at: resets }], now), resets * 1000 + 90_000);
  assert.equal(resetTime([{ type: "five_hour", resets_at: Math.floor(now / 1000) - 60 }], now), now, "already reset");
  assert.equal(resetTime([], now), now);
});

test("keep-awake commands: each OS's own inhibitor, tied to the server's life", () => {
  const win = keepAwakeCommand("win32", 4242)!;
  assert.equal(win.command, "powershell");
  assert.match(win.args.join(" "), /SetThreadExecutionState/);
  assert.match(win.args.join(" "), /4242/, "it watches the server and exits with it");
  assert.deepEqual(keepAwakeCommand("darwin", 4242), { command: "caffeinate", args: ["-i", "-w", "4242"] });
  const linux = keepAwakeCommand("linux", 4242)!;
  assert.equal(linux.command, "systemd-inhibit");
  assert.ok(linux.args.includes("--pid=4242"));
});

function board() {
  const s = setup(fakeQuery().fn);
  let now = Date.parse("2026-09-14T09:00:00");
  // Never hold the real computer awake from a test.
  const keepAwake = Object.assign(new KeepAwake(), { set() {} });
  const scheduler = new Scheduler({ repo: s.repo, bus: s.bus, runner: s.runner, now: () => now, keepAwake });
  return { ...s, scheduler, setNow: (t: number) => (now = t), now: () => now };
}

test("a card whose start time has come is queued once, and its schedule cleared", async () => {
  const b = board();
  try {
    const due = b.repo.createTask({ project_id: b.project.id, title: "due", pipeline: ONE });
    const later = b.repo.createTask({ project_id: b.project.id, title: "later", pipeline: ONE });
    b.repo.updateTask(due.id, { start_at: new Date(b.now() - 60_000).toISOString() });
    b.repo.updateTask(later.id, { start_at: new Date(b.now() + 3_600_000).toISOString() });
    b.scheduler.tick();
    assert.notEqual(b.repo.getTask(due.id)!.status, "backlog", "the due card was queued");
    assert.equal(b.repo.getTask(due.id)!.start_at, null);
    assert.equal(b.repo.getTask(later.id)!.status, "backlog");
    assert.ok(b.repo.getTask(later.id)!.start_at, "the later card keeps its time");
  } finally {
    b.cleanup();
  }
});

test("a scheduled card that cannot start keeps a note saying why, and is not retried forever", () => {
  const b = board();
  try {
    const first = b.repo.createTask({ project_id: b.project.id, title: "first", pipeline: ONE });
    const waits = b.repo.createTask({ project_id: b.project.id, title: "waits", pipeline: ONE, depends_on: [first.id] });
    b.repo.updateTask(waits.id, { start_at: new Date(b.now() - 1000).toISOString() });
    b.scheduler.tick();
    const t = b.repo.getTask(waits.id)!;
    assert.equal(t.status, "backlog");
    assert.equal(t.start_at, null);
    assert.match(t.note ?? "", /scheduled start/i);
  } finally {
    b.cleanup();
  }
});

test("a card started by hand drops its schedule instead of being queued twice", () => {
  const b = board();
  try {
    const t = b.repo.createTask({ project_id: b.project.id, title: "manual", pipeline: ONE, status: "review" });
    b.repo.updateTask(t.id, { start_at: new Date(b.now() - 1000).toISOString() });
    b.scheduler.tick();
    assert.equal(b.repo.getTask(t.id)!.status, "review");
    assert.equal(b.repo.getTask(t.id)!.start_at, null);
  } finally {
    b.cleanup();
  }
});

test("'when my limit resets' waits for the five-hour window, then starts", () => {
  const b = board();
  try {
    b.repo.upsertUsageLimit({ type: "five_hour", status: "allowed", utilization: 0.9, resets_at: Math.floor(b.now() / 1000) + 1800 });
    const t = b.repo.createTask({ project_id: b.project.id, title: "night", pipeline: ONE });
    b.repo.updateTask(t.id, { start_at: "reset" });
    b.scheduler.tick();
    assert.equal(b.repo.getTask(t.id)!.status, "backlog", "not yet");
    b.setNow(b.now() + 1800_000 + 91_000);
    b.scheduler.tick();
    assert.notEqual(b.repo.getTask(t.id)!.status, "backlog");
  } finally {
    b.cleanup();
  }
});

test("a repeating schedule makes a fresh card each time — and only one after days switched off", () => {
  const b = board();
  try {
    const sc = b.scheduler.create({
      project_id: b.project.id, title: "Nightly tests", spec_md: "run them", mode: "supervised", type: "chore", priority: "p2",
      pipeline: ONE, skills: [], days: [0, 1, 2, 3, 4, 5, 6], time: "03:00", enabled: true,
    });
    assert.deepEqual(new Date(sc.next_run_at!), at(2026, 9, 15, 3, 0), "first run: tomorrow 03:00");

    b.setNow(at(2026, 9, 18, 12).getTime()); // the PC was off for three nights
    b.scheduler.tick();
    const made = b.repo.listTasks({ project_id: b.project.id });
    assert.equal(made.length, 1, "one card, not one per missed night");
    assert.match(made[0].title, /^Nightly tests · /);
    assert.equal(made[0].spec_md, "run them");
    assert.notEqual(made[0].status, "backlog", "and it was queued");
    const after = b.repo.getSchedule(sc.id)!;
    assert.deepEqual(new Date(after.next_run_at!), at(2026, 9, 19, 3, 0), "next: the coming night");
    assert.equal(after.last_task_id, made[0].id);

    b.scheduler.tick();
    assert.equal(b.repo.listTasks({ project_id: b.project.id }).length, 1, "a second tick does nothing");
  } finally {
    b.cleanup();
  }
});

test("run now makes a card without moving the next run; a paused schedule never fires", () => {
  const b = board();
  try {
    const sc = b.scheduler.create({
      project_id: b.project.id, title: "Tidy", spec_md: "", mode: "supervised", type: "chore", priority: "p3",
      pipeline: ONE, skills: [], days: [1], time: "10:00", enabled: false,
    });
    assert.equal(sc.next_run_at, null, "paused: nothing is due");
    b.setNow(at(2026, 9, 30).getTime());
    b.scheduler.tick();
    assert.equal(b.repo.listTasks({ project_id: b.project.id }).length, 0);
    const task = b.scheduler.runNow(sc.id);
    assert.match(task.title, /^Tidy · /);
    assert.equal(b.repo.getSchedule(sc.id)!.next_run_at, null);
    const on = b.scheduler.update(sc.id, { enabled: true });
    assert.ok(on.next_run_at, "switching it on works out the next run");
  } finally {
    b.cleanup();
  }
});

test("the computer is kept awake while anything is queued, running or scheduled", () => {
  const b = board();
  try {
    assert.equal(b.scheduler.wantAwake(), false, "an idle board lets it sleep");
    const t = b.repo.createTask({ project_id: b.project.id, title: "x", pipeline: ONE });
    b.repo.updateTask(t.id, { start_at: new Date(b.now() + 3_600_000).toISOString() });
    assert.equal(b.scheduler.wantAwake(), true);
  } finally {
    b.cleanup();
  }
});

test("API: schedule a card, cancel it; create, pause, run and delete a repeating schedule", async () => {
  const { buildApp } = await import("../src/app.ts");
  const b = board();
  const app = await buildApp({ repo: b.repo, bus: b.bus, runner: b.runner, scheduler: b.scheduler, allowedHosts: ["localhost:80"] });
  try {
    const task = b.repo.createTask({ project_id: b.project.id, title: "later", pipeline: ONE });
    const soon = new Date(Math.max(Date.now(), b.now()) + 3_600_000).toISOString(); // future for the server and the fake clock
    const set = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/schedule`, payload: { start_at: soon } });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().start_at, soon);
    const past = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/schedule`, payload: { start_at: "2020-01-01T00:00:00Z" } });
    assert.equal(past.statusCode, 409, "a time in the past is refused with a reason");
    const off = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/schedule`, payload: { start_at: null } });
    assert.equal(off.json().start_at, null);

    const bad = await app.inject({ method: "POST", url: "/api/schedules", payload: { project_id: b.project.id, title: "x", days: [], time: "25:00" } });
    assert.equal(bad.statusCode, 400);
    const made = await app.inject({ method: "POST", url: "/api/schedules", payload: { project_id: b.project.id, title: "Nightly", days: [1, 1, 3], time: "03:00" } });
    assert.equal(made.statusCode, 200, made.body);
    const sc = made.json();
    assert.deepEqual(sc.days, [1, 3], "days de-duplicated");
    assert.ok(sc.pipeline.length, "the project's default pipeline");
    assert.ok(sc.next_run_at);

    const listed = await app.inject({ method: "GET", url: `/api/projects/${b.project.id}/schedules` });
    assert.equal(listed.json().length, 1);
    const paused = await app.inject({ method: "PATCH", url: `/api/schedules/${sc.id}`, payload: { enabled: false } });
    assert.equal(paused.json().next_run_at, null);
    assert.equal(paused.json().time, "03:00", "a patch leaves the rest alone");
    const ran = await app.inject({ method: "POST", url: `/api/schedules/${sc.id}/run` });
    assert.match(ran.json().title, /^Nightly · /);
    const del = await app.inject({ method: "DELETE", url: `/api/schedules/${sc.id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(b.repo.listSchedules(b.project.id).length, 0);
  } finally {
    await app.close();
    b.cleanup();
  }
});
