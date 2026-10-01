import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    await until(() => s.repo.getTask(task.id)!.status === "review", 15_000);
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
    await until(() => s.repo.getTask(task.id)!.status === "review", 15_000);
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
    await until(() => s.repo.getTask(task.id)!.status === "failed", 15_000);
    assert.match(s.repo.getTask(task.id)!.error ?? "", /was run read-only on the plan stage but changed sneaky\.txt/);
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("a read-only stage in a checkout that already held uncommitted work passes when it changes nothing (D295)", async () => {
  const s = setup(fakeQuery().fn);
  try {
    execFileSync("git", ["init", "-q"], { cwd: s.dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: s.dir });
    writeFileSync(join(s.dir, "my-notes.md"), "the user's own work in progress");
    const { spawnFn } = fakeChild({ lines: OK_LINES });
    setCliSpawn(spawnFn);
    s.repo.updateSettings({ providers: [cliProvider({ mayEditFiles: false })] });
    s.secrets.set("OPENAI_API_KEY", "k-value-1234567");
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gpt-5.6-sol", effort: "low", provider: "codex" }] });
    s.runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(s.repo.getTask(task.id)!.status), 15_000);
    assert.equal(s.repo.getTask(task.id)!.status, "review", s.repo.getTask(task.id)!.error ?? "");
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("Gemini stats become usage; an overloaded error pauses to try again later, and Stop fails it with the reason", async () => {
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
    await until(() => s.repo.getTask(task.id)!.status === "review", 15_000);
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.input_tokens, 800);
    assert.equal(run.session_id, "gem-sess-1");

    const err = readFileSync(join(FIX, "gemini-error.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
    setCliSpawn(fakeChild({ lines: err }).spawnFn);
    const t2 = s.repo.createTask({ project_id: s.project.id, title: "e", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gemini-3.8-pro", effort: "low", provider: "gemini" }] });
    s.runner.queueTask(t2.id);
    // An overloaded model is "busy" (D225): it waits ten minutes rather than failing.
    await until(() => s.repo.getTask(t2.id)!.status === "paused", 15_000);
    assert.match(s.repo.getTask(t2.id)!.note ?? "", /too busy right now: .*model overloaded/);
    assert.ok(s.repo.getTask(t2.id)!.resume_at);
    s.runner.stopPaused(t2.id);
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
    await until(() => s.repo.getTask(task.id)!.status === "review", 15_000);
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
    const { spawnFn, rec } = fakeChild({ hang: true, onKill: () => (killed = true) });
    setCliSpawn(spawnFn);
    s.repo.updateSettings({ providers: [cliProvider()], delegateTimeoutMin: 1 });
    s.secrets.set("OPENAI_API_KEY", "k-value-12345678");
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "gpt-5.6-sol", effort: "low", provider: "codex" }] });
    s.runner.queueTask(task.id);
    // Finding the Codex command comes first; the child exists only once it is started.
    await until(() => rec.command !== "", 15_000);
    s.runner.stopTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed", 15_000);
    assert.equal(killed, true, "the child was killed");
    assert.equal(s.repo.getTask(task.id)!.error, "stopped by user");
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

const OK_LINES = ['{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'];

/** A Codex folder as Codex leaves it: the account's model list, cached by Codex itself. */
function codexFolder(models: unknown[]): () => void {
  const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ fetched_at: "2026-09-19T00:00:00Z", models }));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  return () => {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
    rmSync(dir, { recursive: true, force: true });
  };
}

const PLAN_MODELS = [
  { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", supported_in_api: true, priority: 1, context_window: 272000, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }] },
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", supported_in_api: false, priority: 2, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
  { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", supported_in_api: true, priority: 3 },
];

async function runCodexStage(provider: Provider, opts: { model?: string; effort?: Stage["effort"]; secrets?: Record<string, string> } = {}) {
  const { spawnFn, rec } = fakeChild({ lines: OK_LINES });
  setCliSpawn(spawnFn);
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [provider] });
    for (const [k, v] of Object.entries(opts.secrets ?? {})) s.secrets.set(k, v);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: opts.model ?? "gpt-5.6-terra", effort: opts.effort ?? "low", provider: provider.id }] });
    s.runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(s.repo.getTask(task.id)!.status), 15_000);
    return { rec, task: s.repo.getTask(task.id)! };
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
}

const planProvider = (): Provider => ({ id: "codex", label: "Codex · ChatGPT subscription", kind: "cli", enabled: true, authRef: "", models: [{ id: "gpt-5.6-terra", label: "Terra" }], cli: { preset: "codex", auth: "login" }, mayEditFiles: false });

test("Codex on a ChatGPT plan sees no API key — not the board's, not the computer's — so the plan is what it bills (D293)", async () => {
  process.env.OPENAI_API_KEY = "sk-env-openai-should-not-cross";
  try {
    const { rec, task } = await runCodexStage(planProvider(), { secrets: { OPENAI_API_KEY: "sk-board-openai", CODEX_API_KEY: "sk-board-codex" } });
    assert.equal(task.status, "review");
    assert.equal(rec.env.OPENAI_API_KEY, undefined);
    assert.equal(rec.env.CODEX_API_KEY, undefined);
    assert.ok(rec.env.USERPROFILE || rec.env.HOME, "it can still find its own sign-in");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("Codex on an API key gets it as CODEX_API_KEY, the variable codex exec reads (D293)", async () => {
  const provider: Provider = { ...planProvider(), id: "codex-api", authRef: "CODEX_API_KEY", cli: { preset: "codex", auth: "api-key" } };
  const { rec } = await runCodexStage(provider, { secrets: { CODEX_API_KEY: "sk-codex-key-123456" } });
  assert.equal(rec.env.CODEX_API_KEY, "sk-codex-key-123456");

  // An older board's single Codex entry, with its key under OPENAI_API_KEY, still uses that key.
  const legacy = await runCodexStage(cliProvider({ models: [{ id: "gpt-5.6-terra", label: "Terra" }] }), { secrets: { OPENAI_API_KEY: "sk-legacy-openai-1" } });
  assert.equal(legacy.rec.env.CODEX_API_KEY, "sk-legacy-openai-1");
});

test("codex exec is called without the -a flag it refuses, and with the effort the model takes (D294)", async () => {
  const restore = codexFolder(PLAN_MODELS);
  try {
    const max = await runCodexStage(planProvider(), { effort: "max" });
    assert.ok(!max.rec.args.includes("-a"), "approval is a top-level flag; exec refused it and every stage failed");
    assert.ok(max.rec.args.includes("model_reasoning_effort=max"), "max is passed through, not cut to high");
    const clamped = await runCodexStage(planProvider(), { model: "gpt-5.5", effort: "max" });
    assert.ok(clamped.rec.args.includes("model_reasoning_effort=high"), "a model that stops at high gets high");
  } finally {
    restore();
  }
});

test("the Codex picker lists what the signed-in plan offers; the API-key entry only what the API serves (D294)", async () => {
  const { codexModels, codexRows, setCodexRunner } = await import("../src/engine/providers/codexLocal.ts");
  assert.deepEqual(codexRows(PLAN_MODELS, "login").map((m) => [m.id, m.group]), [["gpt-5.6-terra", "plan"], ["gpt-5.5", "plan"]], "hidden models stay hidden");
  assert.deepEqual(codexRows(PLAN_MODELS, "api-key").map((m) => m.id), ["gpt-5.6-terra"]);
  assert.equal(codexRows(PLAN_MODELS, "login")[0].contextWindow, 272000);
  assert.deepEqual(codexRows(PLAN_MODELS, "login")[1].efforts, ["low", "medium", "high"], "each model's own effort levels");

  // Codex is asked first (`codex debug models`, free); its cache file when it cannot answer.
  setCodexRunner(async (_c, args) => (args[0] === "debug" ? { code: 0, out: JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" }] }) } : { code: 0, out: "codex-cli 0.160.0" }));
  try {
    assert.deepEqual((await codexModels("login"))!.map((m) => m.id), ["gpt-6.1-sol"], "a model new to the account shows without Codex having run");
  } finally {
    setCodexRunner(null);
  }
  const restore = codexFolder(PLAN_MODELS);
  setCodexRunner(async () => ({ code: 1, out: "" }));
  try {
    assert.deepEqual((await codexModels("login"))!.map((m) => m.id), ["gpt-5.6-terra", "gpt-5.5"]);
    process.env.CODEX_HOME = join(tmpdir(), "no-codex-here-at-all");
    assert.equal(await codexModels("login"), null, "no Codex at all: the provider keeps the models typed into Settings");
  } finally {
    setCodexRunner(null);
    restore();
  }
});
