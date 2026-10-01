import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";
import { NotFoundError } from "../engine/runner.ts";
import { taskRecord } from "../engine/record.ts";
import type { EventRow } from "../types.ts";

/** A page of events per request to the database, so a very long run is read in pieces. */
const PAGE = 2000;

export async function recordRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  /** A task's whole story as one Markdown file (see engine/record.ts). `?download=1` saves it instead of showing it. */
  app.get("/tasks/:id/record", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = repo.getTask(id);
    const project = task && repo.getProject(task.project_id);
    if (!task || !project) throw new NotFoundError(`No task ${id}`);
    const runs = repo.runsForTask(id);
    const events = new Map<string, EventRow[]>();
    for (const run of runs) {
      const all: EventRow[] = [];
      for (let after = 0; ; ) {
        const page = repo.eventsAfter(run.id, after, PAGE);
        all.push(...page);
        if (page.length < PAGE) break;
        after = page[page.length - 1].id;
      }
      events.set(run.id, all);
    }
    // No branch, a worktree that is gone, or not a git folder: the record simply has no file list.
    const files = await runner.diff(id).then((d) => d.map((f) => ({ file: f.file, status: f.status })), () => []);
    const md = taskRecord({ task, project, runs, events, approvals: repo.approvalsForTask(id), messages: repo.messagesForTask(id, 500), files });
    reply.header("content-type", "text/markdown; charset=utf-8");
    if ((req.query as { download?: string }).download === "1") {
      const name = task.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || task.id;
      reply.header("content-disposition", `attachment; filename="${name}-record.md"`);
    }
    return md;
  });
}
