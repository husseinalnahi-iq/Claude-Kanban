# Schedules, side chat and suggested skills

Three features, built and shipped in this order. Each one updates the Tour, Welcome, Setup and README when it lands.

Decisions the user made:
- Chat reads the project and makes cards, but never edits code.
- Schedules offer a start time, repeating days, "when my limit resets" and "keep the PC awake".
- Skills install for all projects.
- The features ship one by one.

---

## 1. Schedules: "so I can sleep and AI work"

### What the user sees
- **New task form and the task drawer:** a **When** control with four choices:
  - **Now**: queue it, as today.
  - **Later**: pick a date and time.
  - **When my limit resets**: wait for the next reset of the Claude 5-hour window.
  - **Repeat**: pick days (Mon to Sun chips) and a time.
- **A scheduled card stays in Backlog** with a clock badge ("⏰ Tue 02:00", "⏰ after reset", "↻ Mon Wed Fri 03:00"). Clicking the badge lets you change or cancel it. It has a **Start now** button.
- **Schedules panel:** opened from a clock button in the board header. It lists every one-time start and every repeating schedule for the project. Each can be paused, edited, run now or deleted. Rows slide in and fade out.
- **Keep this computer awake** (Settings → Runs & limits, on by default). While anything is queued, running or scheduled, Windows is told not to sleep. The screen can still turn off.
  - The setting says plainly that a closed laptop lid can still send it to sleep, depending on Windows' power settings.

### Behaviour
- **One-time start:** at the time, the card is queued through the normal `queueTask`, so caps, dependencies, usage limits and approvals all still apply.
  - If it can't queue (for example it's blocked by a dependency), the card gets a note and nothing is lost.
- **When my limit resets:** queued at the reset time known from the usage meter, plus the same 90 s margin auto-resume uses. With no known reset, it queues straight away.
- **Repeat:** a schedule is a *template*. Each time it fires, it creates a fresh card from the template (title plus the date, e.g. "Nightly tests · Mon 12 Sep"), then queues it. The template is never run itself.
  - "Repeat this card" in the drawer creates a template from an existing card.
- **Missed times** (PC off or board closed): on start, anything overdue fires **once**. A repeat never fires once per missed day.
- **Timers:** one timer is armed to the earliest due item, the same pattern as `armResume`. It's re-armed on every change and on `recover()`. All times are in the computer's local time zone.
- **Chat** (feature 2) gets a `board_schedule_task` tool, so "run this every night at 3" works from chat.

### Data
- `tasks.start_at TEXT NULL`: an ISO time, or the literal `reset`.
- `schedules` table with these fields:
  - `id`, `project_id`, `title`, `spec_md`, `mode`, `type`
  - `pipeline` and `skills` (JSON)
  - `days` (JSON array of numbers 0–6) and `time` ("HH:MM")
  - `enabled`, `next_run_at`, `last_run_at`, `last_task_id`, `created_at`

### Code
- `server/src/engine/scheduler.ts` holds three things:
  - The pure `nextOccurrence(days, time, from)`, unit-tested including DST and week wrap.
  - `dueItems(now)`.
  - A `Scheduler` class that owns the timer and calls runner hooks.
- `server/src/engine/keepAwake.ts`:
  - Windows: a hidden PowerShell child that calls `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` and waits. Killing the child releases it.
  - macOS: `caffeinate -i`.
  - Linux: `systemd-inhibit` when present.
  - It starts and stops from the board state and never throws.
- Routes: `POST /tasks/:id/schedule`, `DELETE /tasks/:id/schedule`, and CRUD on `/projects/:id/schedules` plus `/schedules/:id/run`.
- Tests: `nextOccurrence`, a missed-while-off catch-up that fires only once, a template creating a new card each time, and cancelling.

---

## 2. Side chat: talk about the project, get cards made

### What the user sees
- A **Chat** button in the top bar (shortcut `c`) slides a panel in from the right, about 440 px wide. The board stays visible and usable behind it. It slides out with Esc or ×.
- **Thread list** at the top of the panel:
  - The current chat, **+ New chat**, and a list of recent chats for this project.
  - **Archive** hides a chat (it slides away).
  - An **Archived** section can restore or delete chats for good.
  - Each chat takes its title from its first message and can be renamed.
- **Messages** stream in word by word, rendered as markdown.
  - Tool use shows as quiet lines, e.g. "read `server/src/db.ts`".
  - Cards the chat made appear as small card chips with **Open** and **Start** buttons.
  - A **Stop** button interrupts a reply.
- **Header:** a model picker (the existing ProviderPicker and ModelCombobox, Claude only in v1) and the chat's running cost.

### Behaviour
- Each chat is one Claude Code session in the project folder, resumed with `resume: session_id` on every message.
  - Tools: `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, plus a chat board server.
  - `Edit`, `Write`, `Bash` and `NotebookEdit` are disallowed.
  - It loads the project's CLAUDE.md (`settingSources: ["project"]`). It doesn't load user MCP servers (`strictMcpConfig`), which keeps it cheap.
- Chat board tools:
  - `board_list_tasks`, `board_get_task`, `board_memory`
  - `board_create_task` (always into Backlog, with the project's default pipeline and mode rules via `allowedMode`)
  - `board_update_task` (only Backlog/failed cards: title, spec, labels, priority)
  - `board_queue_task`
  - `board_schedule_task`
- **Default model:** Sonnet 5 at medium effort, set in Settings → Chat. It's a balance of quality and price for questions about code; the user can pick Haiku for cheap chat or Opus for hard design talks.
- Replies stream to the browser over the existing websocket (`chat.delta`, `chat.message`, `chat.updated`). A chat's cost is added to the dashboard as "Chat".
- Only one reply per chat at a time. Several chats can be open in parallel.

### Data
- `chats`: `id`, `project_id`, `title`, `session_id`, `model`, `effort`, `cost_usd`, `archived_at`, `created_at`, `updated_at`.
- `chat_messages`: `id`, `chat_id`, `role` (`user` | `assistant` | `tool`), `text`, `meta` JSON (e.g. created card ids), `ts`.

### Code
- `server/src/engine/chat.ts`: `ChatService` with `send`, `stop` and `history`. `queryFn` is injected so tests don't call Claude.
- `server/src/engine/chatBoard.ts`: the chat board tools, as testable handlers plus the MCP wrapper, reusing `boardHandlers` pieces.
- `server/src/routes/chats.ts`.
- `web/src/components/chat/ChatPanel.tsx`, `ChatThreadList.tsx`, `ChatMessage.tsx`.
- Tests: create, archive, restore and delete; tool handlers creating Backlog cards; code-edit tools refused; resume id stored and reused.

---

## 3. Suggested skills: one click in, one click out

### What the user sees
- A **Suggested** section at the top of the Skills tab. Each card shows the name, one plain sentence on what it does for you, and badges: *Free*, *Works unattended*, *Web projects*, *Needs Python*.
  - A card also shows "Good for this project" when the project matches, e.g. React in `package.json`.
  - **Install** shows a progress shimmer, then a tick. The card flips to Installed with a **Remove** button, and the skill appears in the list below with a highlight.
  - Remove fades it back to Install.
- **Install the starter pack** installs the four essentials in one go.
- **Already built into Claude Code:** a small row naming `/code-review`, `/simplify`, `/security-review` and `/verify`. There's nothing to install.

### The list

| Skill | What it does for you | Kind | In starter pack |
|---|---|---|---|
| verification-before-completion (obra/superpowers) | Must show the tests passing before it says "done" | skill | yes |
| systematic-debugging (obra/superpowers) | Finds the real cause of a bug before changing code | skill | yes |
| test-driven-development (obra/superpowers) | Writes a failing test first, so the fix is proven | skill | yes |
| Ponytail (DietrichGebert/ponytail) | Writes less code: checks whether it already exists first. About 10% cheaper per task in JetBrains' independent test | plugin | yes |
| frontend-design (anthropics) | UI changes look designed, not generic | skill / plugin | web projects |
| code-simplifier (anthropics) | Tidies freshly written code without changing what it does | plugin | |
| pr-review-toolkit (anthropics) | Extra reviewers for tests, hidden errors and types | plugin | |
| react-best-practices (vercel-labs) | React habits that avoid slow, buggy pages | skill | React projects |
| graphify (Graphify-Labs) | A map of a big codebase so the agent reads less | tool (Python) | no, big projects only |

- **Left out on purpose:** skills that stop and ask a person questions mid-run and would stall an unattended task. That covers superpowers brainstorming, finishing-a-development-branch and executing-plans, and feature-dev.
- **The whole superpowers plugin is not installed**, only the three skills above. Its start-up hook pushes every run towards asking questions.
- **Ponytail note shown on its card:** "Pushes for less code; if you also use test-first, watch that tests still get written."
- **graphify verdict shown on its card:** "Worth it on large, unfamiliar codebases. On a board of small tasks it mostly adds setup and a map that goes stale after each change."
  - Install is offered only when `uv` or `pipx` is found. Otherwise the card shows the command and a guide link.

### Behaviour
- **Skills** (a single SKILL.md folder):
  - A shallow sparse `git clone` of the source repo into a temp folder, then the one skill folder is copied into `~/.claude/skills/<name>/`. No symlinks.
  - A `.kanban-installed.json` marker records the source and commit.
  - Remove deletes the folder **only when that marker exists**. A skill you installed yourself is never touched.
- **Plugins** (Ponytail, code-simplifier, pr-review-toolkit):
  - Install runs `claude plugin marketplace add <repo>` when needed, then `claude plugin install <plugin>@<marketplace>`.
  - Remove runs `claude plugin uninstall`. Only plugins in this catalog can be removed from here.
  - Runs pick them up through "Load your global plugins", and the card says so when that setting is off.
- **Tools** (graphify): `uv tool install graphifyy` then `graphify install`. Remove runs `uv tool uninstall graphifyy`.
- **Status** comes from the existing `scanSkills` plus `installed_plugins.json`, so a skill installed outside the board still shows as Installed.
- Installs run in the background and publish progress on the websocket. A failure shows the last lines of output and a Retry button.

### Code
- `server/src/skills/catalog.ts`: the curated list, with pinned repo, path and kind. `server/src/skills/install.ts`: install, remove and status, with injectable `exec` for tests.
- Routes `GET /skills/suggested`, `POST /skills/suggested/:id/install`, `POST /skills/suggested/:id/remove`.
- `web/src/views/skills/Suggested.tsx`.
- Tests:
  - Remove refuses a folder without a marker.
  - Install copies only the one folder.
  - Plugin commands are built correctly.
  - Status reads existing installs.

---

## Guidance updates (every feature)
- **Tour and Welcome** (`tour/features.ts`): add three features:
  - Schedules is a headline: "Queue work for the night".
  - Side chat is a headline.
  - Suggested skills.
- **SHORTCUTS:** add `c` for chat, and correct the tab count.
- **README:** add a newcomer section for each feature ("Let it work while you sleep", "Ask about your project", "Add good skills") and a Keep-awake note under troubleshooting.
- **Setup:** an optional row, "Recommended skills: 2 of 4 installed", with an **Install** button.
- **Settings:** a Chat section (model and effort), plus Keep awake under Runs & limits.

## Out of scope for now
- Waking a sleeping PC (Windows wake timers).
- Chat on non-Claude providers.
- Image paste in chat.
- Editing code from chat.
