import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { searchBoard } from "../search.ts";

export type { SearchHit } from "../search.ts";

export async function searchRoutes(app: FastifyInstance, { repo }: AppDeps) {
  app.get("/search", async (req) => {
    const { q, project, limit } = req.query as { q?: string; project?: string; limit?: string };
    return searchBoard(repo, q ?? "", { project, limit: Number(limit) || undefined });
  });
}
