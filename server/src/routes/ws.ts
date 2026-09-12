import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";

/**
 * Server → client push.
 *
 * Everything except transcript events goes to every client — those messages are small and every view
 * needs them. `event` messages are different: a busy run emits hundreds, each carrying a whole SDK
 * message, and only the one drawer that is open cares. Clients say which task's transcript they are
 * watching, and the rest is not sent at all.
 */
export async function wsRoutes(app: FastifyInstance, { bus }: AppDeps) {
  app.get("/ws", { websocket: true }, (socket) => {
    let watching: string | null = null;
    const off = bus.subscribe((msg) => {
      if (socket.readyState !== socket.OPEN) return;
      if (msg.type === "event" && msg.taskId !== watching) return;
      socket.send(JSON.stringify(msg));
    });
    socket.on("message", (raw: Buffer) => {
      try {
        const m = JSON.parse(String(raw)) as { watch?: string | null };
        if ("watch" in m) watching = typeof m.watch === "string" ? m.watch : null;
      } catch {
        // A client that sends nonsense simply keeps its current subscription.
      }
    });
    socket.on("close", off);
    socket.on("error", off);
  });
}
