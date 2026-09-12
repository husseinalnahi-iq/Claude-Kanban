import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { pickFolder } from "../folderPicker.ts";

export async function systemRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  /** Opens the folder picker on this machine (the board is local-only) and returns what was chosen. */
  app.post("/pick-folder", async (req) => {
    const body = (req.body ?? {}) as { start?: string };
    return pickFolder(typeof body.start === "string" && body.start.trim() ? body.start.trim() : undefined);
  });

  app.get("/limits", async () => repo.usageLimits());
  /** Fresh numbers on demand — the same ones Claude's /usage shows, read for free. */
  app.post("/limits/refresh", async () => runner.refreshLimits());
  /** Whether fast mode can run on this account — free to check, it never reaches the model. */
  app.get("/fast-mode", async (req) => runner.fastModeStatus((req.query as { force?: string }).force === "1"));
  /** The Claude models your login can use — free, read from Claude Code's startup handshake. */
  app.get("/claude/models", async (req) => runner.claudeModels((req.query as { force?: string }).force === "1"));
  /** The plugins and tool servers a run gets — also free, read from the session's init message. */
  app.get("/session-tools", async (req) => runner.sessionTools((req.query as { force?: string }).force === "1"));
}
