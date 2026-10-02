import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { NOTE_MAX_CHARS } from "../repo.ts";
import { NotFoundError } from "../engine/runner.ts";

/** Project memory: what the board carries from one task to the next. Editable, because stale memory misleads runs. */
export async function memoryRoutes(app: FastifyInstance, { repo }: AppDeps) {
  app.get("/memory", async (req) => {
    const { project } = req.query as { project?: string };
    return project ? repo.notes(project) : [];
  });

  app.post("/memory", async (req) => {
    const body = z.object({ project_id: z.string(), text: z.string().trim().min(8).max(NOTE_MAX_CHARS) }).parse(req.body);
    if (!repo.getProject(body.project_id)) throw new NotFoundError(`No project ${body.project_id}`);
    return repo.addNote({ project_id: body.project_id, text: body.text, source: "user" });
  });

  // A run flagged the note and you looked: it stands, and goes back into prompts.
  app.post("/memory/:id/keep", async (req) => {
    const id = (req.params as { id: string }).id;
    const note = repo.keepNote(id);
    if (!note) throw new NotFoundError(`No note ${id}`);
    return note;
  });

  app.delete("/memory/:id", async (req) => {
    repo.deleteNote((req.params as { id: string }).id);
    return { ok: true };
  });
}
