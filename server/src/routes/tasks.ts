import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { ConflictError, NotFoundError } from "../engine/runner.ts";
import { defaultPipeline } from "../engine/boardMcp.ts";
import { dependencyError } from "../engine/graph.ts";
import { aheadBehind, currentBranch } from "../git/worktree.ts";
import { removeAttachmentDir } from "./attachments.ts";
import { stageSchema } from "./projects.ts";
import { PRIORITIES, TASK_TYPES } from "../types.ts";

const createSchema = z.object({
  project_id: z.string(),
  title: z.string().trim().min(1),
  spec_md: z.string().default(""),
  mode: z.enum(["autonomous", "supervised"]).default("supervised"),
  pipeline: z.array(stageSchema).optional(),
  parent_id: z.string().nullable().optional(),
  milestone_id: z.string().nullable().optional(),
  skills: z.array(z.string()).optional(),
  type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
  priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
  labels: z.array(z.string().trim().toLowerCase()).max(8).optional(),
  depends_on: z.array(z.string()).max(20).optional(),
  auto_queue_children: z.boolean().optional(),
  plan_approval: z.boolean().nullable().optional(),
  live: z.boolean().optional(),
  own_branch: z.boolean().optional(),
  /** Classify in the background after creating (type/priority/labels). */
  triage: z.boolean().optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  spec_md: z.string().optional(),
  mode: z.enum(["autonomous", "supervised"]).optional(),
  pipeline: z.array(stageSchema).optional(),
  parent_id: z.string().nullable().optional(),
  milestone_id: z.string().nullable().optional(),
  skills: z.array(z.string()).optional(),
  position: z.number().optional(),
  type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
  priority: z.enum(PRIORITIES as [string, ...string[]]).optional(),
  labels: z.array(z.string().trim().toLowerCase()).max(8).optional(),
  depends_on: z.array(z.string()).max(20).optional(),
  auto_queue_children: z.boolean().optional(),
  plan_approval: z.boolean().nullable().optional(),
  live: z.boolean().optional(),
  own_branch: z.boolean().optional(),
  /** Only ever cleared from the UI ("dismiss"), never set. */
  suggestion: z.null().optional(),
});

export async function taskRoutes(app: FastifyInstance, { repo, bus, runner }: AppDeps) {
  const mustGet = (id: string) => {
    const t = repo.getTask(id);
    if (!t) throw new NotFoundError(`No task ${id}`);
    return t;
  };
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  /** Dependencies are drawn by hand in the graph, so the server is what keeps the DAG a DAG. */
  const checkDeps = (taskId: string, projectId: string, deps: string[]) => {
    const err = dependencyError(taskId, projectId, deps, (id) => repo.getTask(id) ?? null, (id) => repo.getTask(id)?.title ?? id);
    if (err) throw new ConflictError(err);
  };

  app.get("/tasks", async (req) => {
    const q = req.query as { project?: string; parent?: string };
    if (q.project && !q.parent) return repo.taskCards(q.project);
    return repo.listTasks({ project_id: q.project, parent_id: q.parent });
  });

  /** Every task waiting for a usage window, across projects, soonest first — for the usage panel. */
  app.get("/tasks/paused", async () =>
    repo.tasksInStatus(["paused"]).filter((t) => t.pause_reason !== "cost").sort((a, b) => (a.resume_at ?? "").localeCompare(b.resume_at ?? "")),
  );

  app.get("/tasks/:id", async (req) => {
    const task = mustGet(idOf(req));
    return {
      task,
      staleness: await staleness(task),
      parent: task.parent_id ? repo.getTask(task.parent_id) ?? null : null,
      children: repo.children(task.id),
      runs: repo.runsForTask(task.id),
      approvals: repo.approvalsForTask(task.id),
      messages: repo.messagesForTask(task.id),
      attachments: repo.listAttachments(task.id),
      busy: runner.isBusy(task.id),
    };
  });

  /** How far a task's branch has fallen behind what it will land on. null when it has no worktree. */
  const staleness = async (task: { project_id: string; branch: string | null; worktree_path: string | null }) => {
    if (!task.branch || !task.worktree_path) return null;
    const project = repo.getProject(task.project_id);
    if (!project) return null;
    try {
      const base = project.merge.baseBranch?.trim() || (await currentBranch(project.path));
      const { behind } = await aheadBehind(project.path, base, task.branch);
      return { base, behind };
    } catch {
      return null; // not a git repo, or the branch is gone: nothing useful to say
    }
  };

  app.post("/tasks", async (req) => {
    const body = createSchema.parse(req.body);
    const project = repo.getProject(body.project_id);
    if (!project) throw new NotFoundError(`No project ${body.project_id}`);
    if (body.depends_on?.length) checkDeps("", body.project_id, body.depends_on);
    const task = repo.createTask({ ...body, pipeline: body.pipeline?.length ? body.pipeline : defaultPipeline(repo, project) } as never);
    bus.publish({ type: "task.updated", task });
    if (body.triage ?? repo.getSettings().autoTriage) void runner.triage(task.id, "classify").catch(() => {});
    return task;
  });

  /** Rewrite a rough request into a proper task. Returns a proposal; nothing is saved until it's applied. */
  app.post("/tasks/:id/refine", async (req) => {
    const proposal = await runner.triage(idOf(req), "refine", { apply: false });
    if (!proposal) throw new ConflictError("Claude could not produce a usable proposal. Try again, or write the spec yourself.");
    return proposal;
  });

  /** Apply an (optionally edited) proposal: task fields, and subtasks with their dependencies. */
  app.post("/tasks/:id/refine/apply", async (req) => {
    const body = z
      .object({
        title: z.string().trim().min(1),
        spec_md: z.string(),
        type: z.enum(TASK_TYPES as [string, ...string[]]),
        priority: z.enum(PRIORITIES as [string, ...string[]]),
        labels: z.array(z.string()).max(8),
        auto_queue_children: z.boolean().optional(),
        subtasks: z
          .array(z.object({
            title: z.string().trim().min(1),
            spec_md: z.string(),
            type: z.enum(TASK_TYPES as [string, ...string[]]),
            depends_on: z.array(z.number().int().min(1)),
            files: z.array(z.string()).max(10).default([]),
          }))
          .max(8)
          .default([]),
      })
      .parse(req.body);
    return runner.applyTriage(idOf(req), body as never);
  });

  app.patch("/tasks/:id", async (req) => {
    const id = idOf(req);
    const current = mustGet(id);
    const body = patchSchema.parse(req.body);
    if ((body.mode || body.pipeline || body.own_branch !== undefined) && runner.isBusy(id)) throw new ConflictError("Cannot change mode, branch or pipeline while the task is queued or running.");
    if (body.own_branch !== undefined && body.own_branch !== current.own_branch && (current.branch || current.worktree_path)) {
      throw new ConflictError(`This task has work on ${current.branch ?? "its worktree"}; approve or discard it before changing where it works.`);
    }
    if (body.mode && body.mode !== current.mode && (current.branch || current.worktree_path)) {
      throw new ConflictError(`This task has work on ${current.branch ?? "its worktree"}; approve or discard it before changing mode.`);
    }
    if (body.depends_on) checkDeps(id, current.project_id, body.depends_on);
    const task = repo.updateTask(id, body as never);
    bus.publish({ type: "task.updated", task });
    return task;
  });

  app.delete("/tasks/:id", async (req) => {
    const id = idOf(req);
    const task = mustGet(id);
    if (runner.isBusy(id)) throw new ConflictError("Stop the task before deleting it.");
    if (task.worktree_path) throw new ConflictError("This task still has a worktree; approve or discard it first.");
    repo.deleteTask(id);
    runner.forget(id);
    removeAttachmentDir(repo.getSettings().stateDir, id);
    bus.publish({ type: "task.deleted", taskId: id });
    return { ok: true };
  });

  /** Accept what triage suggested: its labels, or the pipeline it sized, or both. */
  app.post("/tasks/:id/accept-suggestion", async (req) => {
    const body = z.object({ fields: z.boolean().default(false), pipeline: z.boolean().default(false) }).parse(req.body ?? {});
    return runner.acceptSuggestion(idOf(req), body);
  });

  /** Look at an attached image with the cheap vision model now, instead of waiting for the upload hook. */
  app.post("/attachments/:id/describe", async (req) => {
    const description = await runner.describeAttachment((req.params as { id: string }).id);
    if (!description) throw new ConflictError("Could not describe that image.");
    return { description };
  });

  /** Archiving is visual only: the task, its runs, its images and its history all stay. */
  app.post("/tasks/:id/archive", async (req) => {
    const task = mustGet(idOf(req));
    const updated = repo.updateTask(task.id, { archived_at: new Date().toISOString() });
    bus.publish({ type: "task.updated", task: updated });
    return updated;
  });

  app.post("/tasks/:id/unarchive", async (req) => {
    const task = mustGet(idOf(req));
    const updated = repo.updateTask(task.id, { archived_at: null });
    bus.publish({ type: "task.updated", task: updated });
    return updated;
  });

  /** Tidy the Done column in one go, keeping anything recent. */
  app.post("/tasks/archive-done", async (req) => {
    const body = z.object({ project_id: z.string(), olderThanDays: z.number().int().min(0).max(365).default(0) }).parse(req.body);
    const cutoff = Date.now() - body.olderThanDays * 86_400_000;
    const archived: string[] = [];
    for (const t of repo.listTasks({ project_id: body.project_id })) {
      if (t.status !== "done" || t.archived_at) continue;
      if (Date.parse(t.updated_at) > cutoff) continue;
      const updated = repo.updateTask(t.id, { archived_at: new Date().toISOString() });
      bus.publish({ type: "task.updated", task: updated });
      archived.push(t.id);
    }
    return { archived };
  });

  /** Resume a task paused by a usage limit now, without waiting for the window to reset. */
  /** A task paused at its cost ceiling: spend one more stage's worth, or give up. */
  app.post("/tasks/:id/continue", async (req) => runner.continueTask(idOf(req)));
  app.post("/tasks/:id/stop-paused", async (req) => runner.stopPaused(idOf(req)));
  /** A task paused because Claude or a provider ran out: carry its stage on elsewhere, now. */
  app.post("/tasks/:id/switch", async (req) => {
    const body = z
      .object({ provider: z.string().trim().min(1).max(64), model: z.string().trim().min(1).max(200), remember: z.boolean().optional() })
      .parse(req.body ?? {});
    return runner.switchStage(idOf(req), { provider: body.provider, model: body.model }, body.remember ?? false);
  });
  app.post("/tasks/:id/resume", async (req) => {
    runner.resumeNow(idOf(req));
    return mustGet(idOf(req));
  });

  app.post("/tasks/:id/queue", async (req) => {
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    return runner.queueTask(idOf(req), { fromStage: 0 }, body.force ?? false);
  });
  app.post("/tasks/:id/retry", async (req) => {
    const body = z.object({ stage_index: z.number().int().min(0).optional(), force: z.boolean().optional() }).parse(req.body ?? {});
    return runner.retryTask(idOf(req), body.stage_index, body.force ?? false);
  });
  app.post("/tasks/:id/stop", async (req) => runner.stopTask(idOf(req)));
  app.post("/tasks/:id/approve", async (req) => runner.approveTask(idOf(req)));
  app.post("/tasks/:id/reject", async (req) => {
    const body = z.object({ note: z.string().nullable().optional() }).parse(req.body ?? {});
    return runner.rejectTask(idOf(req), body.note ?? null);
  });
  app.post("/tasks/:id/discard", async (req) => runner.discardTask(idOf(req)));
  app.post("/tasks/:id/plan-decision", async (req) => {
    const body = z.object({ choice: z.enum(["original", "revised", "custom"]), text: z.string().max(200_000).optional() }).parse(req.body);
    return runner.decidePlan(idOf(req), body.choice, body.text);
  });
  /** Catch a long-running task's worktree up with the base branch before it gets further out of date. */
  app.post("/tasks/:id/update-from-base", async (req) => runner.updateTaskFromBase(idOf(req)));
  app.post("/tasks/:id/message", async (req) => {
    const body = z.object({ body: z.string().trim().min(1) }).parse(req.body);
    return runner.chat(idOf(req), body.body);
  });
  app.get("/tasks/:id/diff", async (req) => runner.diff(idOf(req)));

  /** A new task that continues this one, with its outcome written into the new spec. */
  app.post("/tasks/:id/follow-up", async (req) => {
    const body = z
      .object({ title: z.string().trim().optional(), note: z.string().trim().optional(), type: z.enum(TASK_TYPES as [string, ...string[]]).optional() })
      .parse(req.body ?? {});
    return runner.followUp(idOf(req), body as never);
  });
}
