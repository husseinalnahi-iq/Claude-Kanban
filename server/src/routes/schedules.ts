import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import type { Scheduler } from "../engine/scheduler.ts";
import { ConflictError, NotFoundError } from "../engine/runner.ts";
import { defaultPipeline, allowedMode } from "../engine/boardMcp.ts";
import { stageSchema } from "./projects.ts";
import { PRIORITIES, TASK_TYPES, type Stage } from "../types.ts";

const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort());
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM, 24-hour");

/** A schedule's template and timing. Creating fills in defaults; a patch changes only what it sends. */
const fields = z.object({
  title: z.string().trim().min(1),
  spec_md: z.string(),
  mode: z.enum(["autonomous", "supervised"]),
  type: z.enum(TASK_TYPES as [string, ...string[]]),
  priority: z.enum(PRIORITIES as [string, ...string[]]),
  pipeline: z.array(stageSchema),
  skills: z.array(z.string()),
  days,
  time,
  enabled: z.boolean(),
});
const createSchema = fields.partial().required({ title: true, days: true, time: true }).extend({ project_id: z.string() });

export async function scheduleRoutes(app: FastifyInstance, { repo, bus, scheduler }: AppDeps & { scheduler: Scheduler }) {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const mustSchedule = (id: string) => {
    const s = repo.getSchedule(id);
    if (!s) throw new NotFoundError(`No schedule ${id}`);
    return s;
  };

  /** Start a Backlog card later: at a time, or when the Claude usage window resets. null cancels. */
  app.post("/tasks/:id/schedule", async (req) => {
    const body = z
      .object({ start_at: z.union([z.literal("reset"), z.string().datetime({ offset: true }), z.null()]) })
      .parse(req.body);
    const task = repo.getTask(idOf(req));
    if (!task) throw new NotFoundError(`No task ${idOf(req)}`);
    if (body.start_at && task.status !== "backlog" && task.status !== "failed") {
      throw new ConflictError("Only a card in Backlog (or one that failed) can be scheduled.");
    }
    if (body.start_at && body.start_at !== "reset" && Date.parse(body.start_at) < Date.now() - 60_000) {
      throw new ConflictError("That time has already passed. Pick a time in the future, or press Queue to start now.");
    }
    const updated = repo.updateTask(task.id, { start_at: body.start_at, note: null });
    bus.publish({ type: "task.updated", task: updated });
    scheduler.tick();
    return repo.getTask(task.id);
  });

  app.get("/projects/:id/schedules", async (req) => repo.listSchedules(idOf(req)));

  /** A repeating schedule. "Repeat this card" sends that card's fields as the template. */
  app.post("/schedules", async (req) => {
    const body = createSchema.parse(req.body);
    const project = repo.getProject(body.project_id);
    if (!project) throw new NotFoundError(`No project ${body.project_id}`);
    return scheduler.create({
      project_id: project.id,
      title: body.title,
      spec_md: body.spec_md ?? "",
      mode: allowedMode(project, body.mode ?? "supervised"),
      type: (body.type ?? "chore") as never,
      priority: (body.priority ?? "p2") as never,
      pipeline: body.pipeline?.length ? (body.pipeline as Stage[]) : defaultPipeline(repo, project),
      skills: body.skills ?? [],
      days: body.days,
      time: body.time,
      enabled: body.enabled ?? true,
    });
  });

  app.patch("/schedules/:id", async (req) => {
    const current = mustSchedule(idOf(req));
    const body = fields.partial().parse(req.body);
    if (body.mode) body.mode = allowedMode(repo.getProject(current.project_id)!, body.mode);
    return scheduler.update(current.id, body as never);
  });

  app.delete("/schedules/:id", async (req) => {
    scheduler.delete(mustSchedule(idOf(req)).id);
    return { ok: true };
  });

  app.post("/schedules/:id/run", async (req) => scheduler.runNow(mustSchedule(idOf(req)).id));
}
