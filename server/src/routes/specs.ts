import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { EFFORTS } from "../types.ts";
import type { SpecWriter } from "../engine/specWriter.ts";

/** The Spec section's ✦ Rewrite, and its versions. */
export async function specRoutes(app: FastifyInstance, { specs }: AppDeps & { specs: SpecWriter }) {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

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
