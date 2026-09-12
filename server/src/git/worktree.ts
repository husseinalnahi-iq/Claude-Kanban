import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DiffFile, MergeStrategy } from "../types.ts";

const EXCLUDE_LINE = ".kanban/";

export class GitError extends Error {
  constructor(message: string, readonly code: number | null, readonly stdout: string, readonly stderr: string) {
    super(message);
  }
}

/**
 * Runs git and rejects on ANY non-zero exit. (simple-git's raw() resolved on a conflicted merge because
 * git prints CONFLICT to stdout — see docs/DECISIONS.md D18.)
 */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-c", "core.quotepath=false", ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null;
        const detail = (stderr || stdout || err.message).trim();
        reject(new GitError(`git ${args[0]} failed: ${detail}`, code, stdout, stderr));
      } else {
        resolvePromise(stdout);
      }
    });
  });
}

export function worktreePathFor(projectPath: string, taskId: string): string {
  return join(projectPath, ".kanban", "wt", taskId);
}

export function branchFor(taskId: string): string {
  return `kanban/${taskId}`;
}

export async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const top = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
    return resolve(top).toLowerCase() === resolve(path).toLowerCase();
  } catch {
    return false;
  }
}

export async function currentBranch(projectPath: string): Promise<string> {
  return (await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

async function gitPath(projectPath: string, flag: "--git-dir" | "--git-common-dir"): Promise<string> {
  const p = (await git(projectPath, ["rev-parse", flag])).trim();
  return isAbsolute(p) ? p : resolve(projectPath, p);
}

/** Ignore `.kanban/` via the repo's local exclude file — never its tracked .gitignore. */
async function ensureExcluded(projectPath: string) {
  const infoDir = join(await gitPath(projectPath, "--git-common-dir"), "info");
  const file = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!current.split(/\r?\n/).includes(EXCLUDE_LINE)) {
    appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
  }
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  return (await git(projectPath, ["branch", "--list", branch])).trim() !== "";
}

/**
 * Creates the task worktree on a new branch from HEAD. If the branch already exists (its folder was
 * deleted), the worktree is re-attached to it and `baseSha` is null — the caller keeps its stored base.
 */
export async function addWorktree(projectPath: string, taskId: string): Promise<{ path: string; branch: string; baseSha: string | null }> {
  await ensureExcluded(projectPath);
  const path = worktreePathFor(projectPath, taskId);
  const branch = branchFor(taskId);
  mkdirSync(join(projectPath, ".kanban", "wt"), { recursive: true });
  if (await branchExists(projectPath, branch)) {
    await git(projectPath, ["worktree", "prune"]);
    await git(projectPath, ["worktree", "add", path, branch]);
    return { path, branch, baseSha: null };
  }
  const baseSha = (await git(projectPath, ["rev-parse", "HEAD"])).trim();
  await git(projectPath, ["worktree", "add", "-b", branch, path, baseSha]);
  return { path, branch, baseSha };
}

/** Stage and commit everything in the worktree. Returns false when there was nothing to commit. */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await git(worktreePath, ["add", "-A"]);
  if (!(await git(worktreePath, ["status", "--porcelain"])).trim()) return false;
  await git(worktreePath, ["commit", "-q", "--no-verify", "-m", message]);
  return true;
}

export async function diffTask(projectPath: string, baseSha: string, branch: string): Promise<DiffFile[]> {
  const range = `${baseSha}..${branch}`;
  const nameStatus = (await git(projectPath, ["diff", "--name-status", "--no-renames", range])).trim();
  if (!nameStatus) return [];
  const patch = await git(projectPath, ["diff", "--no-renames", range]);
  const chunks = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\//.exec(chunk);
    if (m) chunks.set(m[1], chunk);
  }
  return nameStatus.split(/\r?\n/).map((line) => {
    const [status, file] = line.split("\t");
    return { file, status, patch: chunks.get(file) ?? "" };
  });
}

/** Files git has left in a conflicted state, if any. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  try {
    const out = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).trim();
    return out ? out.split(/\r?\n/) : [];
  } catch {
    return [];
  }
}

/** The commit a working tree currently has out, or null if it cannot be read. */
export async function headSha(path: string): Promise<string | null> {
  try {
    return (await git(path, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

/** Tracked files, for a model that cannot list them itself. Capped: a file list is orientation, not the repo. */
export async function lsFiles(path: string, max = 400): Promise<{ files: string[]; total: number }> {
  const all = (await git(path, ["ls-files"])).split(/\r?\n/).filter(Boolean);
  return { files: all.slice(0, max), total: all.length };
}

/** Uncommitted changes in a checkout (staged and unstaged), in the same shape as diffTask. */
export async function diffWorkingTree(path: string): Promise<DiffFile[]> {
  const nameStatus = (await git(path, ["diff", "HEAD", "--name-status", "--no-renames"])).trim();
  if (!nameStatus) return [];
  const patch = await git(path, ["diff", "HEAD", "--no-renames"]);
  const chunks = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\//.exec(chunk);
    if (m) chunks.set(m[1], chunk);
  }
  return nameStatus.split(/\r?\n/).map((line) => {
    const [status, file] = line.split("\t");
    return { file, status, patch: chunks.get(file) ?? "" };
  });
}

/** Uncommitted or untracked changes present. */
export async function isDirty(path: string): Promise<boolean> {
  return (await git(path, ["status", "--porcelain"])).trim() !== "";
}

/** How many commits each side has that the other doesn't: `{ ahead, behind }` relative to `base`. */
export async function aheadBehind(projectPath: string, base: string, branch: string): Promise<{ ahead: number; behind: number }> {
  const out = (await git(projectPath, ["rev-list", "--left-right", "--count", `${base}...${branch}`])).trim();
  const [behind, ahead] = out.split(/\s+/).map((n) => Number(n) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export interface UpdateResult {
  ok: boolean;
  /** Commits pulled in from the base. 0 means the branch was already up to date. */
  pulled: number;
  conflicts: string[];
}

/**
 * Bring `base` into the task's branch **inside its own worktree**, so any conflict happens there and
 * the checkout you are sitting in is never touched. On a conflict the merge/rebase is aborted and the
 * conflicting files are reported; the worktree is left exactly as it was.
 */
export async function updateFromBase(worktreePath: string, base: string, how: "merge" | "rebase"): Promise<UpdateResult> {
  const branch = (await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const behind = Number((await git(worktreePath, ["rev-list", "--count", `${branch}..${base}`])).trim()) || 0;
  if (behind === 0) return { ok: true, pulled: 0, conflicts: [] };
  try {
    if (how === "rebase") await git(worktreePath, ["rebase", base]);
    else await git(worktreePath, ["merge", "--no-edit", base]);
    return { ok: true, pulled: behind, conflicts: [] };
  } catch (err) {
    const conflicts = await conflictedFiles(worktreePath);
    try {
      await git(worktreePath, how === "rebase" ? ["rebase", "--abort"] : ["merge", "--abort"]);
    } catch {
      // nothing to abort (the command failed before starting)
    }
    if (!conflicts.length) throw err;
    return { ok: false, pulled: 0, conflicts };
  }
}

/**
 * Land the task branch on the branch the main checkout has out. On a conflict the merge is aborted so
 * the checkout is left exactly as it was, and the conflicting files are reported. With
 * `updateFromBase` run first this cannot conflict — it is a fast-forward of an already-current branch.
 */
export async function mergeTask(projectPath: string, branch: string, message: string, strategy: MergeStrategy = "merge"): Promise<void> {
  try {
    if (strategy === "squash") {
      await git(projectPath, ["merge", "--squash", branch]);
      await git(projectPath, ["commit", "-q", "--no-verify", "-m", message]);
    } else if (strategy === "rebase") {
      // The branch was rebased onto the base, so this is a pure fast-forward: no merge commit.
      await git(projectPath, ["merge", "--ff-only", branch]);
    } else {
      await git(projectPath, ["merge", "--no-ff", "-m", message, branch]);
    }
  } catch (err) {
    const conflicts = await conflictedFiles(projectPath);
    // Undo the attempt so the checkout is exactly as it was. Never reset --hard: if the abort itself
    // fails, say so and leave the repository for a human rather than throwing work away.
    let aborted = true;
    try {
      await git(projectPath, ["merge", "--abort"]);
    } catch {
      aborted = !existsSync(join(await gitPath(projectPath, "--git-dir"), "MERGE_HEAD")) && !(await isDirty(projectPath));
    }
    const where = conflicts.length ? `Conflicts in: ${conflicts.join(", ")}. ` : "";
    throw new Error(
      aborted
        ? `${where}The merge was aborted; your checkout is unchanged.${where ? " Update the task's branch from the base first, then approve again." : ` ${err instanceof Error ? err.message : String(err)}`}`
        : `${where}The merge could not be undone automatically — your checkout at ${projectPath} still has it in progress. Resolve it there (git merge --abort) before approving anything else.`,
    );
  }
}

export async function removeWorktree(
  projectPath: string,
  taskId: string,
  opts: { deleteBranch: "safe" | "force" | false },
): Promise<void> {
  const path = worktreePathFor(projectPath, taskId);
  if (existsSync(path)) {
    // Snapshot leftovers so `worktree remove` succeeds without --force; the branch keeps them until deleted.
    await commitAll(path, "kanban: snapshot before worktree removal");
    await git(projectPath, ["worktree", "remove", path]);
  }
  await git(projectPath, ["worktree", "prune"]);
  if (opts.deleteBranch) {
    const branch = branchFor(taskId);
    if (await branchExists(projectPath, branch)) await git(projectPath, ["branch", opts.deleteBranch === "force" ? "-D" : "-d", branch]);
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  taskId: string | null;
  /** Uncommitted or untracked files present. */
  dirty: boolean;
  /** Commits on this branch that the project's current branch doesn't have. */
  unmerged: number;
  /** Commits the project's current branch has that this one doesn't — how stale the worktree is. */
  behind: number;
  isMain: boolean;
}

/** Everything the board needs to decide whether a worktree is safe to remove. */
export async function inspectWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  const out = await git(projectPath, ["worktree", "list", "--porcelain"]);
  const blocks = out.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const main = resolve(projectPath).toLowerCase();
  const infos: WorktreeInfo[] = [];
  for (const block of blocks) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    const isMain = resolve(path).toLowerCase() === main;
    let dirty = false;
    let unmerged = 0;
    let behind = 0;
    if (!isMain && existsSync(path)) {
      try {
        dirty = (await git(path, ["status", "--porcelain"])).trim() !== "";
        const counts = await aheadBehind(projectPath, "HEAD", branch ?? "HEAD");
        unmerged = counts.ahead;
        behind = counts.behind;
      } catch {
        dirty = true; // if we cannot tell, treat it as holding work
      }
    }
    infos.push({ path, branch, taskId: branch?.startsWith("kanban/") ? branch.slice("kanban/".length) : null, dirty, unmerged, behind, isMain });
  }
  return infos;
}

export async function listWorktrees(projectPath: string): Promise<string[]> {
  const out = await git(projectPath, ["worktree", "list", "--porcelain"]);
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}
