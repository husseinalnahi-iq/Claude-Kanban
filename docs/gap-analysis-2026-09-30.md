# Gap analysis, 30 September 2026

Every claim about another product was checked against its own docs or release notes today; anything
marked *unverified* comes from a third-party write-up only.

## What the others do now

- **Claude Code** (CLI, Desktop, claude.ai/code): cloud sessions that keep running with the laptop
  closed, `--cloud` to send work, `--teleport` to pull it back, and **PR auto-fix** that watches CI and
  review comments ([cloud docs](https://code.claude.com/docs/en/claude-code-on-the-web)); **routines**
  fired by a schedule, an HTTP call or a GitHub event ([routines](https://code.claude.com/docs/en/routines));
  local **desktop scheduled tasks** with per-task "always allow" ([desktop tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks));
  Desktop parallel worktree sessions, PR status, sessions from a phone ([desktop](https://code.claude.com/docs/en/desktop));
  **Projects**, one conversation that starts a thread per task and routes follow-ups
  ([projects](https://code.claude.com/docs/en/claude-projects)); **auto mode**, a classifier that lets
  safe edits through ([week 13](https://code.claude.com/docs/en/whats-new/2026-w13)).
- **OpenAI Codex**: automations that run locally, in a worktree or in the cloud, on a schedule or on a
  Gmail, Slack or GitHub event, with an unread inbox ([automations](https://learn.chatgpt.com/docs/automations?surface=app));
  cloud tasks that "keep working while your computer is asleep" and open PRs
  ([cloud](https://learn.chatgpt.com/docs/cloud)); instant interrupt and forking a conversation
  ([changelog](https://learn.chatgpt.com/docs/changelog)); `/goal` long-horizon mode and six concurrent
  subagents (*unverified*: [third party](https://codex.danielvaughan.com/2026/03/27/codex-cli-in-2026-whats-new/),
  [OpenAI use case](https://developers.openai.com/codex/use-cases/follow-goals/)).
- **Google Antigravity**: a Manager view for many agents, subagents, hooks, scheduled tasks, voice,
  worktrees ([I/O deep dive](https://antigravity.google/blog/google-io-2026-feature-deep-dive));
  **artifacts** you comment on before code is written, a **walkthrough** with screenshots and browser
  recordings ([artifacts](https://antigravity.google/docs/artifacts/), [walkthrough](https://antigravity.google/docs/walkthrough/));
  agent teams with a structured interview first and separate critic and auditor agents
  ([teamwork](https://antigravity.google/docs/teamwork/)).
- **Cline**: SSH remotes, the app local while the agent works elsewhere, and parallel sub-agents
  ([v0.0.31](https://github.com/cline/cline/releases/tag/desktop-v0.0.31)); worktrees per task and PR
  status with CI checks ([v0.0.37](https://github.com/cline/cline/releases/tag/desktop-v0.0.37)); a
  live catalog of 200+ providers ([releases](https://github.com/cline/cline/releases)).
- **Vibe Kanban**: a card board that dispatches each task to any of ten agents in its own worktree,
  with diff comments and PR status ([site](https://vibekanban.com/), [agents](https://vibekanban.com/docs/supported-coding-agents));
  now sunsetting to community maintenance. Claude Squad and Conductor cover the same ground
  (*unverified*: [roundup](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)).

## 1. What Claude Kanban already does that the others do not

- **A pipeline per card, with a different model and effort per stage**, sized by a cheap intake call,
  plus a plan debate between two models. Every other tool runs one agent per task.
- **Honest money and usage**: cost per stage, share of the 5-hour window, ceilings that pause and ask
  instead of failing, and a task that waits for a window to reset or moves to a fallback provider with
  a handover.
- **Cheap subscriptions do the typing**: GLM, Kimi, Qwen, Ollama, LM Studio through the real Claude
  Code, so approvals, worktrees and board tools keep working; their usage meters too.
- **Landing safely**: pull main into the worktree first, re-run the verify command, merge one task at
  a time, never `reset --hard`. Automatic dependencies between subtasks whose files overlap.
- **Guardrails no card can click past**: blocked commands, never kill by name, loop detection,
  credential warnings, a sandbox that keeps the main checkout's `.env` out of reach.
- **Live browser view** of what a task is clicking, one headless browser per task.
- **Written for a non-programmer**: Setup that fixes what is missing, a Tour, a local-AI guide.

## 2. Gaps

Ranked by value to a solo developer.

| # | Gap | Who does it well | Why it matters for this board | Effort |
|---|---|---|---|---|
| 1 | Work lands only as a local merge. No pull request, no CI status, no fixing review comments. | [Claude Code auto-fix](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests), [Cline PR status](https://github.com/cline/cline/releases/tag/desktop-v0.0.37), [Codex cloud](https://learn.chatgpt.com/docs/cloud) | Anyone with a remote and CI reviews there. A card should end as a green PR, not a local branch. | M |
| 2 | Nothing runs while the computer is off or the board closed. No hand-off to a cloud session. | [Claude cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web), [Codex cloud tasks](https://learn.chatgpt.com/docs/cloud) | The 2 AM schedule depends on a laptop lid. The night shift is the board's whole pitch. | M |
| 3 | Two leashes only: ask on every write, or fully autonomous. No "ask only for the risky things", no "always allow this for this task". | [Claude auto mode](https://code.claude.com/docs/en/whats-new/2026-w13), [desktop task allow-list](https://code.claude.com/docs/en/desktop-scheduled-tasks#permissions-for-scheduled-tasks) | Supervised runs drown in cards; autonomous runs cannot touch a live system. Most real work sits in between. | S/M |
| 4 | No trigger from outside: a GitHub event, an HTTP call, a Slack message. Already on the roadmap. | [Claude routines](https://code.claude.com/docs/en/routines), [Codex automations](https://learn.chatgpt.com/docs/automations?surface=app) | "Review every PR" and "fix this alert" are the tasks that pay off most when nobody has to type them. | M |
| 5 | Reachable only from this machine (D21). No check-in from a phone or another PC. | [Claude Remote Control and Dispatch](https://code.claude.com/docs/en/desktop), [Cline SSH remotes](https://github.com/cline/cline/releases/tag/desktop-v0.0.31) | Many tasks means many "needs you" moments while you are away from the desk. | M |
| 6 | Review sends work back once; no card keeps iterating against a verification loop until a stated stopping condition holds. | Codex `/goal` (*unverified*, [OpenAI](https://developers.openai.com/codex/use-cases/follow-goals/)) | Migrations and flaky-test hunts need "keep going until green", bounded by the cost ceiling the board already has. | M |
| 7 | The review stage is one model reading a diff. No independent critic, no audit of test evidence. | [Antigravity teamwork](https://antigravity.google/docs/teamwork/), Claude `/ultrareview` ([cloud docs](https://code.claude.com/docs/en/claude-code-on-the-web)) | A second reviewer catches what the first was told to like. The plan debate already shows the pattern. | S |
| 8 | No walkthrough: the result, screenshots and checklist are on three tabs, and there is no browser recording. | [Antigravity walkthrough](https://antigravity.google/docs/walkthrough/) | Reviewing ten cards a day needs one page per card that says what was checked and shows it. | S |
| 9 | Approve is all or nothing. No per-file accept, no revert of one hunk, no rewind to a step. | Codex review panel (*unverified*, [roundup](https://www.verdent.ai/guides/what-is-codex-app)), Claude Code rewind ([week 13](https://code.claude.com/docs/en/whats-new/2026-w13)) | Half-good work gets rejected whole and re-run at full price. | M |
| 10 | Chat creates cards and can message a task, but does not route a new bug report to the task already on that area, nor keep a running stream of work. | [Claude Projects](https://code.claude.com/docs/en/claude-projects) | The coordinator pattern is what lets one person feed twenty items a day without triage. | M |
| 11 | Improve and Rewrite are one-shot. No short interview before a big job. | [Antigravity teamwork phase 1](https://antigravity.google/docs/teamwork/) | Three questions up front are cheaper than a wrong plan approved at 2 AM. | S |
| 12 | Another agent's CLI can only be trusted in a worktree with no approval cards; a delegated stage cannot be steered mid-run. | [Vibe Kanban](https://vibekanban.com/docs/supported-coding-agents) | Codex as coder is a real cost saver only if it is as safe as a Claude stage. | M |
| 13 | A scheduled card cannot change its own schedule from inside a run. | [Claude desktop tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks#manage-scheduled-tasks) | "Run again in an hour if the deploy is not out yet" is one board tool away. | S |
| 14 | No voice input for the New task form or the Chat. | [Antigravity](https://antigravity.google/blog/google-io-2026-feature-deep-dive) | Helps the non-programmer audience; cheap with the browser's speech API. | S |

## 3. The five I would build first

**A pull request as the way work lands.** `server/src/git/worktree.ts` gains push and `gh pr create`
(the Setup check in `server/src/setup/checks.ts` already knows how to detect a CLI), and the approve
path in `server/src/routes/tasks.ts` offers **Open a PR** beside **Land**. The task drawer
(`web/src/views/TaskDrawer.tsx`) shows the PR link, its CI checks from `gh pr checks`, and new review
comments; a **Fix the comments** button feeds them to the task's session the way `DiffView.tsx` already
feeds inline comments. Local landing stays the default for projects with no remote.

**A middle leash.** A third mode, *ask for risky things*, in `server/src/engine/gate.ts` and the
`canUseTool` callback in `runner.ts`: edits inside the project and read-only commands pass, commands
that write outside it, install, push, or touch the network get a card. Each card gains **Always allow
this for this task**, stored on the task and checked before a card is made. Whether the Agent SDK
exposes Claude Code's `auto` permission mode is *unverified*; the board's own rules work either way.
`Approvals.tsx` and `SafetyOptions.tsx` get the new option.

**Hand a card to the cloud.** A **Run in the cloud** action on a card runs `claude --cloud "<spec>"`
in the project folder through a new `server/src/engine/cloud.ts`, stores the session URL on the card,
and shows it as a chip in `Board.tsx`. **Bring it back** opens a terminal tab with
`claude --teleport <id>` so the branch arrives in the project for the normal review and landing.
Requires a GitHub remote; the card says so when there is none. The schedule form gets a *run in the
cloud* switch so night work no longer depends on the laptop.

**Triggers from outside.** A `server/src/routes/triggers.ts` with per-trigger tokens: a POST creates a
card from a template, reusing the repeating-schedule templates in `engine/scheduler.ts`, with the
request body attached as an untrusted note the way Claude routines wrap fire text. GitHub events
come by polling `gh pr list` and `gh run list` every few minutes, so nothing has to reach the
machine from the internet and D21 stands. A card that came from a trigger shows where it came from.

**Check in from a phone.** An opt-in **Reach the board from other devices** in Settings that binds to
the LAN address with a long token in the URL and a QR code, extending the allowed-host list in
`server/src/app.ts` rather than dropping the guard. The Approvals view already fits a phone; the first
pass is that view plus the bell. A Tailscale note covers the rest.

## 4. Deliberately not worth copying

- **Computer use.** The README already says why: a board that can click anything on the PC is a risk
  it does not take. The browser and the terminal cover what tasks need.
- **An in-app file editor.** Everyone has an editor; the terminal and *Terminal here* are enough.
- **Named agent teams (Sentinel, Orchestrator, Critic, Auditor).** Cards, subtasks and pipeline
  stages are the team, and they show cost per role. A hidden squad hides the bill.
- **Being agent-agnostic like Vibe Kanban.** Ten executors means the lowest common denominator: no
  approval cards, no usage windows, no board tools. Keep other agents as stages behind Claude Code.
- **A 200-provider catalog.** Presets for the plans people buy, plus "type any id", is the right size.
- **Cloud-only execution.** Local files, keys and free local models are the point. The cloud is a
  hand-off, not the home.
- **Unbounded goal loops.** Copy the loop only behind the cost ceiling and turn cap; a loop that
  "never gives up" is a bill that never stops.
