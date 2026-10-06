# Chats: a Claude-Code-grade chat inside Claude Kanban

Status: **PLANNED — not started.** Saved 2026-09-20 for later execution.
Recommended execution model: **Opus 5 + High** (code + schema changes across server and web).

## Context

The side chat is read-only and cheap by design (`server/src/engine/chat.ts:181-200`), so day-to-day work —
BizApp/Metabase via skills, Excel in and out, Chrome — still happens in Claude Code. The first plan
(spec `docs/superpowers/specs/2026-09-12-work-chat-design.md`, 7 Backlog cards
in the board's own project) added an Ask/Work toggle, approvals, files, Chrome, wide view. On top of that
we now want:

- a dedicated full-page **Chats** view (sessions grouped by project on the left, full conversation in
  the middle, like Claude Code / Codex), reachable from a dedicated place;
- permission modes: Manual, Accept edits, Plan, Auto, Bypass;
- model and effort switching like Claude Code, `/compact` and auto-compact;
- the chat can create tasks / parallel tasks, ask which models, and read the results — or do the work
  itself; the owner decides the rules.

## Decisions

**Permission modes replace the Ask/Work toggle.** Every chat is full-power (skills, plugins, MCP
servers); the mode decides what runs without asking. Existing chats become Manual. Default mode for
new chats is a setting (Manual). "Plan" is the read-only mode for pure questions.

| Mode | SDK `permissionMode` | What happens |
|---|---|---|
| Manual | `default` | Every change (edit, command, write-MCP, Chrome action) is an Allow / Always / Deny card |
| Accept edits | `acceptEdits` | File edits in the project/workspace auto-allowed; commands still ask |
| Plan | `plan` | Reads only; ends with a plan card: Approve → Auto / Accept edits / Manual, or Keep planning |
| Auto | `auto` | SDK classifier approves/denies; anything it escalates becomes a card |
| Bypass | `bypassPermissions` + `allowDangerouslySkipPermissions` | Nothing asks. Only selectable after Settings → Chats → Allow bypass mode (off by default); red banner while on |

The blocked-command list and `killsByName` (`server/src/engine/gate.ts`) are enforced in **all** modes
through a PreToolUse hook (hooks run even in bypass).

**Entry point:** a **Chats** item pinned at the top of the left sidebar (above projects,
`web/src/App.tsx:138-182`), shortcut `Shift+C`, plus a ⤢ button in the side panel that opens the same
chat full-page. The top-bar ✦ Chat side panel stays for quick questions; both show the same chats.

**Do it itself vs. make cards** (written into the chat's system prompt):
- *Itself*: interactive or short work, anything against external systems (BizApp, Metabase, Excel,
  Chrome), small edits the current mode allows.
- *Cards*: code changes that deserve an isolated copy + review, long jobs, work that splits into
  independent parts (→ parallel), anything to schedule.
- It never lands work itself: Approve / Reject stay the owner's buttons (on the chips and in the drawer).

**Asking about models = an editable task-plan card**, not a chain of questions: the chat proposes the
tasks (titles, specs, dependencies, mode, per-stage model/effort prefilled from the project default);
the owner tweaks dropdowns and presses Create & start / Create only / Cancel.

**Report back** (per-chat toggle, on by default): when the tasks a chat created reach Review / Failed /
needs-you, it posts a status line; when the whole batch is finished it runs one follow-up turn that
reads the results and summarises (verdict, what changed, cost) with Approve/Reject/Open chips.

## Architecture: long-lived chat sessions

Today each message is a fresh `query()` with `resume` (`chat.ts:174-249`), so nothing can change
mid-reply. Claude-Code parity needs the SDK's control methods, which only work with streaming input
(`sdk.d.ts` `Query` 2611+). New `server/src/engine/chatSession.ts`:

- One live `Query` per active chat, fed by a pushable `AsyncIterable<SDKUserMessage>`; closes after
  10 min idle (next message resumes via `session_id`); a board restart just resumes.
- **Send while it works:** messages queue into the same session (`priority: 'next'`), like Claude Code.
- Stop → `interrupt()` (not abort); model → `setModel()`; effort → `applyFlagSettings({ effortLevel })`;
  mode → `setPermissionMode()` — all mid-session, persisted on the chat.
- **Compact:** Compact button and typing `/compact [focus]` push `/compact …` as a user message (verify
  `compact` is in init `slash_commands`); auto-compact per chat via `settings.autoCompactEnabled` in
  Options / `applyFlagSettings`. `system/compact_boundary` → a divider "compacted 142k → 19k tokens";
  `system/status: compacting` → "compacting…" in the header.
- **Context bar:** `getContextUsage()` after each turn → `chats.context_tokens` / `context_window`,
  shown with the existing `ContextBar` (`web/src/components/UsageMeters.tsx:245`).
- Options as a pure, unit-tested `chatOptions(chat, project, settings)`: `settingSources: ["user","project"]`,
  board MCP server, `canUseTool` → in-chat approval cards, PreToolUse blocklist hook, `maxBudgetUsd`
  per turn from a setting (default $5), `extraArgs` chrome per setting.

## Orchestration tools (`server/src/engine/chatBoard.ts`)

- `board_propose_tasks({ goal, tasks: [{ title, spec_md, depends_on: positions, mode?, pipeline? }] })` —
  blocks on the task-plan card; on confirm creates an umbrella card + subtasks with `auto_queue_children`,
  reusing the batch/position logic of `board_create_subtasks` (`server/src/engine/boardMcp.ts:74-162`)
  and `stageSchema` (`boardMcp.ts:18`), so dependents auto-start via `promoteReady` (`runner.ts:2489`).
  Returns ids.
- `board_task_result({ task_id })` — status, `result_md`, review verdict (`verdictOf`, `runner.ts:186`),
  files changed (`runner.diff`, 2276), cost (`repo.taskCost`), last error.
- Chat watches `task.updated` on the bus for its cards (`chat_tasks` link table) to drive report-back.

## Full-page Chats view (web)

- Router: new `"chat"` view + `chat` param (`web/src/lib/router.ts:3,11,32,42`); rendered in the
  `App.tsx` view switch (238-263).
- **Left:** all chats grouped by project (collapsible), search, + New per project, busy / waiting-for-you
  dots, Archived. New `GET /chats` across projects (`server/src/routes/chats.ts`).
- **Middle:** conversation + composer: textarea, 📎, mode pill (cycles with `Shift+Tab` like Claude Code),
  model and effort pickers, context bar, Compact, Stop.
- **Right (collapsible):** Tasks from this chat with live status, cost, Open / Approve / Reject.
- Lift from `web/src/components/chat/ChatPanel.tsx` into shared pieces used by both the panel and the
  page: `useChats`, `useChatConversation(chatId)`, `ChatThread` (MessageRow, CardChips, streaming),
  `ChatComposer`, `ChatList`. Export and reuse `QuestionCard` (`web/src/components/QuestionCard.tsx`)
  and the tool-approval card from `web/src/views/TaskDrawer.tsx:86-112`, decoupled from `run_id`/`task_id`
  (they take an `onDecide` callback).

## Data

- `chats`: `permission_mode`, `auto_compact` (1), `report_back` (1), `allow_json`, `context_tokens`,
  `context_window` (via `LATER_COLUMNS`, `server/src/db.ts:67-96`; `toChat` + `updateChat` whitelist in
  `repo.ts:544-584`).
- New tables in `server/src/schema.sql`: `chat_files`, `chat_tasks` (`chat_id`, `task_id`, `batch_id`).
- `ChatMessage.role` += `approval`, `plan`, `taskplan`, `divider`; `meta.files`, `meta.approval`.
- Settings (`types.ts:631`, `db.ts` seed, `repo.getSettings`, `routes/settings.ts` zod): `chatDefaultMode`,
  `chatAllowBypass` (false), `chatTurnBudgetUsd` (5), `chatChrome` (false).

## Board cards (to create when this is picked up)

Rewrite the spec doc to this design and commit it to `main` (docs only, so autonomous copies can read it),
then update the 7 existing cards and add 2 — all autonomous, Backlog, **not queued**:

| # | Card | Waits for | Source |
|---|---|---|---|
| 1 | Chat session engine: live sessions, queue-while-working, interrupt, model/effort mid-session, compact + auto-compact, context usage, skills/plugins/MCP (+ spike on what loads) | — | rewrite earlier card 1 |
| 2 | Full-page Chats view + shared chat components + `GET /chats` + sidebar entry / `Shift+C` / ⤢ | 1 | new |
| 3 | Permission modes + in-chat approval, question and plan cards; blocklist hook; bypass setting | 2 | rewrite earlier card 2 |
| 4 | Orchestration: task-plan card, `board_propose_tasks`, `board_task_result`, report-back, Tasks rail | 3 | new |
| 5 | Attach files | 2 | earlier card 3 (adjusted) |
| 6 | Files back as downloads | 5 | earlier card 4 |
| 7 | Chrome in chats (setting, read tools free, actions ask per mode) | 3 | earlier card 5 (adjusted) |
| 8 | Tables: scroll, Copy as CSV, links in new tab (wide view moves to card 2) | — | trim earlier card 6 |
| 9 | Workspace project + Tour / Welcome (bump `web/src/lib/welcome.ts` VERSION) / Setup / README / DECISIONS | 4, 6, 7, 8 | earlier card 7 |

## Verification

- Unit tests (`npm test`): `chatOptions` per mode (incl. bypass flag and chrome), gate order (blocklist
  hook first in every mode, always-allow rules, read-only MCP names), approval allow/deny/always/stop-expiry,
  plan-card → `setPermissionMode`, `board_propose_tasks` creates umbrella + subtasks with correct
  dependencies, report-back fires once per batch, compact boundary becomes a divider.
- `npm run typecheck`.
- End to end on the running board (Browser pane, http://127.0.0.1:4310): open Chats from the sidebar and
  `Shift+C`; switch model and effort mid-conversation; Plan → approve → Accept edits; Manual shows an
  Allow card for a Bash command; `/compact` shows the divider and the context bar drops; ask for two
  parallel tasks → task-plan card → Create & start → both run → the chat reports back with results.
- Spike output (card 1) recorded in DECISIONS: which skills, MCP servers, claude.ai connectors and Chrome
  load in a board-started session, and whether `auto` mode is available on the account.
