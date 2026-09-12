import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SetupService } from "../setup/service.ts";
import { localModelsStatus } from "../setup/local.ts";

const fixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), input: z.record(z.string(), z.string()).default({}) }),
  z.object({ kind: z.literal("claude") }),
]);

export async function setupRoutes(app: FastifyInstance, setup: SetupService) {
  app.get("/setup", async (req) => {
    const checks = await setup.all((req.query as { fresh?: string }).fresh === "1");
    const failing = (level: string) => checks.filter((c) => !c.ok && c.level === level).length;
    return { checks, summary: { required: failing("required"), recommended: failing("recommended") } };
  });

  /** The "Free AI on this computer" guide: this machine, and how far LM Studio and Ollama are set up. */
  app.get("/setup/local-models", async () => localModelsStatus(setup.probe, setup.settings()));

  app.post("/setup/:id/check", async (req) => setup.recheck((req.params as { id: string }).id));

  app.post("/setup/:id/fix", async (req) => {
    const { id } = req.params as { id: string };
    const body = fixSchema.parse(req.body ?? {});
    if (body.kind === "claude") return { task: await setup.startClaude(id) };
    setup.startRun(id, body.input);
    return { started: true };
  });
}
