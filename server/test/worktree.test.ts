import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { addWorktree, commitAll, diffTask, mergeTask, removeWorktree, listWorktrees, isGitRepo, currentBranch } from "../src/git/worktree.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kwt-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("add → commit → diff → merge → remove leaves the repo clean", async () => {
  const repo = makeRepo();
  try {
    assert.equal(await isGitRepo(repo), true);
    const wt = await addWorktree(repo, "t_abc123");
    assert.equal(wt.branch, "kanban/t_abc123");
    assert.ok(existsSync(wt.path), "worktree dir exists");
    assert.match(wt.baseSha ?? "", /^[0-9a-f]{40}$/);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\.kanban\/$/m);

    // Adding twice must not duplicate the exclude line.
    await removeWorktree(repo, "t_abc123", { deleteBranch: "force" });
    const wt2 = await addWorktree(repo, "t_abc123");
    assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").match(/^\.kanban\/$/gm)?.length, 1);

    writeFileSync(join(wt2.path, "hello.md"), "one\ntwo\nthree\n");
    assert.equal(await commitAll(wt2.path, "kanban: hello"), true);
    assert.equal(await commitAll(wt2.path, "kanban: nothing"), false, "clean tree → no commit");

    const diff = await diffTask(repo, wt2.baseSha!, wt2.branch);
    assert.deepEqual(diff.map((f) => [f.file, f.status]), [["hello.md", "A"]]);
    assert.match(diff[0].patch, /\+three/);

    assert.equal(await currentBranch(repo), "main");
    await mergeTask(repo, wt2.branch, "Merge kanban/t_abc123");
    assert.ok(existsSync(join(repo, "hello.md")), "merged into main checkout");
    assert.match(git(repo, "log", "-1", "--pretty=%P"), /^\S+ \S+$/, "merge commit has two parents (--no-ff)");

    await removeWorktree(repo, "t_abc123", { deleteBranch: "safe" });
    assert.equal((await listWorktrees(repo)).length, 1);
    assert.equal(git(repo, "branch", "--format=%(refname:short)"), "main");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("discard removes an unmerged worktree with uncommitted changes", async () => {
  const repo = makeRepo();
  try {
    const wt = await addWorktree(repo, "t_disc01");
    writeFileSync(join(wt.path, "scratch.txt"), "x"); // left uncommitted on purpose
    await removeWorktree(repo, "t_disc01", { deleteBranch: "force" });
    assert.equal(existsSync(wt.path), false);
    assert.equal((await listWorktrees(repo)).length, 1);
    assert.equal(git(repo, "branch", "--format=%(refname:short)"), "main");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a worktree whose folder was deleted is re-attached to its existing branch", async () => {
  const repo = makeRepo();
  try {
    const wt = await addWorktree(repo, "t_gone01");
    writeFileSync(join(wt.path, "keep.txt"), "committed work");
    await commitAll(wt.path, "kanban: work");
    rmSync(wt.path, { recursive: true, force: true }); // folder vanishes, branch stays
    const again = await addWorktree(repo, "t_gone01");
    assert.equal(again.baseSha, null, "existing branch → caller keeps its stored base");
    assert.equal(readFileSync(join(again.path, "keep.txt"), "utf8"), "committed work");
    await removeWorktree(repo, "t_gone01", { deleteBranch: "force" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a conflicting merge is aborted and leaves the main checkout unchanged", async () => {
  const repo = makeRepo();
  try {
    const wt = await addWorktree(repo, "t_conf01");
    writeFileSync(join(wt.path, "README.md"), "from task\n");
    await commitAll(wt.path, "kanban: task edit");
    writeFileSync(join(repo, "README.md"), "from main\n");
    git(repo, "commit", "-q", "-am", "main edit");
    await assert.rejects(mergeTask(repo, wt.branch, "Merge"), /Conflicts in: README\.md.*aborted/);
    assert.equal(existsSync(join(repo, ".git", "MERGE_HEAD")), false, "no merge left in progress");
    assert.equal(git(repo, "status", "--porcelain"), "", "checkout clean");
    assert.equal(readFileSync(join(repo, "README.md"), "utf8").replace(/\r\n/g, "\n"), "from main\n"); // autocrlf may rewrite EOLs
    await removeWorktree(repo, "t_conf01", { deleteBranch: "force" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("isGitRepo is false for a plain folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kplain-"));
  assert.equal(await isGitRepo(dir), false);
  rmSync(dir, { recursive: true, force: true });
});
