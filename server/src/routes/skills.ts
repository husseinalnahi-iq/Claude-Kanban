import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";
import { scanSkills } from "../skills.ts";
import { projectFits, type SuggestedSkills } from "../skills/install.ts";
import { reportBusy } from "./busy.ts";

export async function skillRoutes(app: FastifyInstance, { repo, runner, suggested }: AppDeps & { suggested: SuggestedSkills }) {
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

  // An install cut off halfway leaves a half-copied skill or plugin: count it as Setup work in flight.
  reportBusy(runner, "skills", () => suggested.busy().map(() => ({ what: "setup" })));

  /** The Suggested section: each card with this computer's state, and what kind of project is open. */
  app.get("/skills/suggested", async (req) => {
    const projectId = (req.query as { project?: string }).project;
    return {
      skills: await suggested.list(),
      project: projectFits(projectId ? repo.getProject(projectId)?.path : undefined),
      loadUserPlugins: repo.getSettings().loadUserPlugins,
    };
  });

  /** Starts in the background; progress and the new state arrive over the websocket. */
  app.post("/skills/suggested/starter", async () => ({ queued: suggested.installStarter() }));

  app.post("/skills/suggested/:id/install", async (req) => {
    suggested.install((req.params as { id: string }).id);
    return { started: true };
  });

  app.post("/skills/suggested/:id/remove", async (req) => {
    suggested.remove((req.params as { id: string }).id);
    return { started: true };
  });

  app.post("/skills/suggested/:id/enabled", async (req) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    return suggested.setEnabled((req.params as { id: string }).id, on);
  });
}
