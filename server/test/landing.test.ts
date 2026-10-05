import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { addWorktree, aheadBehind, checkResolution, commitAll, finishResolveMerge, headSha, isDirty, landedSince, mergeTask, previewMerge, removeWorktree, revParse, rollbackResolution, startResolveMerge, updateFromBase } from "../src/git/worktree.ts";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner } from "../src/engine/runner.ts";
import { DEFAULT_MERGE } from "../src/types.ts";

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

test("Approve lands a squash and clears its branch, which git itself still calls unmerged", async () => {
  // Why Approve cannot use the safe delete here: the squashed commit has the branch's content, but
  // none of its commits, so `git branch -d` refuses — after the merge has already landed.
  const plain = makeRepo({ "a.txt": "one\n" });
  try {
    const wt = await addWorktree(plain, "t_safe");
    writeFileSync(join(wt.path, "a.txt"), "two\n");
    await commitAll(wt.path, "task work");
    await mergeTask(plain, wt.branch, "land squash", "squash");
    await assert.rejects(removeWorktree(plain, "t_safe", { deleteBranch: "safe" }), /not fully merged/);
    await removeWorktree(plain, "t_safe", { deleteBranch: "force" });
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }

  const dir = makeRepo({ "a.txt": "one\n" });
  try {
    const repo = new Repo(openDb(":memory:"));
    const bus = new Bus();
    const project = repo.createProject({
      name: "squashes", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 },
      merge: { ...DEFAULT_MERGE, strategy: "squash" },
    });
    const runner = new TaskRunner({ repo, bus, queryFn: () => (async function* () {})() });
    const task = repo.createTask({ project_id: project.id, title: "squash me", mode: "autonomous", pipeline: [{ stage: "code", model: "m", effort: "low" }] });
    const wt = await addWorktree(dir, task.id);
    writeFileSync(join(wt.path, "a.txt"), "first\n");
    await commitAll(wt.path, "step one");
    writeFileSync(join(wt.path, "a.txt"), "second\n");
    await commitAll(wt.path, "step two");
    repo.updateTask(task.id, { status: "review", branch: wt.branch, worktree_path: wt.path, base_sha: wt.baseSha });

    const done = await runner.approveTask(task.id);
    assert.equal(done.status, "done", "the task used to stay in Review for good, with its work already merged");
    assert.equal(done.note, null, "and the clean-up went through");
    assert.equal(done.branch, null);
    assert.equal(read(dir, "a.txt"), "second\n", "the work landed");
    assert.equal(git(dir, "log", "-1", "--format=%s"), `Merge ${wt.branch}: squash me`, "as one commit");
    assert.equal(git(dir, "branch", "--list", wt.branch), "", "the branch is gone");
    assert.equal(existsSync(wt.path), false, "and so is the worktree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Approve records when a branch was merged; a task finished without one, or taken back out of done, is not merged", async () => {
  const dir = makeRepo({ "a.txt": "one\n" });
  try {
    const repo = new Repo(openDb(":memory:"));
    const bus = new Bus();
    const project = repo.createProject({ name: "merges", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 }, merge: DEFAULT_MERGE });
    const runner = new TaskRunner({ repo, bus, queryFn: () => (async function* () {})() });
    const pipeline = [{ stage: "code" as const, model: "m", effort: "low" as const }];

    const branched = repo.createTask({ project_id: project.id, title: "merge me", mode: "autonomous", pipeline });
    const wt = await addWorktree(dir, branched.id);
    writeFileSync(join(wt.path, "a.txt"), "two\n");
    await commitAll(wt.path, "task work");
    repo.updateTask(branched.id, { status: "review", branch: wt.branch, worktree_path: wt.path, base_sha: wt.baseSha });
    const merged = await runner.approveTask(branched.id);
    assert.equal(merged.status, "done");
    assert.ok(merged.merged_at, "the AI Manager shows a merge icon from this");

    const plain = repo.createTask({ project_id: project.id, title: "nothing to merge", mode: "supervised", pipeline });
    repo.updateTask(plain.id, { status: "review" });
    const finished = await runner.approveTask(plain.id);
    assert.equal(finished.status, "done");
    assert.equal(finished.merged_at, null, "done, but there was no branch to merge");

    assert.equal(repo.updateTask(merged.id, { status: "backlog" }).merged_at, null, "reopened work is not merged work");
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("a merge can be previewed without touching either checkout: clean, or naming the files that would conflict", async () => {
  const repo = makeRepo({ "a.txt": "one\n", "b.txt": "one\n" });
  try {
    const wt = await addWorktree(repo, "t_preview");
    writeFileSync(join(wt.path, "a.txt"), "the task's version\n");
    await commitAll(wt.path, "task work");

    landOnMain(repo, "b.txt", "main changed b\n", "another file");
    const clean = await previewMerge(wt.path, wt.branch, "main");
    assert.deepEqual({ clean: clean.clean, conflicts: clean.conflicts }, { clean: true, conflicts: [] });
    assert.match(clean.tree, /^[0-9a-f]{40,64}$/);

    landOnMain(repo, "a.txt", "main's version\n", "same line");
    const head = git(wt.path, "rev-parse", "HEAD");
    const clash = await previewMerge(wt.path, wt.branch, "main");
    assert.deepEqual({ clean: clash.clean, conflicts: clash.conflicts }, { clean: false, conflicts: ["a.txt"] });
    assert.equal(git(wt.path, "rev-parse", "HEAD"), head, "the task's branch did not move");
    assert.equal(await isDirty(wt.path), false, "the worktree was not touched");
    assert.equal(await isDirty(repo), false, "nor the project's checkout");
    assert.equal(read(wt.path, "a.txt"), "the task's version\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("what landed on the base since a task started is listed, with the board task behind each landing", async () => {
  const repo = makeRepo({ "a.txt": "one\n" });
  try {
    const wt = await addWorktree(repo, "t_since");
    writeFileSync(join(wt.path, "a.txt"), "task\n");
    await commitAll(wt.path, "task work");
    assert.deepEqual(await landedSince(wt.path, "main"), [], "nothing has landed yet");

    landOnMain(repo, "b.txt", "x\n", "Merge kanban/t_other: Add a discount field");
    landOnMain(repo, "c.txt", "y\n", "kanban: Rename the invoice total");
    landOnMain(repo, "d.txt", "z\n", "fix typo by hand");
    assert.deepEqual(await landedSince(wt.path, "main"), [
      { taskId: null, title: "fix typo by hand" },
      { taskId: null, title: "Rename the invoice total" },
      { taskId: "t_other", title: "Add a discount field" },
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * Two tasks that both added an import at the same spot in app.ts, while the other task also changed
 * notes.txt: the classic conflict where the right answer keeps both lines.
 */
async function conflictScene() {
  const repo = makeRepo({ "app.ts": "import base\n\nrun()\n", "notes.txt": "one\n", "keep.txt": "keep\n" });
  const wt = await addWorktree(repo, "t_resolve");
  writeFileSync(join(wt.path, "app.ts"), "import base\nimport tax\n\nrun()\n");
  await commitAll(wt.path, "task adds tax");
  writeFileSync(join(repo, "app.ts"), "import base\nimport discount\n\nrun()\n");
  writeFileSync(join(repo, "notes.txt"), "the other task's note\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Merge kanban/t_other: Add discount");
  const pre = (await headSha(wt.path))!;
  const baseSha = await revParse(repo, "main");
  const preview = await previewMerge(wt.path, pre, baseSha);
  const conflicts = await startResolveMerge(wt.path, baseSha, "Merge main");
  return { repo, wt, pre, baseSha, preview, conflicts, check: () => checkResolution(wt.path, { pre, baseSha, previewTree: preview.tree, conflicts }) };
}

test("the board starts the merge at a pinned commit and leaves the conflict, original included, for Claude", async () => {
  const s = await conflictScene();
  try {
    assert.deepEqual(s.conflicts, ["app.ts"]);
    assert.deepEqual(s.preview.conflicts, ["app.ts"], "the preview foresaw the same conflict");
    const body = read(s.wt.path, "app.ts");
    assert.match(body, /^<{7} /m);
    assert.match(body, /^\|{7} /m, "zdiff3: the original sits between the two sides");
    assert.equal(read(s.wt.path, "notes.txt"), "the other task's note\n", "git merged the rest itself");
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test("a resolution that keeps both sides passes every check", async () => {
  const s = await conflictScene();
  try {
    writeFileSync(join(s.wt.path, "app.ts"), "import base\nimport tax\nimport discount\n\nrun()\n");
    await finishResolveMerge(s.wt.path, "resolved");
    assert.deepEqual(await s.check(), { hard: [], lost: [], outside: [] });
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test("a resolution that takes one side whole is caught: the other side's lines are listed as lost", async () => {
  const s = await conflictScene();
  try {
    writeFileSync(join(s.wt.path, "app.ts"), "import base\nimport tax\n\nrun()\n");
    await finishResolveMerge(s.wt.path, "took ours");
    const f = await s.check();
    assert.deepEqual(f.hard, []);
    assert.deepEqual(f.lost, [{ file: "app.ts", side: "base", lines: ["import discount"] }]);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test("conflict markers left behind fail the resolution outright", async () => {
  const s = await conflictScene();
  try {
    await finishResolveMerge(s.wt.path, "forgot");
    assert.deepEqual((await s.check()).hard.map((h) => h.id), ["markers"]);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test("quietly undoing the other task's change in a file that never conflicted is caught, and deleting one fails", async () => {
  const s = await conflictScene();
  try {
    writeFileSync(join(s.wt.path, "app.ts"), "import base\nimport tax\nimport discount\n\nrun()\n");
    writeFileSync(join(s.wt.path, "notes.txt"), "one\n");
    rmSync(join(s.wt.path, "keep.txt"));
    await finishResolveMerge(s.wt.path, "overreached");
    const f = await s.check();
    assert.deepEqual(f.hard.map((h) => h.id), ["files"]);
    assert.match(f.hard[0].detail, /keep\.txt/);
    assert.ok(f.outside.includes("notes.txt"));
    assert.deepEqual(f.lost.find((l) => l.file === "notes.txt"), { file: "notes.txt", side: "base", lines: ["the other task's note"] });
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test("a merge that was abandoned instead of finished fails the history check", async () => {
  const s = await conflictScene();
  try {
    git(s.wt.path, "merge", "--abort");
    assert.deepEqual((await s.check()).hard.map((h) => h.id), ["history"]);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test("a resolution that did not pass is set aside: the branch is back where it was, and the attempt is still in the reflog", async () => {
  const s = await conflictScene();
  try {
    writeFileSync(join(s.wt.path, "app.ts"), "import base\nimport tax\n\nrun()\n");
    await rollbackResolution(s.wt.path, s.pre);
    assert.equal(await headSha(s.wt.path), s.pre);
    assert.equal(await isDirty(s.wt.path), false);
    assert.equal(read(s.wt.path, "app.ts"), "import base\nimport tax\n\nrun()\n", "the task's own work is intact");
    assert.match(git(s.wt.path, "reflog", "-3", "--format=%gs"), /set aside a conflict resolution/);
    assert.equal(await isDirty(s.repo), false, "the project's checkout was never touched");
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});
