import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";
import { scanSkills } from "../skills.ts";

export async function skillRoutes(app: FastifyInstance, { repo }: AppDeps) {
  const scan = (projectId?: string) => {
    const off = new Set(repo.getSettings().disabledSkills);
    return scanSkills({ projectPath: projectId ? repo.getProject(projectId)?.path : undefined }).map((s) => ({
      ...s,
      enabled: s.pluginEnabled && !off.has(s.name),
    }));
  };

  app.get("/skills", async (req) => scan((req.query as { project?: string }).project));

  /** Opens a SKILL.md in the OS default editor. Only paths the scanner returned are accepted. */
  app.post("/skills/open", async (req) => {
    const body = z.object({ path: z.string(), project: z.string().optional() }).parse(req.body);
    const known = scan(body.project).find((s) => s.path === body.path);
    if (!known) throw new NotFoundError("Unknown skill path");
    // No shell anywhere: a skill folder name must never be able to inject a command (e.g. "a&calc&b").
    const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(opener, [known.path], { detached: true, stdio: "ignore", shell: false });
    child.unref();
    return { ok: true };
  });
}
