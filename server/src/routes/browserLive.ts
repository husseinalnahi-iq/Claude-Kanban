import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";

/**
 * The live view of a task's browser. JSON text frames carry where it is and what it is doing
 * (`LiveMeta`); binary frames are JPEG pictures, about five a second while the page changes.
 * Behind the same local-only guard as every other route.
 */
export async function browserLiveRoutes(app: FastifyInstance, { runner }: AppDeps) {
  app.get("/api/browser/live", async () => runner.browserWatch.liveTasks());

  app.get("/ws/browser/:taskId", { websocket: true }, (socket, req) => {
    const { taskId } = req.params as { taskId: string };
    const open = () => socket.readyState === socket.OPEN;
    const w = runner.browserWatch.watch(
      taskId,
      (jpeg) => open() && socket.send(jpeg),
      (meta) => open() && socket.send(JSON.stringify(meta)),
    );
    socket.send(JSON.stringify(w.meta));
    if (w.frame) socket.send(w.frame);
    socket.on("close", w.unwatch);
    socket.on("error", w.unwatch);
  });
}
