import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { EFFORTS } from "../types.ts";
import type { SpecWriter } from "../engine/specWriter.ts";
import { reportBusy } from "./busy.ts";

/** The Spec section's ✦ Rewrite, and its versions. */
export async function specRoutes(app: FastifyInstance, { bus, runner, specs }: AppDeps & { specs: SpecWriter }) {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  // Which tasks may have a rewrite running. The writer announces each start, but not every ending (a
  // task deleted mid-rewrite ends in silence), so this is only where to look: the writer has the last word.
  const started = new Set<string>();
  bus.subscribe((m) => {
    if (m.type === "spec.rewrite" && m.state === "running") started.add(m.taskId);
    else if (m.type === "spec.rewrite" || m.type === "task.deleted") started.delete(m.taskId);
  });
  reportBusy(runner, "spec", () => {
    for (const id of started) if (!specs.status(id).rewriting) started.delete(id);
    return [...started].map((task_id) => ({ what: "spec", task_id }));
  });

  app.get("/tasks/:id/spec", async (req) => specs.status(idOf(req)));

  app.post("/tasks/:id/spec/rewrite", async (req) => {
    const body = z
      .object({
        model: z.string().trim().min(1).max(120).optional(),
        effort: z.enum(EFFORTS as [string, ...string[]]).optional(),
        instruction: z.string().max(2000).optional(),
      })
      .parse(req.body ?? {});
    return specs.start(idOf(req), body as Parameters<SpecWriter["start"]>[1]);
  });

  app.post("/tasks/:id/spec/stop", async (req) => ({ stopped: specs.stop(idOf(req)) }));

  app.post("/tasks/:id/spec/restore", async (req) => {
    const { version_id } = z.object({ version_id: z.string().min(1) }).parse(req.body);
    return specs.restore(idOf(req), version_id);
  });
}
