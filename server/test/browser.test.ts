import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { freePort, listenersOn, stopListeners } from "../src/git/bootstrap.ts";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { browserDecision, confineOutput, isLocalUrl, PLAYWRIGHT_PLUGIN_TOOLS } from "../src/engine/browser.ts";
import { killsByName, serverRule } from "../src/engine/gate.ts";
import { buildStagePrompt, type PromptCtx } from "../src/engine/prompts.ts";
import type { Mode, Stage } from "../src/types.ts";

const PW = "mcp__playwright__";
const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];

async function until(cond: () => boolean, ms = 6000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kbrowser-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** Runs one stage with a fake session and returns the options it was started with. */
async function optionsFor(mode: Mode, settings: Record<string, unknown>, probe?: (o: Options, repo: Repo, taskId: string) => Promise<void>) {
  const dir = gitRepo();
  const seen: Options[] = [];
  const q: QueryFn = (params) =>
    (async function* () {
      seen.push(params.options);
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      await probe?.(params.options, repo, task.id);
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as never;
    })();
  const repo = new Repo(openDb(":memory:"));
  repo.updateSettings(settings as never);
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q });
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  const task = repo.createTask({ project_id: project.id, title: "page", mode, pipeline: ONE_STAGE });
  try {
    runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(repo.getTask(task.id)!.status));
    assert.equal(repo.getTask(task.id)!.error, null);
    return { options: seen[0], repo, task };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("only this machine and the task's own files count as local", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kurl-"));
  try {
    for (const u of ["http://localhost:5173/", "https://localhost/x", "http://127.0.0.1:8080", "http://[::1]:3000/", "http://app.localhost/", "http://0.0.0.0:4000", "about:blank", pathToFileURL(join(cwd, "out", "index.html")).href]) {
      assert.ok(isLocalUrl(u, cwd), `local: ${u}`);
    }
    for (const u of ["https://example.com", "http://localhost.evil.com/", "http://192.168.1.10/", "http://127.0.0.1.nip.io/", pathToFileURL(join(tmpdir(), "elsewhere.html")).href, "javascript:alert(1)", "chrome://settings", "not a url"]) {
      assert.equal(isLocalUrl(u, cwd), false, `not local: ${u}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("browser tools follow the board's rules: looking is free, acting depends on the mode", () => {
  const cwd = process.cwd();
  const out = join(tmpdir(), "kb-out");
  const d = (tool: string, input: Record<string, unknown>, autonomous: boolean) => browserDecision(tool, input, autonomous, cwd, out)?.behavior;
  const local = { url: "http://localhost:5173" };
  const remote = { url: "https://example.com" };

  // Looking at a local page changes nothing: no card in either mode.
  for (const mode of [true, false]) {
    assert.equal(d(`${PW}browser_navigate`, local, mode), "allow");
    assert.equal(d(`${PW}browser_take_screenshot`, {}, mode), "allow");
    assert.equal(d(`${PW}browser_snapshot`, {}, mode), "allow");
    assert.equal(d(`${PW}browser_console_messages`, {}, mode), "allow");
  }
  // Somewhere else: an unattended run is refused; a supervised one asks you.
  assert.equal(d(`${PW}browser_navigate`, remote, true), "deny");
  assert.equal(d(`${PW}browser_navigate`, remote, false), "ask");
  assert.equal(d(`${PW}browser_tabs`, { action: "new", url: "https://example.com" }, true), "deny", "any tool carrying a URL is checked, not just navigate");
  // Using the page: fine unattended on a local page, a card in a supervised task.
  assert.equal(d(`${PW}browser_click`, { ref: "e1" }, true), "allow");
  assert.equal(d(`${PW}browser_click`, { ref: "e1" }, false), "ask");
  // Tools that can reach beyond the page are never automatic.
  assert.equal(d(`${PW}browser_run_code_unsafe`, { code: "x" }, true), "deny");
  assert.equal(d(`${PW}browser_file_upload`, { paths: ["C:/secret"] }, true), "deny");
  assert.equal(d(`${PW}browser_something_new`, {}, true), "deny", "a tool a later version adds is not trusted by default");
  assert.equal(d(`${PW}browser_run_code_unsafe`, { code: "x" }, false), "ask");
  // Your own signed-in Chrome: never unattended, every call approved otherwise.
  assert.equal(d("mcp__claude-in-chrome__computer", { action: "screenshot" }, true), "deny");
  assert.equal(d("mcp__claude-in-chrome__computer", { action: "screenshot" }, false), "ask");
  // Not a browser tool at all: left to the normal rules.
  assert.equal(browserDecision("Bash", { command: "ls" }, true, cwd, out), null);
  assert.equal(browserDecision(`${PLAYWRIGHT_PLUGIN_TOOLS}__browser_click`, {}, true, cwd, out), null);
});

test("browser output never lands in the project, and screenshots come back as images", () => {
  // Seen in a real run: filename "header.png" put the file in the worktree and returned no image.
  const out = join(tmpdir(), "kb-out");
  assert.deepEqual(confineOutput("browser_take_screenshot", { filename: "header.png", type: "png" }, out), { type: "png" });
  assert.deepEqual(confineOutput("browser_snapshot", { filename: "../../page.md" }, out), { filename: join(out, "page.md") });
  assert.deepEqual(confineOutput("browser_click", { ref: "e1" }, out), { ref: "e1" }, "tools without a file name are untouched");
  const d = browserDecision(`${PW}browser_take_screenshot`, { filename: "C:\\repo\\shot.png" }, true, process.cwd(), out);
  assert.deepEqual(d, { behavior: "allow", input: {} }, "the rewrite is what the tool actually receives");
});

test("killing processes by name is refused outright; killing your own PID is fine", () => {
  // The exact command a real run used to "stop the dev server" — it killed every Node process, the board included.
  for (const c of [
    'cd "C:\\x" && rm -f header.png; taskkill //F //IM node.exe 2>/dev/null; echo done',
    "taskkill /F /IM node.exe", 'taskkill /f /fi "IMAGENAME eq node.exe"', "pkill node", 'pkill -f "node server.js"', "killall node",
    "Stop-Process -Name node -Force", "Get-Process node | Stop-Process", 'wmic process where name="node.exe" delete', "kill -9 -1",
  ]) assert.ok(killsByName(c), `refused: ${c}`);
  for (const c of ["taskkill /PID 1234 /T /F", "kill 1234", "kill -9 1234", "kill %1", "Stop-Process -Id 1234", "npm run build", "node server.js"]) {
    assert.equal(killsByName(c), null, `allowed: ${c}`);
  }
});

test("a kill-by-name command never runs and never becomes a card, even in a supervised task", async () => {
  let decision: { behavior: string; message?: string } | null = null;
  const opts = { signal: new AbortController().signal, toolUseID: "t" } as never;
  await optionsFor("supervised", { browserChecks: true }, async (o, repo, taskId) => {
    decision = (await o.canUseTool!("Bash", { command: "taskkill //F //IM node.exe" }, opts)) as never;
    assert.equal(repo.pendingApprovals(taskId).length, 0);
  });
  assert.equal(decision!.behavior, "deny");
  assert.match(decision!.message ?? "", /kills every process with that name[\s\S]*PID/);
});

test("whatever a stage leaves listening on the task's port is stopped, by PID", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", `require("http").createServer(() => {}).listen(${port}, "127.0.0.1")`], { stdio: "ignore" });
  const exited = new Promise((r) => child.once("exit", r));
  try {
    const t0 = Date.now();
    while (!(await listenersOn(port)).includes(child.pid!)) {
      if (Date.now() - t0 > 8000) throw new Error("server never listened");
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(await stopListeners(port), [child.pid]);
    await exited;
    assert.deepEqual(await listenersOn(port), [], "the port is free again");
    assert.ok((await stopListeners(await freePort())).length === 0, "nothing listening: nothing stopped");
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("a run gets the board's own browser, and never your Chrome unless it is supervised and you allowed it", async () => {
  const on = await optionsFor("autonomous", { browserChecks: true, chromeInSupervised: true });
  const server = on.options.mcpServers?.playwright as { command: string; args: string[] };
  assert.ok(server, "the board's browser is attached");
  for (const flag of ["--headless", "--isolated", "--output-dir"]) assert.ok(server.args.includes(flag), `started with ${flag}`);
  const outDir = server.args[server.args.indexOf("--output-dir") + 1];
  assert.ok(!outDir.includes("kbrowser-"), "page snapshots and logs are written outside the project, so they are never committed");
  assert.ok(on.options.disallowedTools?.includes(PLAYWRIGHT_PLUGIN_TOOLS), "the plugin's shared-profile copy is hidden");
  assert.deepEqual(on.options.extraArgs, { "no-chrome": null }, "an autonomous run never gets Chrome, even with it allowed");

  const supervised = await optionsFor("supervised", { browserChecks: true, chromeInSupervised: true });
  assert.deepEqual(supervised.options.extraArgs, { chrome: null });

  const off = await optionsFor("supervised", { browserChecks: false, chromeInSupervised: false });
  assert.equal(off.options.mcpServers?.playwright, undefined, "switched off: no browser");
  assert.deepEqual(off.options.extraArgs, { "no-chrome": null });
});

test("in a supervised task a screenshot needs no card, but a click does", async () => {
  const decisions: Record<string, string> = {};
  const opts = { signal: new AbortController().signal, toolUseID: "t" } as never;
  await optionsFor("supervised", { browserChecks: true }, async (o, repo, taskId) => {
    decisions.shot = (await o.canUseTool!(`${PW}browser_take_screenshot`, {}, opts))?.behavior ?? "none";
    decisions.nav = (await o.canUseTool!(`${PW}browser_navigate`, { url: "http://127.0.0.1:5173" }, opts))?.behavior ?? "none";
    // The click becomes an approval card; the stage finishing expires it, which is all this needs.
    void o.canUseTool!(`${PW}browser_click`, { ref: "e1", element: "Save" }, opts);
    await until(() => repo.pendingApprovals(taskId).length === 1);
    decisions.card = repo.pendingApprovals(taskId)[0].tool_name;
  });
  assert.equal(decisions.shot, "allow");
  assert.equal(decisions.nav, "allow");
  assert.equal(decisions.card, `${PW}browser_click`);
});

test("code and review stages are asked to look at visible changes; planning is not", () => {
  const ctx = (stage: PromptCtx["stage"], browser: PromptCtx["browser"]): PromptCtx => ({
    stage, mode: "autonomous", task: { id: "t1", title: "Fix the header", spec_md: "" }, siblings: [], skills: [], messages: [], browser,
  });
  const code = buildStagePrompt(ctx("code", { port: 5301, chrome: false }));
  assert.match(code, /## Look at it in a browser/);
  assert.match(code, /port 5301/);
  assert.match(code, /Skip all of this when nothing visible changed/, "a backend change does not pay for screenshots");
  assert.doesNotMatch(code, /Claude in Chrome/);
  assert.match(buildStagePrompt(ctx("review", { port: 5301, chrome: true })), /look at it yourself before your verdict[\s\S]*Claude in Chrome/);
  assert.doesNotMatch(buildStagePrompt(ctx("plan", { port: 5301, chrome: false })), /Look at it in a browser/);
  assert.doesNotMatch(buildStagePrompt(ctx("code", null)), /Look at it in a browser/, "switched off: not mentioned");
});

test("Settings explains how each tool server is treated", () => {
  assert.match(serverRule("mcp__board__"), /always allowed/);
  assert.match(serverRule("mcp__plugin_context7_context7__"), /always allowed/);
  assert.match(serverRule(`${PLAYWRIGHT_PLUGIN_TOOLS}__`), /Hidden/);
  assert.match(serverRule("mcp__claude-in-chrome__"), /supervised runs only/);
  assert.match(serverRule("mcp__claude_ai_Gmail__"), /Autonomous runs: refused\. Supervised runs: an approval card/);
});
