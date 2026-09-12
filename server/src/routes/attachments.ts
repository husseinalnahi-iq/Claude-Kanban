import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { ConflictError, NotFoundError } from "../engine/runner.ts";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, attachmentKind } from "../types.ts";
import type { Attachment } from "../types.ts";

/** How much of a text file is kept as its preview: enough to see the shape, not enough to bloat a prompt. */
export const PREVIEW_CHARS = 4000;

/** Where a task's files live: under the board's own state dir, never inside the user's project. */
export function attachmentDir(stateDir: string, taskId: string): string {
  const dir = join(stateDir, "attachments", taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The media type for a filename, or null when the board does not accept that kind of file. */
export function mediaTypeFor(name: string): string | null {
  return ATTACHMENT_TYPES[extname(name).toLowerCase()] ?? null;
}

/** The first few KB of a text file, so the UI and the prompts show what is in it without opening it. */
export function textPreview(path: string, mediaType: string): string | null {
  if (attachmentKind(mediaType) !== "text") return null;
  try {
    const buf = readFileSync(path).subarray(0, PREVIEW_CHARS * 2);
    // A file that is really binary despite its extension would render as mojibake; skip it.
    if (buf.includes(0)) return null;
    return buf.toString("utf8").slice(0, PREVIEW_CHARS);
  } catch {
    return null;
  }
}

/**
 * Saves one file and indexes it. Used by the upload route and by the runner when a session produces
 * something, so both go through the same size cap, the same type check and the same naming.
 */
export function saveAttachment(
  repo: { getSettings(): { stateDir: string }; addAttachment(a: Omit<Attachment, "id" | "created_at">): Attachment },
  a: { task_id: string; run_id?: string | null; source: "user" | "run"; name: string; media_type?: string; data: Buffer; note?: string | null },
): Attachment {
  const media = a.media_type ?? mediaTypeFor(a.name);
  if (!media) throw new ConflictError(`The board does not handle "${extname(a.name) || a.name}" files.`);
  if (a.data.byteLength > MAX_ATTACHMENT_BYTES) throw new ConflictError(`"${a.name}" is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
  const dir = attachmentDir(repo.getSettings().stateDir, a.task_id);
  // The stored filename is ours, so a crafted name can never escape the folder or overwrite anything.
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const path = join(dir, `${id}${extname(a.name).toLowerCase() || ".bin"}`);
  writeFileSync(path, a.data);
  return repo.addAttachment({
    task_id: a.task_id,
    run_id: a.run_id ?? null,
    source: a.source,
    name: a.name.slice(0, 120),
    media_type: media,
    bytes: a.data.byteLength,
    path,
    note: a.note ?? null,
    // Text explains itself; an image is described separately by the vision model.
    description: textPreview(path, media),
  });
}

/** Removes a task's whole file folder. Called when a task is deleted. */
export function removeAttachmentDir(stateDir: string, taskId: string): void {
  const dir = join(stateDir, "attachments", taskId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Advisory only: the extension decides, because browsers disagree about .csv and .md. */
  media_type: z.string().optional(),
  /** base64 without the data: prefix; the browser strips it. */
  data: z.string().min(1),
  note: z.string().trim().max(200).nullable().optional(),
});

export async function attachmentRoutes(app: FastifyInstance, { repo, bus, runner }: AppDeps) {
  app.get("/tasks/:id/attachments", async (req) => repo.listAttachments((req.params as { id: string }).id));

  app.post("/tasks/:id/attachments", async (req) => {
    const taskId = (req.params as { id: string }).id;
    if (!repo.getTask(taskId)) throw new NotFoundError(`No task ${taskId}`);
    const body = uploadSchema.parse(req.body);
    if (!mediaTypeFor(body.name)) {
      throw new ConflictError(`The board does not handle "${extname(body.name) || body.name}" files. Images, PDF, Word, Excel, PowerPoint, CSV and text all work.`);
    }
    const data = Buffer.from(body.data, "base64");
    if (!data.byteLength) throw new ConflictError("That file was empty.");
    const attachment = saveAttachment(repo, { task_id: taskId, source: "user", name: body.name, data, note: body.note ?? null });
    bus.publish({ type: "attachment.added", attachment });
    // An image is described once, cheaply, in the background; text already carries its own preview.
    if (attachmentKind(attachment.media_type) === "image") void runner.describeAttachment(attachment.id).catch(() => {});
    return attachment;
  });

  /**
   * The bytes. Everything except a bitmap image is sent as a download with `nosniff`: a task file is
   * untrusted content, and serving an HTML artifact inline from this origin would let it call the
   * board's own API. The UI previews HTML in a sandboxed frame, from /text, instead.
   */
  app.get("/attachments/:id/raw", async (req, reply) => {
    const a = repo.getAttachment((req.params as { id: string }).id);
    if (!a || !existsSync(a.path)) throw new NotFoundError("That file is no longer on disk.");
    const inline = attachmentKind(a.media_type) === "image";
    return reply
      .type(a.media_type)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${a.name.replace(/[^\w.\- ]+/g, "_")}"`)
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(a.path));
  });

  /** Text content of a text-ish file, as plain text, for previews. Never served as its own type. */
  app.get("/attachments/:id/text", async (req, reply) => {
    const a = repo.getAttachment((req.params as { id: string }).id);
    if (!a || !existsSync(a.path)) throw new NotFoundError("That file is no longer on disk.");
    if (attachmentKind(a.media_type) !== "text") throw new ConflictError("That file is not text.");
    return reply
      .type("text/plain; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .send(readFileSync(a.path).toString("utf8").slice(0, 400_000));
  });

  app.delete("/attachments/:id", async (req) => {
    const a = repo.getAttachment((req.params as { id: string }).id);
    if (!a) throw new NotFoundError("No such file.");
    if (existsSync(a.path)) rmSync(a.path, { force: true });
    repo.deleteAttachment(a.id);
    return { ok: true };
  });
}
