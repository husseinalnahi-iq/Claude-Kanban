# Project Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a project is added, the board sets it up for Claude: `/init` for repos with code, a bootstrap task for empty folders, and a verify command read from the result.

**Architecture:** A new `server/src/engine/onboarding.ts` owns the pure logic (folder probe, bootstrap spec, `VERIFY:` parsing, verify-command extraction with a model). Routes in `routes/projects.ts` and `routes/claudeMd.ts` create the tasks and tag them with `Task.onboarding`. `TaskRunner.approveTask` calls the extraction after approval, only for tagged tasks. The web dialog and Settings gain the fields.

**Tech Stack:** Node 24 (`node:test`, `node:sqlite`), Fastify + zod, React + Tailwind, Claude Agent SDK `query()` with `outputFormat: json_schema`.

Spec: `docs/superpowers/specs/2026-09-11-project-onboarding-design.md`.

---

### Task 1: Types, schema, settings default

**Files:**
- Modify: `server/src/types.ts` (ProjectEnv, Task, Settings)
- Modify: `server/src/db.ts` (LATER_COLUMNS, seed)
- Modify: `server/src/repo.ts` (task row mapping, TASK_COLUMNS, NewTask, getSettings)
- Create: `server/src/engine/onboarding.ts` (DEFAULT_CHECKLIST only, for now)
- Modify: `server/src/routes/settings.ts`, `server/src/routes/projects.ts` (schemas)
- Test: `server/test/onboarding.test.ts`

- [ ] **Step 1: Failing test for the new fields**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_CHECKLIST } from "../src/engine/onboarding.ts";

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
```

- [ ] **Step 2: Run** `npm test -w server -- test/onboarding.test.ts` → FAIL (module / property missing).

- [ ] **Step 3: Implement**

`types.ts`: in `ProjectEnv` add `onboarding: { goal: string; stack: string; verify: string } | null;` and to `EMPTY_ENV` add `onboarding: null`. In `Task` add `/** Set on the tasks the board creates to set a project up; approval reads a verify command out of them. */ onboarding: "init" | "bootstrap" | null;`. In `Settings` add `/** Markdown checklist the bootstrap task follows for an empty project. */ onboardingChecklist: string;`.

`engine/onboarding.ts`:
```ts
export const DEFAULT_CHECKLIST = [
  "- `git init` if the folder is not a repository; add a `.gitignore` for the stack.",
  "- A minimal runnable skeleton for the stack — entry point, config, no example features.",
  "- A test runner with one passing smoke test, and a lint or typecheck step.",
  "- One command that runs every check (tests, lint, typecheck, build). Report it on the last line as `VERIFY: <command>`.",
  "- `CLAUDE.md` under 200 lines: how to run, test and build; where things live; conventions that differ from the language's defaults; gotchas. Nothing Claude can read from the code itself.",
  "- `.claude/rules/<area>.md` with `paths:` frontmatter only where a folder needs rules of its own.",
  "- A short README: what it is and how to run it.",
].join("\n");
```

`db.ts`: append `{ table: "tasks", column: "onboarding", ddl: "onboarding TEXT" }` to `LATER_COLUMNS`. No seed for the checklist (empty = default, read-time fallback).

`repo.ts`: task row mapping adds `onboarding: (r.onboarding as Task["onboarding"]) ?? null`; `TASK_COLUMNS` adds `onboarding: str`; `NewTask` adds `onboarding?: Task["onboarding"]`; `createTask` inserts it (find the INSERT and add the column, default `null`). Project row mapping: `env: { ...EMPTY_ENV, ...json(r.env_json, {}) }` so old rows get `onboarding: null` (check existing mapping; if it already spreads EMPTY_ENV, nothing to do). `getSettings` adds `onboardingChecklist: m.get("onboardingChecklist") || DEFAULT_CHECKLIST`.

`routes/settings.ts` patch schema: `onboardingChecklist: z.string().max(8000).optional()`.

`routes/projects.ts` `envSchema`: `onboarding: z.object({ goal: z.string(), stack: z.string(), verify: z.string() }).nullable()`.

- [ ] **Step 4: Run test** → PASS. Run `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(onboarding): task tag, project answers, checklist setting`

---

### Task 2: Folder probe

**Files:** `server/src/engine/onboarding.ts`, `server/src/routes/projects.ts`, test file.

- [ ] **Step 1: Failing test**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeFolder } from "../src/engine/onboarding.ts";

test("an empty folder stays empty with git metadata in it; any real file makes it code", () => {
  const dir = mkdtempSync(join(tmpdir(), "konb-"));
  try {
    assert.equal(probeFolder(dir), "empty");
    mkdirSync(join(dir, ".git")); writeFileSync(join(dir, ".gitignore"), "");
    mkdirSync(join(dir, ".claude"));
    assert.equal(probeFolder(dir), "empty");
    writeFileSync(join(dir, "index.ts"), "");
    assert.equal(probeFolder(dir), "code");
    assert.equal(probeFolder(join(dir, "nope")), "missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
export type FolderKind = "empty" | "code" | "missing";
const IGNORED = new Set([".git", ".claude", ".gitignore", ".ds_store", "thumbs.db", "desktop.ini"]);
export function probeFolder(path: string): FolderKind {
  if (!existsSync(path) || !statSync(path).isDirectory()) return "missing";
  return readdirSync(path).some((n) => !IGNORED.has(n.toLowerCase())) ? "code" : "empty";
}
```

Route in `projects.ts`: `app.get("/projects/probe", async (req) => { const path = resolve(z.object({ path: z.string().min(1) }).parse(req.query).path); return { path, kind: probeFolder(path), hasClaudeMd: existsSync(join(path, "CLAUDE.md")) || existsSync(join(path, ".claude", "CLAUDE.md")) }; });` — register it **before** `/projects/:id` routes so `probe` is not taken as an id (Fastify matches static before param anyway, but keep it first for clarity).

Test the route too (append to the same test with `buildApp`, GET `/api/projects/probe?path=…`, expect `kind`).

- [ ] **Step 4: PASS. Commit** `feat(onboarding): folder probe`

---

### Task 3: Bootstrap task route, `/init` tag, create-with-onboarding

**Files:** `server/src/engine/onboarding.ts` (`bootstrapSpec`), `server/src/routes/claudeMd.ts`, `server/src/routes/projects.ts`, test.

- [ ] **Step 1: Failing tests**

```ts
import { bootstrapSpec, parseVerifyLine } from "../src/engine/onboarding.ts";

test("the bootstrap spec carries the answers, the checklist and the VERIFY contract", () => {
  const spec = bootstrapSpec({ goal: "A CLI that counts words", stack: "", verify: "" }, "- rule one");
  assert.match(spec, /counts words/);
  assert.match(spec, /let Claude choose|choose the stack/i);
  assert.match(spec, /- rule one/);
  assert.match(spec, /VERIFY: <command>/);
  assert.match(spec, /under 200 lines/);
  const withStack = bootstrapSpec({ goal: "g", stack: "Python + uv", verify: "pytest" }, "");
  assert.match(withStack, /Python \+ uv/); assert.match(withStack, /pytest/);
});

test("VERIFY line: last one wins, backticks stripped, absent → null", () => {
  assert.equal(parseVerifyLine("done\nVERIFY: `npm test`\n"), "npm test");
  assert.equal(parseVerifyLine("VERIFY: a\ntext\nVERIFY: b"), "b");
  assert.equal(parseVerifyLine("nothing"), null);
  assert.equal(parseVerifyLine("VERIFY: none"), null);
});
```

Route test (same `buildApp` pattern as claudemd.test.ts, stub `QueryFn` recording prompts):
- `POST /api/projects/:id/bootstrap` with `{goal:"g"}` → 200, task title `Bootstrap the project`, `onboarding: "bootstrap"`, one custom stage, spec contains "g"; project `env.onboarding.goal === "g"`; supervised when the dir is not a git repo.
- `POST /api/projects/:id/bootstrap` on a folder with a file → 409.
- `POST /api/projects/:id/claude-md/init` → task has `onboarding: "init"`.
- `POST /api/projects` with `{ …, onboarding: { init: true } }` on a folder with a file → response has `onboardingTask.title` starting "Create CLAUDE.md"; with `{ onboarding: { bootstrap: { goal } } }` on an empty folder → `onboardingTask.onboarding === "bootstrap"`; without `onboarding` → `onboardingTask` is null.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

`onboarding.ts`:
```ts
export interface Answers { goal: string; stack: string; verify: string }
export function bootstrapSpec(a: Answers, checklist: string): string {
  return [
    "Set this empty folder up as a new project so later tasks can work in it well.",
    `\n## Goal\n${a.goal.trim()}`,
    `\n## Stack\n${a.stack.trim() || "Not chosen — choose the stack that fits the goal best and say why in CLAUDE.md."}`,
    `\n## How it is verified\n${a.verify.trim() || "Not chosen — pick the stack's standard test runner."}`,
    `\n## Checklist\n${checklist.trim() || DEFAULT_CHECKLIST}`,
    "\n## Rules",
    "- Keep `CLAUDE.md` under 200 lines and specific: commands, layout, conventions that differ from the defaults, gotchas. Leave out what Claude can read from the code.",
    "- No example features, no placeholder pages. A skeleton that runs and one smoke test that passes.",
    "- Run the checks yourself before you finish and show the output.",
    "- End your final message with one line `VERIFY: <command>` — the single command that runs every check. The board sets it as this project's verify command.",
  ].join("\n");
}
export function parseVerifyLine(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => /^\s*VERIFY:/i.test(l));
  const last = lines.at(-1);
  if (!last) return null;
  const cmd = last.replace(/^\s*VERIFY:\s*/i, "").replace(/^`+|`+$/g, "").trim();
  return cmd && !/^(none|null|n\/a|-)$/i.test(cmd) ? cmd : null;
}
```

`claudeMd.ts`: extract a helper `export function queueInitTask(deps, project)` from the existing route body (returns the created task, publishes, queues) and add `onboarding: "init"` to `createTask`. Add `export async function queueBootstrapTask(deps, project, answers)`:
- `probeFolder(project.path) !== "empty"` → `ConflictError("This folder already has files; use /init instead.")`
- store answers: `repo.updateProject(id, { env: { ...project.env, onboarding: answers } })`, publish `project.updated`
- `mode = (await isGitRepo(project.path)) ? allowedMode(project, "autonomous") : "supervised"`
- `createTask({ project_id, title: "Bootstrap the project", spec_md: bootstrapSpec(answers, settings.onboardingChecklist), type: "chore", mode, onboarding: "bootstrap", pipeline: [{ stage: "custom", model: settings.tiers.balanced, effort: "high", prompt: "Work on the task below exactly as its checklist says." }] })`
- publish + `runner.queueTask`.

Route `POST /projects/:id/bootstrap` body `{ goal: z.string().trim().min(1), stack: z.string().default(""), verify: z.string().default("") }`.

`projects.ts` create: `createSchema` gains `onboarding: z.object({ init: z.boolean().optional(), bootstrap: z.object({ goal, stack, verify }).optional() }).optional()`. After creating the project: `let onboardingTask = null; if (body.onboarding?.bootstrap) onboardingTask = await queueBootstrapTask(...); else if (body.onboarding?.init) onboardingTask = await queueInitTask(...)`. Return `{ ...(await withGit(project)), onboardingTask }`.

- [ ] **Step 4: PASS. Commit** `feat(onboarding): bootstrap task, tagged /init, onboarding on create`

---

### Task 4: Verify command after approval

**Files:** `server/src/engine/onboarding.ts` (`extractVerifyCommand`, `applyOnboardingResult`), `server/src/engine/runner.ts` (`approveTask`), test.

- [ ] **Step 1: Failing tests**

```ts
import { applyOnboardingResult } from "../src/engine/onboarding.ts";
// helper: a QueryFn that returns structured_output
const structured = (out: unknown): QueryFn => () => (async function* () {
  yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, session_id: "s", modelUsage: {}, structured_output: out } as never;
})();

test("a bootstrap's VERIFY line becomes the verify command without a model call", async () => {
  // repo, project (env.verifyCommand null), task onboarding:"bootstrap", run with result_md "…\nVERIFY: npm test"
  let calls = 0;
  const r = await applyOnboardingResult({ repo, bus, queryFn: () => { calls++; throw new Error("no"); } }, task.id);
  assert.equal(r, "npm test"); assert.equal(calls, 0);
  assert.equal(repo.getProject(project.id)!.env.verifyCommand, "npm test");
  assert.ok(repo.listNotes(project.id).some((n) => n.text.includes("npm test")));
  assert.ok(repo.listMessages(task.id).some((m) => m.body.includes("npm test")));
});
test("an /init task asks the cheap model to read CLAUDE.md; null leaves the project alone", async () => {
  // write CLAUDE.md "## Test\nnpm run check" in project dir; task onboarding:"init"
  assert.equal(await applyOnboardingResult({ repo, bus, queryFn: structured({ command: "npm run check" }) }, task.id), "npm run check");
  // second project: structured({ command: null }) → returns null, verifyCommand stays null
});
test("an existing verify command is never overwritten, and ordinary tasks are ignored", async () => {
  // project env.verifyCommand "make"; bootstrap task with VERIFY: other → returns null, stays "make"
  // task onboarding null → returns null, queryFn never called
});
test("approving a tagged task sets the verify command", async () => {
  // full TaskRunner with queryFn stub whose stage result ends "VERIFY: npm test"; run bootstrap route; until(status review); POST /tasks/:id/approve; until(project.env.verifyCommand === "npm test")
});
```
(Check `repo` for the note/message list method names: `listNotes` may be `notes(project_id)`; use whatever exists.)

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
const SCHEMA = { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: ["string", "null"], description: "The one shell command that runs this project's checks (tests, lint, typecheck, build), or null if the file documents none." } } };

export async function extractVerifyCommand(claudeMd: string, model: string, cwd: string, queryFn: QueryFn): Promise<string | null> {
  const prompt = `Read this CLAUDE.md and return the single command that runs the project's checks. Prefer one that runs everything (e.g. \`npm test\` when it covers lint and types). Return null if none is documented. Never invent one.\n\n${claudeMd.slice(0, 12_000)}`;
  const options: Options = { model, effort: "low", cwd, settingSources: [], permissionMode: "dontAsk", tools: [], maxTurns: 1, maxBudgetUsd: 0.2, outputFormat: { type: "json_schema", schema: SCHEMA } };
  let out: unknown;
  for await (const msg of queryFn({ prompt: userMessage(prompt), options })) if (msg.type === "result") out = (msg as { structured_output?: unknown }).structured_output;
  const cmd = (out as { command?: unknown } | undefined)?.command;
  return typeof cmd === "string" && cmd.trim() ? cmd.trim() : null;
}

export async function applyOnboardingResult(deps: { repo: Repo; bus: Bus; queryFn: QueryFn }, taskId: string): Promise<string | null> {
  const task = deps.repo.getTask(taskId); if (!task?.onboarding) return null;
  const project = deps.repo.getProject(task.project_id); if (!project || project.env.verifyCommand) return null;
  let cmd: string | null = null;
  if (task.onboarding === "bootstrap") cmd = parseVerifyLine(deps.repo.latestRun(taskId)?.result_md ?? "");
  if (!cmd) {
    const file = instructionFiles(project.path).find((f) => (f.scope === "project" || f.scope === "project (.claude)") && f.exists);
    if (file?.content) cmd = await extractVerifyCommand(file.content, deps.repo.getSettings().triageModel, project.path, deps.queryFn);
  }
  if (!cmd) return null;
  const updated = deps.repo.updateProject(project.id, { env: { ...project.env, verifyCommand: cmd } });
  deps.bus.publish({ type: "project.updated", project: updated });
  deps.repo.addNote({ project_id: project.id, task_id: taskId, text: `Verify command set to \`${cmd}\` from ${task.onboarding === "bootstrap" ? "the bootstrap" : "CLAUDE.md"}`, source: "board" });
  const message = deps.repo.insertMessage({ task_id: taskId, from_task_id: null, from_run_id: null, body: `Verify command set to \`${cmd}\`. Change it in Settings → Project if it is wrong.` });
  deps.bus.publish({ type: "message.posted", message });
  return cmd;
}
```
`userMessage` — copy the small helper triage.ts uses (or export it from there). `instructionFiles` import from `../routes/claudeMd.ts` creates a routes→engine→routes cycle only at type level; if it bites, move `instructionFiles` into `engine/onboarding.ts` and re-export from the route.

`runner.ts` `approveTask`: after both `return merged` / `return done` paths — restructure to compute `result`, then `if (task.onboarding) setImmediate(() => applyOnboardingResult({ repo: this.repo, bus: this.bus, queryFn: this.queryFn }, taskId).catch((e) => this.log?.(…) /* or console.warn */));` then return. Check how the runner logs elsewhere (`this.logger`, `console.warn`) and use the same.

- [ ] **Step 4: PASS. `npm test` (all) and typecheck. Commit** `feat(onboarding): verify command from the approved result`

---

### Task 5: Web — dialog, Settings textarea, Bootstrap button

**Files:** `web/src/lib/api.ts`, `web/src/components/forms.tsx` (NewProjectForm), `web/src/views/Settings.tsx` (runs tab), `web/src/views/settings/ClaudeMdSettings.tsx`.

- [ ] **Step 1: api.ts**
```ts
probeFolder: (path: string) => req<{ path: string; kind: "empty" | "code" | "missing"; hasClaudeMd: boolean }>("GET", `/projects/probe?path=${encodeURIComponent(path)}`),
createProject: (b: { name; path; policy?; onboarding?: { init?: boolean; bootstrap?: { goal: string; stack: string; verify: string } } }) => req<ProjectWithGit & { onboardingTask: Task | null }>("POST", "/projects", b),
bootstrapProject: (id: string, b: { goal: string; stack: string; verify: string }) => req<Task>("POST", `/projects/${id}/bootstrap`, b),
```
Check `req` supports GET with a query in the path (it should — `/tasks?project=` does).

- [ ] **Step 2: NewProjectForm**
State: `probe` (`null | {kind, hasClaudeMd}`), `onboard` (bool, default true), `goal`, `stack`, `verify`. `useEffect` on `path` (debounced 300 ms): if `path.trim()` call `api.probeFolder`, else `setProbe(null)`.
Render after Policy, a section titled **Onboarding**:
- `probe?.kind === "code"`: checkbox `Set up CLAUDE.md with /init` (label "Improve CLAUDE.md with /init" when `hasClaudeMd`), hint "Claude reads the code and writes build, test and convention notes. Lands as a change you approve."
- `probe?.kind === "empty"`: checkbox `Bootstrap this project`; when on, three fields: Goal (textarea, required), Stack (input, placeholder "let Claude choose"), How to verify (input, placeholder "npm test").
- otherwise nothing.
Submit: `onboarding: probe?.kind === "code" && onboard ? { init: true } : probe?.kind === "empty" && onboard ? { bootstrap: { goal, stack, verify } } : undefined`. Register button disabled also when bootstrap is on and `!goal.trim()`. After create: navigate to the onboarding task if present (`taskId: p.onboardingTask?.id ?? null`).

- [ ] **Step 3: Settings → Runs**
State `checklist`, loaded from `settings.onboardingChecklist`, saved as `onboardingChecklist: checklist`. New `<Section title="Onboarding" hint="What the bootstrap task does for an empty project. Edit it once; every future bootstrap follows it. Leave it empty to restore the default.">` with a `<textarea className={`${inputCls} mt-1 min-h-[160px] font-mono text-[12.5px]`}>` — place it after the Intake models section.

- [ ] **Step 4: ClaudeMdSettings Bootstrap button**
Load `api.probeFolder(project.path)` in the existing `load`. When `kind === "empty"`, show a **Bootstrap…** button next to Create/Improve that opens a small inline form (same three fields) and calls `api.bootstrapProject`, then navigates to the task. Hide Create with /init for empty folders (nothing to analyse).

- [ ] **Step 5:** `npm run typecheck`, `npm run build -w web` if that is the build script (check package.json). Commit `feat(onboarding): dialog, settings checklist, bootstrap button`.

---

### Task 6: Docs and verification

- [ ] README: under **CLAUDE.md** add a short **Onboarding** paragraph (dialog behaviour, bootstrap, verify command set automatically, checklist in Settings → Runs).
- [ ] `docs/DECISIONS.md`: one row — why no per-stage best-practice prompt (Anthropic: <200 lines, specific; tokens per stage), why the checklist is a setting, why verify is set automatically with a message.
- [ ] Browser check: start the dev server, open the add-project dialog on an empty temp folder and on this repo, screenshot both states; confirm Settings shows the checklist.
- [ ] Commit `docs: onboarding`.
