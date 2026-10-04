# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Claude Kanban — working notes

A board that runs Claude Code sessions as tasks. `server/` is the Fastify + SQLite engine, `web/` the
React board, `docs/DECISIONS.md` the log of every decision worth remembering (D1…; add one when you make
a call someone would otherwise undo).

## Before you finish

```bash
cd server && npx tsc --noEmit && npm test
```

```bash
cd web && npx tsc --noEmit -p . && npm run build
```

The board serves `web/dist`, so a UI change needs that build. Restart the board to pick up server
changes: run `Start Claude Kanban.cmd` again — it stops an older instance when the code on disk is newer.

Every feature change also updates what tells people about it: the **Tour** (`web/src/components/tour/features.ts`),
the **Welcome** pop-up, the **Setup** checklist where it applies, and the **README**.

## Running and testing

```bash
cd server && node --disable-warning=ExperimentalWarning --import tsx --test test/chat.test.ts
```

One test file; add `--test-name-pattern="part of the test's name"` for one test. Tests never call a
model: they pass a fake `QueryFn` (`server/test/helpers.ts` — `setup()` gives a repo, bus, runner and a
temp project; `fakeQuery()` scripts the SDK messages). Known flaky under load: livebrowser "a watched
task streams its page" — re-run it alone before chasing it.

- `npm run dev` (root): API on :4310 (tsx watch) and Vite on :5173, which proxies to it.
- `node scripts/test-board.mjs`: a second board on :4320 with its own state folder (`KANBAN_PORT`,
  `KANBAN_STATE_DIR`). Use it to try anything that runs real tasks — one board per state folder is
  enforced (`instanceLock.ts`), and starting the server on the default folder rewrites the state of
  the board you actually use (boot recovery fails whatever was running).
- `server/scripts/measure-overhead.ts`, `helper-smoke.ts`, `smoke.ts`: real Haiku runs (cents). A cost
  claim is measured with these or a whole-task A/B on the test board before it ships (D272–D274).

## How it fits together

- **One process, one SQLite file.** `server/src/index.ts` takes the instance lock, opens the db
  (`db.ts`: schema, `LATER_COLUMNS` migrations, seeded settings), runs `runner.recover()`, starts the
  scheduler and the Fastify app. All rows go through `repo.ts`; every change is published on `bus.ts`
  and pushed to the browser over `/ws` (`routes/ws.ts` → `web/src/lib/ws.ts` / `store.tsx`).
- **A setting** lives in five places: the `Settings` type (`types.ts`), its seed (`db.ts`), its read
  with a fallback (`repo.getSettings`), its zod rule (`routes/settings.ts`), and its control in
  `web/src/views/Settings.tsx`. Miss one and it silently never saves or never loads.
- **The engine** is `engine/runner.ts` (`TaskRunner`): the queue starts `runPipeline`, which runs each
  stage through `runQuery`/`streamStage` — that is where the SDK `Options` are built (model, effort,
  tools, MCP servers, hooks, budget). Stage prompts come from `engine/prompts.ts`. Autonomous tasks run
  in a git worktree (`git/worktree.ts`, `.kanban/wt/<task>`) behind `engine/gate.ts` (enforced in a
  PreToolUse hook and in `canUseTool`); supervised tasks turn each write into an approval card.
- **Every run gets the board as tools**: `engine/boardMcp.ts` (summary, subtasks, messages, ask,
  report blocked, memory). The side chat is `engine/chat.ts` with its own tools in `chatBoard.ts`
  (read cards and their progress, create/queue/schedule, message a task through `runner.chat`).
- **Other models**: `engine/providers/` — a stage, tier, critic or vision call can run on an
  Anthropic-compatible endpoint, an OpenAI-compatible API (text only) or another agent's CLI.
- **The web imports from the server** (`../../server/src/types.ts` and pure helpers such as
  `engine/claudeModels.ts`, `engine/checklist.ts`). Keep those modules free of Node-only imports.

## Publishing

The public repo is published from the working repo with one script, which squashes the current tree
onto the public `main` as a single commit:

```bash
node scripts/publish.mjs --message "What changed, in a line" --remote public
```

Name the remote that points at the **public** repo (`origin` in a clone of the public repo, `public`
in the working one). The script refuses a remote whose URL is a `-private` repo, and moves local
`main` only when publishing to `origin` (D242). Leave out `--push` to see exactly what would be
published first; add it only when that list is right.

Everything private is handled by the gitignored `.claude/publish.local.json`, which must never be
committed: `exclude` (paths left out), `replace` (real names swapped for neutral ones in the published
copy only — the working tree keeps the real ones, D214, D247) and `blocklist` (checked after the
swaps; any hit refuses the publish), plus `names` / `nameSources` (people and companies, read fresh
from the private data on every publish) and `allow`.

**Follow the `publish-public` skill** (`.claude/skills/publish-public/SKILL.md`) for every publish. The
script scans each added line and the message (`scripts/publish-scan.mjs`, D369): names from the
private data, your board's own ids, emails, your home folder and key shapes are refused; big amounts
and unknown web addresses need `--reviewed`. `--audit` scans what is public already.

Rules that do not change:

- Never push a working branch, or its history, to the public repo.
- Docs and test fixtures are where private names slip in: prefer neutral names (`C:\work\proj`,
  `fix_access.py`) from the start, and add a `replace` pair when a real one is needed.
- A published commit message is public too: describe the change, not the customer or the system it
  was found on.

## House style

- Comments say **why**, not what; a comment that explains a trap earns its place, one that narrates the
  next line does not.
- Tests are named as the behaviour they protect, in a sentence.
- Anything a user sees — a label, a hint, an error — is written for someone who is not a programmer.
