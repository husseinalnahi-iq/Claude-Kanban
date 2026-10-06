import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import type { Repo } from "./repo.ts";
import type { Bus } from "./bus.ts";
import { ConflictError, NotFoundError, PolicyError, type TaskRunner } from "./engine/runner.ts";
import { ProviderError } from "./engine/providers/registry.ts";
import { PORT, STATE_DIR } from "./config.ts";
import { SetupService } from "./setup/service.ts";
import { setupRoutes } from "./routes/setup.ts";
import { projectRoutes } from "./routes/projects.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { runRoutes } from "./routes/runs.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { milestoneRoutes } from "./routes/milestones.ts";
import { skillRoutes } from "./routes/skills.ts";
import { SuggestedSkills } from "./skills/install.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { healthRoutes } from "./routes/health.ts";
import { codexRoutes } from "./routes/codex.ts";
import { systemRoutes } from "./routes/system.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { worktreeRoutes } from "./routes/worktrees.ts";
import { analyticsRoutes } from "./routes/analytics.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { claudeMdRoutes } from "./routes/claudeMd.ts";
import { providerRoutes } from "./routes/providers.ts";
import { imageRoutes } from "./routes/images.ts";
import { searchRoutes } from "./routes/search.ts";
import { wsRoutes } from "./routes/ws.ts";
import { scheduleRoutes } from "./routes/schedules.ts";
import { Scheduler } from "./engine/scheduler.ts";
import { ChatService } from "./engine/chat.ts";
import { RecoveryService } from "./engine/recovery.ts";
import { chatRoutes } from "./routes/chats.ts";
import { ExplainService } from "./engine/explainAi.ts";
import { explainRoutes } from "./routes/explain.ts";
import { SpecWriter } from "./engine/specWriter.ts";
import { specRoutes } from "./routes/specs.ts";
import { recordRoutes } from "./routes/record.ts";
import { TerminalManager } from "./terminal.ts";
import { terminalRoutes } from "./routes/terminals.ts";
import { browserLiveRoutes } from "./routes/browserLive.ts";

export interface AppDeps {
  repo: Repo;
  bus: Bus;
  runner: TaskRunner;
  webDist?: string;
  logger?: boolean;
  /** host:port values the server answers to. Defaults to 127.0.0.1/localhost on the API and Vite ports. */
  allowedHosts?: string[];
  /** The Setup page's checks and fixes. Tests pass one with a fake machine. */
  setup?: SetupService;
  /** Starts cards on time. index.ts starts its timer; tests get one that only ticks when asked. */
  scheduler?: Scheduler;
  /** The side chat. Built here when not given; it shares the runner's SDK entry point. */
  chat?: ChatService;
  /** Looks at failed tasks and retries what can be retried (D411). Built here when not given. */
  recovery?: RecoveryService;
  /** The shells behind the Terminal dock. All of them end when the server closes. */
  terminals?: TerminalManager;
  /** The Spec section's ✦ Rewrite. */
  specs?: SpecWriter;
  /** The Skills tab's Suggested section. Tests pass one with a fake machine and a temp home. */
  suggested?: SuggestedSkills;
}

export function defaultAllowedHosts(): string[] {
  return [PORT, 5173].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // 20 MB: a 10 MB file arrives base64-encoded, which is about a third larger.
  const app = Fastify({ logger: deps.logger ? { level: "info" } : false, bodyLimit: 20 * 1024 * 1024 });

  // Local-only guard: other websites open in the browser must not read the board (WS has no CORS) or
  // trigger actions (a no-cors POST still reaches handlers), and DNS rebinding must not reach the API.
  const hosts = new Set((deps.allowedHosts ?? defaultAllowedHosts()).map((h) => h.toLowerCase()));
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!hosts.has(host)) return reply.code(403).send({ error: `Host "${host}" is not allowed.` });
    const origin = req.headers.origin?.toLowerCase();
    if (origin !== undefined && !origins.has(origin)) return reply.code(403).send({ error: "Cross-origin request refused." });
  });

  // The page shows text written by models, and the web side strips what could act from it. This is
  // the second lock: even if something slips through, the browser loads no picture from another
  // site (a way to send data out without an approval card) and posts no form to one. Only these two
  // are named, so scripts, styles, fonts and the websocket are left exactly as they were.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("content-security-policy", "img-src 'self' data: blob:; form-action 'self'");
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err instanceof PolicyError || err instanceof ConflictError || err instanceof ProviderError) return reply.code(409).send({ error: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: e.message ?? "Internal error" });
  });

  await app.register(websocket);
  const suggested = deps.suggested ?? new SuggestedSkills({ bus: deps.bus });
  const setup = deps.setup ?? new SetupService({ repo: deps.repo, bus: deps.bus, runner: deps.runner, stateDir: join(STATE_DIR, "setup"), skillsBusy: () => suggested.busy() });
  const scheduler = deps.scheduler ?? new Scheduler({ repo: deps.repo, bus: deps.bus, runner: deps.runner });
  const chat = deps.chat ?? new ChatService({ repo: deps.repo, bus: deps.bus, runner: deps.runner, scheduler });
  deps.recovery ?? new RecoveryService({ repo: deps.repo, bus: deps.bus, runner: deps.runner });
  const specs = deps.specs ?? new SpecWriter({ repo: deps.repo, bus: deps.bus, runner: deps.runner });
  await app.register(async (api) => {
    await projectRoutes(api, deps);
    await taskRoutes(api, deps);
    await runRoutes(api, deps);
    await approvalRoutes(api, deps);
    await milestoneRoutes(api, deps);
    await skillRoutes(api, { ...deps, suggested });
    await settingsRoutes(api, deps);
    await imageRoutes(api, deps);
    await healthRoutes(api, deps);
    await codexRoutes(api, deps);
    await setupRoutes(api, setup);
    await systemRoutes(api, deps);
    await memoryRoutes(api, deps);
    await worktreeRoutes(api, deps);
    await analyticsRoutes(api, deps);
    await searchRoutes(api, deps);
    await attachmentRoutes(api, deps);
    await claudeMdRoutes(api, deps);
    await providerRoutes(api, deps);
    await scheduleRoutes(api, { ...deps, scheduler });
    await chatRoutes(api, { ...deps, chat });
    await explainRoutes(api, { explain: new ExplainService(deps.runner) });
    await specRoutes(api, { ...deps, specs });
    await recordRoutes(api, deps);
  }, { prefix: "/api" });
  await wsRoutes(app, deps);
  const terminals = deps.terminals ?? new TerminalManager();
  await terminalRoutes(app, { ...deps, terminals });
  await browserLiveRoutes(app, deps);
  app.addHook("onClose", async () => {
    terminals.killAll();
    deps.runner.browserWatch.stopAll();
  });

  if (deps.webDist && existsSync(deps.webDist)) {
    await app.register(fastifyStatic, { root: deps.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
