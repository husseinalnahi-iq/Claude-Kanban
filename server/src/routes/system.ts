import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { pickFolder } from "../folderPicker.ts";

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const STARTED_AT = Date.now();

/** When the server's code on disk last changed. */
function newestChange(dir = SERVER_SRC): number {
  let newest = 0;
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) newest = Math.max(newest, statSync(join(f.parentPath, f.name)).mtimeMs);
  }
  return newest;
}

export async function systemRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  /**
   * Whether this server runs older code than what is on disk. The page is rebuilt from disk, so a server
   * left running across an update serves a page that asks it for things it does not have yet.
   */
  app.get("/version", async () => ({ startedAt: new Date(STARTED_AT).toISOString(), stale: newestChange() > STARTED_AT }));

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
