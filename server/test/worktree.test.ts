import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { removeTemp } from "./helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { addWorktree, commitAll, diffTask, mergeTask, removeWorktree, listWorktrees, isGitRepo, currentBranch, syncUnionFiles, updateFromBase } from "../src/git/worktree.ts";

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

test("a worktree folder something else is still using does not stop its merged branch from going, and is reported (D396)", async () => {
  const repo = makeRepo();
  const { spawn } = await import("node:child_process");
  const wt = await addWorktree(repo, "t_held");
  writeFileSync(join(wt.path, "game.js"), "play()\n");
  await commitAll(wt.path, "kanban: game");
  await mergeTask(repo, wt.branch, "Merge kanban/t_held");
  // A program whose working folder is the worktree: on Windows git can then empty the folder but not delete it.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd: wt.path, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  try {
    // The folder that stays is said out loud now, not passed over: the card gets a note (D396).
    await assert.rejects(removeWorktree(repo, "t_held", { deleteBranch: "safe" }), /could not be deleted/);
    assert.equal(git(repo, "branch", "--format=%(refname:short)"), "main", "the merged branch is gone");
    assert.equal((await listWorktrees(repo)).length, 1, "git no longer lists the worktree");
  } finally {
    holder.kill();
    await new Promise((r) => setTimeout(r, 200));
    await removeTemp(repo);
  }
});

/** A worktree holding the key files a live task was given, as D385 seeds them (git ignores them). */
async function worktreeWithKeys(repo: string, taskId: string) {
  writeFileSync(join(repo, ".gitignore"), ".env\n.codex-secrets/\n.kanban/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "ignore keys");
  const wt = await addWorktree(repo, taskId);
  writeFileSync(join(wt.path, ".env"), "KEY=1\n");
  mkdirSync(join(wt.path, ".codex-secrets"));
  writeFileSync(join(wt.path, ".codex-secrets", "erp.json"), '{"key":"k"}');
  return wt;
}

test("removing a worktree takes the copied key files with it (D396)", async () => {
  const repo = makeRepo();
  try {
    const wt = await worktreeWithKeys(repo, "t_keys1");
    await removeWorktree(repo, "t_keys1", { deleteBranch: "force" });
    assert.equal(existsSync(wt.path), false, "the folder is gone, keys and all");
  } finally {
    await removeTemp(repo);
  }
});

test("the board keeps its own block in the repository's attributes and leaves everyone else's lines alone (D404)", async () => {
  const repo = makeRepo();
  try {
    const file = join(repo, ".git", "info", "attributes");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(file, "*.png binary\n");
    await syncUnionFiles(repo, ["DECISIONS.md", "docs/my log.md"]);
    assert.match(readFileSync(file, "utf8"), /^\*\.png binary\n# --- Claude Kanban[^\n]*\nDECISIONS\.md merge=union\n"docs\/my log\.md" merge=union\n# --- end Claude Kanban ---\n$/);
    await syncUnionFiles(repo, ["CHANGELOG.md"]);
    assert.doesNotMatch(readFileSync(file, "utf8"), /DECISIONS/, "the block is replaced, not added to");
    await syncUnionFiles(repo, []);
    assert.equal(readFileSync(file, "utf8"), "*.png binary\n", "an empty list takes the block away");
  } finally {
    await removeTemp(repo);
  }
});

test("a tracked .env.example is not taken for a key: the merged branch still goes and its last commit changes nothing", async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, ".env.example"), "KEY=\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "example settings");
    const wt = await worktreeWithKeys(repo, "t_keys3");
    writeFileSync(join(wt.path, "game.js"), "play()\n");
    await commitAll(wt.path, "kanban: game");
    await mergeTask(repo, wt.branch, "Merge kanban/t_keys3");
    await removeWorktree(repo, "t_keys3", { deleteBranch: "safe" });
    assert.equal(git(repo, "branch", "--format=%(refname:short)"), "main", "git counts the branch as merged and deletes it");
    assert.equal(readFileSync(join(repo, ".env.example"), "utf8"), "KEY=\n");
  } finally {
    await removeTemp(repo);
  }
});

test("a worktree folder that cannot be deleted is reported, never left silently, and its keys go first (D396)", async (t) => {
  if (process.platform !== "win32") return t.skip("an open file blocks a delete only on Windows");
  const repo = makeRepo();
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    const wt = await worktreeWithKeys(repo, "t_keys2");
    // A program working inside the folder (a dev server, a terminal): Windows will not delete its folder.
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: wt.path, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(removeWorktree(repo, "t_keys2", { deleteBranch: "force" }), /could not be deleted.*key files were removed/);
    assert.equal(existsSync(join(wt.path, ".env")), false, "the key file is gone even though the folder stayed");
    assert.equal(existsSync(join(wt.path, ".codex-secrets")), false);
  } finally {
    holder?.kill();
    await new Promise((r) => setTimeout(r, 300));
    await removeTemp(repo);
  }
});

test("a file name that only fits the project's own checkout still checks out in a task's copy on Windows (D415)", { skip: process.platform !== "win32" }, async () => {
  const repo = makeRepo();
  try {
    // Pad the file's path so the project's checkout is just under 260 characters and the copy, which
    // sits under .kanban\wt\<task>\, is well over it — as a real repo's long attachment names were.
    const dirPart = "attachments";
    const room = 255 - (repo.length + 1 + dirPart.length + 1) - 4;
    const name = `${"b".repeat(Math.max(10, room))}.pdf`;
    mkdirSync(join(repo, dirPart), { recursive: true });
    writeFileSync(join(repo, dirPart, name), "x");
    execFileSync("git", ["-c", "core.longpaths=true", "add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "core.longpaths=true", "commit", "-q", "-m", "long name"], { cwd: repo });
    assert.ok(join(repo, ".kanban", "wt", "t_long0001", dirPart, name).length > 260, "the copy's path is over the limit");

    const wt = await addWorktree(repo, "t_long0001");
    assert.ok(existsSync(join(wt.path, dirPart, name)), "the long-named file is in the task's copy");
    await removeWorktree(repo, "t_long0001", { deleteBranch: "force" });
  } finally {
    await removeTemp(repo);
  }
});

test("a copy that cannot be made leaves no branch or folder behind, and an empty leftover branch is started again (D415)", async () => {
  const repo = makeRepo();
  try {
    // What a failed attempt used to leave: the task's branch, pointing at HEAD, with nothing of its own.
    git(repo, "branch", "kanban/t_left0001");
    mkdirSync(join(repo, ".kanban", "wt", "t_left0001"), { recursive: true });
    writeFileSync(join(repo, ".kanban", "wt", "t_left0001", "half.txt"), "half-written");
    const wt = await addWorktree(repo, "t_left0001");
    assert.match(wt.baseSha ?? "", /^[0-9a-f]{40}$/, "started again from HEAD, so it has a base to diff against");
    assert.ok(existsSync(join(wt.path, "README.md")));
    assert.ok(!existsSync(join(wt.path, "half.txt")), "the half-written folder was cleared first");
    await removeWorktree(repo, "t_left0001", { deleteBranch: "force" });

    // A base git cannot check out: the attempt fails and cleans up after itself.
    await assert.rejects(addWorktree(join(repo, "no-such-subfolder"), "t_fail0001"));
    assert.equal(git(repo, "branch", "--list", "kanban/t_fail0001"), "");
  } finally {
    await removeTemp(repo);
  }
});

test("git's error is shown without its progress meter", async () => {
  const { gitErrorText } = await import("../src/git/worktree.ts");
  const raw = "Preparing worktree (new branch 'kanban/t_x')\nUpdating files:   6% (2858/42454)\rUpdating files:   7% (2972/42454)\rUpdating files: 100% (42454/42454), done.\nerror: unable to create file migration/very/long/name.pdf: Filename too long\nfatal: Could not reset index file to revision 'HEAD'.";
  assert.equal(gitErrorText(raw), "Preparing worktree (new branch 'kanban/t_x')\nerror: unable to create file migration/very/long/name.pdf: Filename too long\nfatal: Could not reset index file to revision 'HEAD'.");
});

test("a task's diff leaves out the base's commits it took in with Update from base (D428)", async () => {
  const repo = makeRepo();
  try {
    const wt = await addWorktree(repo, "t_ff");
    // Someone else commits on main while the task works; the task's branch is brought up to date.
    writeFileSync(join(repo, "theirs.md"), "owner's work\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "updates");
    await updateFromBase(wt.path, "main", "merge");
    assert.deepEqual(await diffTask(repo, wt.baseSha!, wt.branch), [], "a card that changed nothing lists nothing");

    writeFileSync(join(wt.path, "mine.md"), "the task's work\n");
    await commitAll(wt.path, "kanban: mine");
    assert.deepEqual((await diffTask(repo, wt.baseSha!, wt.branch)).map((f) => f.file), ["mine.md"]);
    await removeWorktree(repo, "t_ff", { deleteBranch: "force" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
