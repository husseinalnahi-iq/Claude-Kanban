import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";
import { buildChecks } from "../src/setup/checks.ts";
import { pickBrowser, type Probe, type RunResult } from "../src/setup/probe.ts";
import { SetupService } from "../src/setup/service.ts";
import { resetHardwareCache } from "../src/setup/local.ts";
import type { Provider, WsMessage } from "../src/types.ts";

async function until(cond: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const done: QueryFn = () =>
  (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
  })();

test("the Setup project is created once and never listed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksetup-p-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: done }), allowedHosts: ["localhost:80"] });
  try {
    const a = repo.setupProject(join(dir, "setup"));
    assert.equal(a.system, true);
    assert.ok(existsSync(join(dir, "setup")), "its folder is created");
    assert.equal(repo.setupProject(join(dir, "setup")).id, a.id, "one, ever");
    assert.equal(repo.listProjects().length, 0);
    assert.equal(repo.listProjects({ includeSystem: true }).length, 1);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/projects" })).json(), []);
    assert.equal(repo.createProject({ name: "n", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } }).system, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const OK = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A machine with nothing on it; tests add what they need by mutating `o`. */
function fake(init: { env?: Record<string, string>; dirs?: Record<string, string[]> } = {}) {
  const o = { cmds: {} as Record<string, RunResult>, files: [] as string[], json: {} as Record<string, unknown> };
  const calls: string[] = [];
  const probe: Probe = {
    platform: "win32",
    env: init.env ?? {},
    claudeBin: "claude-bin",
    run: async (c, a) => {
      const k = [c, ...a].join(" ");
      calls.push(k);
      return o.cmds[k] ?? { code: null, stdout: "", stderr: "not found" };
    },
    stream: async (c, a, _opts, on) => {
      const k = [c, ...a].join(" ");
      calls.push(`stream ${k}`);
      on(`ran ${k}\n`);
      return o.cmds[k]?.code ?? 0;
    },
    exists: (p) => o.files.includes(p),
    list: (d) => init.dirs?.[d] ?? [],
    fetchJson: async (u) => {
      if (u in o.json) return o.json[u];
      throw new Error("ECONNREFUSED");
    },
    refreshPath: async () => {},
  };
  return { probe, calls, o };
}

const PROVIDERS = [
  { id: "ollama", label: "Ollama (agentic)", kind: "anthropic-compatible", enabled: true, baseUrl: "http://localhost:11434", authRef: "OLLAMA_TOKEN", models: [{ id: "qwen3-coder", label: "Q" }, { id: "bad model;x", label: "B" }], mayEditFiles: true },
  { id: "codex", label: "Codex CLI (OpenAI)", kind: "cli", enabled: true, authRef: "OPENAI_API_KEY", models: [], cli: { preset: "codex" }, mayEditFiles: false },
  { id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic", authRef: "ZAI_API_KEY", models: [], mayEditFiles: true },
  { id: "off", label: "Off", kind: "openai-compatible", enabled: false, baseUrl: "https://x", authRef: "X_KEY", models: [], mayEditFiles: false },
] as Provider[];

/** LM Studio is offered to everyone, set up or not. */
const LMS = ["lmstudio", "lmstudio-server", "lmstudio-model:google/gemma-4-12b-qat", "lmstudio-model:qwen/qwen3.8-27b"];

test("the checklist follows what is switched on and set up", () => {
  const repo = new Repo(openDb(":memory:"));
  const ids = () => buildChecks(repo.getSettings()).map((c) => c.id);
  assert.deepEqual(ids(), ["node", "claude-login", "git", "git-identity", "browser", ...LMS, "plugins"]);
  repo.updateSettings({ browserChecks: false });
  assert.ok(!ids().includes("browser"));
  repo.updateSettings({ providers: PROVIDERS });
  assert.deepEqual(ids(), ["node", "claude-login", "git", "git-identity", "ollama", "ollama-model:qwen3-coder", ...LMS, "cli-codex", "key-zai", "plugins"]);
});

test("LM Studio gets a server check and no key check; an Ollama model a pipeline picked gets a pull check", async () => {
  const repo = new Repo(openDb(":memory:"));
  const lms = { id: "lmstudio", label: "LM Studio", kind: "anthropic-compatible", enabled: true, baseUrl: "http://localhost:1234", authRef: "LM_API_TOKEN", models: [], mayEditFiles: true } as Provider;
  repo.updateSettings({
    browserChecks: false,
    providers: [PROVIDERS[0], lms],
    defaultPipeline: [{ stage: "code", model: "glm-5.3:cloud", effort: "high", provider: "ollama" }],
  });
  const ids = buildChecks(repo.getSettings()).map((c) => c.id);
  assert.ok(ids.includes("ollama-model:glm-5.3:cloud"), ids.join(","));
  assert.ok(!ids.includes("key-lmstudio"));
});

test("LM Studio: install, then its server (one click: Turn on), then a model or two (one click: Download)", async () => {
  resetHardwareCache();
  const repo = new Repo(openDb(":memory:"));
  const f = fake({ env: { USERPROFILE: "U", LOCALAPPDATA: "L" } });
  const ctx = { probe: f.probe, settings: repo.getSettings(), hasSecret: () => false };
  const checks = buildChecks(ctx.settings);
  const get = (id: string) => checks.find((x) => x.id === id)!;
  const lms = join("U", ".lmstudio", "bin", "lms.exe");

  assert.equal((await get("lmstudio").detect(ctx)).detail, "Not installed (optional)");
  assert.equal((await get("lmstudio-server").detect(ctx)).blockedBy, "lmstudio");
  assert.equal((await get("lmstudio-model:google/gemma-4-12b-qat").detect(ctx)).blockedBy, "lmstudio");

  f.o.files.push(lms);
  assert.deepEqual(await get("lmstudio").detect(ctx), { ok: true, detail: "Installed" });
  assert.deepEqual(await get("lmstudio-server").detect(ctx), { ok: false, detail: "Off" });
  assert.equal(get("lmstudio-server").runLabel, "Turn on");
  assert.deepEqual(get("lmstudio-server").run!({}).map((c) => c.args), [["server", "start"]]);
  f.o.json["http://localhost:1234/api/v1/models"] = { models: [{ type: "llm", loaded_instances: [{}] }, { type: "embedding" }] };
  assert.equal((await get("lmstudio-server").detect(ctx)).detail, "On at http://localhost:1234 · 1 model downloaded, 1 loaded · add it to the board in Settings → Providers");

  const gemma = get("lmstudio-model:google/gemma-4-12b-qat");
  assert.equal(gemma.runLabel, "Download");
  assert.deepEqual(gemma.run!({})[0].args, ["get", "google/gemma-4-12b-qat", "--yes"]);
  assert.match((await gemma.detect(ctx)).detail, /^Not downloaded · 7\.4 GB · /);
  f.o.cmds[`${lms} ls --json`] = OK(JSON.stringify([{ modelKey: "google/gemma-4-12b" }, { modelKey: "nomic-embed" }]));
  assert.deepEqual(await gemma.detect(ctx), { ok: true, detail: "Downloaded" }, "the plain build counts as the QAT one");
});

test("detectors: git, identity, login, browser", async () => {
  const repo = new Repo(openDb(":memory:"));
  const f = fake({ env: { PROGRAMFILES: "PF", "PROGRAMFILES(X86)": "X86", LOCALAPPDATA: "L" } });
  const ctx = { probe: f.probe, settings: repo.getSettings(), hasSecret: () => false };
  const get = (id: string, c = ctx) => buildChecks(c.settings).find((x) => x.id === id)!.detect(c);

  assert.equal((await get("git")).ok, false);
  assert.equal((await get("git-identity")).blockedBy, "git");
  f.o.cmds["git --version"] = OK("git version 2.50.0.windows.1\n");
  f.o.cmds["git config --global user.name"] = OK("Ada\n");
  assert.equal((await get("git")).detail, "git version 2.50.0.windows.1");
  assert.equal((await get("git-identity")).detail, "Missing email");
  f.o.cmds["git config --global user.email"] = OK("ada@x.io\n");
  assert.deepEqual(await get("git-identity"), { ok: true, detail: "Ada <ada@x.io>" });

  assert.equal((await get("claude-login")).ok, false);
  f.o.cmds["claude-bin auth status"] = OK(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  assert.equal((await get("claude-login")).detail, "Logged in with claude.ai (max)");
  const g = fake({ env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal((await get("claude-login", { ...ctx, probe: g.probe })).ok, true);
  assert.equal(g.calls.length, 0, "an API key needs no CLI call");

  assert.equal((await get("browser")).ok, false);
  f.o.files.push(join("X86", "Microsoft", "Edge", "Application", "msedge.exe"));
  assert.equal(pickBrowser(f.probe)?.browser, "msedge");
  assert.match((await get("browser")).detail, /Edge/);
  f.o.files.push(join("PF", "Google", "Chrome", "Application", "chrome.exe"));
  assert.equal(pickBrowser(f.probe)?.browser, "chrome", "Chrome wins over Edge");
  const h = fake({ env: { PLAYWRIGHT_BROWSERS_PATH: "PW" }, dirs: { PW: ["ffmpeg-1011", "chromium-1217"] } });
  assert.deepEqual(pickBrowser(h.probe), { browser: "chromium", path: join("PW", "chromium-1217") });
});

test("detectors: Ollama server, then its models; CLIs; keys", async () => {
  const repo = new Repo(openDb(":memory:"));
  repo.updateSettings({ providers: PROVIDERS });
  const f = fake();
  let secret = false;
  const ctx = { probe: f.probe, settings: repo.getSettings(), hasSecret: () => secret };
  const get = (id: string) => buildChecks(ctx.settings).find((x) => x.id === id)!.detect(ctx);

  assert.match((await get("ollama")).detail, /Nothing answers at http:\/\/localhost:11434/);
  assert.equal((await get("ollama-model:qwen3-coder")).blockedBy, "ollama");
  f.o.json["http://localhost:11434/api/version"] = { version: "0.12.0" };
  f.o.json["http://localhost:11434/api/tags"] = { models: [{ name: "qwen3-coder:latest" }] };
  assert.equal((await get("ollama")).ok, true);
  assert.equal((await get("ollama-model:qwen3-coder")).ok, true);

  assert.equal((await get("cli-codex")).ok, false);
  f.o.cmds["codex --version"] = OK("codex-cli 0.40.0\n");
  assert.equal((await get("cli-codex")).detail, "codex-cli 0.40.0");

  assert.equal((await get("key-zai")).ok, false);
  secret = true;
  assert.equal((await get("key-zai")).ok, true);
});

test("setup routes: summary, validation, one-click fix, Claude session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksetup-r-"));
  const f = fake();
  const repo = new Repo(openDb(":memory:"));
  repo.updateSettings({ browserChecks: false });
  const bus = new Bus();
  // The Claude session holds until released, so the test decides when it has "installed" git.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const gated: QueryFn = (params) =>
    (async function* () {
      await gate;
      yield* done(params);
    })();
  const runner = new TaskRunner({ repo, bus, queryFn: gated });
  const setup = new SetupService({ repo, bus, runner, stateDir: dir, probe: f.probe });
  const app = await buildApp({ repo, bus, runner, setup, allowedHosts: ["localhost:80"] });
  const events: WsMessage[] = [];
  bus.subscribe((m) => events.push(m));
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url: `/api${url}`, payload: payload as object });
  const checks = async () => (await app.inject({ method: "GET", url: "/api/setup?fresh=1" })).json();
  try {
    const s = await checks();
    assert.deepEqual(s.summary, { required: 3, recommended: 0 }, "login, git and identity");
    const by = (id: string) => s.checks.find((c: { id: string }) => c.id === id);
    assert.deepEqual(by("claude-login").fixes, ["login"]);
    assert.deepEqual(by("git").fixes, ["claude"]);
    assert.deepEqual(by("git-identity").fixes, [], "blocked until git is installed");
    assert.equal(by("git").manual, "winget install --id Git.Git -e");

    assert.equal((await post("/setup/nope/fix", { kind: "run" })).statusCode, 404);
    assert.equal((await post("/setup/node/fix", { kind: "claude" })).statusCode, 409);
    f.o.cmds["git --version"] = OK("git version 2.50\n");
    assert.equal((await post("/setup/git-identity/fix", { kind: "run", input: { name: "Ada", email: "nope" } })).statusCode, 400);
    assert.equal((await post("/setup/git-identity/fix", { kind: "run", input: { name: 'A"da', email: "a@b.c" } })).statusCode, 400);

    // One click: the built-in commands run, their output streams, and the check is looked at again.
    f.o.cmds["git config --global user.name"] = OK("Ada Lovelace\n");
    f.o.cmds["git config --global user.email"] = OK("ada@x.io\n");
    const res = await post("/setup/git-identity/fix", { kind: "run", input: { name: "Ada Lovelace", email: "ada@x.io" } });
    assert.equal(res.statusCode, 200, res.body);
    await until(() => events.some((m) => m.type === "setup.updated" && m.check.id === "git-identity" && m.check.ok));
    assert.ok(f.calls.includes("stream git config --global user.name Ada Lovelace"));
    assert.ok(events.some((m) => m.type === "setup.output" && m.id === "git-identity" && m.chunk.includes("ran git config")));

    // Claude: a supervised, Claude-pinned task in the hidden Setup project, one per check.
    delete f.o.cmds["git --version"];
    const t = (await post("/setup/git/fix", { kind: "claude" })).json().task;
    assert.equal(t.mode, "supervised");
    assert.deepEqual(t.labels, ["setup:git"]);
    assert.equal(t.pipeline[0].provider, undefined);
    assert.match(t.spec_md, /Install git/);
    assert.match(t.spec_md, /winget install --id Git\.Git/);
    assert.equal(repo.getProject(t.project_id)!.system, true);
    assert.equal((await post("/setup/git/fix", { kind: "claude" })).json().task.id, t.id, "one open session per check");
    assert.equal((await checks()).checks.find((c: { id: string }) => c.id === "git").taskId, t.id);
    // When the session reaches review, the check is looked at again.
    f.o.cmds["git --version"] = OK("git version 2.50\n");
    release();
    await until(() => repo.getTask(t.id)!.status === "review", 8000);
    await until(() => events.some((m) => m.type === "setup.updated" && m.check.id === "git" && m.check.ok));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
