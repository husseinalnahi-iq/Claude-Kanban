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
  /**
   * Where the money goes (D276). Tokens by kind — Claude bills each kind at its own rate, and a long
   * session is mostly cached re-reads — and dollars by job, so a saving can be checked, not assumed.
   */
  spend: {
    tokens: { output: number; fresh: number; cacheRead: number; cacheWrite: number };
    byJob: { key: string; cost: number }[];
  };
}

const day = (iso: string) => iso.slice(0, 10);

function tally<T extends string>(items: T[], keys: T[]): { key: T; count: number }[] {
  const counts = new Map<T, number>(keys.map((k) => [k, 0]));
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

export interface StageStat {
  stage: string;
  runs: number;
  medianMinutes: number;
  medianCost: number;
}

export async function analyticsRoutes(app: FastifyInstance, { repo }: AppDeps) {
  /** Typical time and cost of each kind of stage, so the new-task form can say what a plan stage adds (D205). */
  app.get("/stats/stages", async (req) => {
    const { project } = req.query as { project?: string };
    return repo.stageStats(project) satisfies StageStat[];
  });

  app.get("/analytics", async (req) => {
    const { project, days } = req.query as { project?: string; days?: string };
    const window = Math.min(120, Math.max(7, Number(days) || 30));
    // Counting needs a few short columns of each task, not the task: one read, and no specs.
    const tasks = repo.taskFacts(project);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // The day a task was finished. updated_at stands in only for the odd row without a date.
    const doneDay = (t: { done_at: string | null; updated_at: string }) => day(t.done_at ?? t.updated_at);
    const doneOn = new Map<string, number>();
    const createdOn = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === "done") doneOn.set(doneDay(t), (doneOn.get(doneDay(t)) ?? 0) + 1);
      createdOn.set(day(t.created_at), (createdOn.get(day(t.created_at)) ?? 0) + 1);
    }
    // Waiting on a task that is not done yet. A dependency outside this list (there should be none:
    // links across projects are refused) is looked up rather than assumed finished.
    const blocked = (t: { depends_on: string[] }) =>
      t.depends_on.some((id) => {
        const dep = byId.get(id) ?? repo.getTask(id);
        return Boolean(dep) && dep!.status !== "done";
      });
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
        done: doneOn.get(date) ?? 0,
        created: createdOn.get(date) ?? 0,
        cost: Number((r?.cost ?? 0).toFixed(4)),
        runs: r?.runs ?? 0,
      };
    });

    // Cycle time: first run started → task marked done. Median, because one stuck task skews a mean.
    const cycleRows = repo.cycleTimes(project);
    const cycles = cycleRows.map((r) => (Date.parse(r.doneAt) - Date.parse(r.startedAt)) / 3_600_000).sort((a, b) => a - b);
    const median = cycles.length ? cycles[Math.floor(cycles.length / 2)] : null;
    const firstPass = cycleRows.filter((r) => r.failed === 0).length;
    const finished = cycleRows.length;
    const done = agg.totals.success;
    const failed = agg.totals.failed;

    // The side chat is not a run, but it is spend: one line in the cost breakdown, and in the total.
    const chatCost = repo.chatCost(project);
    // So are spec rewrites, and the small intake jobs (sorting a task, describing an image).
    const specCost = repo.specCost(project);
    const intake = repo.intakeCost(project);
    const intakeCost = intake.reduce((s, x) => s + x.cost, 0);
    const split = repo.spendSplit(project);
    const money = (n: number) => Number(n.toFixed(4));
    const result: Analytics = {
      byStatus: tally(tasks.map((t) => t.status), ["backlog", "queued", "planning", "running", "approval", "review", "done", "failed"]),
      byType: tally(tasks.map((t) => t.type), TASK_TYPES),
      byPriority: tally(tasks.map((t) => t.priority), ["p0", "p1", "p2", "p3"]),
      daily,
      totals: {
        open: tasks.filter((t) => !["done"].includes(t.status)).length,
        done: tasks.filter((t) => t.status === "done").length,
        blocked: tasks.filter((t) => t.status === "backlog" && blocked(t)).length,
        needsYou: tasks.filter((t) => ["approval", "review", "failed"].includes(t.status)).length,
        cost7d: Number(daily.slice(-7).reduce((s, d) => s + d.cost, 0).toFixed(4)),
        costAll: Number((agg.totals.cost + chatCost + specCost + intakeCost).toFixed(4)),
        runs: agg.totals.runs,
        runSuccessRate: done + failed ? done / (done + failed) : null,
        medianCycleHours: median === null ? null : Number(median.toFixed(2)),
        firstPassRate: finished ? firstPass / finished : null,
      },
      failuresByStage: agg.failuresByStage,
      costByModel: [
        ...agg.byModel,
        ...(chatCost > 0 ? [{ key: "side chat", cost: Number(chatCost.toFixed(4)), runs: 0 }] : []),
        ...(specCost > 0 ? [{ key: "spec rewrites", cost: Number(specCost.toFixed(4)), runs: 0 }] : []),
        ...intake.map((x) => ({ key: x.kind === "triage" ? "sorting new tasks" : "describing images", cost: money(x.cost), runs: 0 })),
      ].sort((a, b) => b.cost - a.cost),
      spend: {
        tokens: { output: split.output, fresh: split.fresh, cacheRead: split.cacheRead, cacheWrite: split.cacheWrite },
        byJob: [
          { key: "stages — their own model", cost: money(agg.totals.cost - split.otherModelsUsd - split.criticUsd) },
          { key: "helpers and small calls inside stages", cost: money(split.otherModelsUsd) },
          { key: "plan critic", cost: money(split.criticUsd) },
          { key: "side chat", cost: money(chatCost) },
          { key: "spec rewrites", cost: money(specCost) },
          { key: "sorting tasks and describing images", cost: money(intakeCost) },
        ].filter((x) => x.cost > 0),
      },
    };
    return result;
  });
}
