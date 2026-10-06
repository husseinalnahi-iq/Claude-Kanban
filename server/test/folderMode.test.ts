import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";
import { removeTemp, until } from "./helpers.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A small repository with a git-ignored key file, and optionally one file you were already changing. */
function gitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "kfolder-"));
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.email", "test@example.com");
  gitIn(dir, "config", "user.name", "Test");
  gitIn(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, "README.md"), "base\n");
  writeFileSync(join(dir, "notes.md"), "mine\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, ".env"), "KEY=1\n");
  return dir;
}

type Hook = (input: unknown, id: undefined, o: { signal: AbortSignal }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
/** One step of a fake stage: ask the gate, and when it allows a write, make it the way Claude Code would. */
type Step = { tool: string; input: Record<string, unknown>; write?: { file: string; text: string }; remove?: string };

interface Harness {
  repo: Repo;
  runner: TaskRunner;
  dir: string;
  cwds: string[];
  decisions: (string | undefined)[];
  cleanup: () => Promise<void>;
}

function harness(dir: string, steps: Step[] = [], settings: Record<string, unknown> = { autonomousWorktree: false }): Harness {
  const repo = new Repo(openDb(":memory:"));
  const state = mkdtempSync(join(tmpdir(), "kfolderstate-"));
  repo.setStateDir(state);
  repo.updateSettings({ autoTriage: false, ...settings } as never);
  const cwds: string[] = [];
  const decisions: (string | undefined)[] = [];
  const q: QueryFn = (params) =>
    (async function* () {
      const o = params.options as Options;
      const cwd = String(o.cwd);
      cwds.push(cwd);
      const hook = o.hooks!.PreToolUse![0].hooks[0] as unknown as Hook;
      for (const s of steps) {
        const out = await hook({ tool_name: s.tool, tool_input: s.input }, undefined, { signal: new AbortController().signal });
        const decision = out.hookSpecificOutput?.permissionDecision;
        decisions.push(decision === "deny" ? `deny: ${out.hookSpecificOutput?.permissionDecisionReason}` : "allow");
        if (decision !== "deny" && s.write) writeFileSync(join(cwd, s.write.file), s.write.text);
        if (decision !== "deny" && s.remove) rmSync(join(cwd, s.remove));
      }
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as never;
    })();
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q });
  return {
    repo, runner, dir, cwds, decisions,
    cleanup: async () => {
      for (const d of [dir, state]) {
        try {
          await removeTemp(d);
        } catch {
          // a temp folder; Windows may still hold it
        }
      }
    },
  };
}

function project(h: Harness) {
  return h.repo.createProject({ name: "app", path: h.dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
}

async function runToReview(h: Harness, over: Record<string, unknown> = {}) {
  const p = project(h);
  const task = h.repo.createTask({ project_id: p.id, title: "Change the readme", mode: "autonomous", pipeline: ONE_STAGE, ...over });
  h.runner.queueTask(task.id);
  await until(() => ["review", "failed"].includes(h.repo.getTask(task.id)!.status));
  return h.repo.getTask(task.id)!;
}

const edit = (file: string, text: string): Step => ({ tool: "Write", input: { file_path: file, content: text }, write: { file, text } });

test("with the worktree setting off, an autonomous task works in the project folder and keeps that place", async () => {
  const h = harness(gitProject());
  try {
    const t = await runToReview(h);
    assert.equal(t.status, "review", t.error ?? "");
    assert.equal(h.cwds[0], h.dir, "it ran in the project folder itself");
    assert.equal(t.in_folder, true, "the card is stamped");
    assert.equal(t.worktree_path, null);
    assert.equal(existsSync(join(h.dir, ".kanban", "wt")), false, "no worktree was made");
    // Turning the setting back on does not move a task that already worked in the folder.
    h.repo.updateSettings({ autonomousWorktree: true });
    h.runner.retryTask(t.id);
    await until(() => h.cwds.length === 2 && h.repo.getTask(t.id)!.status === "review");
    assert.equal(h.cwds[1], h.dir);
  } finally {
    await h.cleanup();
  }
});

test("a folder without git runs an autonomous task in the folder, with the setting on, instead of refusing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kplainf-"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>\n");
  const h = harness(dir, [edit("index.html", "<h1>hello</h1>\n")], { autonomousWorktree: true });
  try {
    const t = await runToReview(h);
    assert.equal(t.status, "review", t.error ?? "");
    assert.equal(h.cwds[0], dir);
    assert.equal(t.in_folder, true);
    const diff = await h.runner.diff(t.id);
    assert.deepEqual(diff.map((d) => [d.file, d.status]), [["index.html", "M"]], "the Changes tab works without a repository");
    const done = await h.runner.approveTask(t.id);
    assert.equal(done.status, "done", "no repository: Approve marks it done");
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<h1>hello</h1>\n");
  } finally {
    await h.cleanup();
  }
});

test("in the project folder the gate keeps a run out of .git and .kanban, lets git only look, and never prints the keys", async () => {
  const dir = gitProject();
  const h = harness(dir, [
    { tool: "Read", input: { file_path: join(dir, ".git", "config") } },
    { tool: "Write", input: { file_path: join(dir, ".kanban", "wt", "t_x", "a.txt"), content: "x" } },
    { tool: "Bash", input: { command: "git commit -am 'mine'" } },
    { tool: "Bash", input: { command: "git status && git diff" } },
    { tool: "Bash", input: { command: "cat .env" } },
    { tool: "Read", input: { file_path: join(dir, ".gitignore") } },
  ]);
  try {
    await runToReview(h);
    const [gitDir, kanban, commit, look, keys, gitignore] = h.decisions;
    assert.match(gitDir ?? "", /^deny: .*\.git and \.kanban/);
    assert.match(kanban ?? "", /^deny: .*\.git and \.kanban/);
    assert.match(commit ?? "", /^deny: .*git commit.*only looks/);
    assert.equal(look, "allow");
    assert.match(keys ?? "", /^deny: .*passwords or keys/);
    assert.equal(gitignore, "allow", ".gitignore is not .git");
  } finally {
    await h.cleanup();
  }
});

test("Approve commits exactly the task's files on your branch and leaves your own changes uncommitted", async () => {
  const dir = gitProject();
  writeFileSync(join(dir, "notes.md"), "mine, still being written\n"); // yours, before the task starts
  const h = harness(dir, [edit("README.md", "base\nfrom the task\n"), edit("new.txt", "made by the task\n")]);
  try {
    const t = await runToReview(h);
    const diff = await h.runner.diff(t.id);
    assert.deepEqual(diff.map((d) => [d.file, d.status]).sort(), [["README.md", "M"], ["new.txt", "A"]]);
    assert.match(diff.find((d) => d.file === "README.md")!.patch, /\+from the task/);
    const done = await h.runner.approveTask(t.id);
    assert.equal(done.status, "done");
    assert.deepEqual(gitIn(dir, "show", "--name-only", "--pretty=format:%s", "HEAD").split("\n").filter(Boolean), ["Change the readme", "README.md", "new.txt"]);
    assert.equal(gitIn(dir, "status", "--porcelain"), "M notes.md", "your own change is still yours, uncommitted");
    assert.equal(done.landed_sha, gitIn(dir, "rev-parse", "HEAD"));
  } finally {
    await h.cleanup();
  }
});

test("a helper the task wrote and deleted again is dropped from its files, and Approve commits the rest", async () => {
  const dir = gitProject();
  const h = harness(dir, [
    edit("README.md", "base\nfrom the task\n"),
    edit("tmp_helper.py", "print('look')\n"),
    { tool: "Bash", input: { command: "rm tmp_helper.py" }, remove: "tmp_helper.py" },
  ]);
  try {
    const t = await runToReview(h);
    assert.deepEqual(t.footprint.touched, ["README.md"], "the card does not list a file that is gone");
    const done = await h.runner.approveTask(t.id);
    assert.equal(done.status, "done", "naming the vanished helper used to fail git add, and the whole Approve");
    assert.deepEqual(gitIn(dir, "show", "--name-only", "--pretty=format:%s", "HEAD").split("\n").filter(Boolean), ["Change the readme", "README.md"]);
  } finally {
    await h.cleanup();
  }
});

test("Discard puts the folder back the way the task found it", async () => {
  const dir = gitProject();
  const h = harness(dir, [edit("README.md", "changed\n"), edit("new.txt", "made\n")]);
  try {
    const t = await runToReview(h);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "changed\n");
    const back = await h.runner.discardTask(t.id);
    assert.equal(back.status, "backlog");
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "base\n");
    assert.equal(existsSync(join(dir, "new.txt")), false);
    assert.equal(gitIn(dir, "status", "--porcelain"), "");
  } finally {
    await h.cleanup();
  }
});

test("an autonomous live task in the project folder does its live steps itself, with the keys where they are", async () => {
  const h = harness(gitProject(), [{ tool: "Bash", input: { command: "cat .env" } }]);
  try {
    const t = await runToReview(h, { live: true });
    assert.equal(t.status, "review", t.error ?? "");
    const run = h.repo.stageRuns(t.id)[0];
    const prompt = (h.repo.eventsAfter(run.id).find((e) => e.type === "user:prompt")!.payload as { text: string }).text;
    assert.match(prompt, /directly in the project folder, and it may change the live system/);
    assert.match(prompt, /Do the live steps yourself/);
    assert.doesNotMatch(prompt, /Left for a supervised run/);
    assert.match(h.decisions[0] ?? "", /^deny: .*passwords or keys/, "a script may load them, nothing may print them");
  } finally {
    await h.cleanup();
  }
});

test("another agent's CLI may not change files in the project folder", async () => {
  const h = harness(gitProject());
  try {
    h.repo.updateSettings({
      providers: [{ id: "codex", label: "Codex", kind: "cli", enabled: true, authRef: "", models: [{ id: "gpt-x", label: "X" }], cli: { preset: "codex", auth: "login" }, mayEditFiles: true }],
    } as never);
    const p = project(h);
    const task = h.repo.createTask({ project_id: p.id, title: "x", mode: "autonomous", pipeline: [{ stage: "code", provider: "codex", model: "gpt-x", effort: "low" }] });
    assert.throws(() => h.runner.queueTask(task.id), /only change files in a task's own copy/);
  } finally {
    await h.cleanup();
  }
});
