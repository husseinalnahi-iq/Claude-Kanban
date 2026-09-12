import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { ConflictError, NotFoundError } from "../engine/runner.ts";
import { inspectWorktrees, removeWorktree } from "../git/worktree.ts";

/**
 * Worktree housekeeping. Removal is deliberately conservative: a worktree is only removable when it
 * holds no uncommitted work, has nothing unmerged, and its task is finished or gone.
 */
export async function worktreeRoutes(app: FastifyInstance, { repo, runner }: AppDeps) {
  const survey = async (projectId: string) => {
    const project = repo.getProject(projectId);
    if (!project) throw new NotFoundError(`No project ${projectId}`);
    const infos = await inspectWorktrees(project.path);
    return infos
      .filter((w) => !w.isMain)
      .map((w) => {
        const task = w.taskId ? repo.getTask(w.taskId) : undefined;
        const busy = w.taskId ? runner.isBusy(w.taskId) : false;
        const blockers: string[] = [];
        if (busy) blockers.push("its task is running");
        if (w.dirty) blockers.push("uncommitted or untracked files");
        if (w.unmerged > 0) blockers.push(`${w.unmerged} unmerged commit${w.unmerged > 1 ? "s" : ""}`);
        if (task && !["done", "backlog"].includes(task.status)) blockers.push(`task is ${task.status}`);
        return { ...w, taskTitle: task?.title ?? null, taskStatus: task?.status ?? null, removable: blockers.length === 0, blockers };
      });
  };

  app.get("/worktrees", async (req) => survey((req.query as { project: string }).project));

  app.post("/worktrees/prune", async (req) => {
    const body = z.object({ project_id: z.string() }).parse(req.body);
    const project = repo.getProject(body.project_id)!;
    if (!project) throw new NotFoundError(`No project ${body.project_id}`);
    const list = await survey(body.project_id);
    const removable = list.filter((w) => w.removable && w.taskId);
    if (!removable.length) throw new ConflictError("Nothing is safe to remove: every worktree still holds work or belongs to a live task.");
    const removed: string[] = [];
    for (const w of removable) {
      await removeWorktree(project.path, w.taskId!, { deleteBranch: "safe" });
      const task = repo.getTask(w.taskId!);
      if (task) repo.updateTask(task.id, { worktree_path: null, branch: task.status === "done" ? null : task.branch });
      removed.push(w.path);
    }
    return { removed };
  });
}
