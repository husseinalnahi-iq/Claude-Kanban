import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { ConflictError } from "../engine/runner.ts";
import { codexModels, codexStatus, forgetCodexStatus } from "../engine/providers/codexLocal.ts";
import { codexPlanProvider, linkCodexPatch } from "../engine/codexLink.ts";
import { openTerminal } from "./health.ts";

/**
 * Codex on this computer (D296): what is there and signed in, one click to put it on the board, and a
 * sign-in that opens Codex's own login in a terminal (it opens a browser and waits for it).
 */
export async function codexRoutes(app: FastifyInstance, { repo, bus, runner }: AppDeps) {
  const secrets = runner.secrets;
  const hasKey = (n: string) => Boolean(secrets.get(n));
  const view = async (force = false) => {
    const st = await codexStatus(force);
    return { ...st, linked: Boolean(codexPlanProvider(repo.getSettings(), hasKey)?.enabled) };
  };

  app.get("/codex/status", async (req) => view((req.query as { fresh?: string }).fresh === "1"));

  app.post("/codex/link", async () => {
    const st = await codexStatus(true);
    if (!st.found) throw new ConflictError("Codex is not on this computer yet: install it from Setup, or install the Codex app.");
    if (st.signedIn !== "chatgpt") throw new ConflictError(st.signedIn === "api-key" ? "Codex is signed in with an API key. Sign in with ChatGPT first, so your plan is what pays." : "Sign in to Codex with your ChatGPT account first.");
    const { patch, changed } = linkCodexPatch(repo.getSettings(), (await codexModels("login")) ?? [], hasKey);
    if (Object.keys(patch).length) bus.publish({ type: "settings.updated", settings: repo.updateSettings(patch) });
    return { changed, status: await view() };
  });

  app.post("/codex/login", async () => {
    const before = await codexStatus(true);
    if (!before.found) throw new ConflictError("Codex is not on this computer yet: install it from Setup, or install the Codex app.");
    openTerminal("Codex sign-in", before.command, "login");
    // Codex's login waits for the browser; watch for it to finish, about four minutes at most.
    void (async () => {
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        forgetCodexStatus();
        const now = await view(true);
        bus.publish({ type: "codex.updated", status: now });
        if (now.signedIn === "chatgpt") return;
      }
    })();
    return { started: true };
  });

  /** "Check again": forget that Codex could not make pictures, so the next one tries it (D297). */
  app.post("/codex/pictures/reset", async () => {
    bus.publish({ type: "settings.updated", settings: repo.updateSettings({ codexPictures: { works: null, version: null, detail: "", checked_at: null } }) });
    return { ok: true };
  });
}
