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
- A **Recommended** section at the top of the Skills tab (named Suggested until it was folded together with main's Recommended list, D321). Each card shows the name, one plain sentence on what it does for you, and badges: *Free*, *Works unattended*, *Web projects*, *Needs Python*.
  - A card also shows "Good for this project" when the project matches, e.g. React in `package.json`.
  - **Install** shows a progress shimmer, then a tick. The card flips to Installed with a **Remove** button, and the skill appears in the list below with a highlight.
  - Remove fades it back to Install.
  - **Every card has an ⓘ next to its name** (D319). Hovering it, or tapping it on a touch screen, opens a short tooltip with three parts:
    1. **Unattended:** one of "Works unattended", "Works unattended, with a note" or "Needs a person"; every skill on the list today is one of the first two.
    2. **Watch out for:** costs, things it needs installed, where your data goes, licence.
    3. **Turning it off:** only where the usual switch does not cover it.
  - The text for each skill is in the table under "Tooltips" below. It lives in the catalog next to the skill, so a skill cannot be added without one.
- **Install the starter pack** installs the five essentials in one go.
- **Already built into Claude Code:** a small row naming `/code-review`, `/simplify`, `/security-review` and `/verify`. There's nothing to install.

### The list

| Skill | What it does for you | Kind | In starter pack |
|---|---|---|---|
| verification-before-completion (obra/superpowers, `skills/verification-before-completion`) | Must show the tests passing before it says "done" | skill | yes |
| systematic-debugging (obra/superpowers, `skills/systematic-debugging`) | Finds the real cause of a bug before changing code | skill | yes |
| test-driven-development (obra/superpowers, `skills/test-driven-development`) | Writes a failing test first, so the fix is proven | skill | yes |
| Ponytail (`ponytail@ponytail`, marketplace DietrichGebert/ponytail) | Writes less code: checks whether it already exists first. About 10% cheaper per task in JetBrains' independent test | plugin | yes |
| code-simplifier (`code-simplifier@claude-plugins-official`) | Tidies freshly written code without changing what it does | plugin | yes |
| frontend-design (`frontend-design@claude-plugins-official`) | UI changes look designed, not generic | plugin | web projects |
| pr-review-toolkit (`pr-review-toolkit@claude-plugins-official`) | Extra reviewers for tests, hidden errors and types | plugin | |
| react-best-practices (vercel-labs/agent-skills, `skills/react-best-practices`) | React habits that avoid slow, buggy pages | skill | React projects |
| document-skills (`document-skills@anthropic-agent-skills`, marketplace anthropics/skills: pdf, xlsx, docx, pptx) | Reads, makes and edits PDFs and Excel, Word and PowerPoint files | plugin | |
| playwright-cli (microsoft/playwright-cli, `skills/playwright-cli`) | Opens the web page it just built, clicks through it and takes screenshots | skill + tool | web projects |
| Context7 find-docs (upstash/context7, `skills/find-docs`) | Looks up a library's current docs instead of guessing from memory | skill | |
| Context7 plugin (`context7@claude-plugins-official`) | The same docs lookup, as a connection Claude can call at any time | plugin (MCP only) | |
| Emil Kowalski — design engineering (emilkowalski/skills, `skills/emil-design-eng`) | Interfaces that feel finished: animation timing, easing, responsive buttons | skill | web projects |
| Taste (Leonxlnx/taste-skill, `skills/taste-skill` → `design-taste-frontend`) | Landing pages and portfolios that don't look templated | skill | web projects |
| UI/UX Pro Max (`ui-ux-pro-max@ui-ux-pro-max-skill`) | A searchable design library, plus brand, banner and slide skills | plugin | web projects |
| MarkItDown (Microsoft's markitdown-mcp) | Claude reads PDFs, Word, Excel, PowerPoint and web pages as text | tool (its own Setup check) | |

Checked online on 2026-10-02 (D317):
- **Plugins come from `anthropics/claude-plugins-official`**, not the older copies in `anthropics/claude-code` (that repo is "All rights reserved"; the official marketplace is Apache-2.0).
- **The superpowers skills mention "your human partner"** (systematic-debugging after repeated failed fixes, test-driven-development for exceptions). Nothing to add: an autonomous run already reads "Nobody is watching this run", so such a question becomes a `board_ask` with a default (D239), not a stall.
- **Ponytail's "about 10%"** is JetBrains' measured 10.3% (July 2026, 80 paired tasks, no quality loss). Its own README claims about 20%; the card quotes the independent figure. It needs `node`, which the board already has.
- **Cost note shown on the code-simplifier and pr-review-toolkit cards:** "Its reviewer runs on Opus, so each use costs more than the task's own model."
- **react-best-practices:** the repo has no LICENSE file; only the skill's own header says MIT. Copy the one folder with its marker, as for any skill.

Added on 2026-10-02 (D318):
- **document-skills is installed only as a plugin, never copied.** Its LICENSE.txt is Anthropic's own terms ("All rights reserved"), not open source, so the board must not clone and copy the folders as it does for other skills.
  - It needs Python (pypdf, pdfplumber, openpyxl, python-pptx) and LibreOffice, which recalculates Excel formulas and converts files. The card shows the *Needs Python* badge and says when `soffice` is not found.
- **playwright-cli** is the one browser tool on the list. It runs without a visible window by default, and uses fewer tokens than the Playwright MCP.
  - Install runs `npm install -g @playwright/cli@latest`, then copies the skill folder into `~/.claude/skills/`. Do not use the tool's own `playwright-cli install --skills`: it writes into the current folder, which for a run is the task's worktree.
  - Remove deletes the skill folder (marker rule as above) and leaves the global npm tool alone, since the user may use it elsewhere.
- **find-docs** (MIT) runs `npx ctx7@latest` and needs no key; a `CONTEXT7_API_KEY` only raises the rate limit.
  - The card says that its questions go to Context7's service. The skill itself tells the agent to leave secrets and private code out of them.
- **The Context7 plugin is offered too** (D319). This is a list of suggestions, and whatever is installed can be switched off. It is only an MCP server (`https://mcp.context7.com/mcp`), with no skills in it.
  - Every run that loads global plugins connects to it, even a task that needs no docs.
  - The two Context7 cards say you need only one of them.

Folded in on 2026-10-02 (D321): main's Recommended list (D310–D316) was built at the same time. Its four design skills and MarkItDown are on this list now, pinned and checked the same way; every card also offers main's **Install with Claude**.

- **Left out on purpose:** skills that stop and ask a person questions mid-run and would stall an unattended task. That covers superpowers brainstorming, finishing-a-development-branch and executing-plans, and feature-dev.
- **graphify is dropped (D317):** on a folder over 500 files, which is the only place it pays off, its skill says to "ask which subfolder to run on. Wait for the user's answer", so it stalls an unattended task.
- **The whole superpowers plugin is not installed**, only the three skills above. Its start-up hook pushes every run towards asking questions.
### Tooltips

Every line below was checked against the skill's own files on 2026-10-02.

| Skill | Unattended | Watch out for |
|---|---|---|
| verification-before-completion | Works unattended | Runs the tests before it says "done", so a task takes a little longer and costs a little more. |
| systematic-debugging | Works unattended, with a note | After several failed fixes it wants to talk to a person. On the board that becomes a question on the card with a default answer, and the task carries on. |
| test-driven-development | Works unattended, with a note | Writes a test before the fix, so tasks take longer. Exceptions it would ask a person about become a question on the card. |
| Ponytail | Works unattended | Pushes for less code. If test-driven-development is also on, check that tests still get written. JetBrains measured it about 10% cheaper per task. |
| code-simplifier | Works unattended | Runs on Opus, so each use costs more than the task's own model. It only tidies code and never changes what it does. |
| frontend-design | Works unattended | Only helps tasks that change screens. On a vague brief it may stop to confirm what the product is, so say what it is and who it is for. |
| pr-review-toolkit | Works unattended | Its main reviewer runs on Opus, so each review costs more. It uses the GitHub tool (`gh`) to look at an open pull request. |
| react-best-practices | Works unattended | Only useful in React projects. Its repo has no licence file; the skill itself says MIT. |
| document-skills | Works unattended | Needs Python and LibreOffice on this computer. Without LibreOffice, Excel formulas are not recalculated and some conversions fail. Anthropic's licence: free to use with Claude, not to copy or share. |
| playwright-cli | Works unattended | Opens a hidden browser. The task must be able to start the app on its own, and pages behind a login need test account details in the task. |
| Context7 find-docs | Works unattended | Sends your library questions, but no code or passwords, to Context7's online service. Free without an account; a free key raises the limit. You need this or the Context7 plugin, not both. |
| Context7 plugin | Works unattended | Every task connects to Context7's online service, even one that needs no docs. You need this or Context7 find-docs, not both. Turning it off: use the switch on this card (see Behaviour), because the skill switches below do not cover it. |
| Emil Kowalski — design engineering | Works unattended, with a note | Asked to use it with no actual job, it only says hello and stops, so give each task a concrete request. Licence: MIT. |
| Taste | Works unattended, with a note | Very long (about 22,000 tokens each time it is used). On a vague brief it asks one question, which becomes a question on the card. It uses any picture maker you have connected. |
| UI/UX Pro Max | Works unattended, with a note | Its banner, logo and brand skills ask you questions: on the card in an unattended task, waiting for you in a supervised one. Needs Python 3; its logo and image tools need paid API keys. |
| MarkItDown | Works unattended | Needs Python 3.10 to 3.14. Documents are converted on this computer, but an audio or video file is sent to Google's speech service to be written out. It fetches any web address a task gives it. Turning it off: Settings → Browser, images & plugins. |

### Behaviour
- **Skills** (a single SKILL.md folder):
  - A shallow sparse `git clone` of the source repo into a temp folder, then the one skill folder is copied into `~/.claude/skills/<name>/`. No symlinks.
  - A `.kanban-installed.json` marker records the source and commit.
  - Remove deletes the folder **only when that marker exists**. A skill you installed yourself is never touched.
- **Plugins** (Ponytail, code-simplifier, frontend-design, pr-review-toolkit, document-skills, Context7):
  - Install runs `claude plugin marketplace add <repo>` when needed, then `claude plugin install <plugin>@<marketplace>`.
  - Remove runs `claude plugin uninstall`. Only plugins in this catalog can be removed from here.
  - **On and off:** a skill is switched on and off in the Skills list as today (`disabledSkills`). A plugin with no skills, which today is only Context7, never shows in that list. So its installed card gets its own switch, which runs `claude plugin disable` or `claude plugin enable` (D319).
  - Runs pick them up through "Load your global plugins", and the card says so when that setting is off.
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
  - Every catalog entry has its tooltip text, so a new skill cannot be added without one.
  - A plugin with no skills gets its own switch on the card.

---

## Guidance updates (every feature)
- **Tour and Welcome** (`tour/features.ts`): add three features:
  - Schedules is a headline: "Queue work for the night".
  - Side chat is a headline.
  - Suggested skills.
- **SHORTCUTS:** add `c` for chat, and correct the tab count.
- **README:** add a newcomer section for each feature ("Let it work while you sleep", "Ask about your project", "Add good skills") and a Keep-awake note under troubleshooting.
- **Setup:** an optional row, "Recommended skills: 2 of 5 installed", with an **Install** button.
- **Settings:** a Chat section (model and effort), plus Keep awake under Runs & limits.

## Out of scope for now
- Waking a sleeping PC (Windows wake timers).
- Chat on non-Claude providers.
- Image paste in chat.
- Editing code from chat.
