import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";

export async function approvalRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  app.get("/approvals", async () => repo.pendingApprovalsAll());

  app.post("/approvals/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ decision: z.enum(["allow", "deny"]), note: z.string().nullable().optional() }).parse(req.body);
    return runner.decideApproval(id, body.decision, body.note?.trim() || null);
  });
}
