import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";
import type { TerminalManager } from "../terminal.ts";

/**
 * Your own terminal inside the board. A shell only ever opens in a registered project's folder or in
 * one of its tasks' worktrees, and the socket carrying it is behind the same local-only guard as the
 * rest of the API (a website in another tab cannot reach it).
 */
export async function terminalRoutes(app: FastifyInstance, { repo, terminals }: AppDeps & { terminals: TerminalManager }) {
  app.get("/api/terminals", async () => terminals.list());

  app.post("/api/terminals", async (req) => {
    const body = z
      .object({ project_id: z.string(), task_id: z.string().nullable().optional(), cols: z.number().int().min(10).max(500).optional(), rows: z.number().int().min(4).max(200).optional() })
      .parse(req.body);
    const project = repo.getProject(body.project_id);
    if (!project) throw new NotFoundError(`No project ${body.project_id}`);
    let cwd = project.path;
    let title = project.name;
    if (body.task_id) {
      const task = repo.getTask(body.task_id);
      if (!task || task.project_id !== project.id) throw new NotFoundError(`No task ${body.task_id} in ${project.name}`);
      if (task.worktree_path && existsSync(task.worktree_path)) cwd = task.worktree_path;
      title = task.title;
    }
    if (!existsSync(cwd)) throw new NotFoundError(`The folder ${cwd} is gone.`);
    return terminals.create({ project_id: project.id, task_id: body.task_id ?? null, cwd, title, cols: body.cols, rows: body.rows });
  });

  app.delete("/api/terminals/:id", async (req) => ({ ok: terminals.kill((req.params as { id: string }).id) }));

  /** Output as `{t:"d", d}`, the end as `{t:"x", code}`; input as `{t:"i", d}` and size as `{t:"r", cols, rows}`. */
  app.get("/ws/terminal/:id", { websocket: true }, (socket, req) => {
    const id = (req.params as { id: string }).id;
    const send = (m: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
    const attached = terminals.attach(id, (d) => send({ t: "d", d }), (code) => send({ t: "x", code }));
    if (!attached) {
      send({ t: "x", code: null, gone: true });
      socket.close();
      return;
    }
    if (attached.replay) send({ t: "d", d: attached.replay });
    if (!terminals.get(id)?.alive) send({ t: "x", code: null });
    socket.on("message", (raw: Buffer) => {
      try {
        const m = JSON.parse(String(raw)) as { t?: string; d?: string; cols?: number; rows?: number };
        if (m.t === "i" && typeof m.d === "string") terminals.write(id, m.d);
        else if (m.t === "r") terminals.resize(id, Number(m.cols), Number(m.rows));
      } catch {
        // ignore anything that is not a message this route knows
      }
    });
    socket.on("close", attached.detach);
    socket.on("error", attached.detach);
  });
}
