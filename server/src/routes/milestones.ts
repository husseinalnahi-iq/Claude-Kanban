import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";

export async function milestoneRoutes(app: FastifyInstance, { repo, bus }: AppDeps) {
  app.get("/milestones", async (req) => {
    const { project } = req.query as { project?: string };
    return project ? repo.listMilestones(project) : [];
  });

  app.post("/milestones", async (req) => {
    const body = z
      .object({ project_id: z.string(), title: z.string().trim().min(1), due_date: z.string().nullable().optional(), notes: z.string().nullable().optional() })
      .parse(req.body);
    if (!repo.getProject(body.project_id)) throw new NotFoundError(`No project ${body.project_id}`);
    const milestone = repo.createMilestone(body);
    bus.publish({ type: "milestone.updated", milestone });
    return milestone;
  });

  app.patch("/milestones/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!repo.getMilestone(id)) throw new NotFoundError(`No milestone ${id}`);
    const body = z
      .object({ title: z.string().trim().min(1).optional(), position: z.number().optional(), due_date: z.string().nullable().optional(), notes: z.string().nullable().optional() })
      .parse(req.body);
    const milestone = repo.updateMilestone(id, body);
    bus.publish({ type: "milestone.updated", milestone });
    return milestone;
  });

  app.delete("/milestones/:id", async (req) => {
    const { id } = req.params as { id: string };
    repo.deleteMilestone(id);
    return { ok: true };
  });
}
