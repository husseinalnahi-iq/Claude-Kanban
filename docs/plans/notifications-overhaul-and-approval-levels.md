# Notifications overhaul + auto-approve levels

> Status: **planned, not started.** Saved 2026-09-20 to be implemented later.
> Suggested execution model: **Opus 5 + High** (server gate + runner changes, many files).

## Context
Notifications live entirely in the browser (`web/src/lib/alerts.ts` → `Toasts.tsx`, `notify.ts`, `sounds.ts`, `BellControl.tsx`); the server only broadcasts WS messages. Confirmed problems:

1. **Approval toasts never go away after you approve.** They're sticky (`Toasts.tsx:12` `approval: Infinity`) and nothing links a toast to its approval — `approval.decided` is only handled by `store.tsx:33`. Desktop notifications are never closed either.
2. **No context / no actions on the card.** `approval.requested` is published with the bare row (`runner.ts:2066` → `repo.createApproval` → `toApproval`, no join), so the toast always says "A task", has no project, and only shows `Wants to: <tool>`.
3. **The bell does nothing useful.** Clicking it only toggles `muted` (`BellControl.tsx:90`); there is no notification list/history anywhere. The "unseen" dot only exists while the tab is hidden, so it's never visible on the bell.
4. **Mute is sound-only.** `prefs.muted` is checked only for sounds (`alerts.ts:128`); toasts, desktop notifications continue. Picking a theme silently unmutes (`BellControl.tsx:127`); tour demo ignores it (`tour/MiniBoard.tsx:84`).
5. **Bursts produce stacks.** Only a 6s same-kind merge in `Toasts.tsx:140`; a 1.2s per-kind sound gap; a global 1.5s desktop throttle that *drops* (e.g. an approval swallowed by a "done"). Merged toasts lose their `taskId` and become unclickable; the 5-toast cap evicts pending approvals.
6. Other gaps: plan-debate gate (`runner.ts:675-682`, `status:"approval"` + `plan_gate`) raises no alert at all; `pending` isn't refetched after a WS reconnect (missed events lost); pref changes don't sync across tabs; desktop notification click doesn't open the task.
7. **No auto-approve.** Only `supervised` (card for every write) vs `autonomous` (worktree + `autonomousGate`). Mode can't change once a task is running/has a worktree (`routes/tasks.ts:148-150`), so "switch to autonomous" from a pending card is impossible.

## Case study: one supervised access-fix task on a live accounting system, 45 cards
Supervised, plan → code → review, 45 minutes, **45 approval cards, all 45 approved** (from `~/.claude-kanban/kanban.db`):

| Stage | Cards | What they were |
|---|---|---|
| plan (26 min) | 8 | 4× **WebFetch** of raw.githubusercontent.com (a *read-only* tool — bug), 4× Bash writing+running query scripts in the Claude scratchpad (outside the project). One sat **17 min** waiting for you. |
| code (18 min) | 30 | 6 Write + 6 Edit; 6× `python _investigate_*.py` in a write→run→rewrite loop; 6 read-only shell (`wc -l`×3, `grep`, `git status`, `Get-Command python`); 2× doc-check script; `rm`, `git add`, `git commit`. |
| review (1 min) | 7 | 4 read-only (`git log`, `git show`×2, `find`); re-ran `fix_access.py`; 2× doc-check script. |

Root causes:
1. **Bug — read-only tools still carded.** `FORCE_ASK` (`runner.ts:204-214`) skips `READ_ONLY_TOOLS`, but the SDK in `permissionMode:"default"` still asks for WebFetch, and `canUseTool` (`runner.ts:824-857`) has no read-only short-circuit → `askApproval`. 4 cards.
2. **Read-only shell commands are treated as writes.** Every Bash/PowerShell call is a card, even `git log`/`wc -l`/`find`. 10 cards. Claude Code itself auto-allows read-only commands.
3. **No "don't ask again" / accept-edits.** The same `python <script>` and the same doc-check script were approved 6× and 4×; 12 file edits in the project each needed a click.
4. Each card was a **sticky toast + sound** → the pile-up of notifications that stay after approving.

What the fixes below would have left: fixes 1+2 alone → **31** cards; + *Accept edits* → **19**; + "Always allow `python …`"/doc-check rule → **~10**; *Auto-approve* → **0–4** (only the scratchpad scripts, and 0 if temp dirs count as the task's own space, see below).

Also worth knowing: the **review** stage re-ran `fix_access.py` (a script that changes the live system). The card caught it, but review stages have no tool restrictions today (only plan gets `PLAN_DISALLOWED`, `runner.ts:528`). Not changed in this plan — flagged for a separate decision.

### Fixes from the case study (apply at every level, including `ask`)
- **R1 — read-only short-circuit in `canUseTool`**: `if (READ_ONLY_TOOLS.has(toolName) || isSafeMcp(toolName)) return allow` right after the board-tool check (`runner.ts:825`). Test: supervised run calling WebFetch produces no approval.
- **R2 — read-only shell classifier** `readOnlyShell(cmd, projectPath): boolean` in `engine/gate.ts`, auto-allowed (logged `[board] read-only, allowed`), checked after the blocked-list/kill-by-name checks. Conservative: split on `&& || ; |` and newlines; **every** segment must be one of: `cd <path inside project>`; `git status|log|show|diff|rev-parse|ls-files|blame|grep|describe|shortlog|branch --list` (no `-C`/`--git-dir`, no `--output`); `ls dir pwd cat type head tail wc grep rg which where echo sort uniq cut`; `find` without `-exec -execdir -delete -ok -fprint*`; PowerShell `Get-ChildItem Get-Content Get-Command Get-Location Test-Path Select-String Select-Object Where-Object Measure-Object Format-*`. Reject if any `>`/`>>` redirection (except `2>&1`, `2>/dev/null`, `2>$null`), `$(`, backticks, `<<` heredoc, `Out-File|Set-Content|Add-Content|tee|Invoke-Expression|iex`, or any path outside the project. Unknown → not read-only (card as before). Unit-test with every command from this task (the 10 RO ones pass, the others don't).
- **R3 — shell allow-rules match per segment and across Bash/PowerShell**: rule = program + subcommand for multi-command tools (`python <script>` → `python`, `npm run test` → `npm run`, `git commit` → `git commit`, `powershell -File scripts\x.ps1` → that script); a command auto-approves only if every non-`cd`, non-read-only segment matches a rule. The card's "Always allow" label shows exactly what the rule will match.
- **R4 — `auto` level treats the OS temp dir (`os.tmpdir()`, which contains Claude's scratchpad) as the task's own space** alongside the project folder, for writes and shell paths.

## Decision: auto-approve = a per-task *approval level* (Claude Code-style), independent of mode
Switching a running supervised task to autonomous would move it to a worktree mid-run — not viable. Instead, mirror Claude Code's permission modes (Shift+Tab) and its "Yes, don't ask again" option, **changeable live, even while a card is waiting**:

| Level | Behaviour (supervised tasks) |
|---|---|
| `ask` (default) | Today's behaviour: a card for every non-read tool. |
| `edits` — *Accept edits* | Edit/Write/MultiEdit/NotebookEdit **inside the project folder** auto-approved; shell and everything else still asks. |
| `auto` — *Auto-approve* | Anything `autonomousGate(tool, input, projectPath)` would allow is auto-approved (writes & shell that stay in the folder, allowed git subcommands). Anything it would refuse (external MCP, paths outside, `git push`…) **falls back to a card**, not a denial — a human is around. |

Always kept regardless of level: blocked-command list and kill-by-name (checked first, `runner.ts:831-850`), browser rules (`browserDecision` "ask" still asks), `AskUserQuestion` always asks.

Plus **"Always allow this for this task"** (Claude's "don't ask again"): stores a rule on the task — for shell tools the command's first two tokens as a prefix (e.g. `npm test`), otherwise the tool name — auto-approving matching calls for the rest of the task.

Autonomous tasks are unaffected. Mode switching stays where it is (drawer, allowed before a run).

## Server changes
- **Types** (`server/src/types.ts`): `ApprovalLevel = "ask"|"edits"|"auto"`; `AllowRule = { tool: string; prefix?: string }`; `Task.approval_level`, `Task.allow_rules`; `Settings.defaultApprovalLevel`.
- **DB** (`server/src/db.ts` `LATER_COLUMNS`): `tasks.approval_level TEXT NOT NULL DEFAULT 'ask'`, `tasks.allow_rules_json TEXT NOT NULL DEFAULT '[]'`; map in `repo.ts` `TASK_COLUMNS`/row mapper. Settings default in `repo.getSettings()` + zod in `routes/settings.ts`.
- **Routes** (`routes/tasks.ts`): create/patch accept `approval_level` and `allow_rules`; unlike `mode`, allowed while busy. New `POST /approvals/:id` body gains optional `remember: "rule" | "edits" | "auto"` → decide allow **and** update the task (rule appended / level raised) in one call.
- **Gate** (`engine/gate.ts`): new pure `autoApprove(level, rules, tool, input, projectPath): boolean` — reuses `PATH_KEYS`/`inside()`/`autonomousGate`; plus `ruleFor(tool, input): AllowRule` and `matchesRule`.
- **Runner** (`engine/runner.ts`):
  - In `canUseTool` (line 856), supervised branch: read the task's *current* level/rules from repo on each call (so live changes apply); if `autoApprove(...)` → record an already-decided approval row (`decision:"allow"`, note `auto · Accept edits`/`auto · rule npm test`), log a `[board] auto-approved …` line, return allow. Else `askApproval`.
  - `askApproval`: store alongside the resolver a `recheck()` closure (tool, input, cwd). New `recheckPending(taskId)` — called after a level/rule change — resolves any live card that now qualifies. So pressing "Auto-approve this task" on a card clears it immediately.
  - Publish **joined** approvals: add `repo.getApprovalView(id)` (same join as `pendingApprovalsAll`, `repo.ts:868-877`) and use it for both `approval.requested` and `approval.decided`.
- **Tests** (`server/test/`, using `helpers.ts` bus capture): gate unit tests for each level + rules; runner: `edits` auto-approves in-folder Write but asks for Bash; `auto` still carded for out-of-folder path; blocked command still denied under `auto`; raising level with a pending card resolves it; `approval.requested` carries `task_title`/`project_id`; existing `runner.test.ts:87` (`permissionMode === "default"`) unchanged.

## Web changes

### 1. Alert engine (`web/src/lib/alerts.ts`) — linked, batched, DND-aware
- `Alert` gains `key` (link to the thing it's about: `approval:<id>`, `paused:<taskId>`, `plan:<taskId>`, else unique) and `resolved?: boolean`.
- **`resolveAlert(key)`**: closes the matching toast, closes the desktop notification, marks the history entry "handled". Called on `approval.decided` (→ `approval:<id>`), on `task.updated` leaving `paused`/`approval` (→ `paused:`/`plan:`), and on `task.deleted` (all keys for that task).
- **Smart batching** — new pure module `web/src/lib/coalesce.ts` (no DOM; testable). `raise()` pushes into a buffer; flush after **900 ms quiet or 3 s max** from the first buffered alert (debounce with max-wait — first alert of a burst still appears in <1 s, a steady trickle can't produce one pop-up per second). On flush:
  - drop alerts already resolved inside the window (approved/auto-approved within the second → nothing shown);
  - per task keep only the most urgent (`started`+`approval` → `approval`), urgency order = existing `URGENCY` (`alerts.ts:256`);
  - group by kind → one bundle per kind;
  - **one sound** per flush (most urgent enabled kind), with a 2 s global sound gap that a *more urgent* kind may break;
  - **one desktop notification** per flush (single item → specific title/body; several → "3 updates · 2 need you, 1 failed"), tag per bundle, `requireInteraction` for "Needs you", click → focus + navigate to the task/inbox (`notify.ts` returns the `Notification` so it can be closed on resolve). Remove the dropping 1.5 s throttle.
  - toasts: merge into a visible toast of the same kind (existing 6 s window) instead of stacking; merged toasts keep a clickable item list (first 3 titles, each opens its task).
- **Do Not Disturb** replaces `muted` (migrate `muted:true` → DND "until turned off"): `dnd: { until: number | null }` with presets 1 h / until tomorrow 8:00 / until I turn it off. While on: no sounds, no pop-ups, no desktop notifications; everything still lands in the notification center and bell/tab badges keep counting. Option "Let 'Needs you' through" (default off). Tour demo sound + theme picking respect/no longer clear DND. Explicit previews in settings still play.
- Plan gate: `onTask` raises `approval`-kind "Pick a plan" when status becomes `approval` with `plan_gate`, keyed `plan:<taskId>`.
- Cross-tab: `storage` event listener re-reads prefs + history.

### 2. Live approval card in the toast stack (`web/src/components/ApprovalToast.tsx`, new)
Rendered by `Toasts.tsx` from `useAppData().pending` — **state-bound, not event-bound**, so it disappears the moment an approval is decided anywhere (inbox, drawer, other tab, auto-approve, expiry). Event-driven `approval` toasts for tool cards are suppressed (sound/desktop/history still fire via the batcher).
- Header: project · task title, age, "1 of 3 ‹ ›" pager when several, "Open inbox".
- Body: tool name + what it wants, via a shared `ApprovalSummary` (extract `ApprovalInput` from `TaskDrawer.tsx:86-105` + `inputSummary` from `Approvals.tsx:11-15` into `web/src/components/ApprovalInput.tsx`, compact variant: Bash `$ cmd`, Edit/Write path + 3-line diff peek, JSON otherwise).
- Actions: **Deny**, **Allow**, and a split "▾" menu: *Always allow `npm test` for this task*, *Accept edits for this task*, *Auto-approve this task* (each = `api.decide(id,"allow",{remember})`). Questions show "Answer…" which opens the task drawer's question card. Keyboard: `y`/`n` when the card is focused.
- Dismiss (×) = snooze until a *new* approval arrives; never evicted by the toast cap (cap applies to event toasts only). Shown also after page load if approvals are pending (no sound).

### 3. Notification center — the bell (`BellControl.tsx` → `NotificationCenter.tsx`)
- Bell click **opens a panel**; badge shows unread count (rose if anything needs you, else the most urgent unread kind's colour). Bell icon gets a moon/slash when DND is on.
- Panel: header with **DND switch** (+ duration menu) and ⚙ (the current sound/kinds/desktop settings move into this sub-view, unchanged).
  - **Needs you**: live pending approvals (same compact card + actions as §2) and cost/provider-paused tasks with a link.
  - **Recent**: history (localStorage `kanban.notifications`, cap 200 / 7 days), newest first, grouped by batch, unread dot, resolved entries dimmed with "handled"; click → open task. "Mark all read", "Clear".
- Opening the panel marks items read.

### 4. Approval-level controls elsewhere
- `lib/api.ts`: `decide(id, decision, { note, remember })`, `patchTask` accepts `approval_level`/`allow_rules`.
- Drawer Spec tab (`TaskDrawer.tsx:192-209`): "Approvals: Ask · Accept edits · Auto" segmented control next to Mode (supervised only, enabled while running), plus list of remembered rules with ×. Same menu on `PendingToolApproval` and `Approvals.tsx` `ToolRow`.
- New-task form (`components/forms.tsx:65-82`): level picker for supervised, default from `settings.defaultApprovalLevel`; Settings → Runs & limits → Guardrails: default level.
- Board card (`views/Board.tsx`): small "auto" chip on supervised tasks with level ≠ ask.
- `store.tsx`: refetch `pending` on WS reconnect (add an `onReconnect` subscription in `lib/ws.ts` `onopen`).

### 5. Guidance (per project rule: every feature updates Tour/Welcome/Setup/README)
- `web/src/components/tour/features.ts` "You stay in charge": add approval levels + "Always allow"; update bell/notification-center + DND entries; `Tour.tsx:66,107,171`.
- `README.md` (approval/guardrails sections ~`:321-328`, `:665-681`) and notifications; `docs/DECISIONS.md` new entries (approval levels fall back to cards, state-bound approval toast, batching window).
- `Welcome.tsx`/`Setup.tsx` copy where it mentions approving every command.

## Tests
- Server: as listed above (`npm test` in `server/`), plus a **replay test of that task**: feed its 45 recorded tool calls (tool + input, as fixtures) through the new gate at each level and assert the card counts (≈31 ask / ≈19 edits / ≤4 auto; 0 WebFetch cards at any level).
- Web: add `tsx` devDependency + `"test": "node --import tsx --test src/**/*.test.ts"` to `web/package.json`; `web/src/lib/coalesce.test.ts` covers: burst of 5 within 300 ms → one flush/one sound; same-task supersession; alert resolved inside window dropped; max-wait flushes a steady trickle; DND suppresses channels but keeps history.
- `npm run typecheck` in `web/`.

## Verification (end to end, in the Browser pane)
1. Start the dev server via `.claude/launch.json`; create a supervised task that writes a file and runs a command.
2. Card appears in the toast stack with task/project, command, Allow/Deny/▾. Approve from the **inbox** → toast and desktop notification vanish; history entry shows "handled".
3. From the toast ▾ choose *Accept edits*: next Write auto-approves (run log shows `[board] auto-approved`), Bash still carded. Choose *Auto-approve*: pending card clears instantly; a `git push` still produces a card; a blocked command is still refused.
4. Trigger several tasks at once (start 3 subtasks) → a single pop-up "×3", one sound.
5. Bell: opens panel with Needs you + Recent; unread badge clears on open. DND on → no sound/pop-up while tasks finish; items still in Recent; DND off restores.
6. Reload with an approval pending → card shows without sound; kill/restart WS (restart server) → pending refetched.
7. Screenshot proof of toast card, notification center, and drawer level control.
