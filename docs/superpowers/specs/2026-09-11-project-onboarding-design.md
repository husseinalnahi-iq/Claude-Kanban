# Project onboarding — design

Date: 2026-09-11. Status: approved in conversation.

## Why

When a project is added, the board should make Claude work well in it from the first task: a good
`CLAUDE.md` and a verify command. Anthropic's guidance (code.claude.com/docs/en/memory,
/best-practices) is that instruction files stay **under 200 lines, specific, project-only**, and that
Claude needs **a check it can run**. So the board does not add a generic "best practices" prompt to
every stage — that would cost tokens on every run and dilute attention. It produces the two project
artifacts once, as a reviewed change, and lets Claude Code's own `/init` do what it already does
(it also reads Cursor rules and `AGENTS.md`).

## 1. Onboarding on add-project

The **Register a project** dialog gets an *Onboarding* section that adapts to the folder. The server
reports `kind: "code" | "empty"` for a path via `GET /projects/probe?path=…` (empty = no entries other
than `.git`, `.claude`, `.gitignore`, `.DS_Store`, `Thumbs.db`); the dialog calls it when the path
changes.

- **Folder has code** → checkbox **Set up CLAUDE.md with /init** (default on). On submit the
  project is created, then the existing `/init` task is queued (same code path as Settings → CLAUDE.md).
  If a project `CLAUDE.md` already exists the task is the "Improve" variant, as today.
- **Folder is empty** → checkbox **Bootstrap this project** (default on) with three fields:
  **Goal** (paragraph, required when the box is on), **Stack** (free text, placeholder "let Claude
  choose"), **How to verify** (free text, optional, e.g. `npm test`). On submit a bootstrap task is
  queued. The answers are stored on the project as `env.onboarding: { goal, stack, verify } | null`.
- Not a git repo yet → the task runs **supervised** in the folder (as `/init` does today); the
  bootstrap's first step is `git init`.

Settings → CLAUDE.md gains a **Bootstrap** button, shown only while the folder is still empty, that
opens the same three fields and queues the same task.

## 2. The bootstrap task

`POST /projects/:id/bootstrap` with `{ goal, stack?, verify? }`. It creates a task:

- title `Bootstrap the project`, type `chore`, mode autonomous where allowed and the folder is a git
  repo, otherwise supervised; pipeline: one `custom` stage, `tiers.balanced`, effort `high`.
- `spec_md` = goal, stack, verify answers, then the **Onboarding checklist** (below), then the rules:
  keep `CLAUDE.md` under 200 lines and specific; no example features; end with the single command
  that runs all checks on a line `VERIFY: <command>`.
- tagged `onboarding: "bootstrap"` (a new nullable `Task.onboarding` column, `"init" | "bootstrap"`)
  so approval can act on it (§3). The `/init` route sets `onboarding: "init"`.

### Onboarding checklist (setting `onboardingChecklist`, markdown, editable in Settings → Runs)

Shipped default:

```
- `git init` if the folder is not a repository; add a `.gitignore` for the stack.
- A minimal runnable skeleton for the stack — entry point, config, no example features.
- A test runner with one passing smoke test, and a lint or typecheck step.
- One command that runs every check (tests, lint, typecheck, build). Report it on the last line as `VERIFY: <command>`.
- `CLAUDE.md` under 200 lines: how to run, test and build; where things live; conventions that differ from the language's defaults; gotchas. Nothing Claude can read from the code itself.
- `.claude/rules/<area>.md` with `paths:` frontmatter only where a folder needs rules of its own.
- A short README: what it is and how to run it.
```

Schema: `z.string().max(8000)`. Empty string restores the default.

## 3. Verify command, set automatically

In `approveTask`, after the task is marked done, if `task.onboarding` is set and the project has no
`env.verifyCommand`:

1. Bootstrap: take the last `VERIFY: …` line of the run's `result_md` if present.
2. Otherwise (both kinds): read the project `CLAUDE.md` (first 12k chars) and ask `settings.triageModel`
   (one `query()`, `maxTurns: 1`, `settingSources: []`, like triage) for a JSON `{ "command": string | null }`
   naming the single command that runs the project's checks, or null when none is documented.
3. If a command comes back: `updateProject(env.verifyCommand)`, publish `project.updated`, add a
   board memory note `Verify command set to \`<cmd>\` from CLAUDE.md`, and post a task message
   `Verify command set to \`<cmd>\`. Change it in Settings → Project if it is wrong.`
4. Any failure is logged and ignored: approval itself never fails because of this step. It runs after
   `approveTask` returns (`setImmediate`), so approval stays fast.

Ordinary tasks (`onboarding` null) never trigger it.

## 4. Changes

Server: `Task.onboarding` column + migration; `ProjectEnv.onboarding`; `Settings.onboardingChecklist`
(+ patch schema, default); `GET /projects/probe`; `POST /projects/:id/bootstrap`; `/init` route sets
the tag; `approveTask` hook with `extractVerifyCommand()` in a new `engine/onboarding.ts`.

Web: `api.probeFolder`, `api.bootstrapProject`; dialog section; Settings → Runs textarea; CLAUDE.md
tab Bootstrap button (empty folders only).

Tests (`server/test/onboarding.test.ts`): folder probe (empty vs code, ignoring `.git`); bootstrap spec
contains the answers and the checklist; `VERIFY:` line parsed; extraction with a stubbed query fn sets
the command, ignores null, never overwrites an existing one; approving a normal task does nothing.

Out of scope: `CLAUDE_CODE_NEW_INIT` interview mode, editing `CLAUDE.md` from the board, any
per-stage prompt additions.
