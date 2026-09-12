import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppDeps } from "../app.ts";
import { ConflictError, NotFoundError } from "../engine/runner.ts";
import { allowedMode } from "../engine/boardMcp.ts";
import { isGitRepo } from "../git/worktree.ts";
import { bootstrapSpec, probeFolder, type Answers } from "../engine/onboarding.ts";
import type { Project, Task } from "../types.ts";
import { z } from "zod";

/** Shown in full up to this size; past it, the start is shown and the rest is on disk. */
const MAX_CHARS = 200_000;

export interface InstructionFile {
  /** Where Claude Code reads it from, in its own terms. */
  scope: "project" | "project (.claude)" | "local" | "user" | "rule";
  path: string;
  exists: boolean;
  content: string | null;
  bytes: number;
  modified: string | null;
  /** Claude's one-line description of what this file is for. */
  purpose: string;
}

function read(scope: InstructionFile["scope"], path: string, purpose: string): InstructionFile {
  if (!existsSync(path)) return { scope, path, exists: false, content: null, bytes: 0, modified: null, purpose };
  const st = statSync(path);
  const text = readFileSync(path, "utf8");
  return {
    scope,
    path,
    exists: true,
    content: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n…[${text.length - MAX_CHARS} more characters on disk]` : text,
    bytes: st.size,
    modified: st.mtime.toISOString(),
    purpose,
  };
}

/**
 * The instruction files Claude Code loads for a project, in its own order and with its own wording
 * (code.claude.com/docs/en/memory): user, then project (either location), then local, plus path-scoped
 * rules. They are concatenated, not overridden — every one that exists reaches every run.
 */
export function instructionFiles(projectPath: string): InstructionFile[] {
  const files: InstructionFile[] = [
    read("user", join(homedir(), ".claude", "CLAUDE.md"), "Personal — applies to all your projects"),
    read("project", join(projectPath, "CLAUDE.md"), "Team-shared — checked into the repository"),
    read("project (.claude)", join(projectPath, ".claude", "CLAUDE.md"), "Team-shared — the same, kept inside .claude/"),
    read("local", join(projectPath, "CLAUDE.local.md"), "Personal — this project only, not committed"),
  ];
  const rules = join(projectPath, ".claude", "rules");
  if (existsSync(rules)) {
    for (const f of readdirSync(rules).filter((n) => n.endsWith(".md")).sort()) {
      files.push(read("rule", join(rules, f), "Path-scoped rule — loaded when Claude works on matching files"));
    }
  }
  return files;
}

type Deps = Pick<AppDeps, "repo" | "bus" | "runner">;

/**
 * Runs Claude Code's own `/init` as a task: it creates CLAUDE.md, or — in Claude's words — "if a
 * CLAUDE.md already exists, /init suggests improvements rather than overwriting it."
 *
 * It is a task, not a direct write, on purpose: the file lands the way every other change does. In a
 * supervised project the write is an approval card; in an autonomous one it is a diff you approve.
 * A locked-down repository's rules are never bypassed by a side door.
 */
export async function queueInitTask({ repo, bus, runner }: Deps, project: Project): Promise<Task> {
  const exists = instructionFiles(project.path).some((f) => (f.scope === "project" || f.scope === "project (.claude)") && f.exists);
  const settings = repo.getSettings();
  // Autonomous (a reviewed diff) where the project allows it and it is a git repository; otherwise
  // supervised, where writing CLAUDE.md is an approval card.
  const mode = (await isGitRepo(project.path)) ? allowedMode(project, "autonomous") : "supervised";
  const task = repo.createTask({
    project_id: project.id,
    title: exists ? "Improve CLAUDE.md with /init" : "Create CLAUDE.md with /init",
    spec_md: exists
      ? "Runs Claude Code's `/init` on the existing CLAUDE.md. In Claude's words: *\"If a CLAUDE.md already exists, /init suggests improvements rather than overwriting it.\"*\n\nReview the change before approving it."
      : "Runs Claude Code's `/init`: *\"Claude analyzes your codebase and creates a file with build commands, test instructions, and project conventions it discovers.\"*\n\nReview the file before approving it.",
    type: "docs",
    mode,
    onboarding: "init",
    // One stage that sends the command itself. Balanced tier at Claude's default effort: /init reads a
    // lot of the repository, which a small model does poorly, but it is not a hard reasoning problem.
    // /init is a Claude Code command: it always runs on Claude, whatever provider the tier names.
    pipeline: [{ stage: "custom", model: settings.tiers.balanced.provider === "anthropic" ? settings.tiers.balanced.model : "claude-sonnet-5", effort: "high", prompt: "/init" }],
  });
  bus.publish({ type: "task.updated", task });
  runner.queueTask(task.id);
  return repo.getTask(task.id)!;
}

/**
 * Sets an empty folder up as a project: one task that follows the onboarding checklist and lands as a
 * reviewed change. The human's answers are kept on the project, so they show in the spec and later.
 */
export async function queueBootstrapTask({ repo, bus, runner }: Deps, project: Project, answers: Answers): Promise<Task> {
  if (probeFolder(project.path) !== "empty") throw new ConflictError("This folder already has files in it; use /init instead.");
  const settings = repo.getSettings();
  const updated = repo.updateProject(project.id, { env: { ...project.env, onboarding: answers } });
  bus.publish({ type: "project.updated", project: updated });
  // Without a repository there is no worktree to review a diff in: supervised, where each write is a card.
  const mode = (await isGitRepo(project.path)) ? allowedMode(project, "autonomous") : "supervised";
  const task = repo.createTask({
    project_id: project.id,
    title: "Bootstrap the project",
    spec_md: bootstrapSpec(answers, settings.onboardingChecklist),
    type: "chore",
    mode,
    onboarding: "bootstrap",
    // It writes files and runs tools, which a text-only provider cannot: always Claude, like /init.
    pipeline: [{ stage: "custom", model: settings.tiers.balanced.provider === "anthropic" ? settings.tiers.balanced.model : "claude-sonnet-5", effort: "high", prompt: "Work on the task below exactly as its checklist says." }],
  });
  bus.publish({ type: "task.updated", task });
  runner.queueTask(task.id);
  return repo.getTask(task.id)!;
}

export const answersSchema = z.object({ goal: z.string().trim().min(1), stack: z.string().default(""), verify: z.string().default("") });

export async function claudeMdRoutes(app: FastifyInstance, deps: AppDeps) {
  const { repo } = deps;
  /** Read-only: the board never edits these files directly. Changing them goes through a task. */
  app.get("/projects/:id/claude-md", async (req) => {
    const project = repo.getProject((req.params as { id: string }).id);
    if (!project) throw new NotFoundError("No such project.");
    return instructionFiles(project.path);
  });

  app.post("/projects/:id/claude-md/init", async (req) => {
    const project = repo.getProject((req.params as { id: string }).id);
    if (!project) throw new NotFoundError("No such project.");
    return queueInitTask(deps, project);
  });

  app.post("/projects/:id/bootstrap", async (req) => {
    const project = repo.getProject((req.params as { id: string }).id);
    if (!project) throw new NotFoundError("No such project.");
    return queueBootstrapTask(deps, project, answersSchema.parse(req.body));
  });
}
