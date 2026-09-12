# Setup checklist — design

**Date:** 2026-09-12 · **Status:** approved

## Problem

A new user installs Claude Kanban and finds out what is missing one failure at a time. Today the only readiness check is Claude login (`GET /api/health`), and it cannot tell "CLI not installed" from "logged out". Everything else fails silently or with someone else's error:

- git not installed looks exactly like "folder is not a git repo" (`isGitRepo` swallows every error).
- No git identity: approve fails with "Please tell me who you are".
- Browser checks are on by default, but nothing checks that `@playwright/mcp` has a browser to launch; runs quietly lose the look step.
- Ollama, agent CLIs (codex, gemini, kimi, opencode) and provider keys are only checked by the Providers → Test button.

## Goal

One Setup page that says what this machine has, what is missing, and fixes it with the least effort: one click where a known, safe command exists; a supervised Claude session where installing is OS-specific and messy; a copyable command always.

## Decisions (from brainstorming)

- **Fix method: hybrid.** Built-in commands run by the board for known fixes; "Fix with Claude" for the rest; copy-command on every row.
- **Placement: Setup page + nudge.** A "Setup" view in the sidebar. The board opens it on launch while a required item fails; afterwards a top-bar chip ("2 to fix") while a required or recommended item fails. Optional items never nag.
- **Fix with Claude runs inside the board**, as a supervised task in a hidden built-in "Setup" project, so every command is an approval card and progress shows in the usual task drawer.

## The checks

One registry, `server/src/setup/checks.ts`. A check is:

```ts
interface SetupCheck {
  id: string;
  title: string;
  level: "required" | "recommended" | "optional" | "info";
  why: string;                       // one sentence: which feature needs it
  applies(ctx): boolean;             // e.g. Ollama only when an Ollama provider exists
  detect(ctx): Promise<{ ok: boolean; detail: string }>;  // version found, or what is wrong
  fix: { run?: FixCommand; claude?: string /* goal */; link?: string };
  manual: Partial<Record<NodeJS.Platform, string>>;       // copyable commands per OS
}
```

| id | Level | Detect | Fix |
|---|---|---|---|
| `node` | required | `process.versions.node` ≥ 24 | info only — the server could not run without it |
| `claude-login` | required | `auth status` through the **SDK's bundled `claude` binary** (resolved from `@anthropic-ai/claude-agent-sdk-<platform>`), falling back to a global `claude`; `ANTHROPIC_API_KEY` in the env also counts | existing login terminal, now launching the bundled binary. No separate global CLI install is needed any more |
| `git` | required | `git --version` | Claude (winget / brew / apt), manual commands |
| `git-identity` | required, only when git is present | `git config --global user.name` and `user.email` | inline form → `git config --global user.name <v>` / `user.email <v>` (validated) |
| `browser` | recommended, only when Browser checks is on | a browser `@playwright/mcp` can launch: Chrome, else Edge, else a Playwright Chromium in the ms-playwright cache | one click: install Chromium with the Playwright version the MCP server uses; the board passes `--browser` for whichever was found |
| `notifications` | optional | browser `Notification.permission` (checked in the web client) | one click: request permission |
| `ollama` | optional, only when an Ollama provider exists | `GET http://localhost:11434/api/version` | Claude (install Ollama), manual link |
| `ollama-models` | optional, per model a pipeline/tier uses on an Ollama provider | `/api/tags` lists it | one click: `ollama pull <model>` (model id from the provider config, validated) |
| `cli-<preset>` | optional, per CLI provider added | `<command> --version` | one click `npm i -g <pkg>` for codex (`@openai/codex`) and gemini (`@google/gemini-cli`); Claude for kimi / opencode; login shown as a command to copy |
| `provider-key-<id>` | optional, per provider whose key is required and missing | `SecretStore.has` | link to Settings → Providers |
| `plugins` | info | — | lists what runs load; link to the Skills view. No board feature needs a plugin |

The git error message also changes: when git is missing, the autonomous-mode refusal says "git is not installed" instead of "not a git repository".

## Server

- `GET /api/setup` → `{ checks: CheckResult[], summary: { required: n, recommended: n } }` where `CheckResult = { id, title, level, why, ok, detail, fixes: ("run" | "claude" | "link")[], manual: string | null, link?: string, running: boolean, taskId?: string }`. Results cache ~10 s; `?fresh=1` re-detects.
- `POST /api/setup/:id/fix` `{ kind: "run", input? }` runs the check's built-in command. Only built-in argv; the only user values are the git name/email and the model id, validated (`^[^\n\r"]{1,100}$`, email shape, model id `^[\w.:/-]{1,100}$`). One fix at a time per check; 10-minute timeout; output streams as `setup.output` bus events `{ id, chunk }`; ends with `setup.updated` carrying the re-detected result. No shell except where Windows `.cmd` shims require it (fixed argv, same pattern as `health.ts`).
- `POST /api/setup/:id/fix` `{ kind: "claude" }` creates the Setup task (below) and returns it.
- **Setup project.** `projects.system INTEGER` (LATER_COLUMNS). `repo.setupProject()` creates on first use: name "Setup", path `<stateDir>/setup` (created), policy worktrees/autonomous forbidden, maxConcurrent 1. `listProjects()` excludes system projects; `listProjects({ includeSystem: true })` for the places that need all (the runner's scheduling, if it iterates projects). `GET /api/projects` never shows it.
- **Setup task.** type chore, supervised, one custom stage pinned to Claude (same rule as the bootstrap), effort medium. Spec: the goal, the OS and shell, what detect found, the manual commands as hints, "Stop as soon as `<detect command>` succeeds. Install only this; change nothing else on the machine. Ask before anything that needs admin rights." Tagged `setup: <checkId>` (tasks column). When the task reaches review/done, the check re-detects and publishes `setup.updated`.
- Login and Node never offer Claude (Claude itself needs them).

## Web

- `View` gains `"setup"`; sidebar entry "Setup" with a count badge.
- `views/Setup.tsx`: groups Required / Recommended / Optional / Info. Each row: status dot, title, why, detail (version or error), and buttons [Install] [Fix with Claude] [Copy command] [Re-check]. A running one-click fix shows its streamed output inline. A running Claude fix shows "Claude is working on it — open" which opens the Setup task in the task drawer (approval cards included). The git identity row expands into a two-field form.
- On launch: if any required check fails, the router lands on `setup` instead of `board` (only when no explicit view is in the URL).
- The Setup tab in the top nav carries a count (required + recommended failing). The existing `LoginBanner` is replaced by this chip plus the Setup row; the login button keeps working from the row.
- The notifications row is detected and fixed client-side (it is the browser's permission, not the machine's).

## Error handling

- Every detector has a timeout (5 s) and turns any error into `ok: false` with the message as `detail`; the page never fails as a whole.
- A one-click fix that exits non-zero keeps its output visible and offers "Fix with Claude" next to it.
- A Claude fix that ends without the check passing leaves the row failing with "Claude finished, but the check still fails" and the task link.

## Testing

- `server/test/setup.test.ts`: registry filtering by `applies` (Ollama only with an Ollama provider, identity only with git); detect results with injected command runners (no real installs); fix validation (rejects bad names/emails/model ids, unknown check, check without that fix); run fix streams and re-detects (fake runner); Claude fix creates a supervised, Claude-pinned task in the hidden Setup project; `GET /api/projects` excludes it; the bundled-binary resolver.
- Web: typecheck and build; browser check of the page on a scratch state dir (a fresh machine shape: missing identity, browser checks on).

## Out of scope

- Project-level problems (repo with no commits, dirty tree) — they belong in the add-project dialog.
- The macOS/Linux bug where a missing agent CLI reads as success (`spawn.ts:114`, `translate.ts`); tracked separately.
- Installing Node or the board itself.
