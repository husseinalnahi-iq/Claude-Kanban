import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExplainService } from "../engine/explainAi.ts";

/** A command the board's own table cannot explain, explained by Claude's cheapest model on request (D336). */
export async function explainRoutes(app: FastifyInstance, { explain }: { explain: ExplainService }) {
  app.post("/explain", async (req) => {
    const body = z.object({ command: z.string().trim().min(1).max(4000) }).parse(req.body);
    return { text: await explain.explain(body.command) };
  });
}
