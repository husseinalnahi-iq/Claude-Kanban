import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellFor, TerminalManager } from "../src/terminal.ts";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";

/** A tiny "shell": prints a prompt, answers each line in capitals. Same on every OS. */
const FAKE_SHELL = {
  command: process.execPath,
  args: ["-e", "process.stdout.write('$ ');process.stdin.on('data',d=>process.stdout.write(String(d).trim().toUpperCase()+'\\n$ '))"],
};

/** Windows keeps a dead shell's folder busy for a moment: never fail a test on cleanup. */
const tidy = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // left for the OS temp cleaner
  }
};

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the shell: PowerShell 7 if installed, else Windows PowerShell; elsewhere your login shell", () => {
  const pf = "C:\\Program Files";
  assert.equal(shellFor("win32", { ProgramFiles: pf }, (p) => p === join(pf, "PowerShell", "7", "pwsh.exe")).command, join(pf, "PowerShell", "7", "pwsh.exe"));
  const winPs = shellFor("win32", { ProgramFiles: pf }, () => false);
  assert.equal(winPs.command, "powershell.exe");
  const args = winPs.args.join(" ");
  assert.match(args, /-ExecutionPolicy RemoteSigned/, "npm and npx (scripts on Windows) run, for this shell only");
  assert.match(args, /UTF8Encoding/, "accented letters and symbols display correctly");
  assert.deepEqual(shellFor("darwin", { SHELL: "/bin/zsh" }), { command: "/bin/zsh", args: ["-l"] });
});

test("basic mode: typing is echoed, Enter runs the line, the scrollback replays for a second viewer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kterm-"));
  const t = new TerminalManager({ forceBasic: true, shell: FAKE_SHELL });
  try {
    const info = await t.create({ project_id: "p", cwd: dir, title: "demo" });
    assert.equal(info.mode, "basic");
    let seen = "";
    const a = t.attach(info.id, (d) => (seen += d), () => {})!;
    t.write(info.id, "helo\x7flo\r");
    await until(() => seen.includes("HELLO"));
    assert.ok(seen.includes("helo\b \blo"), "the typo is echoed, then Backspace erases it on screen");
    const b = t.attach(info.id, () => {}, () => {})!;
    assert.ok(b.replay.includes("HELLO"), "a panel opened later sees what already happened");
    a.detach();
    b.detach();
    assert.equal(t.kill(info.id), true);
    assert.equal(t.list().length, 0);
  } finally {
    t.killAll();
    tidy(dir);
  }
});

test("full mode runs in a real terminal when node-pty is installed", async (tt) => {
  const t = new TerminalManager({ shell: FAKE_SHELL });
  if (!(await t.fullMode())) return tt.skip("node-pty is not installed here");
  const dir = mkdtempSync(join(tmpdir(), "kterm-"));
  try {
    const info = await t.create({ project_id: "p", cwd: dir, title: "demo", cols: 80, rows: 20 });
    assert.equal(info.mode, "full");
    let seen = "";
    t.attach(info.id, (d) => (seen += d), () => {});
    t.write(info.id, "pty works\r");
    await until(() => seen.includes("PTY WORKS"));
    t.resize(info.id, 120, 30);
  } finally {
    t.killAll();
    tidy(dir);
  }
});

test("API: a terminal opens only in a registered project (or its task), never anywhere else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kterm-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const terminals = new TerminalManager({ forceBasic: true, shell: FAKE_SHELL });
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus }), terminals, allowedHosts: ["localhost:80"] });
  try {
    const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
    const other = repo.createProject({ name: "other", path: dir + "-x", policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
    const foreign = repo.createTask({ project_id: other.id, title: "not here" });

    const ok = await app.inject({ method: "POST", url: "/api/terminals", payload: { project_id: project.id } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().cwd, dir);
    assert.equal((await app.inject({ method: "POST", url: "/api/terminals", payload: { project_id: "nope" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/terminals", payload: { project_id: project.id, task_id: foreign.id } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/terminals" })).json().length, 1);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/terminals/${ok.json().id}` })).json().ok, true);
    const cross = await app.inject({ method: "GET", url: "/api/terminals", headers: { origin: "http://evil.example" } });
    assert.equal(cross.statusCode, 403, "another website cannot reach it");
  } finally {
    await app.close();
    tidy(dir);
  }
});
