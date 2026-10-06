import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";
import { removeTemp, until } from "./helpers.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];

/** A project whose keys live where git leaves them out, as a real ERP repo keeps them. */
function projectWithKeys(): string {
  const dir = mkdtempSync(join(tmpdir(), "klive-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), ".env\n.codex-secrets/\n");
  writeFileSync(join(dir, ".env.example"), "KEY=\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, ".env"), "KEY=1\n");
  mkdirSync(join(dir, ".codex-secrets"));
  writeFileSync(join(dir, ".codex-secrets", "erp.json"), '{"key":"k"}');
  return dir;
}

type Seen = { cwd: string; envCopied: boolean; erpCopied: boolean; catKeys: unknown; editSkill: unknown };

async function runLiveTask(settings: Record<string, unknown>, taskFields: { live?: boolean } = {}): Promise<{ seen: Seen; prompt: string }> {
  const dir = projectWithKeys();
  const repo = new Repo(openDb(":memory:"));
  const state = mkdtempSync(join(tmpdir(), "klivestate-"));
  repo.setStateDir(state);
  repo.updateSettings(settings as never);
  let seen: Seen | null = null;
  const q: QueryFn = (params) =>
    (async function* () {
      const o = params.options as Options;
      const cwd = String(o.cwd);
      const hook = o.hooks!.PreToolUse![0].hooks[0];
      const catKeys = await hook({ tool_name: "Bash", tool_input: { command: "cat .codex-secrets/erp.json" } } as never, undefined, { signal: new AbortController().signal });
      const editSkill = await hook({ tool_name: "Edit", tool_input: { file_path: join(homedir(), ".claude", "skills", "erp-workflows", "SKILL.md"), old_string: "a", new_string: "b" } } as never, undefined, { signal: new AbortController().signal });
      seen = { editSkill, cwd, envCopied: existsSync(join(cwd, ".env")), erpCopied: existsSync(join(cwd, ".codex-secrets", "erp.json")), catKeys };
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as never;
    })();
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q });
  const project = repo.createProject({ name: "erp", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  const task = repo.createTask({ project_id: project.id, title: "push the script", mode: "autonomous", pipeline: ONE_STAGE, live: taskFields.live ?? true });
  try {
    runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(repo.getTask(task.id)!.status));
    const run = repo.stageRuns(task.id)[0];
    const prompt = repo.eventsAfter(run.id).find((e) => e.type === "user:prompt")!.payload as { text: string };
    return { seen: seen!, prompt: prompt.text };
  } finally {
    for (const d of [dir, state]) {
      try {
        await removeTemp(d);
      } catch {
        // a temp folder; Windows may still hold it
      }
    }
  }
}

test("an autonomous live task gets the project's keys in its folder and is told to do the live steps itself", async () => {
  const { seen, prompt } = await runLiveTask({});
  assert.match(seen.cwd, /\.kanban[\\/]wt[\\/]/, "it still works in its own worktree");
  assert.ok(seen.envCopied && seen.erpCopied, "the gitignored key files were copied in");
  assert.match(prompt, /Do the live steps yourself/);
  assert.doesNotMatch(prompt, /Left for a supervised run/);
  const deny = (seen.catKeys as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  assert.equal(deny?.permissionDecision, "deny", "showing a key file is refused");
  assert.match(deny?.permissionDecisionReason ?? "", /transcript/);
});

const decision = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

test("an autonomous live task may update the skills Claude loads, and is told where they are (D406)", async () => {
  const { seen, prompt } = await runLiveTask({});
  assert.notEqual(decision(seen.editSkill), "deny", "editing a skill file is not refused");
  assert.match(prompt, /The skills Claude loads are in .*.claude.skills and you may edit them/);
  assert.match(prompt, /the skills folder named above is the one exception/);
});

test("an autonomous task without live access may update the skills Claude loads too", async () => {
  const { seen, prompt } = await runLiveTask({ autonomousLive: false });
  assert.notEqual(decision(seen.editSkill), "deny");
  assert.match(prompt, /The skills Claude loads are in .*.claude.skills and you may edit them/);
});

test("an autonomous task nobody marked live gets the keys and the same instruction to finish: live was triage's guess (D410)", async () => {
  const { seen, prompt } = await runLiveTask({}, { live: false });
  assert.ok(seen.envCopied && seen.erpCopied, "the key files were copied in all the same");
  assert.match(prompt, /Do the live steps yourself/);
  assert.match(prompt, /Finish the task end to end/);
  assert.match(prompt, /needs_access/);
});

test("with the setting off, an autonomous live task gets no keys and leaves live steps for a supervised run", async () => {
  const { seen, prompt } = await runLiveTask({ autonomousLive: false });
  assert.equal(seen.envCopied || seen.erpCopied, false);
  assert.match(prompt, /Left for a supervised run/);
});


test("once its worktree is ready, the card stops saying it is preparing one (D395)", async () => {
  const dir = projectWithKeys();
  const repo = new Repo(openDb(":memory:"));
  const q: QueryFn = () =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as never;
    })();
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q });
  const project = repo.createProject({ name: "p", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  const task = repo.createTask({ project_id: project.id, title: "x", mode: "autonomous", pipeline: ONE_STAGE });
  try {
    runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(repo.getTask(task.id)!.status));
    assert.equal(repo.getTask(task.id)!.status, "review");
    assert.doesNotMatch(repo.getTask(task.id)!.summary ?? "", /Making its own copy/);
  } finally {
    await removeTemp(dir);
  }
});
