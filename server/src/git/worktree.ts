import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DiffFile, MergeStrategy } from "../types.ts";
import { removeKeyCopies } from "./bootstrap.ts";

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

/** git prints C:/x/y where Node has C:\x\y, and Windows paths ignore case. */
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

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

/**
 * Which of `files` changed between `from` and HEAD: what others did to a card's files since it last landed,
 * for the next round's prompt (D375). Empty when nothing did, or when `from` is no longer known.
 */
export async function changedSince(cwd: string, from: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  try {
    return (await git(cwd, ["diff", "--name-only", `${from}..HEAD`, "--", ...files.slice(0, 200)])).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
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

/** Paths with uncommitted or untracked changes, as `git status --porcelain` names them (a rename: its new path). */
export async function statusFiles(path: string): Promise<string[]> {
  const out = await git(path, ["status", "--porcelain"]);
  return out
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => (l.slice(3).split(" -> ").pop() ?? "").replace(/^"|"$/g, ""))
    .filter(Boolean);
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

export interface MergePreview {
  clean: boolean;
  /** The tree git would produce. For a conflicted merge, conflicted files hold conflict markers. */
  tree: string;
  conflicts: string[];
}

/**
 * What merging `theirs` into `ours` would do, worked out in git's object store alone: no checkout,
 * index or HEAD is touched (`git merge-tree --write-tree`, git 2.38+). This is what lets the board ask
 * "would this conflict?" of a task that is running, or of one nobody has approved yet.
 */
export async function previewMerge(cwd: string, ours: string, theirs: string): Promise<MergePreview> {
  let out: string;
  try {
    out = await git(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs]);
  } catch (err) {
    // Exit 1 is git's answer "it conflicts", with the same output on stdout; anything else is a failure.
    if (!(err instanceof GitError) || err.code !== 1) throw err;
    out = err.stdout;
  }
  const [tree = "", ...rest] = out.split(/\r?\n/);
  const conflicts = rest.filter(Boolean);
  return { clean: conflicts.length === 0, tree: tree.trim(), conflicts };
}

export interface LandedWork {
  /** The board task that landed it, when its merge message names one. */
  taskId: string | null;
  title: string;
}

/**
 * What arrived on `base` since the worktree's branch split from it, newest first — the "other side" of
 * a conflict. The board's own landings are recognised by their messages (`Merge kanban/<id>: <title>`
 * for merge and squash, `kanban: <title>` for the commits a rebase fast-forwards in); anything else is
 * someone's own commit and is listed by its subject.
 */
export async function landedSince(worktreePath: string, base: string, limit = 20): Promise<LandedWork[]> {
  const from = (await git(worktreePath, ["merge-base", "HEAD", base])).trim();
  // --first-parent: a merge landing counts once, not once more for every commit inside it.
  const log = (await git(worktreePath, ["log", "--first-parent", "--format=%s", `-${limit}`, `${from}..${base}`])).trim();
  if (!log) return [];
  return log.split(/\r?\n/).map((subject) => {
    const merged = /^Merge kanban\/(\S+): (.*)$/.exec(subject);
    if (merged) return { taskId: merged[1], title: merged[2] };
    const committed = /^kanban: (.*)$/.exec(subject);
    return { taskId: null, title: committed ? committed[1] : subject };
  });
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
  let leftOver: unknown = null;
  if (existsSync(path)) {
    // Keys first: git ignores them, so the snapshot below never holds them, and a folder that then cannot
    // be removed kept a full copy of the project's keys with nothing said (D396).
    await removeKeyCopies(path);
    // Snapshot leftovers so `worktree remove` succeeds without --force; the branch keeps them until deleted.
    await commitAll(path, "kanban: snapshot before worktree removal");
    try {
      await git(projectPath, ["worktree", "remove", path]);
    } catch (err) {
      // On Windows a program whose working folder is the worktree (a dev server, a terminal), or CloudSync
      // syncing it, can stop git deleting the folder. Once git has let go of the worktree, the folder is
      // retried here for a while; Node's rmSync gives up on the first EPERM by itself.
      if ((await listWorktrees(projectPath)).some((p) => samePath(p, path))) throw err;
      leftOver = await removeFolder(path);
    }
  }
  await git(projectPath, ["worktree", "prune"]);
  if (opts.deleteBranch) {
    const branch = branchFor(taskId);
    if (await branchExists(projectPath, branch)) await git(projectPath, ["branch", opts.deleteBranch === "force" ? "-D" : "-d", branch]);
  }
  // Said, not swallowed: the caller puts it on the card so the folder is not forgotten (D396).
  if (leftOver) throw new FolderLeftError(path, String((leftOver as NodeJS.ErrnoException).code ?? leftOver));
}

/**
 * The worktree is gone as far as git is concerned (unregistered, branch handled, keys removed), but its
 * folder could not be deleted. Callers finish what they were doing and say so (D396).
 */
export class FolderLeftError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`the folder ${path} could not be deleted (${reason}); its key files were removed`);
  }
}

/** Deletes a folder, retrying for about ten seconds; returns the last error when it is still there. */
async function removeFolder(path: string): Promise<unknown> {
  let last: unknown = null;
  for (let waited = 0; waited <= 10_000; waited += 500) {
    try {
      rmSync(path, { recursive: true, force: true });
      if (!existsSync(path)) return null;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return existsSync(path) ? last ?? new Error("still present") : null;
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

// ── Conflict resolution (D355) ────────────────────────────────────────────────────────────────────
// The board, not the model, starts and finishes the merge, so what is checked is exactly what was
// merged: a pinned base commit, with git's own clean merge of everything else as the yardstick.

/** The commit a name points at, in that repository. */
export async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
}

/** Remember where a branch stood, under the board's own ref namespace (never a branch). */
export async function setRef(cwd: string, ref: string, sha: string | null): Promise<void> {
  if (sha) await git(cwd, ["update-ref", ref, sha]);
  else await git(cwd, ["update-ref", "-d", ref]).catch(() => undefined);
}

async function mergeInProgress(cwd: string): Promise<boolean> {
  return existsSync(join(await gitPath(cwd, "--git-dir"), "MERGE_HEAD"));
}

/**
 * Start merging `baseSha` into the worktree and leave any conflicts in place for Claude, written
 * zdiff3-style (this side, the original after `|||||||`, the other side). Returns the conflicted
 * files; none means git merged it cleanly and has already committed.
 */
export async function startResolveMerge(worktreePath: string, baseSha: string, message: string): Promise<string[]> {
  try {
    await git(worktreePath, ["-c", "merge.conflictStyle=zdiff3", "merge", "--no-ff", "-m", message, baseSha]);
    return [];
  } catch (err) {
    const conflicts = await conflictedFiles(worktreePath);
    if (!conflicts.length) {
      if (await mergeInProgress(worktreePath)) await git(worktreePath, ["merge", "--abort"]).catch(() => undefined);
      throw err;
    }
    return conflicts;
  }
}

/** Commit whatever the resolution left: concludes the merge, or records edits made after Claude committed it. */
export async function finishResolveMerge(worktreePath: string, message: string): Promise<void> {
  if (await mergeInProgress(worktreePath)) {
    await git(worktreePath, ["add", "-A"]);
    await git(worktreePath, ["commit", "-q", "--no-verify", "-m", message]);
    return;
  }
  await commitAll(worktreePath, message);
}

/**
 * Put the task's branch back where it was before the attempt. The attempt is committed first and only
 * then stepped back from with `reset --keep`, so it stays in the reflog: nothing is thrown away, and
 * `--keep` refuses rather than overwrite anything it did not expect.
 */
export async function rollbackResolution(worktreePath: string, pre: string): Promise<void> {
  await finishResolveMerge(worktreePath, "kanban: set aside a conflict resolution that did not pass").catch(() => undefined);
  if ((await headSha(worktreePath)) === pre) return;
  await git(worktreePath, ["reset", "-q", "--keep", pre]);
}

export interface ResolutionFindings {
  /** Failures no explanation can excuse: the resolution is set aside. */
  hard: { id: "history" | "markers" | "files"; detail: string }[];
  /** Lines either side added that the result no longer has — each needs the reviewer's agreement. */
  lost: { file: string; side: "task" | "base"; lines: string[] }[];
  /** Files changed that git had merged cleanly, or that are new. */
  outside: string[];
}

const MARKER = /^(<{7}|>{7}|\|{7})(\s|$)/;
const SEPARATOR = /^={7}$/;
const LOST_PER_FILE = 20;

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

async function showFile(cwd: string, rev: string, file: string): Promise<string | null> {
  try {
    return await git(cwd, ["show", `${rev}:${file}`]);
  } catch {
    return null;
  }
}

async function namesBetween(cwd: string, from: string, to: string, filter?: string): Promise<string[]> {
  const out = (await git(cwd, ["diff", "--name-only", "--no-renames", ...(filter ? [`--diff-filter=${filter}`] : []), from, to])).trim();
  return out ? out.split(/\r?\n/) : [];
}

/** A line worth missing: brace-only and blank lines move about in any honest merge. */
const meaningful = (line: string) => line.trim().length >= 3 && /[A-Za-z0-9]/.test(line);

/** The lines a `diff -U0` adds, by file. */
export function addedLines(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(4).replace(/^b\//, "");
      if (file && !out.has(file)) out.set(file, []);
    } else if (file && line.startsWith("+")) {
      out.get(file)!.push(line.slice(1));
    }
  }
  return out;
}

/**
 * Check a committed resolution against what was merged. `previewTree` is git's own merge of the two
 * sides (`previewMerge`): everything outside the conflicts must still match it.
 */
export async function checkResolution(
  worktreePath: string,
  a: { pre: string; baseSha: string; previewTree: string; conflicts: string[] },
): Promise<ResolutionFindings> {
  const hard: ResolutionFindings["hard"] = [];
  const head = await headSha(worktreePath);

  // Both histories must survive whole: a rebase, reset or abort would drop one of them.
  if (!head || head === a.pre || (await mergeInProgress(worktreePath)) || !(await isAncestor(worktreePath, a.pre, head)) || !(await isAncestor(worktreePath, a.baseSha, head))) {
    hard.push({ id: "history", detail: "The merge was not completed with both histories in it." });
    return { hard, lost: [], outside: [] };
  }

  const marked: string[] = [];
  for (const file of a.conflicts) {
    const body = await showFile(worktreePath, head, file);
    if (body === null) continue;
    const lines = body.split(/\r?\n/);
    const opening = lines.some((l) => MARKER.test(l));
    if (opening || (lines.some((l) => SEPARATOR.test(l)) && lines.some((l) => /^<{7}/.test(l)))) marked.push(file);
  }
  if (marked.length) hard.push({ id: "markers", detail: `Conflict markers are still in: ${marked.join(", ")}.` });

  const conflicted = new Set(a.conflicts);
  const changed = await namesBetween(worktreePath, a.previewTree, head);
  const outside = changed.filter((f) => !conflicted.has(f));
  const removed = (await namesBetween(worktreePath, a.previewTree, head, "D")).filter((f) => !conflicted.has(f));
  if (removed.length) hard.push({ id: "files", detail: `Files git had merged cleanly were deleted: ${removed.join(", ")}.` });

  // Lines each side added, looked for in the result. Only where the resolution could have touched:
  // everywhere else the result is git's own merge, which keeps both sides by construction.
  const scope = [...new Set([...a.conflicts, ...outside])];
  const lost: ResolutionFindings["lost"] = [];
  if (scope.length) {
    const mb = (await git(worktreePath, ["merge-base", a.pre, a.baseSha])).trim();
    const finals = new Map<string, Set<string>>();
    for (const file of scope) {
      const body = await showFile(worktreePath, head, file);
      finals.set(file, new Set((body ?? "").split(/\r?\n/).map((l) => l.trim())));
    }
    for (const [side, tip] of [["task", a.pre], ["base", a.baseSha]] as const) {
      const patch = await git(worktreePath, ["diff", "-U0", "--no-renames", "--no-color", mb, tip, "--", ...scope]);
      for (const [file, added] of addedLines(patch)) {
        const final = finals.get(file);
        if (!final) continue;
        const missing = [...new Set(added.filter((l) => meaningful(l) && !final.has(l.trim())).map((l) => l.trim()))];
        if (missing.length) lost.push({ file, side, lines: missing.slice(0, LOST_PER_FILE) });
      }
    }
  }
  return { hard, lost, outside };
}

/** What a resolution changed in some files, against one side — for the reviewer to read. */
export async function diffFiles(cwd: string, from: string, to: string, files: string[]): Promise<string> {
  if (!files.length) return "";
  return git(cwd, ["diff", "--no-renames", "--no-color", from, to, "--", ...files]);
}

/** Where the two sides split. */
export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  return (await git(cwd, ["merge-base", a, b])).trim();
}
