import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { autonomousGate, markitdownRead, serverRule } from "../src/engine/gate.ts";
import { markitdownDir, recommendedChecks, venvPython } from "../src/setup/recommended.ts";
import type { Probe, RunResult } from "../src/setup/probe.ts";
import { MARKITDOWN_TOOL, type Mode, type Stage } from "../src/types.ts";
import { until, removeTemp } from "./helpers.ts";

test("MarkItDown reads web pages and inline data freely, and files only inside the task's folders", () => {
  const cwd = "/work/proj/.kanban/wt/t1";
  const roots = ["/home/me/.claude/skills"];
  assert.deepEqual(markitdownRead({ uri: "https://example.com/a.pdf" }, cwd), { ok: true });
  assert.deepEqual(markitdownRead({ uri: "data:text/plain;base64,aGk=" }, cwd), { ok: true });
  assert.deepEqual(markitdownRead({ uri: "file:///work/proj/.kanban/wt/t1/docs/PO%2042.pdf" }, cwd), { ok: true, path: "/work/proj/.kanban/wt/t1/docs/PO 42.pdf" });
  assert.equal(markitdownRead({ uri: "file:///home/me/.claude/skills/x/ref.pdf" }, cwd, roots).ok, true, "a folder the task may read");
  for (const uri of ["file:///work/proj/.env", "file:///etc/passwd", "file://fileserver/share/secret.xlsx", "ftp://x/y.pdf", "not a uri", ""]) {
    assert.equal(markitdownRead({ uri }, cwd).ok, false, uri);
  }
  const win = "C:\\work\\proj\\.kanban\\wt\\t1";
  assert.equal(markitdownRead({ uri: "file:///C:/work/proj/.kanban/wt/t1/a.docx" }, win).ok, true, "a Windows file URI starts at the drive");
  assert.equal(markitdownRead({ uri: "file:///C:/Users/me/Documents/salaries.xlsx" }, win).ok, false);
});

test("autonomous runs refuse MarkItDown like any outside tool unless the setting lets it read", () => {
  const cwd = "/work/proj/.kanban/wt/t1";
  const inside = { uri: "file:///work/proj/.kanban/wt/t1/a.pdf" };
  assert.equal(autonomousGate(MARKITDOWN_TOOL, inside, cwd).behavior, "deny", "off: an outside tool");
  assert.equal(autonomousGate(MARKITDOWN_TOOL, inside, cwd, [], { markitdown: true }).behavior, "allow");
  assert.equal(autonomousGate(MARKITDOWN_TOOL, { uri: "file:///work/proj/.env" }, cwd, [], { markitdown: true }).behavior, "deny");
  assert.equal(autonomousGate("mcp__markitdown__something_else", {}, cwd, [], { markitdown: true }).behavior, "deny", "only the one tool");
  assert.match(serverRule("mcp__markitdown__", { markitdown: true }), /Documents to Markdown/);
  assert.match(serverRule("mcp__markitdown__"), /Autonomous runs: refused/);
});

const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kmdrepo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** Runs one stage with a fake session; `probe` sees the options it was started with, mid-run. */
async function stage(mode: Mode, settings: Record<string, unknown>, probe: (o: Options, repo: Repo, taskId: string) => Promise<void>) {
  const dir = gitRepo();
  const q: QueryFn = (params) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      await probe(params.options as Options, repo, task.id);
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as never;
    })();
  const repo = new Repo(openDb(":memory:"));
  repo.setStateDir(mkdtempSync(join(tmpdir(), "kmdstate-")));
  repo.updateSettings(settings as never);
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q });
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  const task = repo.createTask({ project_id: project.id, title: "read the PO", mode, pipeline: ONE_STAGE });
  try {
    runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(repo.getTask(task.id)!.status));
    assert.equal(repo.getTask(task.id)!.error, null);
  } finally {
    await removeTemp(dir);
  }
}

const opts = { signal: new AbortController().signal, toolUseID: "t" } as never;
const guard = async (o: Options, input: Record<string, unknown>) => {
  const matchers = (o.hooks?.PreToolUse ?? []) as { hooks: ((input: unknown, id: string, x: { signal: AbortSignal }) => Promise<unknown>)[] }[];
  for (const m of matchers) {
    for (const h of m.hooks) {
      const a = (await h({ hook_event_name: "PreToolUse", tool_name: MARKITDOWN_TOOL, tool_input: input }, "t1", { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (a?.hookSpecificOutput?.permissionDecision === "deny") return "deny";
    }
  }
  return "allowed";
};

test("an autonomous task in sandbox reach reads a document in its worktree with MarkItDown, and is refused one outside it", async () => {
  const seen: Record<string, string> = {};
  await stage("autonomous", { autonomousReach: "sandbox" }, async (o) => {
    const inside = { uri: pathToFileURL(join(o.cwd!, "README.md")).href };
    const outside = { uri: pathToFileURL(join(tmpdir(), "elsewhere", "secret.pdf")).href };
    seen.inside = (await o.canUseTool!(MARKITDOWN_TOOL, inside, opts))?.behavior ?? "none";
    seen.outside = (await o.canUseTool!(MARKITDOWN_TOOL, outside, opts))?.behavior ?? "none";
    seen.web = (await o.canUseTool!(MARKITDOWN_TOOL, { uri: "https://example.com/report.pdf" }, opts))?.behavior ?? "none";
    seen.guardInside = await guard(o, inside);
    seen.guardOutside = await guard(o, outside);
  });
  assert.deepEqual(seen, { inside: "allow", outside: "deny", web: "allow", guardInside: "allowed", guardOutside: "deny" });

  let off = "";
  await stage("autonomous", { markitdownInTasks: false, autonomousReach: "sandbox" }, async (o) => {
    off = (await o.canUseTool!(MARKITDOWN_TOOL, { uri: "https://example.com/report.pdf" }, opts))?.behavior ?? "none";
  });
  assert.equal(off, "deny", "switched off: an outside tool again");
});

test("a supervised task reads a web document with MarkItDown without a card, and asks about a file outside the project", async () => {
  let free = "";
  let card = "";
  let logged = 0;
  await stage("supervised", {}, async (o, repo, taskId) => {
    free = (await o.canUseTool!(MARKITDOWN_TOOL, { uri: "https://example.com/report.pdf" }, opts))?.behavior ?? "none";
    logged = repo.runsForTask(taskId).flatMap((r) => repo.eventsAfter(r.id)).filter((e) => JSON.stringify(e).includes("auto_allowed")).length;
    // The stage finishing expires the card, which is all this needs.
    void o.canUseTool!(MARKITDOWN_TOOL, { uri: pathToFileURL(join(tmpdir(), "elsewhere", "salaries.xlsx")).href }, opts);
    await until(() => repo.pendingApprovals(taskId).length === 1);
    card = repo.pendingApprovals(taskId)[0].tool_name;
  });
  assert.equal(free, "allow");
  assert.equal(logged, 1, "shown in the transcript as allowed by the board");
  assert.equal(card, MARKITDOWN_TOOL);
});

const OK = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A computer answering only the commands a test gives it. */
function machine(platform: NodeJS.Platform, cmds: Record<string, RunResult>): Probe {
  return {
    platform,
    env: {},
    claudeBin: "claude-bin",
    run: async (c, a) => cmds[[c, ...a].join(" ")] ?? { code: null, stdout: "", stderr: "not found" },
    stream: async () => 0,
    exists: () => false,
    list: () => [],
    fetchJson: async () => {
      throw new Error("offline");
    },
    refreshPath: async () => {},
  } as Probe;
}

const ASK = `-c import sys; print(sys.executable); print('%d.%d' % sys.version_info[:2])`;

test("the MarkItDown card finds a Python that fits, gives MarkItDown its own environment, and adds it to your Claude Code", async () => {
  const home = "/home/me";
  const check = recommendedChecks(() => home).find((c) => c.id === "tool:markitdown")!;
  const ctx = (probe: Probe) => ({ probe, settings: {} as never, hasSecret: () => false });

  // No Python: say so, and offer nothing that would fail.
  const none = await check.detect(ctx(machine("linux", {})));
  assert.equal(none.ok, false);
  assert.equal(none.offerFixes, false);
  assert.match(none.detail, /Needs Python 3\.10/);

  // Too old a Python is skipped for one that fits.
  const linux = machine("linux", {
    [`python3 ${ASK}`]: OK("/usr/bin/python3\n3.8\n"),
    [`python ${ASK}`]: OK("/opt/py/bin/python\n3.12\n"),
    "claude-bin mcp get markitdown": { code: 1, stdout: 'No MCP server named "markitdown".', stderr: "" },
  });
  const fresh = await check.detect(ctx(linux));
  assert.deepEqual([fresh.ok, fresh.detail], [false, "Not added yet — will use Python 3.12"]);
  const dir = markitdownDir(home, "linux");
  const py = venvPython(dir, "linux");
  assert.equal(py, "/home/me/.claude-kanban/tools/markitdown/bin/python");
  const steps = check.run!({}).map((c) => [c.command.split(/[\\/]/).pop(), ...c.args].join(" "));
  assert.deepEqual(steps.slice(0, 2), [`python -m venv ${dir}`, `python -m pip install --upgrade --disable-pip-version-check markitdown-mcp`]);
  assert.equal(check.run!({})[0].command, "/opt/py/bin/python", "the Python that fits, by its full path");
  assert.equal(check.run!({})[1].command, py, "pip runs in MarkItDown's own environment");
  assert.match(steps.at(-1)!, / mcp add -s user markitdown -- \/home\/me\/\.claude-kanban\/tools\/markitdown\/bin\/python -m markitdown_mcp$/);
  assert.ok(!steps.some((s) => s.includes("mcp remove")), "nothing to remove the first time");

  // Added but not starting: set it up again, removing the old entry first.
  linux.run = async (c, a) =>
    ({
      [`python3 ${ASK}`]: OK("/usr/bin/python3\n3.11\n"),
      "claude-bin mcp get markitdown": OK("markitdown:\n  Scope: User config\n  Status: ✗ Failed to connect\n"),
    })[[c, ...a].join(" ")] ?? { code: null, stdout: "", stderr: "" };
  const broken = await check.detect(ctx(linux));
  assert.equal(broken.ok, false);
  assert.equal(broken.warn, true);
  const again = check.run!({}).map((c) => c.args.join(" "));
  assert.ok(again.indexOf("mcp remove -s user markitdown") === again.length - 2, "removed, then added");

  // Connected: done.
  linux.run = async (c, a) =>
    [c, ...a].join(" ") === "claude-bin mcp get markitdown" ? OK("markitdown:\n  Scope: User config\n  Status: √ Connected\n") : { code: null, stdout: "", stderr: "" };
  const done = await check.detect(ctx(linux));
  assert.deepEqual([done.ok, done.offerFixes], [true, false]);

  // Windows: the py launcher first, and the environment's Python under Scripts.
  const win = machine("win32", { [`py -3 ${ASK}`]: OK("C:\\Python313\\python.exe\r\n3.13\r\n") });
  assert.equal((await check.detect(ctx(win))).detail, "Not added yet — will use Python 3.13");
  assert.equal(venvPython(markitdownDir("C:\\Users\\me", "win32"), "win32"), "C:\\Users\\me\\.claude-kanban\\tools\\markitdown\\Scripts\\python.exe");
});
