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

  /** Answer a question Claude asked mid-task. Skipping it is a plain "deny" on the route above. */
  app.post("/approvals/:id/answer", async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ answers: z.record(z.string(), z.string().trim().min(1).max(4000)) }).parse(req.body);
    if (!Object.keys(body.answers).length) throw Object.assign(new Error("Pick or type an answer first."), { statusCode: 400 });
    return runner.answerQuestion(id, body.answers);
  });
}
