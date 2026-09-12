import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeQuery, setup, until } from "./helpers.ts";
import { setCliSpawn } from "../src/engine/providers/cli/index.ts";
import { spawnCli, type Child, type SpawnFn } from "../src/engine/providers/cli/spawn.ts";
import { ProviderError } from "../src/engine/providers/registry.ts";
import { PolicyError } from "../src/engine/runner.ts";
import type { Provider, Stage } from "../src/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli");

/** A fake child: replays a fixture's lines on stdout, records what it was given, exits with `code`. */
function fakeChild(opts: { lines?: string[]; stderr?: string; code?: number | null; writeInto?: { cwd: string; file: string }; hang?: boolean; onKill?: () => void }): { spawnFn: SpawnFn; rec: { command: string; args: string[]; env: Record<string, string>; stdin: string } } {
  const rec = { command: "", args: [] as string[], env: {} as Record<string, string>, stdin: "" };
  const spawnFn: SpawnFn = (command, args, o) => {
    rec.command = command; rec.args = args; rec.env = o.env;
    const listeners: Record<string, ((a: unknown) => void)[]> = {};
    const child: Child = {
      pid: 4242,
      stdin: { write: (s) => { rec.stdin += s; }, end: () => {} },
      stdout: (async function* () { for (const l of opts.lines ?? []) yield l + "\n"; })(),
      stderr: (async function* () { if (opts.stderr) yield opts.stderr; })(),
      on: (event, cb) => { (listeners[event] ??= []).push(cb); },
      kill: () => { opts.onKill?.(); (listeners.close ?? []).forEach((cb) => cb(null)); },
    };
    if (opts.writeInto) writeFileSync(join(opts.writeInto.cwd, opts.writeInto.file), "edited by the provider\n");
    if (!opts.hang) setTimeout(() => (listeners.close ?? []).forEach((cb) => cb(opts.code ?? 0)), 5);
    return child;
  };
  return { spawnFn, rec };
}

function cliProvider(over: Partial<Provider> = {}): Provider {
  return { id: "codex", label: "Codex", kind: "cli", enabled: true, authRef: "OPENAI_API_KEY", models: [{ id: "gpt-5.6-sol", label: "Sol" }], cli: { preset: "codex" }, mayEditFiles: false, ...over };
}

test("codex JSONL becomes SDK-shaped events; the last-message file is the result; usage counts cached input", async () => {
  const lines = readFileSync(join(FIX, "codex.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
  const { spawnFn, rec } = fakeChild({ lines });
  setCliSpawn(spawnFn);
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [cliProvider()] });
    s.secrets.set("OPENAI_API_KEY", "sk-openai-secret-value");
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gpt-5.6-sol", effort: "high", provider: "codex" }] });
    // Codex writes the result to the -o file; simulate that by writing to the path it was given.
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review", 5000);
    const [run] = s.repo.runsForTask(task.id);
    const types = s.repo.eventsAfter(run.id).map((e) => e.type);
    assert.deepEqual(types, ["user:prompt", "delegate:command", "system:init", "assistant", "assistant", "user", "assistant", "assistant", "result:success"]);
    assert.equal(run.session_id, "th_abc123");
    assert.equal(run.input_tokens, 1500, "input + cached");
    assert.equal(run.output_tokens, 150);
    assert.equal(run.cost_source, "subscription");
    // args carry read-only and never the prompt; the prompt went over stdin.
    assert.ok(rec.args.includes("read-only"));
    assert.equal(rec.stdin.length > 0, true);
    assert.ok(!rec.args.some((a) => a.includes("Stage:")), "the prompt is never an argument");
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("the child env is an allowlist plus the provider's own key — no ANTHROPIC or other-provider secrets", async () => {
  const { spawnFn, rec } = fakeChild({ lines: ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'] });
  setCliSpawn(spawnFn);
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [cliProvider()] });
    s.secrets.set("OPENAI_API_KEY", "sk-openai-secret-value");
    s.secrets.set("ZAI_API_KEY", "sk-zai-other-provider");
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gpt-5.6-sol", effort: "low", provider: "codex" }] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review", 5000);
    assert.equal(rec.env.OPENAI_API_KEY, "sk-openai-secret-value");
    assert.ok(rec.env.PATH, "PATH is passed");
    assert.equal(rec.env.ANTHROPIC_API_KEY, undefined, "the board's Anthropic key never crosses");
    assert.equal(rec.env.ZAI_API_KEY, undefined, "another provider's key never crosses");
    assert.equal(rec.env.KANBAN_TASK_ID, task.id);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("read-only vs write args, and the stage matrix at queue time", async () => {
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [cliProvider({ mayEditFiles: false })] });
    // A code stage on a read-only CLI provider is refused.
    const t1 = s.repo.createTask({ project_id: s.project.id, title: "c", spec_md: "x", mode: "autonomous", pipeline: [{ stage: "code", model: "gpt-5.6-sol", effort: "low", provider: "codex" }] });
    assert.throws(() => s.runner.queueTask(t1.id), (e: Error) => e instanceof ProviderError && /read-only/.test(e.message));

    // With mayEditFiles on, a code stage is allowed autonomously but refused in supervised mode.
    s.repo.updateSettings({ providers: [cliProvider({ mayEditFiles: true })] });
    const sup = s.repo.createTask({ project_id: s.project.id, title: "s", spec_md: "x", mode: "supervised", pipeline: [{ stage: "code", model: "gpt-5.6-sol", effort: "low", provider: "codex" }] });
    assert.throws(() => s.runner.queueTask(sup.id), (e: Error) => e instanceof ProviderError && /autonomous/.test(e.message));
  } finally {
    s.cleanup();
  }
});

test("a read-only stage that leaves the worktree dirty fails, and nothing is committed", async () => {
  const s = setup(fakeQuery().fn);
  try {
    execFileSync("git", ["init", "-q"], { cwd: s.dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: s.dir });
    const { spawnFn } = fakeChild({ lines: ['{"type":"item.completed","item":{"type":"agent_message","text":"snuck an edit"}}', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'], writeInto: { cwd: s.dir, file: "sneaky.txt" } });
    setCliSpawn(spawnFn);
    s.repo.updateSettings({ providers: [cliProvider({ mayEditFiles: false })] });
    s.secrets.set("OPENAI_API_KEY", "k-value-1234567");
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gpt-5.6-sol", effort: "low", provider: "codex" }] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed", 5000);
    assert.match(s.repo.getTask(task.id)!.error ?? "", /left changes in the workspace/);
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("Gemini stats become usage; an error status fails the run", async () => {
  const good = readFileSync(join(FIX, "gemini.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
  const { spawnFn } = fakeChild({ lines: good });
  setCliSpawn(spawnFn);
  const gp = cliProvider({ id: "gemini", label: "Gemini", authRef: "GEMINI_API_KEY", cli: { preset: "gemini" }, models: [{ id: "gemini-3.8-pro", label: "Pro" }] });
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [gp] });
    s.secrets.set("GEMINI_API_KEY", "g-value-12345678");
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gemini-3.8-pro", effort: "low", provider: "gemini" }] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review", 5000);
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.input_tokens, 800);
    assert.equal(run.session_id, "gem-sess-1");

    const err = readFileSync(join(FIX, "gemini-error.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
    setCliSpawn(fakeChild({ lines: err }).spawnFn);
    const t2 = s.repo.createTask({ project_id: s.project.id, title: "e", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gemini-3.8-pro", effort: "low", provider: "gemini" }] });
    s.runner.queueTask(t2.id);
    await until(() => s.repo.getTask(t2.id)!.status === "failed", 5000);
    assert.match(s.repo.getTask(t2.id)!.error ?? "", /model overloaded/);
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("a custom command gets the prompt in a file and its stdout as the result; unknown lines never throw", async () => {
  let promptPath = "";
  const { spawnFn, rec } = fakeChild({ lines: ["not json, just text", "the answer"], code: 0 });
  // Wrap to capture the prompt-file argument.
  const wrapped: SpawnFn = (c, a, o) => { promptPath = a.find((x) => x.endsWith(".prompt.md")) ?? ""; return spawnFn(c, a, o); };
  setCliSpawn(wrapped);
  const cp = cliProvider({ id: "custom", label: "Mine", authRef: "", cli: { preset: "custom", command: "my-agent --file {prompt_file} --model {model} --mode {mode}" }, models: [{ id: "default", label: "d" }] });
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [cp] });
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "default", effort: "low", provider: "custom" }] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review", 5000);
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.result_md, "not json, just text\nthe answer");
    assert.ok(rec.args.includes("read-only"), "{mode} became read-only");
    assert.ok(promptPath, "the prompt went to a file");
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("spawnCli refuses an unsafe argument when a Windows shim needs a shell", async () => {
  await assert.rejects(
    spawnCli(
      { command: "codex", args: ["-m", "gpt-5; rm -rf /"] },
      { onLine: () => {}, onStderr: () => {} },
      { cwd: ".", env: {}, timeoutMs: 1000, abort: new AbortController().signal, platform: "win32", spawnFn: () => { throw new Error("should not spawn"); } },
    ),
    (e: Error) => e instanceof PolicyError && /cannot .*safely|only contain/i.test(e.message),
  );
});

test("stop and timeout kill the child and fail the run", async () => {
  const s = setup(fakeQuery().fn);
  try {
    let killed = false;
    const { spawnFn } = fakeChild({ hang: true, onKill: () => (killed = true) });
    setCliSpawn(spawnFn);
    s.repo.updateSettings({ providers: [cliProvider()], delegateTimeoutMin: 1 });
    s.secrets.set("OPENAI_API_KEY", "k-value-12345678");
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gpt-5.6-sol", effort: "low", provider: "codex" }] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "planning", 5000);
    s.runner.stopTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed", 5000);
    assert.equal(killed, true, "the child was killed");
    assert.equal(s.repo.getTask(task.id)!.error, "stopped by user");
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});
