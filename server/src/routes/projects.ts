import type { FastifyInstance } from "fastify";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { ConflictError, NotFoundError } from "../engine/runner.ts";
import { isGitRepo } from "../git/worktree.ts";
import { probeFolder } from "../engine/onboarding.ts";
import { answersSchema, queueBootstrapTask, queueInitTask } from "./claudeMd.ts";
import { EFFORTS, EMPTY_ENV, type MergePolicy, type Policy } from "../types.ts";

export const stageSchema = z.object({
  stage: z.enum(["plan", "code", "review", "custom"]),
  model: z.string().trim().min(1),
  effort: z.enum(EFFORTS as [string, ...string[]]),
  fast: z.boolean().optional(),
  prompt: z.string().optional(),
  provider: z.string().trim().min(1).max(40).optional(),
  debate: z.union([
    z.boolean(),
    z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), effort: z.enum(EFFORTS as [string, ...string[]]).optional() }),
  ]).optional(),
});

const policySchema = z.object({
  worktrees: z.enum(["allowed", "forbidden"]),
  autonomous: z.enum(["allowed", "forbidden"]),
  maxConcurrent: z.number().int().min(1).max(8),
  defaultPipeline: z.array(stageSchema).optional(),
});

const envSchema = z.object({
  worktreeInclude: z.array(z.string().trim().min(1)).max(50),
  setupCommand: z.string().nullable(),
  verifyCommand: z.string().nullable(),
  labels: z.array(z.string().trim().toLowerCase().min(1)).max(30),
  onboarding: z.object({ goal: z.string(), stack: z.string(), verify: z.string() }).nullable(),
});

export const mergeSchema = z.object({
  baseBranch: z.string().trim().min(1).nullable(),
  updateBeforeMerge: z.boolean(),
  strategy: z.enum(["merge", "rebase", "squash"]),
  verifyBeforeMerge: z.boolean(),
  onConflict: z.enum(["ask", "claude"]),
});

const createSchema = z.object({
  name: z.string().trim().min(1),
  path: z.string().trim().min(1),
  policy: policySchema.partial().optional(),
  env: envSchema.partial().optional(),
  /** What to do for the new project right away: /init on code, or a bootstrap of an empty folder. */
  onboarding: z.object({ init: z.boolean().optional(), bootstrap: answersSchema.optional() }).optional(),
});

export async function projectRoutes(app: FastifyInstance, { repo, bus, runner }: AppDeps) {
  // Whether a folder is a git repo effectively never changes, and the board polls this endpoint;
  // without a cache that was one git subprocess per project per request.
  const gitCache = new Map<string, { at: number; isGit: boolean }>();
  const GIT_CACHE_MS = 60_000;
  const withGit = async <T extends { path: string }>(p: T) => {
    const hit = gitCache.get(p.path);
    if (hit && Date.now() - hit.at < GIT_CACHE_MS) return { ...p, isGit: hit.isGit };
    const isGit = await isGitRepo(p.path);
    gitCache.set(p.path, { at: Date.now(), isGit });
    return { ...p, isGit };
  };

  app.get("/projects", async () => Promise.all(repo.listProjects().map(withGit)));

  /** What the add-project dialog needs to offer the right onboarding: is there code here, and a CLAUDE.md? */
  app.get("/projects/probe", async (req) => {
    const path = resolve(z.object({ path: z.string().trim().min(1) }).parse(req.query).path);
    return { path, kind: probeFolder(path), hasClaudeMd: existsSync(join(path, "CLAUDE.md")) || existsSync(join(path, ".claude", "CLAUDE.md")) };
  });

  app.post("/projects", async (req) => {
    const body = createSchema.parse(req.body);
    const path = resolve(body.path);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new ConflictError(`Folder not found: ${path}`);
    if (repo.listProjects().some((p) => p.path.toLowerCase() === path.toLowerCase())) throw new ConflictError(`Already registered: ${path}`);
    const policy: Policy = {
      worktrees: "allowed",
      autonomous: "allowed",
      maxConcurrent: repo.getSettings().defaultMaxConcurrent,
      ...body.policy,
    } as Policy;
    const project = repo.createProject({ name: body.name, path, policy, env: { ...EMPTY_ENV, ...body.env } as never, merge: repo.getSettings().defaultMerge });
    bus.publish({ type: "project.updated", project });
    const deps = { repo, bus, runner };
    const onboardingTask = body.onboarding?.bootstrap
      ? await queueBootstrapTask(deps, project, body.onboarding.bootstrap)
      : body.onboarding?.init
        ? await queueInitTask(deps, project)
        : null;
    return { ...(await withGit(repo.getProject(project.id)!)), onboardingTask };
  });

  app.patch("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const current = repo.getProject(id);
    if (!current) throw new NotFoundError(`No project ${id}`);
    const body = z
      .object({
        name: z.string().trim().min(1).optional(),
        policy: policySchema.partial().optional(),
        env: envSchema.partial().optional(),
        merge: mergeSchema.partial().optional(),
      })
      .parse(req.body);
    const project = repo.updateProject(id, {
      name: body.name,
      policy: body.policy ? ({ ...current.policy, ...body.policy } as Policy) : undefined,
      env: body.env ? { ...current.env, ...body.env } : undefined,
      merge: body.merge ? ({ ...current.merge, ...body.merge } as MergePolicy) : undefined,
    });
    bus.publish({ type: "project.updated", project });
    return withGit(project);
  });

  app.delete("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const tasks = repo.listTasks({ project_id: id });
    if (tasks.some((t) => runner.isBusy(t.id))) throw new ConflictError("Stop this project's running tasks first.");
    if (tasks.some((t) => t.worktree_path)) throw new ConflictError("Some tasks still have worktrees; approve or discard them first.");
    repo.deleteProject(id);
    return { ok: true };
  });
}
