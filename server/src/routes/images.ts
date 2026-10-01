import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { CLOUDFLARE_TOKEN_REF, POLLINATIONS_KEY_REF } from "../engine/images.ts";

const SECRET_NAMES = [POLLINATIONS_KEY_REF, CLOUDFLARE_TOKEN_REF] as const;

/**
 * Settings → Images. The provider and the Cloudflare account id travel with settings (PATCH /settings);
 * the keys never do (D125), so they are written and removed here, and only "is one set?" is read back.
 */
export async function imageRoutes(app: FastifyInstance, { repo, runner, bus }: AppDeps) {
  app.get("/settings/images", async () => runner.imageStatus());

  app.put("/settings/images/secret", async (req) => {
    const { name, value } = z.object({ name: z.enum(SECRET_NAMES), value: z.string().trim().min(1).max(4000) }).parse(req.body);
    runner.secrets.set(name, value);
    bus.publish({ type: "settings.updated", settings: repo.getSettings() });
    return runner.imageStatus();
  });

  app.delete("/settings/images/secret/:name", async (req) => {
    const { name } = z.object({ name: z.enum(SECRET_NAMES) }).parse(req.params);
    runner.secrets.delete(name);
    bus.publish({ type: "settings.updated", settings: repo.getSettings() });
    return runner.imageStatus();
  });

  /** Try it: one small image from what is set right now, so a wrong key shows here and not mid-task. */
  app.post("/settings/images/test", async (req) => {
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(500).optional() }).parse(req.body ?? {});
    return runner.testImage(prompt ?? "a friendly robot at a kanban board, flat illustration, soft colours");
  });
}
