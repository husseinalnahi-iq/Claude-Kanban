# Claude Kanban v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app (Node server on 127.0.0.1:4310 + React UI) that manages tasks/roadmaps across projects and runs Claude Agent SDK sessions per task, per pipeline stage, with per-stage model choice, approvals, worktrees and a shared board MCP.

**Architecture:** Fastify server owns a `node:sqlite` DB, an in-memory FIFO run queue, and a `TaskRunner` that calls the Agent SDK `query()` in-process for each pipeline stage. Every run gets a per-run `board` MCP server (createSdkMcpServer) so sessions can read tasks, post messages and create subtasks. SDK messages are persisted as `events` and fanned out over a WebSocket. The React UI (Vite, Tailwind v4, no component lib) talks REST + WS.

**Tech Stack:** Node 24 (`node:sqlite`), TypeScript, tsx, Fastify 5 + @fastify/websocket + @fastify/static, @anthropic-ai/claude-agent-sdk **0.3.268** (pinned, matches CLI 2.1.268), simple-git, zod 4; Vite, React 19, Tailwind v4, marked + DOMPurify; `node:test`.

**Spec:** [docs/spec.md](../../spec.md).

---

## Verified SDK facts (from installed `sdk.d.ts`, 0.3.268)

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` → `Query` (AsyncGenerator<SDKMessage> + `interrupt()`, `close()`).
- Options used: `model`, `effort` (`low|medium|high|xhigh|max`), `cwd`, `settingSources` (`user|project|local`), `permissionMode` (`default|acceptEdits|plan|...`), `canUseTool(toolName, input, {signal, toolUseID, title, ...})` → `{behavior:'allow', updatedInput?} | {behavior:'deny', message, interrupt?}`, `mcpServers`, `allowedTools`, `disallowedTools`, `resume`, `abortController`, `skills`, `stderr`.
- `createSdkMcpServer({name, version, instructions, tools, alwaysLoad})`, `tool(name, desc, zodRawShape, handler)` with handler returning `{content:[{type:'text', text}]}`.
- Result message: `{type:'result', subtype:'success'|'error_*', result?, errors?, total_cost_usd, usage, modelUsage: Record<model,{inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,costUSD}>, session_id}`.
- Prompt is passed as a one-message AsyncIterable (streaming input) so `canUseTool` and `interrupt()` are supported.

## Design decisions made while planning (recorded in `docs/DECISIONS.md`)

| # | Decision | Why |
|---|---|---|
| D1 | REST under `/api/*`, WS at `/ws` | Prod serves `web/dist` from `/`; prefix avoids route clashes |
| D2 | Web imports server types with `import type` from `server/src/types.ts` | One source of truth for row shapes, no shared package |
| D3 | After each autonomous Code stage the runner commits the worktree (`kanban: <title>`); diff = `git diff <base_sha>..kanban/<id>` | Agent is told not to commit; committing makes diff/merge/remove deterministic and lets `worktree remove` run without `--force` |
| D4 | Approve = `merge --no-ff` then `worktree remove` then `branch -d` (safe delete) | Keeps `git worktree list` / `git branch` clean after E2E |
| D5 | Discard = commit-all, `worktree remove`, `branch -D` | Discard is the explicit "throw away" action; unmerged branch needs `-D`. Never used elsewhere |
| D6 | Autonomous gate: `acceptEdits` + `canUseTool` auto-allows, except Edit/Write outside the worktree and Bash matching `git push|git reset|git checkout|git switch|git rebase|--force|branch -D` → deny | Autonomous = no human; worktree confines edits; block history-rewriting/escaping commands |
| D7 | Supervised: `permissionMode:'default'`; every `canUseTool` call becomes an approval card; board MCP tools pre-allowed | "Every write an approval card" (that project rule 2) |
| D8 | Plan stage runs with `disallowedTools: Edit, Write, NotebookEdit` | Plan must not edit; cheaper than plan-mode + ExitPlanMode round-trip |
| D9 | Chat follow-up reuses the task's latest run row (`resume` its `session_id`), cost accumulates | §6.2.5 "resume on the same run" |
| D10 | Supervised pipeline end → `review`; Approve on supervised = `done` (no merge) | Same human checkpoint for both modes |
| D11 | Boot recovery: runs `running|approval` → `failed` (`interrupted`), their tasks → `failed`; tasks still `queued` are re-enqueued; pending approvals → `expired` | §6.2.6 + the queue is in-memory |
| D12 | Stop: queued → `backlog`; running → abort, run+task `failed` with `stopped by user` (retryable) | Retry keeps working via stored `session_id` |
| D13 | Messages to a task are injected into that task's next stage prompt (last 20) and broadcast live | §6.3 "read by that task's next stage prompt" |
| D14 | `board_post_message` default target = parent task | Children report up to the parent; §8.4 |
| D15 | Plugin skills come from `installed_plugins.json` `installPath` (active version) and are flagged enabled via `settings.json` `enabledPlugins` | Cache holds stale versions (e.g. two `frontend-design` dirs) |

## File map

```
package.json                      workspaces + scripts (dev/build/start/test/typecheck)
scripts/dev.mjs                   spawns server (tsx watch) + web (vite), prefixes output
docs/spec.md, docs/DECISIONS.md, README.md
server/
  tsconfig.json
  src/config.ts                   PORT, HOST, STATE_DIR, DB path, caps
  src/types.ts                    Project, Task, Run, EventRow, Message, Approval, Milestone, Settings, Policy, Stage, WsMessage
  src/schema.sql                  §6.1 tables (+ tasks.summary, note, error, base_sha, skills_json)
  src/db.ts                       openDb(path) → DatabaseSync; migrations + settings seed; newId()
  src/repo.ts                     Repo class: typed CRUD for all tables (JSON columns parsed)
  src/bus.ts                      Bus (EventEmitter) publish(WsMessage)
  src/git/worktree.ts             isGitRepo, addWorktree, commitAll, diffTask, mergeTask, removeWorktree, listWorktrees
  src/engine/queue.ts             RunQueue (per-project FIFO, per-project cap, global cap, cancel, snapshot)
  src/engine/prompts.ts           buildStagePrompt(ctx)
  src/engine/gate.ts              autonomousGate(toolName, input, cwd)
  src/engine/boardMcp.ts          createBoardServer(repo, bus, {taskId, runId})
  src/engine/runner.ts            TaskRunner: queueTask, runPipeline, retry, stop, approve/reject/discard, chat, decideApproval, recover
  src/skills.ts                   parseFrontmatter, scanSkills({home, projectPath})
  src/app.ts                      buildApp(deps) → Fastify (routes + ws + static)
  src/routes/{projects,tasks,runs,approvals,milestones,skills,settings,ws}.ts
  src/index.ts                    open DB, recover, listen 127.0.0.1:4310
  test/{db,queue,worktree,prompts,gate,skills,runner,api}.test.ts
web/
  package.json, vite.config.ts, tsconfig.json, index.html
  src/main.tsx, src/index.css (tailwind), src/App.tsx
  src/lib/api.ts, ws.ts, format.ts, markdown.tsx
  src/views/Board.tsx, TaskDrawer.tsx, Roadmap.tsx, Sessions.tsx, Skills.tsx, Settings.tsx
  src/components/ProjectRail.tsx, NewTaskForm.tsx, PipelineEditor.tsx, Transcript.tsx, DiffView.tsx, NewProjectForm.tsx
```

---

### Task 1: Scaffold (done in planning session start)

- [x] `git init -b main`, root/server `package.json`, deps installed.
- [ ] Pin SDK exactly `0.3.268`, `@types/node` `^24`; add `server/tsconfig.json`; `.gitignore` (`node_modules`, `web/dist`, `.kanban/`).
- [ ] `docs/spec.md` holds the agreed design; `docs/DECISIONS.md` holds every decision with its reason.
- [ ] Commit `chore: scaffold workspaces`.

### Task 2: DB + schema (TDD)

**Files:** `server/src/{config,types,db}.ts`, `server/src/schema.sql`, `server/test/db.test.ts`

- [ ] Test first:

```ts
test("migrations are idempotent and settings seeded once", () => {
  const file = join(mkdtempSync(join(tmpdir(), "kdb-")), "k.db");
  const a = openDb(file);
  a.prepare("UPDATE settings SET value=? WHERE key='globalCap'").run("5");
  a.close();
  const b = openDb(file);                       // second open re-runs migrations
  const tables = b.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  for (const t of ["projects","tasks","runs","events","messages","approvals","milestones","settings"]) assert.ok(tables.includes(t));
  assert.equal((b.prepare("SELECT value FROM settings WHERE key='globalCap'").get() as any).value, "5"); // not re-seeded
  const models = JSON.parse((b.prepare("SELECT value FROM settings WHERE key='models'").get() as any).value);
  assert.deepEqual(models.map((m: any) => m.id), ["claude-fable-5-1","claude-opus-5","claude-sonnet-5","claude-haiku-4-5-20251001"]);
});
```

- [ ] Run `npm test` → FAIL (module missing). Implement `openDb`: `new DatabaseSync(file)`, `PRAGMA journal_mode=WAL; foreign_keys=ON`, `exec(schema.sql)`, `addColumnIfMissing` helper, `INSERT OR IGNORE` seeds for `models`, `defaultPipeline`, `globalCap=8`, `defaultMaxConcurrent=3`, `stateDir`. Run → PASS. Commit.

### Task 3: Worktree helpers (TDD on a temp repo)

**Files:** `server/src/git/worktree.ts`, `server/test/worktree.test.ts`

API: `isGitRepo(p)`, `addWorktree(projectPath, taskId) → {path, branch, baseSha}` (also appends `.kanban/` to `<git-common-dir>/info/exclude` once), `commitAll(wtPath, msg) → boolean`, `diffTask(projectPath, baseSha, branch) → {files:[{file,status,patch}], stat}`, `mergeTask(projectPath, branch, msg)`, `removeWorktree(projectPath, taskId, {deleteBranch:'safe'|'force'|false})`, `listWorktrees(p)`.

- [ ] Test: init temp repo with one commit → `addWorktree` → dir + branch exist, exclude has `.kanban/` → write `hello.md` in wt → `commitAll` true → `diffTask` lists `hello.md` status `A` → `mergeTask` → file in main checkout, log has merge commit → `removeWorktree(safe)` → `listWorktrees` length 1, `git branch` only `main`. Second test: discard path with `force` on unmerged branch.
- [ ] FAIL → implement with simple-git → PASS → commit.

### Task 4: Queue (TDD)

**Files:** `server/src/engine/queue.ts`, `server/test/queue.test.ts`

```ts
type QueueItem = { taskId: string; projectId: string };
class RunQueue {
  constructor(opts: { globalCap: () => number; projectCap: (projectId: string) => number; start: (item: QueueItem) => Promise<void> });
  enqueue(item: QueueItem): void;      // no-op if already waiting/running
  cancel(taskId: string): boolean;     // removes a waiting item
  isQueued(taskId): boolean; isRunning(taskId): boolean;
  snapshot(): { running: string[]; waiting: string[] };
}
```

- [ ] Tests: (a) project cap 2, enqueue 4 same project → 2 running, finish one → next in FIFO order; (b) global cap 3 across 3 projects each cap 3, enqueue 6 → 3 running; (c) cancel waiting item; (d) start() rejection still frees the slot.
- [ ] FAIL → implement (pump loop scanning waiting list in order, skipping items whose project is at cap) → PASS → commit.

### Task 5: Prompts + autonomous gate (TDD)

**Files:** `server/src/engine/{prompts,gate}.ts`, tests.

```ts
type PromptCtx = { stage: StageName; customPrompt?: string; mode: Mode; task: {id,title,spec_md}; branch?: string|null;
  parent?: {id,title,spec_md}|null; siblings: {id,title,status,summary}[]; previousResult?: string|null;
  skills: string[]; messages: {from: string; body: string}[] };
buildStagePrompt(ctx): string
autonomousGate(toolName, input, cwd): { behavior: "allow", updatedInput } | { behavior: "deny", message }
```

- [ ] Prompt test asserts presence of: stage heading, task spec, `## Parent task` + parent spec, each sibling `title — status — summary`, `## Previous stage result` + text, "use the `pdf` skill", inbound message bodies, custom prompt for `custom` stage, worktree note for autonomous.
- [ ] Gate tests: `Edit` inside cwd allow; `Write` to `C:\other\x` deny; `Bash git push` deny; `Bash npm test` allow; `Read` allow.
- [ ] FAIL → implement → PASS → commit.

### Task 6: Repo + bus + board MCP

**Files:** `server/src/{repo,bus}.ts`, `server/src/engine/boardMcp.ts`

- [ ] `Repo` methods: projects (list/get/create/update), tasks (list by project/parent, get, create, update, delete, children, siblings), runs (create/get/update/listByTask/listAll with task+project names, latestForTask, active), events (insert, listAfter), messages (insert, listForTask, listFromTask), approvals (create, get, decide, pendingForRun, expireAllPending), milestones (list/create/update/delete), settings (getAll/get/set).
- [ ] Board server tools exactly per §6.3 with zod shapes; handlers call Repo and `bus.publish`. `board_create_subtasks` forces `mode:'supervised'` when project policy forbids autonomous.
- [ ] Covered by runner test (Task 7) calling handlers directly. Commit.

### Task 7: TaskRunner (TDD with fake `queryFn`)

**Files:** `server/src/engine/runner.ts`, `server/test/runner.test.ts`

`new TaskRunner({ repo, bus, queryFn = query, git = worktree module })`

- [ ] Tests with a fake `queryFn` that yields `{type:'system', subtype:'init', session_id:'s1'}`, an assistant message, then a `result` success with cost 0.01:
  1. supervised one-stage task → run row `success`, `session_id='s1'`, `cost_usd=0.01`, events persisted, task → `review`.
  2. autonomous task in project with `autonomous:'forbidden'` → `queueTask` throws `PolicyError` with message naming the policy.
  3. supervised approval gate: fake calls `options.canUseTool('Write', {...})` → approval row appears, task status `approval`; `decideApproval(id,'deny')` → fake receives `{behavior:'deny'}`; status back to stage status.
  4. failure result → task `failed`, run `error`; `retry` re-runs that stage with `resume:'s1'`.
  5. `recover()` marks running runs failed `interrupted`.
- [ ] FAIL → implement → PASS → commit.

### Task 8: Skills scanner (TDD)

**Files:** `server/src/skills.ts`, `server/test/skills.test.ts`

- [ ] `parseFrontmatter` handles plain, quoted, and `>`/`|` block values. `scanSkills({home, projectPath})` over a fake home with `skills/a/SKILL.md`, `plugins/installed_plugins.json` → installPath with `skills/b/SKILL.md`, `settings.json` enabledPlugins, and project `.claude/skills/c/SKILL.md` → groups user/plugin/project with `plugin:skill` qualified names.
- [ ] FAIL → implement → PASS → commit.

### Task 9: HTTP API + WS

**Files:** `server/src/app.ts`, `server/src/routes/*.ts`, `server/src/index.ts`, `server/test/api.test.ts`

- [ ] Routes per §6.4 under `/api`. Errors: zod validation → 400; `PolicyError` → 409 `{error}`; not found → 404.
- [ ] `api.test.ts` (Fastify `inject`): create project with forbidden policy, create autonomous task → `POST /api/tasks/:id/queue` → 409 with policy text; supervised queue → 200 (runner stubbed).
- [ ] WS: `/ws` sends every `bus` message as JSON.
- [ ] Commit.

### Task 10: Smoke run (real SDK)

- [ ] `server/scripts/smoke.ts`: one-stage `claude-haiku-4-5-20251001` run in a temp folder, prompt "Reply with the word PONG", with the board MCP attached; print session_id, result, cost. Must PASS before UI work.

### Task 11: Web app

- [ ] Vite + React 19 + Tailwind v4 scaffold, proxy `/api` + `/ws` → 4310.
- [ ] `lib/api.ts` (typed fetch), `lib/ws.ts` (reconnecting socket + `useWs(handler)`), `lib/markdown.tsx` (marked + DOMPurify).
- [ ] App shell: left project rail (+ add project form with policy), top nav Board/Roadmap/Sessions/Skills/Settings.
- [ ] Board: status columns, cards (title, mode chip, stage dots w/ model, summary, cost, Queue/Stop), drag Backlog↔Queued only, new task form.
- [ ] TaskDrawer tabs: Spec, Pipeline, Transcript, Approvals, Diff, Subtasks, Messages, Chat + actions (Queue, Retry, Stop, Approve, Reject, Discard).
- [ ] Sessions, Skills (groups, Open, Attach to task), Settings (models add/remove, default pipeline, caps), Roadmap (milestones as columns, add, move tasks).
- [ ] `npm run typecheck` clean; commit.

### Task 12: Dev script, README, verification §8, cleanup

- [ ] `scripts/dev.mjs`; README (what, run, modes, policies, roadmap §9).
- [ ] Run §8.1–8.6; record results in README "Verification" section; clean scratch repo/worktrees/DB rows; commit.
