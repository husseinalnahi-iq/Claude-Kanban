import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type { ChatMessage, Task } from "../types.ts";
import { PRIORITIES, TASK_TYPES } from "../types.ts";
import { allowedMode, defaultPipeline } from "./boardMcp.ts";
import type { TaskRunner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";

type Card = NonNullable<ChatMessage["meta"]["cards"]>[number];

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ ...text(message), isError: true });
const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, type: t.type, priority: t.priority, mode: t.mode, summary: t.summary, start_at: t.start_at });

export interface ChatBoardDeps {
  repo: Repo;
  bus: Bus;
  runner: TaskRunner;
  scheduler?: Scheduler;
}

/**
 * The side chat's hands: it reads the board and makes, edits, queues and schedules cards in its own
 * project. It never touches code; changing code is what a card is for. Handlers are separate from the
 * MCP wrapper so tests call them directly. `onCard` records each card touched, for the chips.
 */
export function chatBoardHandlers({ repo, bus, runner, scheduler }: ChatBoardDeps, projectId: string, onCard: (c: Card) => void) {
  const mine = (id: string) => {
    const t = repo.getTask(id);
    return t && t.project_id === projectId ? t : undefined;
  };
  const publish = (t: Task) => bus.publish({ type: "task.updated", task: t });

  return {
    listTasks(args: { status?: string }) {
      const tasks = repo.listTasks({ project_id: projectId }).filter((t) => !t.archived_at && (!args.status || t.status === args.status));
      return text({ tasks: tasks.map(brief), note: tasks.length ? undefined : "No cards on this board yet." });
    },

    getTask(args: { task_id: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      return text({ ...brief(t), spec_md: t.spec_md, depends_on: t.depends_on, error: t.error, pipeline: t.pipeline.map((s) => `${s.stage} · ${s.model} · ${s.effort}`) });
    },

    createTask(args: { title: string; spec_md: string; type?: string; priority?: string; mode?: "supervised" | "autonomous"; depends_on?: string[] }) {
      const project = repo.getProject(projectId)!;
      const deps = (args.depends_on ?? []).filter((id) => mine(id));
      const t = repo.createTask({
        project_id: projectId,
        title: args.title.trim(),
        spec_md: args.spec_md,
        type: (args.type as Task["type"]) ?? "feature",
        priority: (args.priority as Task["priority"]) ?? "p2",
        mode: allowedMode(project, args.mode ?? "supervised"),
        pipeline: defaultPipeline(repo, project),
        depends_on: deps,
        status: "backlog",
      });
      publish(t);
      onCard({ id: t.id, title: t.title, action: "created" });
      return text({ created: brief(t), note: "It is in Backlog. Offer to queue it now or schedule it for later." });
    },

    updateTask(args: { task_id: string; title?: string; spec_md?: string; priority?: string; labels?: string[] }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      if (t.status !== "backlog" && t.status !== "failed") return fail(`"${t.title}" is ${t.status}; only a card in Backlog (or one that failed) can be edited from chat.`);
      const updated = repo.updateTask(t.id, {
        title: args.title?.trim() || undefined,
        spec_md: args.spec_md,
        priority: args.priority as Task["priority"] | undefined,
        labels: args.labels,
      });
      publish(updated);
      onCard({ id: t.id, title: updated.title, action: "updated" });
      return text({ updated: brief(updated) });
    },

    queueTask(args: { task_id: string }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      try {
        const queued = runner.queueTask(t.id);
        onCard({ id: t.id, title: t.title, action: "queued" });
        return text({ queued: brief(queued) });
      } catch (err) {
        return fail(`Could not queue "${t.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    scheduleTask(args: { task_id: string; start_at: string | null }) {
      const t = mine(args.task_id);
      if (!t) return fail(`No card ${args.task_id} in this project.`);
      if (args.start_at && t.status !== "backlog" && t.status !== "failed") return fail(`"${t.title}" is ${t.status}; only a Backlog card can be scheduled.`);
      if (args.start_at && args.start_at !== "reset") {
        const at = Date.parse(args.start_at);
        if (!Number.isFinite(at)) return fail(`"${args.start_at}" is not a time. Use ISO 8601 with the offset, e.g. 2026-09-14T03:00:00+03:00, or "reset".`);
        if (at < Date.now() - 60_000) return fail("That time has already passed. Pick a time in the future.");
      }
      const updated = repo.updateTask(t.id, { start_at: args.start_at ? (args.start_at === "reset" ? "reset" : new Date(args.start_at).toISOString()) : null, note: null });
      publish(updated);
      scheduler?.tick();
      onCard({ id: t.id, title: t.title, action: "scheduled" });
      return text({ scheduled: brief(updated) });
    },

    memory() {
      return text({ memory: repo.notes(projectId).map((n) => n.text) });
    },
  };
}

export function createChatBoardServer(deps: ChatBoardDeps, projectId: string, onCard: (c: Card) => void) {
  const h = chatBoardHandlers(deps, projectId, onCard);
  return createSdkMcpServer({
    name: "board",
    version: "1.0.0",
    alwaysLoad: true,
    instructions: "This project's Claude Kanban board. List and read cards, create cards for work to be done, edit Backlog cards, queue them, or schedule them for later.",
    tools: [
      tool("board_list_tasks", "List the cards on this project's board, optionally only one status (backlog, queued, running, review, done, failed…).",
        { status: z.string().optional() }, async (a) => h.listTasks(a)),
      tool("board_get_task", "Read one card: its spec, status, summary and pipeline.", { task_id: z.string() }, async (a) => h.getTask(a)),
      tool("board_create_task",
        "Create a card in Backlog. Give it a short title and a spec that says what done looks like, in the user's terms. Supervised unless the user asked for autonomous.",
        {
          title: z.string().min(1).max(200),
          spec_md: z.string().max(20_000),
          type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
          priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
          mode: z.enum(["supervised", "autonomous"]).optional(),
          depends_on: z.array(z.string()).max(10).optional().describe("Ids of cards that must finish first."),
        },
        async (a) => h.createTask(a)),
      tool("board_update_task", "Edit a card that is in Backlog or failed: title, spec, priority or labels.",
        { task_id: z.string(), title: z.string().optional(), spec_md: z.string().optional(), priority: z.enum(PRIORITIES as [string, ...string[]]).optional(), labels: z.array(z.string()).max(8).optional() },
        async (a) => h.updateTask(a)),
      tool("board_queue_task", "Start a Backlog card now (it joins the queue). Only when the user asked for it to run.", { task_id: z.string() }, async (a) => h.queueTask(a)),
      tool("board_schedule_task",
        'Start a Backlog card later: start_at is an ISO 8601 time with the local offset, or "reset" for when the Claude usage window resets; null cancels.',
        { task_id: z.string(), start_at: z.string().nullable() }, async (a) => h.scheduleTask(a)),
      tool("board_memory", "Read what the board remembers about this project: decisions and conventions from earlier tasks.", {}, async () => h.memory()),
    ],
  });
}
