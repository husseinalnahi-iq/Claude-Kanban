import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";

export async function runRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  app.get("/runs", async (req) => {
    const q = req.query as { task?: string };
    return q.task ? repo.runsForTask(q.task) : repo.listRuns();
  });

  app.get("/runs/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    if (!repo.getRun(id)) throw new NotFoundError(`No run ${id}`);
    const after = Number((req.query as { after?: string }).after ?? 0) || 0;
    return repo.eventsAfter(id, after);
  });

  app.get("/queue", async () => runner.queue.snapshot());
}
