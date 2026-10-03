import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import type { ChatService } from "../engine/chat.ts";
import { EFFORTS, FOLDER_COLORS, attachmentKind } from "../types.ts";
import { NotFoundError } from "../engine/runner.ts";
import { reportBusy } from "./busy.ts";
import { revealPath } from "../openPath.ts";

/** The side chat: conversations about a project that read the code and make cards. */
export async function chatRoutes(app: FastifyInstance, { repo, runner, chat }: AppDeps & { chat: ChatService }) {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  reportBusy(runner, "chat", () => repo.chatIds().filter((c) => chat.isBusy(c.id)).map((c) => ({ what: "chat", project_id: c.project_id })));

  app.get("/projects/:id/chats", async (req) => chat.list(idOf(req)));

  app.post("/projects/:id/chats", async (req) => {
    const body = z.object({ title: z.string().max(120).optional() }).parse(req.body ?? {});
    return chat.create(idOf(req), body.title);
  });

  app.patch("/chats/:id", async (req) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        model: z.string().trim().min(1).max(120).optional(),
        effort: z.enum(EFFORTS as [string, ...string[]]).optional(),
        provider: z.string().trim().min(1).max(64).optional(),
        archived: z.boolean().optional(),
        folder_id: z.string().trim().min(1).max(64).nullable().optional(),
        keep_alive: z.boolean().optional(),
        use_tools: z.boolean().optional(),
        mode: z.enum(["supervised", "autonomous"]).optional(),
      })
      .parse(req.body);
    return chat.update(idOf(req), body as never);
  });

  // Folders on the Studio's chat list: a name over a group of chats, nothing more.
  app.get("/projects/:id/chat-folders", async (req) => chat.folders(idOf(req)));

  app.post("/projects/:id/chat-folders", async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    return chat.createFolder(idOf(req), body.name);
  });

  app.patch("/chat-folders/:id", async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(60).optional(), color: z.enum(FOLDER_COLORS).nullable().optional() }).parse(req.body);
    return chat.updateFolder(idOf(req), body);
  });

  app.delete("/chat-folders/:id", async (req) => {
    chat.deleteFolder(idOf(req));
    return { ok: true };
  });

  app.delete("/chats/:id", async (req) => {
    chat.delete(idOf(req));
    return { ok: true };
  });

  app.get("/chats/:id/messages", async (req) => repo.chatMessages(idOf(req)));

  app.post("/chats/:id/send", async (req) => {
    const body = z.object({ text: z.string().trim().min(1).max(20_000) }).parse(req.body);
    return chat.send(idOf(req), body.text);
  });

  app.post("/chats/:id/stop", async (req) => ({ stopped: chat.stop(idOf(req)) }));

  /** ✦ What next?: five suggested next steps, as a message of the board's own (D338). */
  app.post("/chats/:id/suggest", async (req) => chat.suggest(idOf(req)));

  // Files attached to a chat (D334): the same kinds and size cap as a task's attachments.
  app.get("/chats/:id/files", async (req) => chat.files(idOf(req)));

  app.post("/chats/:id/files", async (req) => {
    // base64 without the data: prefix; the browser strips it. The extension decides the type.
    const body = z.object({ name: z.string().trim().min(1).max(120), data: z.string().min(1) }).parse(req.body);
    return chat.addFile(idOf(req), { name: body.name, data: Buffer.from(body.data, "base64") });
  });

  app.delete("/chat-files/:id", async (req) => {
    chat.removeFile(idOf(req));
    return { ok: true };
  });

  /** Opens the file on this computer with its default app, or shows it selected in its folder (D351). */
  app.post("/chat-files/:id/open", async (req) => {
    const f = repo.getChatFile(idOf(req));
    if (!f || !existsSync(f.path)) throw new NotFoundError("That file is no longer on disk.");
    const body = z.object({ where: z.enum(["file", "folder"]).default("file") }).parse(req.body ?? {});
    revealPath(f.path, body.where);
    return { ok: true };
  });

  app.get("/chat-files/:id/raw", async (req, reply) => {
    const f = repo.getChatFile(idOf(req));
    if (!f || !existsSync(f.path)) throw new NotFoundError("That file is no longer on disk.");
    const inline = attachmentKind(f.media_type) === "image";
    return reply
      .type(f.media_type)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\w.\- ]+/g, "_")}"`)
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(createReadStream(f.path));
  });
}
