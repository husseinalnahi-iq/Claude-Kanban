import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { addWorktree, aheadBehind, commitAll, isDirty, mergeTask, removeWorktree, updateFromBase } from "../src/git/worktree.ts";

/** Reads a file with line endings normalised: git on Windows may check out CRLF. */
const read = (...p: string[]) => readFileSync(join(...p), "utf8").split("\r\n").join("\n");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(files: Record<string, string> = { "README.md": "base\n" }): string {
  const dir = mkdtempSync(join(tmpdir(), "kland-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false"); // Windows would otherwise rewrite line endings on checkout
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Commit straight onto the base, as another task landing would. */
function landOnMain(repo: string, file: string, body: string, message: string) {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

test("a task branch is brought up to date inside its own worktree, and the merge then cannot conflict", async () => {
  const repo = makeRepo({ "a.txt": "one\n", "b.txt": "one\n" });
  try {
    const wt = await addWorktree(repo, "t_update");
    writeFileSync(join(wt.path, "a.txt"), "task changed a\n");
    await commitAll(wt.path, "task work");

    landOnMain(repo, "b.txt", "main changed b\n", "another task landed");
    assert.deepEqual(await aheadBehind(repo, "main", wt.branch), { ahead: 1, behind: 1 });

    const update = await updateFromBase(wt.path, "main", "merge");
    assert.deepEqual({ ok: update.ok, pulled: update.pulled }, { ok: true, pulled: 1 });
    // The worktree now holds BOTH changes — which is the point: the task can be verified as combined.
    assert.equal(read(wt.path, "a.txt"), "task changed a\n");
    assert.equal(read(wt.path, "b.txt"), "main changed b\n");
    assert.equal((await aheadBehind(repo, "main", wt.branch)).behind, 0, "nothing left to catch up on");

    await mergeTask(repo, wt.branch, "land it", "merge");
    assert.equal(read(repo, "a.txt"), "task changed a\n", "the task's change landed");
    assert.equal(read(repo, "b.txt"), "main changed b\n", "and the other task's was not overwritten");
    assert.equal(await isDirty(repo), false);
    await removeWorktree(repo, "t_update", { deleteBranch: "safe" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a real conflict is reported from the worktree and aborted, leaving both checkouts untouched", async () => {
  const repo = makeRepo({ "a.txt": "one\n" });
  try {
    const wt = await addWorktree(repo, "t_conflict");
    writeFileSync(join(wt.path, "a.txt"), "the task's version\n");
    await commitAll(wt.path, "task work");
    landOnMain(repo, "a.txt", "main's version\n", "another task touched the same line");

    const update = await updateFromBase(wt.path, "main", "merge");
    assert.equal(update.ok, false);
    assert.deepEqual(update.conflicts, ["a.txt"]);
    assert.equal(await isDirty(wt.path), false, "the failed merge was aborted, not left half-applied");
    assert.equal(read(wt.path, "a.txt"), "the task's version\n", "the task's work is intact");
    assert.equal(read(repo, "a.txt"), "main's version\n", "and the checkout never saw the conflict");

    // Landing it anyway is refused with the files named, and the checkout still does not change.
    await assert.rejects(mergeTask(repo, wt.branch, "land it", "merge"), /Conflicts in: a\.txt/);
    assert.equal(read(repo, "a.txt"), "main's version\n");
    assert.equal(await isDirty(repo), false);
    await removeWorktree(repo, "t_conflict", { deleteBranch: "force" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rebase lands as a fast-forward, squash lands as one commit", async () => {
  for (const strategy of ["rebase", "squash"] as const) {
    const repo = makeRepo({ "a.txt": "one\n", "b.txt": "one\n" });
    try {
      const before = Number(git(repo, "rev-list", "--count", "HEAD"));
      const wt = await addWorktree(repo, `t_${strategy}`);
      writeFileSync(join(wt.path, "a.txt"), "first\n");
      await commitAll(wt.path, "step one");
      writeFileSync(join(wt.path, "a.txt"), "second\n");
      await commitAll(wt.path, "step two");
      landOnMain(repo, "b.txt", "moved on\n", "another task landed");

      await updateFromBase(wt.path, "main", strategy === "rebase" ? "rebase" : "merge");
      await mergeTask(repo, wt.branch, `land ${strategy}`, strategy);

      assert.equal(read(repo, "a.txt"), "second\n", `${strategy}: the work landed`);
      assert.equal(read(repo, "b.txt"), "moved on\n", `${strategy}: the other task survived`);
      const added = Number(git(repo, "rev-list", "--count", "HEAD")) - before;
      if (strategy === "squash") assert.equal(added, 2, "one commit for the other task, one for the squashed task");
      else assert.equal(added, 3, "rebase replays both task commits on top, with no merge commit");
      await removeWorktree(repo, `t_${strategy}`, { deleteBranch: "force" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("updating when nothing has landed is a no-op", async () => {
  const repo = makeRepo();
  try {
    const wt = await addWorktree(repo, "t_noop");
    const res = await updateFromBase(wt.path, "main", "merge");
    assert.deepEqual(res, { ok: true, pulled: 0, conflicts: [] });
    await removeWorktree(repo, "t_noop", { deleteBranch: "force" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
