# Setup Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Setup page that detects what this machine is missing for the board's features and fixes it: one-click built-in commands, a supervised Claude session, or a copyable command.

**Architecture:** `server/src/setup/` holds a `Probe` (every call to the machine, injectable for tests), a registry of checks built from the current settings, and a `SetupService` that detects, runs built-in fixes (streaming over the bus) and queues "Fix with Claude" tasks in a hidden system project. The web gets a `setup` view, a nav badge, and lands there on first launch while a required item fails.

**Tech Stack:** Fastify + zod, `node:sqlite` (LATER_COLUMNS), node:test, React + Tailwind.

Spec: `docs/superpowers/specs/2026-09-12-setup-checklist-design.md`.

**Facts settled while planning** (verified on this machine):
- The SDK ships its own Claude binary: `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`; `auth status` prints JSON (`loggedIn`, `authMethod`, `subscriptionType`).
- `@playwright/mcp` accepts `--browser chrome|msedge|chromium` (`chromium` = the downloaded "chrome-for-testing" build), and `npx -y @playwright/mcp@latest install-browser chromium` installs the browser matching its own Playwright version. This machine has Edge but no Chrome, so today's default (Chrome) cannot launch here.
- On Windows, a program installed after the board started is not on the server's PATH; the probe re-reads Machine+User PATH from the registry after every fix.

---

### Task 1: Hidden system project

**Files:** Modify `server/src/db.ts`, `server/src/types.ts`, `server/src/repo.ts`. Test: `server/test/setup.test.ts` (new).

- [ ] **Step 1: Failing test** — create `server/test/setup.test.ts`:

```ts
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
```

- [ ] **Step 2:** `npm test` → fails (`setupProject` missing).
- [ ] **Step 3: Implement.**
  - `db.ts` LATER_COLUMNS: `{ table: "projects", column: "system", ddl: "system INTEGER NOT NULL DEFAULT 0" },`
  - `types.ts` `Project`: add `/** The board's own hidden project (Setup). Never listed. */ system?: boolean;`
  - `repo.ts` `toProject`: `system: r.system === 1,`
  - `repo.ts` replace `listProjects`, add two methods:

```ts
  /** Your projects. The board's own (Setup) only when asked for. */
  listProjects(opts: { includeSystem?: boolean } = {}): Project[] {
    const where = opts.includeSystem ? "" : "WHERE system = 0 ";
    return (this.db.prepare(`SELECT * FROM projects ${where}ORDER BY created_at`).all() as Row[]).map(toProject);
  }

  findSetupProject(): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE system = 1 LIMIT 1").get() as Row | undefined;
    return r && toProject(r);
  }

  /** The hidden project "Fix with Claude" runs in: supervised only, one at a time, in the board's own folder. */
  setupProject(dir: string): Project {
    const found = this.findSetupProject();
    if (found) return found;
    mkdirSync(dir, { recursive: true });
    const p = this.createProject({ name: "Setup", path: dir, policy: { worktrees: "forbidden", autonomous: "forbidden", maxConcurrent: 1 } });
    this.db.prepare("UPDATE projects SET system = 1 WHERE id = ?").run(p.id);
    return this.getProject(p.id)!;
  }
```
  (import `mkdirSync` from `node:fs` in repo.ts.)
- [ ] **Step 4:** `npm test` → passes. **Step 5:** commit `feat(setup): hidden system project`.

### Task 2: Probe

**Files:** Create `server/src/setup/probe.ts`.

```ts
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RunResult {
  /** null when the program could not be started at all (not installed). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Everything a setup check may ask of the machine, in one place, so tests pass a fake and nothing in
 * the checks themselves touches the OS.
 */
export interface Probe {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** The Claude binary for login and status: the SDK's own, so Claude Code need not be installed separately. */
  claudeBin: string;
  run(command: string, args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** Like run, but hands output over as it arrives. Resolves with the exit code (null: never started). */
  stream(command: string, args: string[], opts: { timeoutMs: number }, onChunk: (s: string) => void): Promise<number | null>;
  exists(path: string): boolean;
  list(dir: string): string[];
  fetchJson(url: string, timeoutMs?: number): Promise<unknown>;
  /** Windows: pick up PATH changes an installer just made, so the new program works without a restart. */
  refreshPath(): Promise<void>;
}

/**
 * Windows `.cmd` shims need a shell (Node 24 refuses to spawn them otherwise). Only these names get
 * one, and only with the fixed arguments the checks use; git and anything taking a user value never do.
 */
const SHIMS = new Set(["npm", "npx", "claude", "codex", "gemini", "kimi", "opencode"]);
const shellFor = (command: string) => process.platform === "win32" && SHIMS.has(command);

const require = createRequire(import.meta.url);

/** The binary the Agent SDK bundles for this platform, or null (then a global `claude` is tried). */
export function bundledClaude(): string | null {
  try {
    const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    for (const name of [`claude-agent-sdk-${process.platform}-${process.arch}`, `claude-agent-sdk-${process.platform}-${process.arch}-musl`]) {
      const p = join(sdkDir, "..", name, exe);
      if (existsSync(p)) return p;
    }
  } catch {
    // SDK not resolvable: fall through to a global install.
  }
  return null;
}

function run(command: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, shell: shellFor(command), timeout: opts.timeoutMs ?? 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === null ? err.message : "") });
    });
  });
}

export const realProbe: Probe = {
  platform: process.platform,
  env: process.env,
  claudeBin: bundledClaude() ?? "claude",
  run,
  stream: (command, args, opts, onChunk) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { windowsHide: true, shell: shellFor(command) });
      const timer = setTimeout(() => child.kill(), opts.timeoutMs);
      child.stdout?.on("data", (d) => onChunk(String(d)));
      child.stderr?.on("data", (d) => onChunk(String(d)));
      child.on("error", (e) => {
        clearTimeout(timer);
        onChunk(`${e.message}\n`);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    }),
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  fetchJson: async (url, timeoutMs = 3000) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  refreshPath: async () => {
    if (process.platform !== "win32") return;
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], { timeoutMs: 10_000 });
    if (r.code !== 0) return;
    // Keep what the board started with first (npm adds its own bin folders), then anything new.
    const merged = new Set([...(process.env.PATH ?? "").split(";"), ...r.stdout.trim().split(";")].filter(Boolean));
    process.env.PATH = [...merged].join(";");
  },
};

export type BrowserChoice = { browser: "chrome" | "msedge" | "chromium"; path: string };

/** Where Chrome and Edge install themselves, per OS. Chrome first: it is what the MCP server defaults to. */
function browserCandidates(p: Probe): BrowserChoice[] {
  if (p.platform === "win32") {
    const roots = [p.env.PROGRAMFILES, p.env["PROGRAMFILES(X86)"], p.env.LOCALAPPDATA].filter(Boolean) as string[];
    return [
      ...roots.map((r) => ({ browser: "chrome" as const, path: join(r, "Google", "Chrome", "Application", "chrome.exe") })),
      ...roots.map((r) => ({ browser: "msedge" as const, path: join(r, "Microsoft", "Edge", "Application", "msedge.exe") })),
    ];
  }
  if (p.platform === "darwin") {
    return [
      { browser: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { browser: "msedge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ];
  }
  return [
    { browser: "chrome", path: "/opt/google/chrome/chrome" },
    { browser: "msedge", path: "/opt/microsoft/msedge/msedge" },
  ];
}

/** Playwright's own download folder (PLAYWRIGHT_BROWSERS_PATH wins, as in Playwright). */
function playwrightCache(p: Probe): string {
  if (p.env.PLAYWRIGHT_BROWSERS_PATH) return p.env.PLAYWRIGHT_BROWSERS_PATH;
  if (p.platform === "win32") return join(p.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  if (p.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  return join(homedir(), ".cache", "ms-playwright");
}

/** A browser the board's Playwright server can launch: Chrome, then Edge, then a downloaded Chromium. */
export function pickBrowser(p: Probe): BrowserChoice | null {
  const found = browserCandidates(p).find((c) => p.exists(c.path));
  if (found) return found;
  const cache = playwrightCache(p);
  const chromium = p.list(cache).find((n) => /^chromium-\d+$/.test(n));
  return chromium ? { browser: "chromium", path: join(cache, chromium) } : null;
}
```

Covered by Task 3's tests. Typecheck, commit `feat(setup): machine probe`.

### Task 3: Check registry

**Files:** Create `server/src/setup/checks.ts`; add `SetupCheckResult` and two `WsMessage` members to `server/src/types.ts`; tests in `server/test/setup.test.ts`.

- [ ] **Step 1: types.ts** — after `DiffFile`:

```ts
/** One row on the Setup page (server/src/setup). Detected on request, never stored. */
export interface SetupCheckResult {
  id: string;
  title: string;
  level: "required" | "recommended" | "optional" | "info";
  why: string;
  ok: boolean;
  detail: string;
  /** What the page may offer: a built-in command, a supervised Claude session, Claude's own login. */
  fixes: ("run" | "claude" | "login")[];
  /** Fields the built-in fix needs (git name and email). */
  form: { name: string; label: string; placeholder: string }[] | null;
  /** The usual command(s) on this OS, to copy. */
  manual: string | null;
  link: { label: string; href: string } | null;
  running: boolean;
  /** The open "Fix with Claude" task for this check, if any. */
  taskId: string | null;
}
```
and in `WsMessage`:
```ts
  | { type: "setup.updated"; check: SetupCheckResult }
  | { type: "setup.output"; id: string; chunk: string }
```

- [ ] **Step 2: Failing tests** — append to `setup.test.ts` (add imports `buildChecks` from `../src/setup/checks.ts`, `pickBrowser, type Probe, type RunResult` from `../src/setup/probe.ts`, `type Provider` from `../src/types.ts`):

```ts
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

test("the checklist follows what is switched on and set up", () => {
  const repo = new Repo(openDb(":memory:"));
  const ids = () => buildChecks(repo.getSettings()).map((c) => c.id);
  assert.deepEqual(ids(), ["node", "claude-login", "git", "git-identity", "browser", "plugins"]);
  repo.updateSettings({ browserChecks: false });
  assert.ok(!ids().includes("browser"));
  repo.updateSettings({ providers: PROVIDERS });
  assert.deepEqual(ids(), ["node", "claude-login", "git", "git-identity", "ollama", "ollama-model:qwen3-coder", "cli-codex", "key-zai", "plugins"]);
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
```

- [ ] **Step 3:** `npm test` → fails (module missing).
- [ ] **Step 4: Implement `server/src/setup/checks.ts`:**

```ts
import { z } from "zod";
import type { CliPreset, Provider, SetupCheckResult, Settings } from "../types.ts";
import { pickBrowser, type Probe } from "./probe.ts";

export interface CheckCtx {
  probe: Probe;
  settings: Settings;
  hasSecret: (name: string) => boolean;
}

export interface Detected {
  ok: boolean;
  detail: string;
  /** Can't be fixed until this other check passes (identity needs git; models need Ollama). */
  blockedBy?: string;
}

/** A built-in command. The only user values that reach one are validated form fields. */
export interface FixCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface FormField {
  name: string;
  label: string;
  placeholder: string;
  schema: z.ZodType<string>;
}

export interface SetupCheck {
  id: string;
  title: string;
  level: SetupCheckResult["level"];
  why: string;
  detect(ctx: CheckCtx): Promise<Detected>;
  /** One click: the board runs these itself. */
  run?: (input: Record<string, string>) => FixCommand[];
  form?: FormField[];
  /** For a supervised Claude session; checks with only `run` get a generic goal as a fallback. */
  claude?: { goal: string; doneWhen: string };
  /** Claude's own login terminal. */
  login?: true;
  link?: { label: string; href: string };
  manual?: Partial<Record<NodeJS.Platform, string>>;
}

const MIN = 60_000;
const ok = (detail: string): Detected => ({ ok: true, detail });
const bad = (detail: string, blockedBy?: string): Detected => (blockedBy ? { ok: false, detail, blockedBy } : { ok: false, detail });
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";
const everywhere = (cmd: string) => ({ win32: cmd, darwin: cmd, linux: cmd });

async function gitVersion(p: Probe): Promise<string | null> {
  const r = await p.run("git", ["--version"]);
  return r.code === 0 ? firstLine(r.stdout) : null;
}

const node: SetupCheck = {
  id: "node",
  title: "Node.js 24 or newer",
  level: "required",
  why: "The board itself runs on it.",
  async detect() {
    const major = Number(process.versions.node.split(".")[0]);
    return major >= 24 ? ok(`v${process.versions.node}`) : bad(`v${process.versions.node} — the board needs 24 or newer`);
  },
};

const claudeLogin: SetupCheck = {
  id: "claude-login",
  title: "Claude login",
  level: "required",
  why: "Every run uses your Claude subscription (or an API key).",
  login: true,
  async detect({ probe }) {
    if (probe.env.ANTHROPIC_API_KEY) return ok("Using ANTHROPIC_API_KEY");
    const r = await probe.run(probe.claudeBin, ["auth", "status"], { timeoutMs: 15_000 });
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (!j.loggedIn) return bad("Not logged in");
      return ok(`Logged in with ${j.authMethod ?? "Claude"}${j.subscriptionType ? ` (${j.subscriptionType})` : ""}`);
    } catch {
      return bad(firstLine(r.stderr) || "Claude's login check did not answer");
    }
  },
};

const git: SetupCheck = {
  id: "git",
  title: "git",
  level: "required",
  why: "Autonomous runs work in git worktrees, and every change is reviewed as a diff.",
  claude: { goal: "Install git on this computer.", doneWhen: "git --version" },
  manual: { win32: "winget install --id Git.Git -e", darwin: "xcode-select --install", linux: "sudo apt install git" },
  async detect({ probe }) {
    const v = await gitVersion(probe);
    return v ? ok(v) : bad("git is not installed, or not on PATH");
  },
};

const gitIdentity: SetupCheck = {
  id: "git-identity",
  title: "git name and email",
  level: "required",
  why: "Approving a task makes a commit, and git refuses to commit without them.",
  form: [
    { name: "name", label: "Name", placeholder: "Ada Lovelace", schema: z.string().trim().min(1).max(100).regex(/^[^\r\n"]+$/, "No quotes or line breaks") },
    { name: "email", label: "Email", placeholder: "ada@example.com", schema: z.string().trim().max(200).regex(/^[^\s@"]+@[^\s@"]+$/, "Not an email address") },
  ],
  run: (input) => [
    { command: "git", args: ["config", "--global", "user.name", input.name] },
    { command: "git", args: ["config", "--global", "user.email", input.email] },
  ],
  manual: everywhere('git config --global user.name "Your Name"\ngit config --global user.email you@example.com'),
  async detect({ probe }) {
    if (!(await gitVersion(probe))) return bad("Install git first", "git");
    const name = firstLine((await probe.run("git", ["config", "--global", "user.name"])).stdout);
    const email = firstLine((await probe.run("git", ["config", "--global", "user.email"])).stdout);
    if (name && email) return ok(`${name} <${email}>`);
    return bad(`Missing ${[!name && "name", !email && "email"].filter(Boolean).join(" and ")}`);
  },
};

const BROWSER_LABEL = { chrome: "Chrome", msedge: "Edge", chromium: "Playwright Chromium" } as const;
const INSTALL_BROWSER = ["-y", "@playwright/mcp@latest", "install-browser", "chromium"];

const browser: SetupCheck = {
  id: "browser",
  title: "A browser for browser checks",
  level: "recommended",
  why: "Runs open what they built in a headless browser to look at it. Without one they skip that step.",
  // Playwright's own download, matched to the version the board's browser server uses.
  run: () => [{ command: "npx", args: INSTALL_BROWSER, timeoutMs: 10 * MIN }],
  manual: everywhere(`npx ${INSTALL_BROWSER.join(" ")}`),
  async detect({ probe }) {
    const b = pickBrowser(probe);
    return b ? ok(`${BROWSER_LABEL[b.browser]} — ${b.path}`) : bad("No Chrome, Edge or Playwright Chromium found");
  },
};

const isOllama = (p: Provider) => p.kind !== "cli" && (/^ollama/.test(p.id) || /:11434(\/|$)/.test(p.baseUrl ?? ""));
const MODEL_ID = /^[\w.:/-]{1,100}$/;

const ollama = (origin: string): SetupCheck => ({
  id: "ollama",
  title: "Ollama",
  level: "optional",
  why: "An Ollama provider is set up in Settings → Providers; it needs Ollama running on this computer.",
  claude: { goal: "Install Ollama on this computer and start it.", doneWhen: `a request to ${origin}/api/version answers` },
  manual: { win32: "winget install --id Ollama.Ollama -e", darwin: "brew install ollama && ollama serve", linux: "curl -fsSL https://ollama.com/install.sh | sh" },
  link: { label: "ollama.com/download", href: "https://ollama.com/download" },
  async detect({ probe }) {
    try {
      const j = (await probe.fetchJson(`${origin}/api/version`)) as { version?: string };
      return ok(`Ollama ${j.version ?? ""} at ${origin}`.replace("  ", " "));
    } catch {
      return bad(`Nothing answers at ${origin}. Install Ollama, or start it.`);
    }
  },
});

const ollamaModel = (origin: string, model: string): SetupCheck => ({
  id: `ollama-model:${model}`,
  title: `Ollama model ${model}`,
  level: "optional",
  why: "A provider in Settings → Providers lists this model.",
  run: () => [{ command: "ollama", args: ["pull", model], timeoutMs: 60 * MIN }],
  manual: everywhere(`ollama pull ${model}`),
  async detect({ probe }) {
    let tags: { models?: { name: string }[] };
    try {
      tags = (await probe.fetchJson(`${origin}/api/tags`)) as typeof tags;
    } catch {
      return bad("Start Ollama first", "ollama");
    }
    const names = (tags.models ?? []).map((m) => m.name);
    return names.some((n) => n === model || n === `${model}:latest`) ? ok("Pulled") : bad("Not pulled yet");
  },
});

/** The agent CLIs the board can drive, and how each is installed. */
const CLI: Record<Exclude<CliPreset, "custom">, { command: string; pkg?: string; login?: string; url: string }> = {
  codex: { command: "codex", pkg: "@openai/codex", login: "codex login", url: "https://github.com/openai/codex" },
  gemini: { command: "gemini", pkg: "@google/gemini-cli", login: "gemini", url: "https://github.com/google-gemini/gemini-cli" },
  kimi: { command: "kimi", login: "kimi login", url: "https://code.kimi.com" },
  opencode: { command: "opencode", url: "https://opencode.ai" },
};

const cliCheck = (p: Provider, preset: Exclude<CliPreset, "custom">): SetupCheck => {
  const c = CLI[preset];
  return {
    id: `cli-${preset}`,
    title: p.label,
    level: "optional",
    why: `Provider “${p.label}” runs the \`${c.command}\` command.`,
    ...(c.pkg ? { run: () => [{ command: "npm", args: ["install", "-g", c.pkg!], timeoutMs: 10 * MIN }] } : {}),
    claude: { goal: `Install the \`${c.command}\` command-line tool on this computer, following ${c.url}.`, doneWhen: `${c.command} --version` },
    manual: everywhere([c.pkg ? `npm install -g ${c.pkg}` : `See ${c.url}`, c.login ? `${c.login}   # then log in once` : ""].filter(Boolean).join("\n")),
    link: { label: c.url.replace(/^https:\/\//, ""), href: c.url },
    async detect({ probe }) {
      const r = await probe.run(c.command, ["--version"], { timeoutMs: 10_000 });
      return r.code === 0 ? ok(firstLine(r.stdout) || "Installed") : bad(`\`${c.command}\` is not installed, or not on PATH`);
    },
  };
};

const keyCheck = (p: Provider): SetupCheck => ({
  id: `key-${p.id}`,
  title: `${p.label} key`,
  level: "optional",
  why: `Provider “${p.label}” needs ${p.authRef}.`,
  link: { label: "Settings → Providers", href: "#/settings" },
  async detect({ hasSecret }) {
    return hasSecret(p.authRef) ? ok("Key is set") : bad("No key yet");
  },
});

const plugins: SetupCheck = {
  id: "plugins",
  title: "Plugins and skills",
  level: "info",
  why: "No board feature needs a plugin. Runs load the ones you enabled in Claude Code.",
  link: { label: "Open Skills", href: "#/skills" },
  async detect({ settings }) {
    return ok(settings.loadUserPlugins ? "Runs load your Claude Code plugins" : "Runs load no global plugins (Settings → Runs & limits)");
  },
};

/** The checks that apply right now: always the core, then only what your settings switch on. */
export function buildChecks(settings: Settings): SetupCheck[] {
  const list: SetupCheck[] = [node, claudeLogin, git, gitIdentity];
  if (settings.browserChecks) list.push(browser);
  const enabled = settings.providers.filter((p) => p.enabled);
  const local = enabled.filter(isOllama);
  if (local.length) {
    // One Ollama per machine in practice; the first one's address is the one checked.
    const origin = new URL(local[0].baseUrl!).origin;
    list.push(ollama(origin));
    const models = [...new Set(local.flatMap((p) => p.models.map((m) => m.id)))].filter((m) => MODEL_ID.test(m));
    for (const m of models) list.push(ollamaModel(origin, m));
  }
  const presets = new Set<string>();
  for (const p of enabled) {
    const preset = p.kind === "cli" ? p.cli?.preset : undefined;
    if (preset && preset !== "custom" && !presets.has(preset)) {
      presets.add(preset);
      list.push(cliCheck(p, preset));
    }
  }
  for (const p of enabled) if (p.kind !== "cli" && p.authRef && !isOllama(p)) list.push(keyCheck(p));
  list.push(plugins);
  return list;
}
```

- [ ] **Step 5:** `npm test` → passes; `npm run typecheck -w server`. Commit `feat(setup): check registry`.

### Task 4: SetupService, routes, bus

**Files:** Create `server/src/setup/service.ts`, `server/src/routes/setup.ts`; modify `server/src/app.ts`. Tests appended to `setup.test.ts`.

- [ ] **Step 1: Failing test** (imports: `SetupService` from `../src/setup/service.ts`, `type WsMessage` from `../src/types.ts`):

```ts
test("setup routes: summary, validation, one-click fix, Claude session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksetup-r-"));
  const f = fake();
  const repo = new Repo(openDb(":memory:"));
  repo.updateSettings({ browserChecks: false });
  const bus = new Bus();
  const runner = new TaskRunner({ repo, bus, queryFn: done });
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
    await until(() => repo.getTask(t.id)!.status === "review", 8000);
    await until(() => events.some((m) => m.type === "setup.updated" && m.check.id === "git" && m.check.ok));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2:** `npm test` → fails.
- [ ] **Step 3: `server/src/setup/service.ts`:**

```ts
import type { Bus } from "../bus.ts";
import type { Repo } from "../repo.ts";
import { ConflictError, NotFoundError, type TaskRunner } from "../engine/runner.ts";
import type { SetupCheckResult, Task } from "../types.ts";
import { buildChecks, type CheckCtx, type Detected, type SetupCheck } from "./checks.ts";
import { realProbe, type Probe } from "./probe.ts";

const LABEL = "setup:";
const CLOSED: Task["status"][] = ["done", "failed"];
const OS_NAME: Partial<Record<NodeJS.Platform, string>> = { win32: "Windows (PowerShell available; winget is the usual installer)", darwin: "macOS (Homebrew if installed)", linux: "Linux" };

/** The task a supervised Claude session works from. */
export function setupSpec(c: SetupCheck, d: Detected, platform: NodeJS.Platform): string {
  const goal = c.claude?.goal ?? `Make this setup check pass: ${c.title}.`;
  const usual = c.manual?.[platform] ?? c.run?.({}).map((x) => [x.command, ...x.args].join(" ")).join("\n");
  const doneWhen = c.claude?.doneWhen ?? "the check's own command";
  return [
    `## Goal\n\n${goal}`,
    `## This computer\n\n- OS: ${OS_NAME[platform] ?? platform}\n- What the board found: ${d.detail}`,
    usual ? `## The usual way\n\n\`\`\`\n${usual}\n\`\`\`` : "",
    "## Rules\n\n" +
      "- Install only this. Change nothing else on the computer.\n" +
      "- Prefer the OS package manager (winget on Windows, Homebrew on macOS, the distribution's on Linux).\n" +
      "- If it needs administrator rights, a restart, or a download you are unsure about, say so and stop.\n" +
      `- Finish by checking that ${doneWhen} works, and report what it printed.`,
  ].filter(Boolean).join("\n\n");
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`No answer after ${ms / 1000}s`)), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Detects what this machine has, runs the built-in fixes, and hands the rest to a supervised Claude
 * session. Results are cached briefly and never stored: the machine is the source of truth.
 */
export class SetupService {
  readonly probe: Probe;
  private cache = new Map<string, { at: number; d: Detected }>();
  private running = new Set<string>();

  constructor(private readonly deps: { repo: Repo; bus: Bus; runner: TaskRunner; stateDir: string; probe?: Probe }) {
    this.probe = deps.probe ?? realProbe;
    // A Claude session that stops (for review, done or failed) may have installed something: look again.
    deps.bus.subscribe((m) => {
      if (m.type !== "task.updated") return;
      const id = m.task.labels.find((l) => l.startsWith(LABEL))?.slice(LABEL.length);
      if (!id || !["review", "done", "failed"].includes(m.task.status)) return;
      void this.probe.refreshPath().then(() => this.recheck(id)).catch(() => {});
    });
  }

  private ctx(): CheckCtx {
    return { probe: this.probe, settings: this.deps.repo.getSettings(), hasSecret: (n) => this.deps.runner.secrets.has(n) };
  }

  private find(id: string): SetupCheck {
    const c = buildChecks(this.deps.repo.getSettings()).find((x) => x.id === id);
    if (!c) throw new NotFoundError(`No setup check "${id}".`);
    return c;
  }

  private async detect(c: SetupCheck, fresh: boolean): Promise<Detected> {
    const hit = this.cache.get(c.id);
    if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.d;
    let d: Detected;
    try {
      d = await withTimeout(c.detect(this.ctx()), 20_000);
    } catch (e) {
      d = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    this.cache.set(c.id, { at: Date.now(), d });
    return d;
  }

  /** Claude can take on anything the board cannot do itself, except what Claude needs to run, and your own name. */
  private claudeCan(c: SetupCheck): boolean {
    return c.id !== "node" && !c.login && !c.form && Boolean(c.claude || c.run);
  }

  private openTask(id: string): Task | undefined {
    const p = this.deps.repo.findSetupProject();
    if (!p) return undefined;
    return this.deps.repo.listTasks({ project_id: p.id }).filter((t) => t.labels.includes(LABEL + id) && !CLOSED.includes(t.status)).at(-1);
  }

  private result(c: SetupCheck, d: Detected): SetupCheckResult {
    const fixes: SetupCheckResult["fixes"] = [];
    if (!d.ok && !d.blockedBy) {
      if (c.login) fixes.push("login");
      if (c.run) fixes.push("run");
      if (this.claudeCan(c)) fixes.push("claude");
    }
    return {
      id: c.id,
      title: c.title,
      level: c.level,
      why: c.why,
      ok: d.ok,
      detail: d.detail,
      fixes,
      form: c.form ? c.form.map(({ name, label, placeholder }) => ({ name, label, placeholder })) : null,
      manual: c.manual?.[this.probe.platform] ?? null,
      link: c.link ?? null,
      running: this.running.has(c.id),
      taskId: this.openTask(c.id)?.id ?? null,
    };
  }

  async all(fresh = false): Promise<SetupCheckResult[]> {
    const checks = buildChecks(this.deps.repo.getSettings());
    return Promise.all(checks.map(async (c) => this.result(c, await this.detect(c, fresh))));
  }

  async recheck(id: string): Promise<SetupCheckResult> {
    const c = this.find(id);
    const r = this.result(c, await this.detect(c, true));
    this.deps.bus.publish({ type: "setup.updated", check: r });
    return r;
  }

  /** Starts a built-in fix. Returns once it is running; output and the new result arrive over the bus. */
  startRun(id: string, input: Record<string, string>): void {
    const c = this.find(id);
    if (!c.run) throw new ConflictError(`${c.title} has no one-click fix.`);
    if (this.running.has(id)) throw new ConflictError(`${c.title} is already being fixed.`);
    const clean: Record<string, string> = {};
    for (const f of c.form ?? []) clean[f.name] = f.schema.parse(input[f.name] ?? ""); // ZodError → 400
    const commands = c.run(clean);
    this.running.add(id);
    const out = (chunk: string) => this.deps.bus.publish({ type: "setup.output", id, chunk });
    void (async () => {
      try {
        for (const cmd of commands) {
          out(`$ ${[cmd.command, ...cmd.args].join(" ")}\n`);
          const code = await this.probe.stream(cmd.command, cmd.args, { timeoutMs: cmd.timeoutMs ?? 2 * 60_000 }, out);
          if (code !== 0) {
            out(`\n[exited with ${code ?? "an error: the program could not start"}]\n`);
            break;
          }
        }
      } finally {
        this.running.delete(id);
        await this.probe.refreshPath().catch(() => {});
        await this.recheck(id).catch(() => {});
      }
    })();
  }

  /** Hands the fix to a supervised Claude session: every command it wants to run is an approval card. */
  async startClaude(id: string): Promise<Task> {
    const c = this.find(id);
    if (!this.claudeCan(c)) throw new ConflictError(`${c.title} can't be fixed by Claude from here.`);
    const open = this.openTask(id);
    if (open) return open;
    const d = await this.detect(c, true);
    if (d.ok) throw new ConflictError(`${c.title} is already fine.`);
    const { repo, bus, runner, stateDir } = this.deps;
    const project = repo.setupProject(stateDir);
    const settings = repo.getSettings();
    const task = repo.createTask({
      project_id: project.id,
      title: `Set up ${c.title}`,
      spec_md: setupSpec(c, d, this.probe.platform),
      type: "chore",
      mode: "supervised",
      labels: [LABEL + id],
      // It runs installers, which only a real Claude Code session can: always Claude, like /init.
      pipeline: [{ stage: "custom", model: settings.tiers.balanced.provider === "anthropic" ? settings.tiers.balanced.model : "claude-sonnet-5", effort: "medium", prompt: "Do the task below. Every command you run is shown to the user for approval first." }],
    });
    bus.publish({ type: "task.updated", task });
    runner.queueTask(task.id);
    return repo.getTask(task.id)!;
  }
}
```

- [ ] **Step 4: `server/src/routes/setup.ts`:**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SetupService } from "../setup/service.ts";

const fixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), input: z.record(z.string(), z.string()).default({}) }),
  z.object({ kind: z.literal("claude") }),
]);

export async function setupRoutes(app: FastifyInstance, setup: SetupService) {
  app.get("/setup", async (req) => {
    const checks = await setup.all((req.query as { fresh?: string }).fresh === "1");
    const failing = (level: string) => checks.filter((c) => !c.ok && c.level === level).length;
    return { checks, summary: { required: failing("required"), recommended: failing("recommended") } };
  });

  app.post("/setup/:id/check", async (req) => setup.recheck((req.params as { id: string }).id));

  app.post("/setup/:id/fix", async (req) => {
    const { id } = req.params as { id: string };
    const body = fixSchema.parse(req.body ?? {});
    if (body.kind === "claude") return { task: await setup.startClaude(id) };
    setup.startRun(id, body.input);
    return { started: true };
  });
}
```

- [ ] **Step 5: `app.ts`:** import `setupRoutes`, `SetupService`, `STATE_DIR`; add `setup?: SetupService` to `AppDeps`; inside `buildApp` before the api register: `const setup = deps.setup ?? new SetupService({ repo: deps.repo, bus: deps.bus, runner: deps.runner, stateDir: join(STATE_DIR, "setup") });` and `await setupRoutes(api, setup);`. (Import `join` from `node:path`.) In the test, `stateDir: dir` is passed directly — the service uses it as the project folder as given.
- [ ] **Step 6:** `npm test` → passes; typecheck. Commit `feat(setup): service and routes`.

### Task 5: Login through the bundled binary, browser choice, git message

**Files:** Modify `server/src/routes/health.ts`, `server/src/engine/browser.ts`, `server/src/engine/runner.ts`.

- [ ] **health.ts:** replace the `claude()` helper body with `realProbe.run(realProbe.claudeBin, args, { timeoutMs: 15_000 }).then((r) => ({ code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr }))`, drop the now-unused `execFile` import only if unused (the login terminal still uses it). Replace `openLoginTerminal`:

```ts
/** Opens a real terminal running Claude's login (it needs a TTY). The binary is the SDK's own when there is one. */
function openLoginTerminal(): void {
  const bin = realProbe.claudeBin;
  if (process.platform === "win32") {
    // cmd's own quoting: outer quotes wrap the /k command, inner ones the path (which may have spaces).
    // Verbatim, because Node's escaping of embedded quotes is not what cmd expects.
    execFile("cmd.exe", ["/c", `start "Claude login" cmd /k ""${bin}" auth login"`], { windowsHide: false, windowsVerbatimArguments: true }, () => {});
    return;
  }
  const cmd = `'${bin.replace(/'/g, `'\\''`)}' auth login`;
  const term = process.platform === "darwin"
    ? ["osascript", ["-e", `tell app "Terminal" to do script "${cmd.replace(/["\\]/g, "\\$&")}"`]]
    : ["x-terminal-emulator", ["-e", cmd]];
  execFile(term[0] as string, term[1] as string[], () => {});
}
```
- [ ] **browser.ts:** `export function browserServer(outputDir: string, browser?: "chrome" | "msedge" | "chromium")` with args `["-y", "@playwright/mcp@latest", "--headless", "--isolated", ...(browser ? ["--browser", browser] : []), "--output-dir", outputDir]`.
- [ ] **runner.ts:** import `{ pickBrowser, realProbe } from "../setup/probe.ts"`; the MCP entry becomes `browserServer(browserDir, pickBrowser(realProbe)?.browser)` (checked per stage, so a browser installed from Setup is used at once). In `ensureCwd`, replace the throw:

```ts
    if (!(await this.git.isGitRepo(project.path))) {
      const installed = (await realProbe.run("git", ["--version"])).code === 0;
      throw new PolicyError(installed ? `Autonomous mode needs a git repository; ${project.path} is not one.` : "Autonomous mode needs git, and git is not installed on this computer. Open Setup to install it.");
    }
```
- [ ] **Manual check:** from the server dir, `node -e` launching `npx -y @playwright/mcp@latest --headless --isolated --browser msedge` is exercised in Task 7's browser check instead (session-tools shows `playwright` connected). Run `npm test`, typecheck. Commit `feat(setup): bundled login, browser choice, clearer git error`.

### Task 6: Web

**Files:** Modify `web/src/lib/api.ts`, `web/src/lib/router.ts`, `web/src/App.tsx`; create `web/src/views/Setup.tsx`.

- [ ] **api.ts:** add `SetupCheckResult` to the server type import and re-export; add
```ts
export type SetupReport = { checks: SetupCheckResult[]; summary: { required: number; recommended: number } };
```
and methods:
```ts
  setup: (fresh = false) => req<SetupReport>("GET", `/setup${fresh ? "?fresh=1" : ""}`),
  recheckSetup: (id: string) => req<SetupCheckResult>("POST", `/setup/${encodeURIComponent(id)}/check`, {}),
  fixSetup: (id: string, body: { kind: "run"; input?: Record<string, string> } | { kind: "claude" }) =>
    req<{ started?: boolean; task?: Task }>("POST", `/setup/${encodeURIComponent(id)}/fix`, body),
```
- [ ] **router.ts:** add `"setup"` to `View` and `VIEWS`.
- [ ] **Setup.tsx:**

```tsx
import { useEffect, useState, type ReactNode } from "react";
import { api, type SetupCheckResult } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useWs } from "../lib/ws.ts";
import { enableNotifications, notifyState } from "../lib/notify.ts";
import { Button, ErrorLine, inputCls, useAction } from "../components/ui.tsx";

const GROUPS = [
  { level: "required", title: "Required", hint: "The board does not work without these." },
  { level: "recommended", title: "Recommended", hint: "Features that are on by default use these." },
  { level: "optional", title: "Optional", hint: "Only for what you have set up." },
  { level: "info", title: "Good to know", hint: "" },
] as const;

/** Required + recommended items still failing, for the nav badge. */
export function useSetupCount(): number {
  const [n, setN] = useState(0);
  const load = () => void api.setup().then((r) => setN(r.summary.required + r.summary.recommended), () => {});
  useEffect(load, []);
  useWs((m) => {
    if (m.type === "setup.updated" || m.type === "health.updated" || m.type === "settings.updated") load();
  });
  return n;
}

function Shell({ ok, level, title, detail, why, actions, children }: { ok: boolean; level: string; title: string; detail: string; why: string; actions?: ReactNode; children?: ReactNode }) {
  const dot = ok ? "bg-moss" : level === "required" ? "bg-rust" : level === "recommended" ? "bg-amber" : "bg-ink-500";
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/60 p-3">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-ink-100">{title}</span>
            <span className={`break-all font-mono text-[11px] ${ok ? "text-moss" : "text-ink-400"}`}>{detail}</span>
          </div>
          <p className="mt-0.5 text-[12px] text-ink-500">{why}</p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap justify-end gap-1.5">{actions}</div> : null}
      </div>
      {children ? <div className="mt-2.5 space-y-2 pl-5">{children}</div> : null}
    </div>
  );
}

function Row({ c, output, onChange }: { c: SetupCheckResult; output?: string; onChange: (c: SetupCheckResult) => void }) {
  const { busy, error, run } = useAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const external = (href: string) => /^https?:/.test(href);
  const filled = (c.form ?? []).every((f) => form[f.name]?.trim());
  const actions = (
    <>
      {c.fixes.includes("login") ? (
        <Button size="sm" variant="primary" busy={loggingIn && !c.ok} onClick={() => run(async () => { setLoggingIn(true); await api.login(); })}>
          {loggingIn ? "Waiting for login…" : "Log in to Claude"}
        </Button>
      ) : null}
      {c.fixes.includes("run") ? (
        <Button size="sm" variant="primary" busy={c.running} disabled={!filled} onClick={() => run(() => api.fixSetup(c.id, { kind: "run", input: form }))}>
          {c.form ? "Save" : "Install"}
        </Button>
      ) : null}
      {c.fixes.includes("claude") && !c.taskId ? (
        <Button size="sm" variant={c.fixes.includes("run") ? "outline" : "primary"} onClick={() => run(async () => {
          const r = await api.fixSetup(c.id, { kind: "claude" });
          if (r.task) navigate({ taskId: r.task.id });
        })}>
          Fix with Claude
        </Button>
      ) : null}
      {c.link && !c.ok ? (
        <a className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-ink-300 hover:text-amber" href={c.link.href} target={external(c.link.href) ? "_blank" : undefined} rel="noreferrer">
          {c.link.label}
        </a>
      ) : null}
      <Button size="sm" variant="ghost" busy={busy} onClick={() => run(async () => onChange(await api.recheckSetup(c.id)))}>Re-check</Button>
    </>
  );
  return (
    <Shell ok={c.ok} level={c.level} title={c.title} detail={c.detail} why={c.why} actions={actions}>
      {!c.ok && c.form && c.fixes.includes("run") ? (
        <div className="grid gap-2 md:grid-cols-2">
          {c.form.map((f) => (
            <input key={f.name} className={inputCls} placeholder={`${f.label} — ${f.placeholder}`} value={form[f.name] ?? ""} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
          ))}
        </div>
      ) : null}
      {!c.ok && c.manual ? (
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11.5px] text-ink-200">{c.manual}</pre>
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(c.manual!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
      {output ? <pre className="max-h-48 overflow-auto rounded border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11px] text-ink-300">{output}</pre> : null}
      {c.taskId ? (
        <button className="cursor-pointer text-[12px] text-cyan underline underline-offset-2" onClick={() => navigate({ taskId: c.taskId })}>
          Claude is working on it — open the session (approve its commands there)
        </button>
      ) : null}
      <ErrorLine error={error} />
    </Shell>
  );
}

/** The browser's permission, not the machine's: checked and asked for right here. */
function NotificationsRow() {
  const [state, setState] = useState(notifyState());
  return (
    <Shell
      ok={state === "on"}
      level="optional"
      title="Desktop notifications"
      detail={state === "on" ? "On" : state === "unsupported" ? "Not supported in this browser" : "Off"}
      why="A pop-up when a run needs you or a task finishes, while the board is in the background."
      actions={state === "off" ? <Button size="sm" variant="primary" onClick={() => void enableNotifications().then(() => setState(notifyState()))}>Turn on</Button> : undefined}
    />
  );
}

export function Setup() {
  const [checks, setChecks] = useState<SetupCheckResult[] | null>(null);
  const [out, setOut] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const load = (fresh = false) => {
    setBusy(true);
    void api.setup(fresh).then((r) => setChecks(r.checks), () => setChecks([])).finally(() => setBusy(false));
  };
  useEffect(() => load(true), []);
  useWs((m) => {
    if (m.type === "setup.updated") setChecks((cs) => cs?.map((c) => (c.id === m.check.id ? m.check : c)) ?? cs);
    if (m.type === "setup.output") setOut((o) => ({ ...o, [m.id]: ((o[m.id] ?? "") + m.chunk).slice(-20_000) }));
    if (m.type === "health.updated" || m.type === "settings.updated") load();
  });
  const put = (c: SetupCheckResult) => setChecks((cs) => cs?.map((x) => (x.id === c.id ? c : x)) ?? cs);
  const failing = (checks ?? []).filter((c) => !c.ok && (c.level === "required" || c.level === "recommended")).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <h1 className="text-[17px] font-semibold text-ink-100">Setup</h1>
            <p className="mt-1 text-[12.5px] text-ink-400">
              {checks === null ? "Looking at this computer…" : failing ? `${failing} thing${failing > 1 ? "s" : ""} to fix. Install does it in one click; Fix with Claude asks before every command.` : "Everything the board needs is here."}
            </p>
          </div>
          <Button size="sm" busy={busy} onClick={() => load(true)}>Re-check all</Button>
        </div>
        {GROUPS.map((g) => {
          const rows = (checks ?? []).filter((c) => c.level === g.level);
          if (!rows.length && g.level !== "optional") return null;
          return (
            <section key={g.level} className="space-y-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{g.title}</div>
                {g.hint ? <div className="text-[11.5px] text-ink-500">{g.hint}</div> : null}
              </div>
              {rows.map((c) => <Row key={c.id} c={c} output={out[c.id]} onChange={put} />)}
              {g.level === "optional" ? <NotificationsRow /> : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **App.tsx:**
  - Remove `LoginBanner` (component and `<LoginBanner />`), and the imports only it used (`CliHealth`, and `api` if unused afterwards — the first-launch effect below uses `api`).
  - Import `{ Setup, useSetupCount } from "./views/Setup.tsx"`.
  - `NAV`: append `{ view: "setup", label: "Setup", key: "8" }`.
  - In `App`: `const setupCount = useSetupCount();` and a first-launch effect:
```tsx
  // First launch (no route yet) with something required missing: start on Setup, not an empty board.
  useEffect(() => {
    if (location.hash.replace(/^#\/?/, "")) return;
    void api.setup().then((r) => { if (r.summary.required) navigate({ view: "setup" }); }, () => {});
  }, []);
```
  - Nav badge: in the NAV render, before the approvals branch, `n.view === "setup" && setupCount ? <span className="ml-1.5 rounded-full bg-amber px-1.5 font-mono text-[10px] text-ink-950">{setupCount}</span> :` …
  - `main`: add `route.view === "setup" ? <Setup /> :` before the `settings` branch.
- [ ] `npm run typecheck`, `npm run build`. Commit `feat(setup): Setup page, nav badge, first-launch landing`.

### Task 7: Docs and verification

- [ ] **README.md** Requirements: add after the Node/git/CLI sentence: "Missing something? Open **Setup** (it opens by itself on first launch while something required is missing): it checks this computer and installs what it can in one click, or hands the rest to a supervised Claude session." Replace "logged-in Claude Code CLI" wording to note the SDK's bundled Claude is used for login, so a separate install is optional. Add a `### Setup` section describing the groups, the three fix kinds, and that "Fix with Claude" runs in a hidden Setup project where every command is an approval card.
- [ ] **docs/DECISIONS.md:** new section `## Setup checklist (2026-09-12)` with D166–D171:
  - D166 One registry of checks built from current settings; results detected on request (10 s cache), never stored — the machine is the source of truth.
  - D167 One-click fixes are built-in argv only; the only user values (git name/email, Ollama model ids from settings) are validated; git and anything taking a user value never goes through a shell.
  - D168 "Fix with Claude" is a supervised task in a hidden system project (`projects.system`), pinned to Claude; every command is an approval card; one open session per check; the check re-runs when it stops.
  - D169 Login and status use the SDK's bundled Claude binary; a global Claude Code install is optional. `ANTHROPIC_API_KEY` counts as logged in.
  - D170 Browser checks launch Chrome, else Edge, else Playwright's Chromium; the board passes `--browser`, and installs Chromium with `@playwright/mcp install-browser` so the version matches. Edge ships with Windows, so most Windows machines need nothing.
  - D171 On Windows the server re-reads PATH from the registry after every fix, so a program just installed works without restarting the board.
- [ ] `npm test`, `npm run typecheck`, `npm run build` — all pass.
- [ ] Browser check: start the board on port 4311 with a scratch `KANBAN_STATE_DIR` (background `npm start`), open it, confirm: first launch with an empty hash lands on Setup only if something required fails; rows render per group with correct buttons; git identity form validates; Settings → Browser & plugins shows `playwright` connected with Edge. No console errors. Stop the server by PID.
- [ ] Commit `docs(setup): README and decisions`.
