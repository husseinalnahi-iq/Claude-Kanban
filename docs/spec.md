# Claude Kanban — approved design (v1)

The design agreed before the build started (2026-09-11). It is kept as written, so it can be compared against what was actually built; everything decided since is in [DECISIONS.md](DECISIONS.md), which supersedes this where they differ.

## 6. Design (approved)

### Repo layout
```
Claude Kanban/
  package.json            # npm workspaces: server, web; scripts: dev (both), build, test
  README.md               # what it is, how to run, run modes, project policies
  docs/spec.md            # this §6 verbatim (the approved design)
  server/                 # Node 24 + TypeScript (tsx for dev), Fastify + @fastify/websocket
    src/index.ts          # Fastify on 127.0.0.1:4310; serves web/dist in prod
    src/db.ts             # node:sqlite open + idempotent migrations (CREATE TABLE IF NOT EXISTS)
    src/schema.sql
    src/routes/*.ts       # projects, tasks, runs, approvals, milestones, skills, settings, ws
    src/engine/runner.ts  # TaskRunner: stage loop, query() call, event fan-out, cost capture
    src/engine/queue.ts   # per-project concurrency (default 3), global cap 8, FIFO
    src/engine/boardMcp.ts# createSdkMcpServer("board", tools in §6.4)
    src/engine/prompts.ts # stage prompt builders (plan / code / review / custom)
    src/git/worktree.ts   # add / diff / merge / remove via simple-git
    src/skills.ts         # scan user, project, plugin skills (SKILL.md frontmatter)
    test/*.test.ts        # node:test
  web/                    # Vite + React 19 + TypeScript + Tailwind (no component lib in v1)
    src/App.tsx           # left rail = projects; top nav = Board / Roadmap / Sessions / Skills / Settings
    src/views/Board.tsx, TaskDrawer.tsx, Roadmap.tsx, Sessions.tsx, Skills.tsx, Settings.tsx
    src/lib/api.ts, ws.ts
```
State: `%USERPROFILE%\.claude-kanban\kanban.db` + `logs\`. Worktrees: `<project>\.kanban\wt\<taskId>` (add `.kanban/` to the project's `.git/info/exclude`, never to its tracked `.gitignore`).

### 6.1 Data model (SQLite)
- `projects(id, name, path, policy_json, created_at)` — policy `{worktrees:"allowed"|"forbidden", autonomous:"allowed"|"forbidden", maxConcurrent:3, defaultPipeline:[…]}`
- `tasks(id, project_id, parent_id, milestone_id, title, spec_md, status, mode, pipeline_json, branch, worktree_path, position, created_at, updated_at)` — status `backlog|planning|queued|running|review|approval|done|failed`; mode `autonomous|supervised`; pipeline `[{stage:"plan"|"code"|"review"|"custom", model, effort, prompt?}]`
- `runs(id, task_id, stage, session_id, model, effort, status, started_at, ended_at, cost_usd, input_tokens, output_tokens, result_md, error)`
- `events(id, run_id, ts, type, payload_json)` — every SDK message
- `messages(id, task_id, from_task_id, from_run_id, body, ts)` — task-to-task context bus
- `approvals(id, run_id, tool_name, input_json, decision, decided_at, note)`
- `milestones(id, project_id, title, position, due_date, notes)`
- `settings(key, value)` — model list (seeded from §3, free-text add), default efforts

### 6.2 Engine
1. `mode=autonomous` → policy must allow; create worktree branch `kanban/<taskId>` from the project's current HEAD. `mode=supervised` → `cwd = project.path`, no branch.
2. Per pipeline stage: prompt = stage instructions + task spec + parent spec (if subtask) + sibling one-line summaries + previous stage `result_md` + attached skill names ("use the `<skill>` skill"). Call `query()` as in §5. Stream every message → `events` row + WebSocket broadcast. On `result` → `result_md`, `cost_usd`, tokens, `session_id`.
3. Status by stage: plan → `planning`, code → `running`, review → `review`. Failure → `failed` + `error`; "Retry stage" re-runs from that stage with `resume`.
4. Autonomous end → `review` with diff. **Approve** = `git merge --no-ff kanban/<id>` into the project's current branch + worktree remove + `done`. **Reject** = keep worktree, back to `backlog` with note. **Discard** = remove worktree + branch.
5. Supervised: `canUseTool` inserts an `approvals` row, broadcasts, awaits `POST /approvals/:id` → allow/deny. Status `approval` while waiting. Chat box → `POST /tasks/:id/message` → new `query()` with `resume` on the same run.
6. Queue: per-project FIFO with `maxConcurrent`; global cap 8. On server restart, rows in `running|approval` → `failed` with `error="interrupted"` (resumable via stored `session_id`).

### 6.3 Board MCP tools (every run gets them)
- `board_get_task(task_id?)` → spec, status, pipeline, messages (default: own task)
- `board_list_siblings()` → parent + siblings with status + last summary
- `board_post_message(to_task_id?, body)` → `messages` row; live-broadcast if target has a supervised run, else read by that task's next stage prompt
- `board_create_subtasks([{title, spec_md, mode?, pipeline?}])` → children in `backlog` (a Plan stage splits a big task; you queue them)
- `board_set_summary(text)` → one-line progress on the card

### 6.4 API
REST: `GET/POST/PATCH /projects`; `GET/POST/PATCH/DELETE /tasks` + `POST /tasks/:id/{queue,retry,approve,reject,discard,message}`; `GET /tasks/:id/diff`; `GET /runs?task=`; `GET /runs/:id/events?after=`; `POST /approvals/:id`; `GET/POST/PATCH /milestones`; `GET /skills?project=`; `GET/PATCH /settings`. WS `/ws` server→client: `event`, `task.updated`, `approval.requested`, `run.finished`.

### 6.5 UI
- **Board**: columns = statuses; card = title, mode chip, stage dots (plan/code/review) with model labels, live summary, cost, Queue/Stop. Drag only Backlog ↔ Queued.
- **TaskDrawer**: Spec (markdown) · Pipeline (stage rows: model dropdown + free-text id, effort, custom prompt) · Transcript (live, tool calls collapsed) · Approvals (Allow/Deny + note) · Diff (per file) · Subtasks · Messages · Chat (supervised follow-up).
- **Roadmap**: milestones as columns, tasks as cards, add/reorder. ("Generate roadmap" is §9.)
- **Sessions**: every run across projects — state, model, cost, elapsed; click → drawer.
- **Skills**: user / project / plugin groups from SKILL.md frontmatter; Open in editor; Attach to task.
- **Settings**: model list (+ free-text), default pipeline, concurrency, state dir.
- Dark theme, Tailwind, no component library.

