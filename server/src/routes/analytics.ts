import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import type { Priority, TaskStatus, TaskType } from "../types.ts";
import { TASK_TYPES } from "../types.ts";

export interface Analytics {
  /** Tasks by status / type / priority, right now. */
  byStatus: { key: TaskStatus; count: number }[];
  byType: { key: TaskType; count: number }[];
  byPriority: { key: Priority; count: number }[];
  /** Per day: tasks finished, tasks created, and what the runs cost. */
  daily: { date: string; done: number; created: number; cost: number; runs: number }[];
  totals: {
    open: number;
    done: number;
    blocked: number;
    needsYou: number;
    cost7d: number;
    costAll: number;
    runs: number;
    runSuccessRate: number | null;
    /** Median hours from first queue to done, over the last 30 finished tasks. */
    medianCycleHours: number | null;
    firstPassRate: number | null;
  };
  /** Where failures happen, so a bad stage or model is visible. */
  failuresByStage: { key: string; count: number }[];
  costByModel: { key: string; cost: number; runs: number }[];
}

const day = (iso: string) => iso.slice(0, 10);

function tally<T extends string>(items: T[], keys: T[]): { key: T; count: number }[] {
  const counts = new Map<T, number>(keys.map((k) => [k, 0]));
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

export async function analyticsRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  app.get("/analytics", async (req) => {
    const { project, days } = req.query as { project?: string; days?: string };
    const window = Math.min(120, Math.max(7, Number(days) || 30));
    const tasks = project ? repo.listTasks({ project_id: project }) : repo.listProjects().flatMap((p) => repo.listTasks({ project_id: p.id }));
    // Run figures come from SQL aggregates: loading rows into JS meant everything past the first
    // 2000 runs was silently missing from the numbers, with nothing to say so.
    const agg = repo.runAggregates(project);
    const byDate = new Map(agg.daily.map((d) => [d.date, d]));

    const since = new Date(Date.now() - window * 86_400_000);
    const dates: string[] = [];
    for (let d = new Date(since); d <= new Date(); d.setDate(d.getDate() + 1)) dates.push(d.toISOString().slice(0, 10));

    const daily = dates.map((date) => {
      const r = byDate.get(date);
      return {
        date,
        done: tasks.filter((t) => t.status === "done" && day(t.updated_at) === date).length,
        created: tasks.filter((t) => day(t.created_at) === date).length,
        cost: Number((r?.cost ?? 0).toFixed(4)),
        runs: r?.runs ?? 0,
      };
    });

    // Cycle time: first run started → task marked done. Median, because one stuck task skews a mean.
    const cycleRows = repo.cycleTimes(project);
    const cycles = cycleRows.map((r) => (Date.parse(r.updatedAt) - Date.parse(r.startedAt)) / 3_600_000).sort((a, b) => a - b);
    const median = cycles.length ? cycles[Math.floor(cycles.length / 2)] : null;
    const firstPass = cycleRows.filter((r) => r.failed === 0).length;
    const finished = cycleRows.length;
    const done = agg.totals.success;
    const failed = agg.totals.failed;

    const result: Analytics = {
      byStatus: tally(tasks.map((t) => t.status), ["backlog", "queued", "planning", "running", "approval", "review", "done", "failed"]),
      byType: tally(tasks.map((t) => t.type), TASK_TYPES),
      byPriority: tally(tasks.map((t) => t.priority), ["p0", "p1", "p2", "p3"]),
      daily,
      totals: {
        open: tasks.filter((t) => !["done"].includes(t.status)).length,
        done: tasks.filter((t) => t.status === "done").length,
        blocked: tasks.filter((t) => t.status === "backlog" && runner.blockers(t).length > 0).length,
        needsYou: tasks.filter((t) => ["approval", "review", "failed"].includes(t.status)).length,
        cost7d: Number(daily.slice(-7).reduce((s, d) => s + d.cost, 0).toFixed(4)),
        costAll: Number(agg.totals.cost.toFixed(4)),
        runs: agg.totals.runs,
        runSuccessRate: done + failed ? done / (done + failed) : null,
        medianCycleHours: median === null ? null : Number(median.toFixed(2)),
        firstPassRate: finished ? firstPass / finished : null,
      },
      failuresByStage: agg.failuresByStage,
      costByModel: agg.byModel,
    };
    return result;
  });
}
