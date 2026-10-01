import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";

/** Most a page of transcript may hold: an event can be 24k characters, so this is already a large answer. */
const MAX_EVENTS_PAGE = 2000;

export async function runRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  app.get("/runs", async (req) => {
    const q = req.query as { task?: string };
    return q.task ? repo.runsForTask(q.task) : repo.listRuns();
  });

  app.get("/runs/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    if (!repo.getRun(id)) throw new NotFoundError(`No run ${id}`);
    // A long transcript is read a page at a time: ask again with `after` set to the last id you got,
    // until a page comes back shorter than `limit`.
    const q = req.query as { after?: string; limit?: string };
    const after = Math.max(0, Math.floor(Number(q.after)) || 0);
    const limit = Math.min(MAX_EVENTS_PAGE, Math.max(1, Math.floor(Number(q.limit)) || MAX_EVENTS_PAGE));
    return repo.eventsAfter(id, after, limit);
  });

  app.get("/queue", async () => runner.queue.snapshot());
}
