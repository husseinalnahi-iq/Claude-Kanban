import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";
import { PROVIDER_PRESETS } from "../engine/providers/presets.ts";

/**
 * Providers themselves are edited through PATCH /settings. These routes are the parts that must
 * never travel with settings: the secret values (write-only) and a live test of one provider.
 */
export async function providerRoutes(app: FastifyInstance, { repo, runner, bus }: AppDeps) {
  const secrets = runner.secrets;

  app.get("/providers", async () => repo.getSettings().providers.map((p) => ({ ...p, hasSecret: secrets.has(p.authRef) })));

  app.get("/providers/presets", async () => PROVIDER_PRESETS);

  app.put("/providers/:id/secret", async (req) => {
    const { id } = req.params as { id: string };
    const { value } = z.object({ value: z.string().min(1).max(4000) }).parse(req.body);
    const p = repo.getSettings().providers.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`No provider ${id}`);
    if (!p.authRef) throw new NotFoundError(`Provider ${id} has no secret name to store under.`);
    secrets.set(p.authRef, value.trim());
    bus.publish({ type: "settings.updated", settings: repo.getSettings() });
    return { hasSecret: true };
  });

  app.delete("/providers/:id/secret", async (req) => {
    const { id } = req.params as { id: string };
    const p = repo.getSettings().providers.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`No provider ${id}`);
    if (p.authRef) secrets.delete(p.authRef);
    bus.publish({ type: "settings.updated", settings: repo.getSettings() });
    // The environment may still supply one, which is worth knowing.
    return { hasSecret: secrets.has(p.authRef) };
  });

  /** What the provider can run right now (Ollama's pulled models, OpenRouter's list with prices), plus your list. */
  app.get("/providers/:id/models", async (req) => {
    const { id } = req.params as { id: string };
    const p = repo.getSettings().providers.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`No provider ${id}`);
    return runner.catalog.list(p, secrets.get(p.authRef));
  });

  app.post("/providers/:id/test", async (req) => {
    const { id } = req.params as { id: string };
    const { model } = z.object({ model: z.string().trim().min(1).optional() }).parse(req.body ?? {});
    return runner.testProvider(id, model);
  });
}
