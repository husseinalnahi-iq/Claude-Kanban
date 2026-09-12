import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_CHECKLIST } from "../src/engine/onboarding.ts";

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("onboarding fields round-trip: task tag, project answers, checklist setting", () => {
  const repo = new Repo(openDb(":memory:"));
  assert.equal(repo.getSettings().onboardingChecklist, DEFAULT_CHECKLIST);
  repo.updateSettings({ onboardingChecklist: "- my rule" });
  assert.equal(repo.getSettings().onboardingChecklist, "- my rule");
  repo.updateSettings({ onboardingChecklist: "" });
  assert.equal(repo.getSettings().onboardingChecklist, DEFAULT_CHECKLIST, "empty restores the default");

  const p = repo.createProject({ name: "p", path: "C:/x", policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
  assert.equal(p.env.onboarding, null);
  const p2 = repo.updateProject(p.id, { env: { ...p.env, onboarding: { goal: "g", stack: "ts", verify: "npm test" } } });
  assert.deepEqual(p2.env.onboarding, { goal: "g", stack: "ts", verify: "npm test" });

  const t = repo.createTask({ project_id: p.id, title: "t", onboarding: "bootstrap" });
  assert.equal(repo.getTask(t.id)?.onboarding, "bootstrap");
  assert.equal(repo.createTask({ project_id: p.id, title: "u" }).onboarding, null);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeFolder } from "../src/engine/onboarding.ts";

test("an empty folder stays empty with git metadata in it; any real file makes it code", () => {
  const dir = mkdtempSync(join(tmpdir(), "konb-"));
  try {
    assert.equal(probeFolder(dir), "empty");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "");
    mkdirSync(join(dir, ".claude"));
    assert.equal(probeFolder(dir), "empty");
    writeFileSync(join(dir, "index.ts"), "");
    assert.equal(probeFolder(dir), "code");
    assert.equal(probeFolder(join(dir, "nope")), "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";
import { bootstrapSpec, parseVerifyLine } from "../src/engine/onboarding.ts";

test("the bootstrap spec carries the answers, the checklist and the VERIFY contract", () => {
  const spec = bootstrapSpec({ goal: "A CLI that counts words", stack: "", verify: "" }, "- rule one");
  assert.match(spec, /counts words/);
  assert.match(spec, /choose the stack/i);
  assert.match(spec, /- rule one/);
  assert.match(spec, /VERIFY: <command>/);
  assert.match(spec, /under 200 lines/);
  const withStack = bootstrapSpec({ goal: "g", stack: "Python + uv", verify: "pytest" }, "");
  assert.match(withStack, /Python \+ uv/);
  assert.match(withStack, /pytest/);
  assert.match(withStack, /git init/, "an empty checklist falls back to the default");
});

test("VERIFY line: last one wins, backticks stripped, absent or none → null", () => {
  assert.equal(parseVerifyLine("done\nVERIFY: `npm test`\n"), "npm test");
  assert.equal(parseVerifyLine("VERIFY: a\ntext\nVERIFY: b"), "b");
  assert.equal(parseVerifyLine("nothing"), null);
  assert.equal(parseVerifyLine("VERIFY: none"), null);
});

const recording = (): { prompts: string[]; q: QueryFn } => {
  const prompts: string[] = [];
  const q: QueryFn = (params) =>
    (async function* () {
      let text = "";
      for await (const m of params.prompt) text += typeof m.message.content === "string" ? m.message.content : "";
      prompts.push(text);
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  return { prompts, q };
};

test("bootstrap and /init are tagged tasks; bootstrap refuses a folder with code; create can queue either", async () => {
  const dirs = ["e", "c", "c2", "e2", "e3"].map((n) => mkdtempSync(join(tmpdir(), `konb-${n}-`)));
  const [empty, code, code2, empty2, empty3] = dirs;
  writeFileSync(join(code, "index.ts"), "");
  writeFileSync(join(code2, "a.py"), "");
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const { q } = recording();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: q }), allowedHosts: ["localhost:80"] });
  try {
    const policy = { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } as const;
    const p = repo.createProject({ name: "e", path: empty, policy });
    const res = await app.inject({ method: "POST", url: `/api/projects/${p.id}/bootstrap`, payload: { goal: "count words" } });
    assert.equal(res.statusCode, 200, res.body);
    const task = res.json();
    assert.equal(task.title, "Bootstrap the project");
    assert.equal(task.onboarding, "bootstrap");
    assert.equal(task.mode, "supervised", "no repository yet, so no worktree to review a diff in");
    assert.match(task.spec_md, /count words/);
    assert.equal(task.pipeline[0].provider, undefined, "the bootstrap writes files, so it always runs on Claude");
    assert.deepEqual(repo.getProject(p.id)!.env.onboarding, { goal: "count words", stack: "", verify: "" });

    const c = repo.createProject({ name: "c", path: code, policy });
    assert.equal((await app.inject({ method: "POST", url: `/api/projects/${c.id}/bootstrap`, payload: { goal: "x" } })).statusCode, 409);
    const init = (await app.inject({ method: "POST", url: `/api/projects/${c.id}/claude-md/init` })).json();
    assert.equal(init.onboarding, "init");

    const probe = (await app.inject({ method: "GET", url: `/api/projects/probe?path=${encodeURIComponent(code)}` })).json();
    assert.equal(probe.kind, "code");
    assert.equal(probe.hasClaudeMd, false);

    const created = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "n", path: code2, onboarding: { init: true } } })).json();
    assert.equal(created.onboardingTask?.title, "Create CLAUDE.md with /init");
    const created2 = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "n2", path: empty2, onboarding: { bootstrap: { goal: "g" } } } })).json();
    assert.equal(created2.onboardingTask?.onboarding, "bootstrap");
    assert.equal(created2.env.onboarding.goal, "g");
    const created3 = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "n3", path: empty3 } })).json();
    assert.equal(created3.onboardingTask, null);
  } finally {
    await app.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

import { applyOnboardingResult } from "../src/engine/onboarding.ts";

/** A model that answers with a structured object and nothing else. */
const structured = (out: unknown): QueryFn => () =>
  (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, session_id: "s", modelUsage: {}, structured_output: out } as never;
  })();

const never: QueryFn = () => {
  throw new Error("the model must not be called");
};

function fixture(dir: string, onboarding: "init" | "bootstrap" | null, resultMd: string, verifyCommand: string | null = null) {
  const repo = new Repo(openDb(":memory:"));
  const project = repo.createProject({ name: "p", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
  if (verifyCommand) repo.updateProject(project.id, { env: { ...project.env, verifyCommand } });
  const task = repo.createTask({ project_id: project.id, title: "t", onboarding });
  const run = repo.createRun({ task_id: task.id, stage: "custom", stage_index: 0, model: "m", effort: "high" });
  repo.updateRun(run.id, { status: "success", result_md: resultMd });
  return { repo, bus: new Bus(), project, task };
}

test("a bootstrap's VERIFY line becomes the verify command without a model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "konb-v-"));
  try {
    const f = fixture(dir, "bootstrap", "Set up.\n\nVERIFY: npm test");
    assert.equal(await applyOnboardingResult({ ...f, queryFn: never }, f.task.id), "npm test");
    assert.equal(f.repo.getProject(f.project.id)!.env.verifyCommand, "npm test");
    assert.ok(f.repo.notes(f.project.id).some((n) => n.text.includes("npm test")), "remembered on the project");
    assert.ok(f.repo.messagesForTask(f.task.id).some((m) => m.body.includes("npm test")), "and said on the task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an /init task asks the cheap model to read CLAUDE.md; null leaves the project alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "konb-i-"));
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "## Test\nnpm run check\n");
    const f = fixture(dir, "init", "wrote CLAUDE.md");
    assert.equal(await applyOnboardingResult({ ...f, queryFn: structured({ command: "npm run check" }) }, f.task.id), "npm run check");
    assert.equal(f.repo.getProject(f.project.id)!.env.verifyCommand, "npm run check");

    const g = fixture(dir, "init", "wrote CLAUDE.md");
    assert.equal(await applyOnboardingResult({ ...g, queryFn: structured({ command: null }) }, g.task.id), null);
    assert.equal(g.repo.getProject(g.project.id)!.env.verifyCommand, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing verify command is never overwritten, and ordinary tasks are ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "konb-k-"));
  try {
    const f = fixture(dir, "bootstrap", "VERIFY: other", "make");
    assert.equal(await applyOnboardingResult({ ...f, queryFn: never }, f.task.id), null);
    assert.equal(f.repo.getProject(f.project.id)!.env.verifyCommand, "make");
    writeFileSync(join(dir, "CLAUDE.md"), "npm test\n");
    const g = fixture(dir, null, "VERIFY: npm test");
    assert.equal(await applyOnboardingResult({ ...g, queryFn: never }, g.task.id), null);
    assert.equal(g.repo.getProject(g.project.id)!.env.verifyCommand, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approving a bootstrap task sets the project's verify command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "konb-a-"));
  const q: QueryFn = () =>
    (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "All set.\n\nVERIFY: npm test", total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: q }), allowedHosts: ["localhost:80"] });
  try {
    const project = repo.createProject({ name: "p", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
    const task = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/bootstrap`, payload: { goal: "g" } })).json();
    await until(() => repo.getTask(task.id)!.status === "review");
    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
    assert.equal(res.statusCode, 200, res.body);
    await until(() => repo.getProject(project.id)!.env.verifyCommand === "npm test");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
