# Decisions

Every decision with the why. Newest at the bottom of each section.

## Locked before the build started (2026-09-11)

| Decision | Choice | Why |
|---|---|---|
| Build vs adopt | Build our own on the Claude CLI / Agent SDK | The off-the-shelf option was pinned to older models with a fixed picker; the goal was a board that takes any model id |
| Run modes | Both, task-by-task: autonomous pipeline OR supervised session | Autonomous for safe code/docs work; supervised for repositories whose own rules require every write to be approved |
| UI host | Local web app (Node on localhost + React) | Fastest to a working v1; Electron later |
| Engine | Agent SDK in-process (`query()`) | Any model id, `cwd`, `resume`, `permissionMode`, `canUseTool` → approval cards; `createSdkMcpServer` → board as a tool every run can call |
| Repo | `Claude Kanban`, own git on `main` | Its own repository, so no other project's rules apply to it and it applies none to them |
| Model list | Free-text extendable in Settings | A fixed list is exactly the failure of the tool this replaces: new models ship and the tool cannot use them |
| Locked-down projects | `worktrees: forbidden, autonomous: forbidden` → supervised only | Some repositories have rules of their own: main branch only, no worktrees, every write approved. The board obeys them and never edits them |

## Implementation decisions (build session, 2026-09-11)

| # | Decision | Why |
|---|---|---|
| D1 | REST under `/api/*`, WebSocket at `/ws` | Production serves `web/dist` from `/`; the prefix avoids route clashes |
| D2 | Web imports server row types with `import type` from `server/src/types.ts` | One source of truth for shapes without a shared package |
| D3 | After each autonomous Code stage the runner commits the worktree (`kanban: <title>`); diff = `git diff <base_sha>..kanban/<id>` | The agent is told not to commit; committing makes diff/merge/remove deterministic and lets `git worktree remove` run without `--force` |
| D4 | Approve (autonomous) = `git merge --no-ff kanban/<id>` → `git worktree remove` → `git branch -d` | Keeps `git worktree list` and `git branch` clean; `-d` refuses if unmerged |
| D5 | Discard = commit-all → `git worktree remove` → `git branch -D` | Discard is the explicit "throw this away" action, so an unmerged branch must go; `-D` is used nowhere else |
| D6 | Autonomous gate: `permissionMode: acceptEdits`; `canUseTool` allows everything except Edit/Write/NotebookEdit outside the worktree and Bash matching `git push`, `git reset`, `git checkout`, `git switch`, `git rebase`, `--force`, `branch -D` | Autonomous = no human watching; the worktree confines edits; history-rewriting or escaping commands are refused |
| D7 | Supervised: `permissionMode: default`; every `canUseTool` call becomes an approval card; board MCP tools pre-allowed | A project may require that every write is approved; this is how that is honoured |
| D8 | Plan stage runs with `disallowedTools: Edit, Write, NotebookEdit` | A plan must not edit files; cheaper than plan mode + ExitPlanMode round-trip |
| D9 | Chat follow-up reuses the task's latest run row (`resume` its `session_id`); cost accumulates on that run | Spec §6.2.5 "new query() with resume on the same run" |
| D10 | Supervised pipeline end → `review`; Approve on a supervised task = `done` (no merge) | Same human checkpoint in both modes |
| D11 | Boot recovery: runs in `running`/`approval` → `failed` (`interrupted`) and their tasks → `failed`; tasks still `queued` are re-enqueued; pending approvals → `expired` | Spec §6.2.6, and the queue lives in memory |
| D12 | Stop: queued → `backlog`; running → abort, run + task `failed` with `stopped by user` | Retry still works from the stored `session_id` |
| D13 | Messages addressed to a task are injected into that task's next stage prompt (last 20) and broadcast live over WS | Spec §6.3 "read by that task's next stage prompt" |
| D14 | `board_post_message` with no `to_task_id` goes to the parent task | Children report up; verification §8.4 |
| D15 | Plugin skills are read from `~/.claude/plugins/installed_plugins.json` `installPath` (the active version), flagged enabled from `settings.json` `enabledPlugins` | The plugin cache keeps stale versions (e.g. two `frontend-design` dirs) |
| D16 | The SDK prompt is a one-message async iterable (streaming input), not a string | `canUseTool` approvals and `interrupt()` need the bidirectional stream |
| D17 | SDK pinned to exactly `0.3.268` | Must match the installed Claude Code CLI (2.1.268) |

## After the engine code review (2026-09-11)

| # | Decision | Why |
|---|---|---|
| D18 | Git runs through `execFile` with strict exit-code checks; `simple-git` removed (replacing the original simple-git choice) | A test showed simple-git's `raw()` **resolves** on a conflicted `git merge` (CONFLICT goes to stdout), so Approve would have treated a conflict as success. A failed merge is now `merge --abort`ed and reported with the conflicting files; the user's checkout is left unchanged |
| D19 | Autonomous gate hardened: applies to `Bash` **and** `PowerShell`; git limited to an allow-list (`status diff log show add commit ls-files grep blame rev-parse …`); `-C/--git-dir/--work-tree` refused; `..` traversal, home-dir references and absolute paths outside the worktree refused; external MCP tools refused (board + context7 allowed); `AskUserQuestion` refused | The worktree sits inside the project, so `cd ../../.. && git restore .` could wipe the main checkout; `git -C "path with spaces" reset` and `git -c k=v push` got past the first regex; user-level MCP plugins (e.g. Supabase) must never be called unattended |
| D20 | Supervised runs add a `PreToolUse` hook that returns `permissionDecision: "ask"` for every tool that isn't read-only or the board | Settings allow-rules (user or project) would otherwise pre-approve writes and skip the approval card, silently breaking the promise that every write is approved |
| D21 | The server only answers `Host` 127.0.0.1/localhost on :4310 and :5173 and refuses any foreign `Origin` (REST and the WS upgrade) | WebSockets have no CORS and a `no-cors` POST still runs handlers, so any open website could read transcripts or trigger Approve/Discard; DNS rebinding could reach the whole API |
| D22 | Approve / Discard / Chat hold the task busy for their whole git or session step; Stop is honoured between stages and during worktree setup; Approve merges whenever a branch exists; mode can't change while a worktree exists | Review found double-Approve, queue-during-merge, lost Stops and stranded worktrees |
| D23 | A chat that succeeds only moves the task to `review` if every stage has a successful run; otherwise `failed` with "Retry continues from stage #n". Retry (and restart re-queue) default to the first stage without a successful run, resuming its session | Otherwise a chat after a failed Plan could send an unimplemented task to review and Approve would merge partial work |
| D24 | Skills "Open" uses `explorer.exe <path>` (no shell) | `cmd /c start` would run commands embedded in a skill folder name |

## Desktop, usage and limits (2026-09-11)

| # | Decision | Why |
|---|---|---|
| D25 | Every stage runs with `maxTurns` (60) and `maxBudgetUsd` ($5), editable in Settings | Nothing stopped a looping unattended run; the SDK returns `error_max_turns` / `error_max_budget_usd` so a capped run fails cleanly and Retry can continue |
| D26 | The review stage's `VERDICT:` line is parsed — `CHANGES_NEEDED` fails the task with the reasons instead of landing it in `review` | The prompt asked for a verdict that nothing read, so a review that rejected the work still looked ready to Approve |
| D27 | A chat turn restores the run's previous status/result if it fails | A failed follow-up used to overwrite a finished stage's success, making a complete pipeline look incomplete |
| D28 | A commit made after a failed stage is tagged `[failed]` | Otherwise half-written edits look like a normal stage commit in the branch history |
| D29 | The rejection note is injected into the next run's prompt (`## Why this was sent back`) | The note was stored and shown to the user but never reached Claude, so a re-queued task repeated the same mistake |
| D30 | `PRAGMA synchronous = NORMAL` | FULL fsyncs on every streamed event row; NORMAL is the standard durability level under WAL |
| D31 | Usage windows come from the CLI's `rate_limit_event` (five_hour / seven_day) into a `usage_limits` table, shown as meters in the header | Same numbers Claude Code shows; no extra API calls, and it warns before a run is rejected |
| D32 | Context window per run is tracked from each assistant turn's usage vs `modelUsage.contextWindow` | Shows how full a session is before quality degrades; the data was already in the stream |
| D33 | Login is startable from the UI: the server opens a terminal running `claude auth login` and polls `claude auth status` until it succeeds, then confirms in the banner | OAuth needs a TTY, so the app can't do it silently; polling turns "did it work?" into a visible answer |
| D34b | Project folders are chosen with the OS folder dialog (`FolderBrowserDialog` on Windows, `osascript` / `zenity` elsewhere), typing a path still works | Pasting absolute paths was the clumsiest part of adding a project |

## Following Anthropic's guidance (2026-09-11)

Driven by [Anthropic's long-running-agent harness guidance](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and the Claude Code [best practices](https://code.claude.com/docs/en/best-practices) on verification.

| # | Decision | Why |
|---|---|---|
| D35 | Per-project **verify command** gates a task: the code stage runs behind a `Stop` hook that blocks the turn while the command fails, and the board re-runs it afterwards as the record of record. Failure output goes into the next attempt's prompt | "Give Claude a check it can run… without a check, 'looks done' is the only signal and you become the verification loop." The Stop hook is Anthropic's deterministic gate, and Claude Code stops honouring it after 8 blocks, so it cannot loop |
| D36 | Worktrees are seeded from **`.worktreeinclude`** (plus a per-project list) and a **setup command**, with `KANBAN_PORT` exported for dev servers | A worktree is a fresh checkout: `.env` is missing and nothing is installed. This is the most-reported failure in every comparable tool. Same convention as Claude Code and Conductor |
| D37 | Seeding copies a file only when it matches a pattern **and** git already ignores it; patterns that escape the project are refused, with size and count caps | A tracked file must never be silently duplicated into a worktree, and one bad pattern must not copy a gigabyte |
| D38 | **Project memory**: one-line notes per project, injected (first 12) into every stage prompt, readable in full via `board_memory`, written by `board_remember` and automatically on Approve | Gives later tasks the decisions of earlier ones — Anthropic's multi-session pattern of reading memory at session start |
| D39 | Memory is capped (280 chars, 60 per project), de-duplicated, and editable/deletable in Settings | "Catastrophic remembering" is measured: agent instruction files grow +226% and are never pruned, and stale notes silently anchor later runs on wrong information |
| D40 | Prompts are clamped (spec 8k, results 6k, 15 siblings, 10 messages) with a note saying what was trimmed and where to get the rest | Context is a finite budget with diminishing returns; the board tools can fetch the full text on demand |
| D41 | Every earlier successful stage's result is passed forward, not just the previous one | The review stage was seeing the code summary but never the plan it was meant to check against |
| D42 | Subagent blast radius is capped per run (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=5`) | "Opus 5 delegates to subagents more readily than earlier models"; documented runaways burned a five-hour window in minutes |
| D43 | `systemPrompt: { preset: claude_code, excludeDynamicSections: true }` by default | Keeps the prefix static so it is cache-read at 0.1× instead of re-created every stage; the stripped cwd/git sections are re-injected as the first user message, so nothing is lost |
| D44 | Worktree cleanup lists every worktree with its blockers and prunes **only** ones that are clean, fully merged and belong to a finished task | Tools in this category either never shipped cleanup or deleted uncommitted work; refusing is always safe |
| D45 | A global **Approvals inbox** with `a` / `y` / `n` and a tab-title badge | Unattended runs stall silently on permission prompts; the queue is the thing that needs attention, not the board |

## Intake, classification and decomposition (2026-09-11)

Research sources: Linear's split of deterministic triage rules from LLM *suggestions*; measured limits of issue classification (humans mislabel ~34% of bug reports; best classifiers ≈ F1 0.83); Anthropic's guidance on interviewing before specs, on verification, and on when **not** to parallelise.

| # | Decision | Why |
|---|---|---|
| D46 | Five task types (`feature bug chore docs refactor`) and four priorities (p0–p3), both closed enums | Short, closed vocabularies are what teams label consistently; more options produce noise, not precision |
| D47 | Triage **suggests, never decides**: type and labels are applied only above 0.7 confidence, priority is *never* auto-applied, and anything unsure is shown as a dismissible suggestion chip | A wrong label is worse than no label; Linear ships auto-apply as an explicit per-property opt-in for the same reason |
| D48 | Labels come from a **closed per-project vocabulary**; the model picks from it and may not invent one | Label sprawl is the documented failure of LLM labelling, and Linear/GitHub both added controls specifically to prevent it |
| D49 | Intake runs with `settingSources: []`, `tools: []`, `permissionMode: dontAsk`, 2 turns, $0.50 | Classifying a request needs no repo access and no plugins; it is the cheapest possible call and cannot touch anything |
| D50 | **Improve** (refine) rewrites a rough request into Problem · Done when (EARS `WHEN … THE SYSTEM SHALL …`) · Out of scope · Verify, asks at most 3 questions, and proposes subtasks — as a **proposal you edit and accept**, saving nothing until then | Interaction measurably improves outcomes on underspecified tasks; spec-driven tools are criticised for generating documents nobody asked for, so the artifact is one spec on the task itself, not a folder of markdown |
| D51 | Subtasks declare the **files they will touch**, and any two whose file sets overlap are given a dependency automatically — enforced again when the proposal is applied | Anthropic: "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files." The model's own ordering is not trusted |
| D52 | Dependencies are satisfied by `done` (merged), not `review`; a parent can **auto-queue** children, and the ready set drains as dependencies clear | Unmerged work in another worktree is invisible to the next task; auto-queue turns a plan into execution without a human clicking each card |
| D53 | Refuse to split below 3 parts, cap at 6 | "If you could describe the diff in one sentence, skip the plan" — thin subtasks cost more in overhead than they save |
| D54 | Dashboard shows: needs-you, open, done, spend, **median** cycle time, first-pass rate, throughput, spend per day, cost by model, failures by stage | These are the metrics that are actionable at one-user scale; averages of skewed cycle time, velocity, burndown and CFD are vanity or invalid at this n |
| D56 | Old sessions are never reopened days later. **Follow-up task** creates a new task whose spec carries the previous task's summary, reported result and changed files, links both ways, and says to start from the repo's current state | The worktree is deleted at approval so the session has no cwd; the repo has moved on; and the SDK docs advise capturing results into a fresh session over resuming. Chat still resumes *within* a task, where that context is still true |
| D57 | Related tasks are injected into stage prompts as a short list, with `board_get_task` for the detail | Carries history without pasting whole transcripts into the context |
| D58 | `GET /api/search` covers task fields, run results/errors, transcripts, messages and memory, with snippets; `/` or Ctrl-K in the UI | "What did we do about X?" must be answerable from the board's record instead of from a remembered session id |
| D55 | Chart palettes are the dataviz reference instance stepped for our dark surface and **checked with the validator** (categorical 6, 2-series, ordinal priority ramp all pass); every chart has a legend, direct labels and a table view | Colour-blind safety is computable, so it is computed rather than eyeballed; identity never depends on colour alone |

## Seeing and editing the wiring (2026-09-11)

Prompted by: *"Cline have the ability to create multiple tasks… it links them, runs some in parallel if they don't affect each other, or makes a queue… and it shows some wiring."* The engine already did all of it; what was missing was the picture and a way to draw on it.

| # | Decision | Why |
|---|---|---|
| D59 | The graph is laid out by **longest-path layering**: a task sits one column right of its deepest dependency, so a column is exactly the set that may run at once, labelled "start" / "after step N · n in parallel" | The layout answers the two questions a person actually has — what runs now, and what is waiting — without them reading any arrows |
| D60 | Dependencies are editable by dragging a handle between cards, and removed with **two clicks on the arrow** (the first arms it and says what will happen) rather than a modal | A native `confirm()` is a blocking dialog nobody reads; arming the arrow puts the consequence — "these will run together" — where the change is being made |
| D61 | **Cycles, self-links, cross-project links and unknown ids are refused by the server** (409, message names the task), never repaired client-side | A loop has no valid run order and would deadlock the queue silently. The UI is one of several writers (board MCP, triage, API), so the invariant lives where every writer passes: `server/src/engine/graph.ts` |
| D62 | Links stay **one-directional**. No "back and forth" edges, no auto-created reverse links | A cycle is not a workflow, it is two agents waiting for each other; where work genuinely goes back and forth, that is a Follow-up task (D56), which is a new node, not a back-edge |
| D63 | A parent with children on screen is drawn as a **dashed container showing `done/total`**, not as work of its own; the board card carries the same `2/5` chip | The parent is a grouping, and drawing it as a peer of its children implies an ordering that does not exist |
| D64 | The parent's Subtasks tab is a **checklist**: progress bar, "waits for X" under each blocked child, and **Queue N ready** that queues only the unblocked ones | The old button offered to queue every backlog child, including ones the server would immediately refuse for an unmet dependency |

## Landing safely, and who decides how big a task is (2026-09-11)

Prompted by: *"add role related to using trees or keep main, how to deploy merge and avoid conflict or overwrite on other sessions — you decide how we should handle committing to main and merging safely"*, and *"I want the AI to decide if this should be multiple tasks or one, not the user… make sure we're doing things better, not worse and more expensive."*

| # | Decision | Why |
|---|---|---|
| D65 | **The base is merged into the task's worktree before the task is merged into the base.** Conflicts therefore happen in the worktree, where the session that wrote the code can fix them, and the user's checkout is never left mid-merge | This is the whole safety property. It also makes the final merge a fast-forward of an already-current branch, so it cannot conflict |
| D66 | After that update pulls anything in, **the verify command runs again** on the combined result before landing | "It passed before the other task landed" is not the same as "it passes now". Two tasks that each pass alone can fail together, and that is exactly the case a board running work in parallel creates |
| D67 | Landing is **refused while the project checkout is dirty**, and refused when the checkout is on a branch other than the configured base | Merging into a dirty tree entangles the user's own uncommitted work in a merge commit they did not make. Refusing costs one sentence; recovering costs an afternoon |
| D68 | **One landing at a time per project**, serialised through a promise chain in the runner | Two merges into the same branch race over one index and one HEAD. Nothing else in the board needs a lock; this does |
| D69 | Strategy is a choice of `merge` (default), `rebase` (fast-forward, linear) or `squash` (one commit); on conflict the choice is **stop and tell me** (default) or **give it back to Claude**, which appends a resolve stage to the same task | Different repos have genuinely different house rules, and the person who wrote the code is the one best placed to resolve a conflict in it. The default stays the boring, reversible one |
| D70 | A failed merge is undone with `merge --abort`, never `reset --hard`. If the abort itself fails, the board says so and stops rather than "fixing" it | A standing rule on this board: never force past an obstacle. A checkout the board cannot restore is a problem for a human, not for a retry loop |
| D71 | The drawer shows **"N commits landed on main since this started"** with an Update button, and the worktree list shows how far behind each one is | Staleness is invisible until it bites at approval time. Showing it lets a long task catch up while it is cheap to do so |
| D72 | **Triage decides one-task-or-several, not the user**, and must state the reason in `split_reason`; the prompt tells it that each subtask costs a full pipeline, and anything under three pieces collapses back to a single task | The requester is not expected to know what a good decomposition is — that judgement is the product. Making the model account for the cost is what stops it splitting for the sake of looking thorough |
| D73 | The Improve modal shows that decision with the trade-off in usage terms ("3 tasks means 3 pipelines, roughly 3× the usage") | The board exists to be cheaper and more reliable than doing it by hand; a feature that quietly triples spend has to say so |

## Making it usable on a real screen (2026-09-11)

| # | Decision | Why |
|---|---|---|
| D74 | Interface scale (85–150%) is applied as `zoom` **on `<html>`**, not on an inner element | On any inner element the layout box scales too and the app overflows its own viewport; on the root, `height: 100%` resolves against the scaled viewport, which is how browser zoom already behaves. Measured both ways before choosing |
| D75 | Board columns default to **fill** — sharing the window evenly — with fixed S/M/L/XL widths as alternatives, and a horizontal scrollbar kept as a safety valve | Fixed-width columns left dead space on a wide monitor, which was the actual complaint. The scrollbar stays because "fill" on a narrow window would otherwise clip the last column |
| D76 | Display preferences live in `localStorage`, not the database | They describe this screen. A second PC has a different monitor, and syncing them through the board would be wrong on both |
| D77 | A reusable `?` (`Help`) explains autonomous vs supervised wherever the choice is offered, from one shared definition | The board is meant for someone who does not already know what a worktree is. One definition in one place means the two explanations cannot drift apart |
| D78 | Settings is split into tabs: Appearance · Models & pipeline · Runs & limits · Git & merging · Project · Memory · Worktrees, with the Save button only on the tabs it applies to | A single scrolling page had made it unclear which Save button owned which setting — project-scoped sections save themselves, global ones do not |

## Images and archiving (2026-09-11)

| # | Decision | Why |
|---|---|---|
| D79 | Attached images are handed to runs as **absolute paths to read**, not as base64 in the prompt | The Read tool renders images, works in both modes, and costs nothing until the model actually opens one — a prompt-embedded image is paid for on every turn of the session whether it is looked at or not |
| D80 | Images live under `<stateDir>/attachments/<taskId>/`, never inside the user's project, under a filename the board generates | A project folder is the user's; the board does not litter it. Generating the stored name means a crafted upload name cannot escape the folder or overwrite anything |
| D81 | Images a session produces are captured as they stream past — base64 blocks inside tool results, and files written with an image extension — and **copied**, not referenced | A screenshot inside a tool result exists nowhere on disk, and a file in a worktree is deleted at approval. Copying is what makes "see what the session generated" still true tomorrow |
| D82 | Capture is bounded (20 images per run, 8 MB each) and wrapped in try/catch | An image is a nice-to-have; it must never be the reason a run fails, and a chatty browser session must not fill the disk |
| D83 | **Archive is a flag, not a delete**: `archived_at` hides a task from the board and nothing else. It stays in search, in the dashboard, and keeps its runs, diffs and images | The request was "so we don't clutter the view". A destructive answer to a visual problem is how people lose work — and a board nobody dares tidy stops being used |
| D84 | Archiving is offered as **tidy** on the Done column (everything finished, one click) as well as per card, with *show N archived* in place | Clearing one card at a time is the reason clutter accumulates; the bulk action is the one that actually gets used |

## Paying for what the work is worth (2026-09-11)

Requested: *"Not all writing require opus high, maybe sonnet is enough"*, *"reading images doesn't need fable 5.1 high"*, and *"the AI changes the model and effort according to the size of it but asks me for approval; if I reject it goes to default"*.

| # | Decision | Why |
|---|---|---|
| D85 | Intake **sizes the pipeline** for every new task — which stages, and a tier per stage — and the board maps tiers to model ids from Settings | The model choosing `cheap` cannot hallucinate a model id, and changing what "cheap" means updates every future proposal at once. Sizing rides in the intake call that already runs, so it costs nothing extra |
| D86 | A sized pipeline is **only ever a suggestion**. The task keeps the project default until someone presses *Use it*; *Keep default* discards it | Getting this wrong spends real money on an unattended run. Every other auto-applied guess on this board is reversible with a click; this one would not be |
| D87 | A proposal with no `code` stage is discarded | A pipeline of plan-and-review changes nothing. Cheaper is the goal; doing nothing cheaply is not |
| D88 | The intake prompt states the cost relationship outright — "the strong tier and high effort cost several times what the cheap tier costs… spending more than the work needs is a defect, not caution" | Without it the model reaches for the strongest option, the same way it over-splits tasks. Naming the trade-off is what changes the answer |
| D89 | Attached images are described **once, by a cheap vision model**, and the description goes into every later prompt; the path stays as a fallback | A three-stage task otherwise opens the same screenshot three times on whatever model that stage runs — Fable at high effort, in the default pipeline. One Haiku call replaces all of it, and the stage can still open the file when the words are not enough |
| D90 | The vision call gets `tools: ["Read"]`, no setting sources, 4 turns and $0.15 | Describing an image needs exactly one file read and nothing else; the ceiling means a stuck call fails cheaply |
| D91 | Per-task cost shows tokens and dollars **and a measured share of the five-hour window**, taken from the utilization the CLI reported before and after each stage | Runs go through a subscription, so dollars are an estimate of something you are not billed for. The window is the thing that actually runs out — and it is measurable rather than guessed |
| D92 | Where the window was not reported, the panel says "not measured" instead of estimating | A made-up percentage about your remaining quota is worse than an honest gap |

## Files in, artifacts out (2026-09-11)

| # | Decision | Why |
|---|---|---|
| D93 | The accepted set is keyed by **extension**, not by the media type the browser reports | Browsers disagree about `.csv` and `.md`, and the type we store is the one we have to trust when serving the bytes back. An unknown extension is refused with a message naming it |
| D94 | Text and CSV attachments carry their **own first 4 KB as a preview**, written at upload with no model call | The data is usually the point of attaching a CSV. Putting it in the prompt is free and saves the stage a file read; images need a model because pixels are not text, text does not |
| D95 | A run's output files are kept as **artifacts**, matched by an allow-list of output extensions (html, pdf, csv, xlsx, docx, images…) and never from `node_modules`, `.git`, `dist` and friends | "Show what it generated" must not become "hoard every source file it wrote" — those are already in the Diff. One entry per path, so a file written three times appears once |
| D96 | Everything except a bitmap image is served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` | A generated HTML file is untrusted content. Served inline from the board's origin it could call the board's own API with the user's session |
| D97 | HTML and SVG are previewed in an **iframe with `sandbox=""`** (no allow-scripts, no allow-same-origin), fed from a separate `/text` endpoint that always returns `text/plain` | The user asked to see the artifact, not to download it and hope. A sandbox with no privileges renders it faithfully while it can do nothing |
| D98 | CSV/TSV get a real table preview, other text a monospace view, and binary formats an honest "opens in its own application" plus Download | A preview that lies about what it can show is worse than no preview |

## Efficiency audit and what it changed (2026-09-11)

Four parallel audits (engine, UI, token cost, external research) plus direct measurement against the live SDK. The measurements mattered more than the opinions.

| # | Decision | Why |
|---|---|---|
| D99 | **Measured, not assumed**: a stage sends ~44,500 input tokens, of which the board's own prompt is ~1,750 (4%); the cached prefix reads ~34,700 at 0.1× and writes ~6,800; user plugins cost ~5,400 per stage | The cost audit proposed reordering the prompt for cache alignment on the assumption it was 15–20k characters. It is not. Measuring first stopped a day's work that would have saved nothing, and found the real 12% lever instead |
| D100 | Loading global plugins/hooks/skills is now a **setting**, default unchanged | It is 12% of every stage, but turning it off silently would break anyone relying on a global skill. Named, measured, and left to the user |
| D101 | Transcripts **never store base64 image data** (the bytes are already an attachment) and a single event is capped at 24k chars; finished runs' transcripts are pruned after a retention window on restart | `events` was the one table growing without bound, and screenshots were stored twice — once inflated by a third inside JSON. Runs, costs and results are never pruned: those are the record |
| D102 | Analytics are **SQL aggregates**, not rows loaded into JS | The dashboard silently dropped everything past the first 2,000 runs. A number that is quietly wrong is worse than a number that is missing |
| D103 | **A per-task cost ceiling** ($15 default) on top of the per-stage one | Per-stage caps multiply: three stages at $5 is $15, and a parent with six subtasks is far more. The documented incidents are all "nobody was watching" |
| D104 | **Blocked commands are refused outright in both modes**, before the approval card | An approval card assumes a human reads it. For `DROP DATABASE` or `rm -rf /`, a card is just a chance to click the wrong button. Matching normalises quoting and pipes, so `curl … \| sudo bash` is caught |
| D105 | A stage that makes the **same tool call N times in a row is stopped**, and the stream is abandoned rather than merely aborted | Reported runaways retry one failing call for hours. The first implementation only called `abort()`; a test proved the fake session kept streaming, so it now breaks out of the loop as well |
| D106 | Transcript events are sent only to clients **watching that task**; everything else still broadcasts | A busy run emits hundreds of messages, each a whole SDK message, and only the open drawer wants them. This and memoising the card are what make the board stop re-rendering while work runs |
| D107 | The conflict-resolution turn is a **chat in the existing session**, not an appended pipeline stage | The earlier implementation (D69) welded a synthetic stage onto the task permanently, skewing every later retry and every stage statistic. Found by the engine audit; it was my own bug |
| D108 | Verification is **cached against the tree's commit**, and skipped when nothing changed | The same command could run three times for one unchanged tree — Stop hook, board check, and again before landing. Minutes of wall clock for an answer already known |
| D109 | Board cards no longer carry `spec_md`; approvals carry their task title; `isGit` is cached; the health poll is gone | Each was a payload or a subprocess paid on every refresh for something the screen never showed |

## Usage windows and auto-resume (2026-09-11)

Requested: an auto-resume that picks work up again after the session limit resets, and the session time visible inside the board — *"so you just know what there is and no need to open another app."*

| # | Decision | Why |
|---|---|---|
| D110 | Both windows are read from **`rate_limit_info.unifiedWindows`**, one entry per window | Captured from a real call before building anything: the percentages live there, not at the top level. The board had been reading the top level only — recording the five-hour window with no percentage and **never recording the weekly window at all**. That is why the meters were mostly empty |
| D111 | Every run's numbers are kept and shown with **"as of"** and a live countdown; **Check now** makes one tiny call (~$0.018 measured) for fresh ones | No CLI command reports usage — checked `claude --help` — so a call is the only source when nothing is running. It is manual and labelled with its cost rather than polled, because a board that quietly spends your quota to tell you about your quota has the priorities backwards |
| D112 | A run stopped by the limit becomes **`paused`**, a status of its own, not `failed` | Nothing went wrong with the work. Showing it as a failure would train you to ignore red, and sending it to Backlog would lose the fact that it resumes by itself |
| D113 | Resume time is **the latest reset among the blocking windows, plus 90 seconds**; with no reset known, 30 minutes | Resets are not exact to the second, and resuming a moment early walks straight back into the same wall. When the CLI gave no time, half an hour is a guess that errs on neither side |
| D114 | Resuming **is Retry**: the first stage without a successful run, resuming that stage's own session | So a plan already finished is not redone and paid for twice. The test drives plan → code → limit → reset and checks the stages run are exactly `plan, code, code`, with the second `code` resuming `s-code` |
| D115 | One timer for all paused tasks, set to the earliest resume; re-armed on restart, and anything already due resumes at boot | A task paused overnight must still continue if the board was closed and reopened in between. One timer rather than one per task means nothing leaks when tasks are deleted |
| D116 | Only a usage limit pauses. A real error still fails, and auto-resume is a setting | A pause that swallowed genuine failures would hide bugs behind a countdown |

## Speed: effort and fast mode (2026-09-11)

Requested: *"Claude have three speeds, slow, balance and fast — add this, default balanced, follow the same Claude names and notes."*

| # | Decision | Why |
|---|---|---|
| D117 | **No "slow / balanced / fast" was built.** The board uses Claude's two real controls — effort and fast mode — under Claude's own names | Checked before building: the SDK has no three-level speed and the word "balanced" appears nowhere in it; the Claude Code docs confirm there is no such control. The request was to follow Claude's names, and inventing a three-way switch would have done the opposite — the same "if my request is wrong, don't do it" call made for image reading |
| D118 | Effort shows **Claude's notes word for word** — "Fastest and cheapest", "Reduces token usage", "Default on most models", "Deeper reasoning at higher token spend", "Demanding tasks needing maximum reasoning" — and new stages default to `high` | `high` is Claude's own default, which is the nearest honest reading of "default balanced" |
| D119 | Fast mode is **per stage**, off by default, sent as `settings: { fastMode: true }` only when the stage's model is Opus 5 or 4.8 | A stage later moved to Sonnet must not start failing because of a flag it cannot honour. A test runs Opus+↯, Sonnet+↯ and Opus without it, and checks only the first requests fast mode |
| D120 | Availability is read from the session's **init message and aborted before any model call** | It costs nothing, and it matters: on this account it reports `extra_usage_disabled`. A toggle that silently did nothing would be worse than none, so it says why instead |

## CLAUDE.md, and the folder picker (2026-09-11)

Requested: a place to read CLAUDE.md, and to have Claude create or improve it "just like how we do inside Claude Code". Reported: adding a project and clicking Browse "didn't work as expected".

| # | Decision | Why |
|---|---|---|
| D121 | The CLAUDE.md view lists **every file Claude Code loads, in its order**: user, project (either location), local, and path-scoped rules — read-only | Checked against Claude's docs: the files are concatenated, not overridden. Showing only `./CLAUDE.md` would hide instructions every run actually receives |
| D122 | Create / Improve run **Claude Code's real `/init`**, not a board prompt that imitates it | "Just like how we do inside Claude Code" is only true if it is the same command. Confirmed first that `init` is in the SDK session's slash-command list, and that — in Claude's words — `/init` "suggests improvements rather than overwriting" an existing file, so one button covers both |
| D123 | `/init` runs **as a task**, never as a direct write | The change then lands like every other: a reviewed diff, or an approval card in a locked-down project. A convenience button that wrote into a repository whose rules say "every write approved" would be a side door |
| D124 | A custom stage whose prompt is a slash command is **sent as that command**; anything else still gets the board's prompt | Wrapping `/init` in the stage prompt turns it into text Claude reads *about*, not a command it runs. A sentence that merely mentions a command is not treated as one |
| D125 | The folder picker is now Windows' **modern Explorer dialog** (IFileOpenDialog, FOS_PICKFOLDERS), owned by a **shown**, invisible, topmost window | The old version created its owner window but never showed it, so the dialog opened *behind* the browser and the button sat busy — which is what "didn't work" was. It was also the tree-view dialog that cannot take a pasted path |
| D126 | The starting folder reaches PowerShell in an **environment variable**, never spliced into the script; picker failures are returned and shown instead of being reported as a cancel | A folder name containing `$` or a backtick changed the old script. And any error used to look exactly like pressing Cancel, so the form said nothing at all |
| D127 | The dialog is lifted with **`HWND_TOPMOST` on the dialog itself**, then given focus by briefly joining the foreground window's input queue. Verified by measuring the live window: `TOPMOST=True`, `FOREGROUND=True` | D125's owner-window approach was not enough — the report was that it still opened behind other windows. Windows' foreground lock stops a background process taking the foreground, but topmost z-order needs no permission. Simulated keystrokes (the other common trick) were rejected: they leak into whatever window you were using |

## Browser checks and plugins (2026-09-11)

Requested: "Claude Code have built in browser also can use chrome browser … make it also do that, so it can take screenshots and see his final results are good or not", and "make it use plugins that claude code use and have (not only skills) in case we didn't cover this already".

Found first, by opening a real session and stopping it at its init message: runs **already** loaded all 8 plugins (tool servers, commands, agents, hooks, skills), Playwright's 24 tools among them — and the six claude.ai connectors. The browser was loaded but unusable: autonomous runs refused every call, supervised runs would have raised a card per click, and no stage was ever asked to look.

| # | Decision | Why |
|---|---|---|
| D128 | Browser calls get **their own rules**: looking at a local page (navigate, screenshot, snapshot, console) is allowed in both modes, with no card; clicking and typing are allowed unattended on local pages and are a card in supervised tasks; any other site, custom browser code and file upload are refused unattended and a card otherwise | A screenshot changes nothing, so a card for it is noise; a click in a supervised task can write (a local app may talk to a real backend), so it stays approved. "Local" is this machine or a file in the task's folder, checked on every tool that carries a URL, not only navigate |
| D129 | The board runs **its own Playwright server per session** (`--headless --isolated --output-dir <temp>`) and hides the plugin's copy | The plugin's shared on-disk profile is locked by the first browser, so a second task in parallel could not open one. Headless keeps background runs from opening windows over your work; the output folder outside the worktree keeps snapshots and logs out of commits. Verified directly: a screenshot comes back as an image (which the board already saves to the task) and nothing is written into the project folder |
| D130 | **Code and review stages** are told to look at visible changes — start the app on the task's port, screenshot, fix, screenshot once more — and to skip it when nothing visible changed | "See his final results are good or not" is the review; the code stage checking first is cheaper than a failed review. A screenshot costs about a page of text, so the prompt asks for the few that show the result, and a backend task pays nothing |
| D131 | **Claude in Chrome is off by default**, offered only to supervised runs when switched on, with every call a card; autonomous runs are started with `--no-chrome` and refused its tools as well | It is the user's own browser, signed in to their accounts. An unattended run must never drive it, whatever a setting says |
| D132 | Plugins were already covered, so the change is **visibility, not loading**: "What runs get" lists plugins and tool servers from a real session aborted before the model is called, with the board's rule for each | The honest answer to "in case we didn't cover this" is to show what a run gets, measured, rather than assert it. It costs nothing, and it also shows the claude.ai connectors (Gmail, Slack, Drive…) runs can see, and how they are gated |

## First real run of browser checks (2026-09-11)

Asked: "did you test it? … will ai automatically go and use playwright just like claude do". It had only been tested piece by piece. A real task on a throwaway site ("make the header look better", no mention of a browser) showed the session *did* start the app, open it and screenshot it on its own — and found three bugs, one serious.

| # | Decision | Why |
|---|---|---|
| D133 | **Killing processes by name is refused outright**, in both modes, not editable: `taskkill /IM` or `/FI`, `pkill`, `killall`, `Stop-Process -Name`, `Get-Process … \| Stop-Process`, `wmic process … delete`, `kill -1` | Told to "stop the server when you are done", the session ran `taskkill //F //IM node.exe` — which killed every Node process on the machine, the user's own board included. Killing your own PID stays allowed; there is no version of kill-by-name an approval card makes safe |
| D134 | The prompt now says **how** to stop: the background command or PID you started, never by name — and the board **stops whatever is still listening on the task's reserved port** when a stage ends, by PID and process tree | The instruction caused the incident, so it has to be precise. The port belongs to that one task, so whatever holds it after the stage is the stage's leftover; a dev server started with `&` would otherwise outlive the task |
| D135 | A screenshot's **`filename` is dropped**, and any other browser output file is moved into the board's temp folder | Given `filename: "header.png"`, Playwright wrote the file into the worktree and returned no image, so the session had to read it back — one wasted turn, and a file that could have been committed |
| D136 | Images a stage merely **opens** (Read) are no longer collected as screenshots | Reading a user's attached image filed a copy of it as a "screenshot". Only images a tool *produces* are the run's output |

## Usage meter showed the wrong numbers (2026-09-11)

Reported, with a screenshot: "why Claude using is wrong?" The meter said 5-hour 40%, weekly 14%, "as of 1h ago". The real figures were 88% and 19%.

| # | Decision | Why |
|---|---|---|
| D137 | The meter reads your **whole subscription's** usage the way Claude Code's `/usage` does (the SDK's usage request, `skipBehaviors`), when the server starts, every 5 minutes, and on Check now | The old numbers only arrived with the board's own runs, so any use of Claude elsewhere — this very Claude Code session, claude.ai, another machine — was invisible until the next board run. Measured: ~1 s and $0, because the session is closed without a message ever being sent |
| D138 | The paid one-message probe stays, but **only as the fallback** when the free read is unavailable | The SDK marks the usage call experimental and may rename it. A meter that silently stops updating would be worse than one that costs two cents to refresh |
| D139 | Per-model weekly windows the plan reports (e.g. *Weekly · Fable*) are shown too; windows the plan does not have are not invented | Reading the account surfaced a Fable window the rate-limit events never reported. A window that runs out is shown as reached, so auto-resume waits for it |

## Notifications and sounds (2026-09-12)

Requested: "Add notifications and sounds and different sounds and colours for different things — surprise me."

| # | Decision | Why |
|---|---|---|
| D140 | Each event's colour is **the board's existing status colour** (rose needs you, lime review, moss done, rust failed, iris paused, amber running) | A new palette for pop-ups would mean learning two colour systems; this way a rose pop-up and a rose card say the same thing |
| D141 | Sounds are **synthesised with Web Audio**, one motif per event (good news rises, bad news falls, "needs you" knocks), in three voices | No audio files to ship or download, and one set of notes gives three themes. Repeats of one kind within 1.2 s play once, so ten subtasks finishing is one chime |
| D142 | Events are worked out **in the browser** from messages the board already sends; "ready for review" is the *last stage finishing*, not the status | The status is "review" both while the review stage runs and when it is ready for you — announcing on status would ring early. Built client-side because another session was reworking the server at the same time |
| D143 | The board **learns the current state before announcing anything**; "needs your approval" pop-ups stay until dismissed; the tab icon takes the colour of the most urgent thing missed | A reload must not replay old news as new. The approval is the one event that blocks work, so it must not time out unseen |
| D144 | Settings live in the **bell panel in the top bar**, stored per computer | They describe your desk, not the board (a second PC may want silence). And one click away beats a settings tab when the question is "why did it beep?" |

## Model delegation and plan debate (2026-09-12)

A stage no longer has to run on Claude. It can run on a cheaper or niche-better model, and a plan can be argued over before code is written. Three ways in, each with a different safety profile.

| # | Decision | Trade-off |
|---|---|---|
| D145 | Three adapter kinds — Anthropic-compatible (real Claude Code on another endpoint), OpenAI-compatible HTTP (text only), and CLI subprocess — rather than one abstraction over every API | Three code paths, but anything Anthropic-compatible keeps every board tool, hook, gate and worktree for free |
| D146 | Anthropic-compatible providers run the real Claude Code with env overrides only, and pin `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` + the subagent model to the same id | A subagent never asks a GLM endpoint for a Claude id; the cost is you cannot mix models inside one stage |
| D147 | Foreign cost is tokens × the price you enter, stored as `estimated`; a model with no price is a `subscription` shown as $0 with tokens | An honest "estimated / subscription" beats the SDK's $0 for an id it cannot price (same rule as D92) |
| D148 | The board meters a foreign stage's cost itself and stops it past the per-stage ceiling; CLI stages get a wall-clock timeout only | The SDK prices an unknown id as $0, so its own `maxBudgetUsd` would never fire |
| D149 | Provider keys live in `<stateDir>/secrets.json` (0600), keyed by name, resolved file-then-env; the API exposes only `hasSecret`; logs and events are redacted | Portable and dependency-free, at the cost of file-level protection rather than an OS keychain |
| D150 | A child CLI gets an env allowlist plus its own auth variable, never `process.env` | One provider's process never sees another provider's token, or the board's own Anthropic one |
| D151 | HTTP and CLI runs cannot resume: Retry re-runs from scratch, Chat is refused | Paying for a clean re-run beats faking continuity with a prompt that pretends to be a session |
| D152 | Text-only providers are allowed on plan and review only, with the diff or the file list inlined; code and custom stages are refused at queue time | A model with no tools cannot implement, but it can read a diff and critique a plan |
| D153 | A CLI provider launches read-only unless `mayEditFiles` is on **and** the task is autonomous; supervised + CLI on a code stage is refused | Approvals cannot cross a process boundary, so the worktree is the only safety net |
| D154 | The blocked-command list and the autonomous gate are **not** enforced inside a foreign CLI — stated, not pretended | Better a documented gap than a false sense of enforcement; the mitigations are read-only default, worktree isolation, the dirty-tree check, the timeout and loop detection on translated tool calls |
| D155 | Plan debate is one round and the human picks original / revised / custom | An unbounded critic loop spends money arguing; one round surfaces the objections and the person decides |
| D156 | Critic runs carry `role = critic`: visible in the transcript and the cost table, invisible to stage bookkeeping (latest run, cards, retry, chat, follow-up) | A critique must never become "the latest run" and drag the pipeline's accounting with it |
| D157 | A delegated result is labelled in the next stage's prompt as another model's output, to verify rather than trust | Claude treats its own earlier output as reliable; a foreign plan should be checked against the code |
| D158 | Windows CLI spawn uses a shell only for a `.cmd`/`.bat` shim, sends the prompt over stdin or a temp file, and charset-validates every shell-bound argument | Node refuses a `.cmd` without a shell; quoting is the only risk, so nothing free-form is ever on the command line |
| D159 | A 429 / quota from a foreign provider fails the task instead of pausing it | The pause timer is tied to Claude's own usage windows; a countdown against someone else's limit would be wrong |
| D160 | The provider "Test" button is one tiny call through the exact adapter path a stage would use, reporting latency, the model it echoed, and whether usage and cost came back | It tests the real configuration, not a hand-written ping that might pass where a stage fails |
| D161 | A read-only delegated stage that leaves the worktree dirty fails the run, and nothing is committed | A "plan" that edited files broke its contract; the person inspects the workspace rather than the board silently keeping or discarding the changes |

## Project onboarding (2026-09-12)

Registering a project sets it up for Claude: `/init` on a folder with code, a bootstrap on an empty one, and a verify command read from the result.

| # | Decision | Why |
|---|---|---|
| D162 | **No per-stage "best practices" prompt.** Onboarding produces a `CLAUDE.md` and a verify command once, as a reviewed change; the stage prompt is unchanged | Anthropic's guidance: keep CLAUDE.md under 200 lines and specific, and give Claude a check it can run. Generic advice repeated on every stage costs tokens every run and dilutes attention; the system prompt and skills already carry the generic part |
| D163 | Registering a project offers `/init` on a folder with code and a **bootstrap** on an empty one, both on by default; an empty folder is one with nothing but `.git`/`.claude`/`.gitignore` | `/init` has nothing to read in an empty folder; a bootstrap has nothing to add to a codebase. A freshly `git init`ed folder is still empty |
| D164 | The bootstrap checklist is a **setting** shipped with a researched default; empty restores it | House rules ("TypeScript strict", "always Supabase") belong to the user, not the code, and should be written once |
| D165 | After an onboarding task is approved the board **sets the verify command** if the project has none — from the bootstrap's `VERIFY:` line, else by the cheap intake model reading CLAUDE.md, told never to invent one — and posts what it set on the task and in project memory | The gate is the board's main safety check and was off until someone found the field. A wrong guess bounces tasks visibly and is one field to fix; an invented one would do the same silently, hence null over a guess. Runs after approval returns, so approval never waits on a model |

## Serial queue and the usage-limit gate (2026-09-12)

Running one task at a time, forcing one past that, and not feeding a whole backlog into a shut Claude window.

| # | Decision | Why |
|---|---|---|
| D166 | `serial` **overrides** the global cap with 1 instead of overwriting it | The switch has to be reversible without remembering a second number; the user's cap is still theirs when they turn it off |
| D167 | Serial is seeded on for a new state directory and off for a board that already has settings, decided by counting the `settings` rows before seeding | A default should not silently change how someone's existing board behaves on the next start |
| D168 | "Run now" takes a slot **outside** both caps and is not counted by them, bounded by `maxForcedParallel` | Counted, one forced task would sit in the single serial slot and block the ordinary lane for good — the opposite of what forcing means |
| D169 | While a Claude usage window is shut the queue holds only tasks whose **next stage** runs on Claude; delegated stages keep starting | `pauseForLimit` frees the slot, so the queue used to walk the whole backlog into `paused` in about a minute. Gating everything would idle providers that were never rate-limited — which is what delegation exists to avoid |
| D170 | The window is read from the paused tasks' own `resume_at`, not from `usage_limits` | `pauseForLimit` already worked the time out, and the state clears itself when `resumeDue` un-pauses them: no new column, nothing to keep in sync, and it is right even when the limit was only detected from error text |
| D171 | Only the **next** stage is inspected, not the whole pipeline | A task whose first stage is delegated should get on with it and pause later if it must; real progress beats waiting for a window it may never reach |
| D172 | Forcing skips the caps but **not** the limit gate | Forcing Claude work into an exhausted window does not run it, it pauses it seconds later; the card saying "held until 14:30" is the honest answer |

## Welcome and the Tour tab (2026-09-12)

Requested: a first-run guide showing every feature and why it is good, a close button that runs away before it lets you click it, a laughing emoji and a light note, and a dedicated tab.

| # | Decision | Why |
|---|---|---|
| D173 | The welcome shows **six** headline features and a demo; the **Tour** tab has all fourteen, each with *why it's good* and a link to where it lives | A first-run pop-up with fourteen cards is a wall nobody reads. Six earn the click to the tab; the tab is where someone goes when they want the rest |
| D174 | The demo is **a pretend board in the real status colours**, one card walking Queued → Done in 15 s; on the Tour tab it can play the real event sounds | Showing the board's own colours and sounds teaches them before the first real run, instead of describing them in words |
| D175 | The Skip button dodges a **mouse** twice (left, then back home), then gives up with 😂 and a note; **keyboard users are never teased** (Enter, Space and Esc close at once); a click within 0.6 s of it giving up is ignored | The joke is for pointer users. A trap for someone on a keyboard or a screen reader is not a joke. The pause lets the person read the punchline instead of closing on the same click that ended the chase |
| D176 | The dodge count lives in a **ref**, not only in state, with a 350 ms cooldown | Found in testing: one quick approach delivers the hover and the click before React re-renders, so it counted as two escapes and pushed the offset out of range |
| D177 | Seen-ness is stored **per machine** (localStorage) with a version number; storage that cannot be read counts as seen | Same reasoning as D144. Bumping the version re-introduces the board after a big release; treating blocked storage as "seen" stops the welcome opening on every load in a locked-down browser |

## Setup checklist (2026-09-12)

| # | Decision | Why |
|---|---|---|
| D178 | One **registry of checks**, built from the current settings (an Ollama row only with an Ollama provider, the browser row only while browser checks are on); results are detected on request with a 10-second cache and **never stored** | The machine is the source of truth: a stored "git: ok" is wrong the moment someone uninstalls it, and a row for a feature you don't use is nagging |
| D179 | One-click fixes run **built-in argument lists only**. The only user values — git name and email, and Ollama model ids taken from settings — are validated; git never goes through a shell, and Windows `.cmd` shims get one only for a charset-checked string | An Install button is a remote-control for a shell; keeping it to fixed commands keeps it from being one |
| D180 | **Fix with Claude** is a supervised task in a hidden system project (`projects.system`), pinned to Claude, one open session per check, started as **Run now** so serial mode never holds it behind board work; the check re-runs when the session stops | Installing software is exactly where every command should be seen before it runs. Reusing tasks gives the transcript, approval cards and stop button for free; hiding the project keeps it off your boards |
| D181 | Login and its status use the **SDK's bundled Claude binary**; `ANTHROPIC_API_KEY` counts as logged in | The old banner shelled out to a global `claude` and said "logged out" when it simply was not installed — while runs, which use the bundled binary, worked |
| D182 | Browser checks launch **Chrome, else Edge, else Playwright's Chromium**, passing `--browser` to the MCP server; Chromium is installed with `@playwright/mcp install-browser` | The server defaults to Chrome, which many machines lack; Edge ships with Windows. Installing through the MCP package matches its own Playwright version |
| D183 | On Windows the server **re-reads PATH** (Machine + User) after every fix | An installer updates the registry, not the running board; without this, git installed from Setup would still be "not found" until a restart |

## Steering and the cost ceiling (2026-09-12)

Two things Replit and Lovable users take for granted: telling the agent something while it works, and not losing a task to a spending limit.

| # | Decision | Why |
|---|---|---|
| D184 | A message typed on a running task is delivered by a **PostToolUse hook as `additionalContext`**, and a **Stop hook blocks the turn's end** while one is undelivered; a cursor on the run's active record (last message rowid) decides what is new, and it advances synchronously | The SDK's streaming input cannot interrupt a turn in progress; hooks are the one path that reaches the model mid-turn without restarting the session. The Stop guard means a message never waits for a tool call that never comes. Parallel tool calls run PostToolUse concurrently, so the cursor moves before any await |
| D185 | Cost ceilings **pause for a decision** (`pause_reason: "cost"`, no `resume_at`) instead of failing; **Continue** grants **one per-stage ceiling** to the task (`budget_extra_usd`) and resumes the same session; **Stop** fails it with the note as the error | A task stopped at 90 % for money and thrown away is the most expensive outcome there is. Granting one stage at a time keeps the decision small and repeatable; keeping the session means nothing finished is redone. The limit-resume timer keys on `resume_at`, so a cost pause is invisible to it |
| D186 | A cost pause is reported as **needs you**, sorts with approvals, and is left out of the usage panel's paused list | It waits for a person; the limit pause waits for a clock. The colour, the sound and the list should say which |
