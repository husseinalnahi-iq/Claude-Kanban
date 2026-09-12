import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type { Schedule, Task, UsageLimit } from "../types.ts";
import type { TaskRunner } from "./runner.ts";
import { KeepAwake } from "./keepAwake.ts";

/** Same margin auto-resume uses: resets are not instant to the second. */
const RESET_MARGIN_MS = 90_000;

/**
 * The next time after `from` that falls on one of `days` (0 = Sunday) at `time` ("HH:MM"), in the
 * computer's local time. Strictly after: the minute a schedule fires is never its own next run.
 * Built with local Date setters, so daylight-saving changes keep the wall-clock time.
 */
export function nextOccurrence(days: number[], time: string, from: Date): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!days.length || !m) return null;
  const [h, mi] = [Number(m[1]), Number(m[2])];
  for (let d = 0; d <= 7; d++) {
    const c = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h, mi, 0, 0);
    if (days.includes(c.getDay()) && c.getTime() > from.getTime()) return c;
  }
  return null;
}

/** When "after my limit resets" is due: the five-hour window's reset plus a margin, or now if unknown or past. */
export function resetTime(limits: Pick<UsageLimit, "type" | "resets_at">[], now: number): number {
  const five = limits.find((l) => l.type === "five_hour" && l.resets_at);
  // Judge "already reset" on the reset itself: the margin must not make a past reset look future.
  if (!five?.resets_at || five.resets_at * 1000 <= now) return now;
  return five.resets_at * 1000 + RESET_MARGIN_MS;
}

/** "Mon 14 Sep", for the title of a card a schedule made. */
function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export type NewSchedule = Omit<Schedule, "id" | "created_at" | "last_run_at" | "last_task_id" | "next_run_at">;

export interface SchedulerDeps {
  repo: Repo;
  bus: Bus;
  runner: TaskRunner;
  keepAwake?: KeepAwake;
  now?: () => number;
}

/**
 * Starts cards on time. One-time starts (`task.start_at`) and repeating schedules are both checked on
 * a short tick rather than an exact timer: a minute's accuracy is plenty, and a tick survives the
 * computer sleeping, the clock changing and the server restarting without any bookkeeping. Anything
 * missed while the board was off fires once, on the first tick.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  readonly keepAwake: KeepAwake;

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.keepAwake = deps.keepAwake ?? new KeepAwake();
  }

  start(intervalMs = 20_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.keepAwake.stop();
  }

  /** When a one-time start is due, in ms. */
  dueAt(task: Pick<Task, "start_at">): number {
    if (task.start_at === "reset") return resetTime(this.deps.repo.usageLimits(), this.now());
    return task.start_at ? Date.parse(task.start_at) : Infinity;
  }

  tick(): void {
    const { repo } = this.deps;
    const now = this.now();
    for (const task of repo.scheduledTasks()) {
      if (task.status !== "backlog" && task.status !== "failed") {
        this.setTask(task.id, { start_at: null }); // started by hand meanwhile: nothing left to do
        continue;
      }
      if (this.dueAt(task) > now) continue;
      this.setTask(task.id, { start_at: null });
      this.queue(task.id, "Scheduled start");
    }
    for (const sc of repo.listSchedules()) {
      if (!sc.enabled || !sc.next_run_at || Date.parse(sc.next_run_at) > now) continue;
      // From now, not from the missed time: three nights off make one card, not three.
      const next = nextOccurrence(sc.days, sc.time, new Date(now));
      this.fire(sc, { next_run_at: next?.toISOString() ?? null });
    }
    // Only a started scheduler (the real server) touches the computer's sleep; tests and API checks never do.
    if (this.timer) try {
      this.keepAwake.set(repo.getSettings().keepAwake && this.wantAwake());
    } catch {
      // never let keep-awake break scheduling
    }
  }

  /** Anything queued, running or scheduled: the work the computer must stay awake for. */
  wantAwake(): boolean {
    const { repo, runner } = this.deps;
    const q = runner.queue.snapshot();
    if (q.running.length || q.waiting.length) return true;
    if (repo.scheduledTasks().length) return true;
    return repo.listSchedules().some((s) => s.enabled && s.next_run_at);
  }

  create(s: NewSchedule): Schedule {
    const next = s.enabled ? nextOccurrence(s.days, s.time, new Date(this.now())) : null;
    const created = this.deps.repo.createSchedule({ ...s, next_run_at: next?.toISOString() ?? null });
    this.publish(created);
    this.tick();
    return created;
  }

  update(id: string, patch: Partial<NewSchedule>): Schedule {
    const current = this.deps.repo.getSchedule(id);
    if (!current) throw new Error(`No schedule ${id}`);
    const merged = { ...current, ...patch };
    const next = merged.enabled ? nextOccurrence(merged.days, merged.time, new Date(this.now())) : null;
    const updated = this.deps.repo.updateSchedule(id, { ...patch, next_run_at: next?.toISOString() ?? null });
    this.publish(updated);
    this.tick();
    return updated;
  }

  delete(id: string): void {
    const sc = this.deps.repo.getSchedule(id);
    if (!sc) return;
    this.deps.repo.deleteSchedule(id);
    this.deps.bus.publish({ type: "schedule.deleted", id, project_id: sc.project_id });
    this.tick();
  }

  /** Make and queue a card from the schedule now; its next regular run stays where it was. */
  runNow(id: string): Task {
    const sc = this.deps.repo.getSchedule(id);
    if (!sc) throw new Error(`No schedule ${id}`);
    return this.fire(sc, {});
  }

  private fire(sc: Schedule, patch: Partial<Schedule>): Task {
    const { repo, bus } = this.deps;
    const task = repo.createTask({
      project_id: sc.project_id,
      title: `${sc.title} · ${dayLabel(new Date(this.now()))}`,
      spec_md: sc.spec_md,
      mode: sc.mode,
      type: sc.type,
      priority: sc.priority,
      pipeline: sc.pipeline,
      skills: sc.skills,
    });
    bus.publish({ type: "task.updated", task });
    this.publish(repo.updateSchedule(sc.id, { ...patch, last_run_at: new Date(this.now()).toISOString(), last_task_id: task.id }));
    this.queue(task.id, `Made by the schedule "${sc.title}", but it`);
    return repo.getTask(task.id)!;
  }

  /** Queue through the runner so caps, dependencies, limits and approvals all still apply. */
  private queue(taskId: string, who: string): void {
    try {
      this.deps.runner.queueTask(taskId);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.setTask(taskId, { note: `${who} could not begin: ${why}` });
    }
  }

  private setTask(id: string, patch: Partial<Task>): void {
    const task = this.deps.repo.updateTask(id, patch);
    this.deps.bus.publish({ type: "task.updated", task });
  }

  private publish(schedule: Schedule): void {
    this.deps.bus.publish({ type: "schedule.updated", schedule });
  }
}
