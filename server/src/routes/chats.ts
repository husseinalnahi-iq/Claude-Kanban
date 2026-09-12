import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import type { ChatService } from "../engine/chat.ts";
import { EFFORTS } from "../types.ts";

/** The side chat: conversations about a project that read the code and make cards. */
export async function chatRoutes(app: FastifyInstance, { repo, chat }: AppDeps & { chat: ChatService }) {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

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
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    return chat.update(idOf(req), body as never);
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
}
