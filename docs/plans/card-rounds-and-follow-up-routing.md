# Cards that remember: rounds, and follow-ups sent where the memory is

> Status: **built 2026-10-05** (D371–D379), on branch `claude/kanban-improvements-c0xnai`. Written and approved the same day.
> Left for a machine with a Claude login: the real-run check, `server/scripts/rounds-check.ts` (step 1; dry-run
> with a fake model gave 6 of 6 YES), and the before/after numbers from `measure-chat-handoff.ts` (step 8).
> Built in a slightly different order: step 1's spike became a real-run script written after the feature (no
> credentials in the build container), and fork (step 7) came before the chat routing that offers it.
> Builds on step 0 (PR #23, `server/scripts/measure-chat-handoff.ts`, D370).
> Amends D56 ("old sessions are never reopened") where its reasons no longer hold, and keeps it where they do.

---

## 1. What you will get (in plain words)

You ask the AI Manager chat for a new main page. A card builds it. Then you say *"change the heading text"*,
then *"make the button blue"*.

**Today:** each of those becomes a brand-new card. It starts from nothing, looks for the page again,
and pays to read the same files again. The card that built the page, which already knows them, sits unused.

**After this plan:**

- *While the page card waits in Review*, "change the heading" goes **to the same card's coder**. It
  already knows the page. The change joins the work you have not approved yet, and you approve it all once.
- *After you approved the page*, "make the button blue" becomes **round 2 of the same card**. The same
  coder, with its memory, works in a fresh copy of the project as it is now. Round 2 has its own to-do
  list section, its own changes and its own Approve button.
- *If the coder's memory is old or huge*, so continuing would cost more than starting fresh, the chat
  makes a **small new card** instead, told exactly what the old card did and which files it changed.
- **The chat always says what it chose and why**, for example: *"Sent to 'Main page' as round 2 — its
  memory is still warm, about $0.04 instead of about $0.30 for a new card."* You can always override it
  ("make a new card", "send it to the page card").

Claude Code's own **Projects** work the same way. Its coordinator *"starts a thread for each task"* and
sends *"new work … to a thread already working in that area, and Claude tells you which"*. What Projects
does not do is look at the cost. Your board can, because it already records each card's memory size,
model and last activity.

---

## 2. Facts this plan stands on (checked 2026-10-04 and 2026-10-05)

| # | Fact | Source |
|---|---|---|
| F1 | Continuing a session gives full context: files read, analysis, decisions. Forking gives a new session with a copy of the history. | [SDK sessions docs](https://code.claude.com/docs/en/agent-sdk/sessions) |
| F2 | A cache hit needs the same tools, system prompt and model. Changing tools invalidates everything after them. The cache is per model. | [Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| F3 | On Pro and Max the cache lasts **an hour**. A follow-up to a thread idle longer than that *"re-reads that thread's whole conversation"*, and *"for new work, asking Claude to start a fresh thread can use less than reviving a large old one."* | [Projects docs, Usage and cost](https://code.claude.com/docs/en/claude-projects); also `cacheWindow.ts` (D331) |
| F4 | Claude Code deletes session transcripts after **30 days** by default (`cleanupPeriodDays`). After that, a session cannot be continued. | [Claude Code docs: the .claude directory, data usage](https://code.claude.com/docs/en/claude-directory) |
| F5 | The bundled Claude Code (2.1.285, SDK 0.3.285) can resume a session from another folder (from 2.1.223 on). | SDK sessions docs; `node_modules/@anthropic-ai/claude-agent-sdk/package.json` |
| F6 | A card's working copy is always `<project>/.kanban/wt/<card id>` (`worktreePathFor`), and `addWorktree` makes a new branch from the current HEAD when the old one is gone. **Recreating it puts every file back at the path the coder remembers.** | `server/src/git/worktree.ts:33,84` |
| F7 | Stage system prompts are Claude Code's own preset with the dynamic parts left out (`cacheableSystemPrompt`, on by default). The card's instructions go in the message. So the same card continued on the same model and tools can hit the cache. | `runner.ts:1580`, `db.ts:271` |
| F8 | A stage starts at about **40,700 tokens** before it does anything (Claude Code plus the board's tools). That is the floor cost of a new card. | D272 |
| F9 | Messaging a card today continues its **latest** stage (usually the reviewer, not the coder). After approval, an autonomous card cannot be continued ("The task worktree is gone"). The chat only messages a card when you ask it to. | `runner.ts:3403-3436`, `repo.latestRun`, `chatBoard.ts:484` |
| F10 | Each run already records its context size (`runs.context_tokens`), model, end time, cache reads and writes. | `schema.sql`, `db.ts` migrations |

**Why D56 can change:** its three reasons were:
1. *The working copy is deleted.* F6 brings it back at the same path.
2. *The repository has moved on.* Round 2 is told exactly what changed in its files since round 1.
3. *The SDK docs advise a fresh session.* They do so for moving sessions between machines (F1). Projects'
   own docs give the rule the board will follow (F3): continue while the memory is warm and not too big,
   otherwise start fresh with a handoff. D56's fresh card stays as the fallback.

---

## 3. What the AI knows when it decides

This is the core of the plan: the chat gets the facts, the board computes the numbers, and the chat
adds what only it can judge, which is whether the request belongs to that card's work.

### 3.1 What the board computes for every card (new pure module `server/src/engine/memory.ts`, no Node imports, so the web can show the same numbers)

| Field | Meaning | From |
|---|---|---|
| `memory` | `warm` (last activity under 55 min ago), `cool` (session exists, cache gone), `gone` (over 30 days, other provider, or no session) | latest work run's `ended_at`, `CACHE_WINDOW_MIN`, F4 |
| `warm_until` | When the cache runs out | same |
| `context_tokens`, `context_pct` | How big the coder's memory is, and how full its window is | `runs.context_tokens`, `context_window` |
| `model` | The coder's model (continuing keeps it, for the cache) | work run |
| `files` | Files the card changed in all rounds (top 25) | `diffTask` per round, stored at landing |
| `round`, `rounds` | Which round it is on, and a one-line result for each | new `task_rounds` table |
| `continue_cost` / `fresh_cost` | Estimated cost of each route, in tokens and in dollars when known | see 3.2 |
| `can` | What is possible now: `steer` (running), `add_to_round` (in Review), `new_round` (done, memory not gone), `fork` (new parallel card), or `fresh_only` | status, memory, worktree, provider |
| `recommendation` + `why` | The board's pick, with one plain sentence of reasons | rule in 3.3 |

### 3.2 How the two costs are estimated (shown as approximate)

- **Continue:** the coder's memory is re-read on every turn. When warm, it's read at the cache-read
  price, about a tenth of normal input. When cool, the first turn re-writes it at the cache-write price,
  which is twice normal input for the hour cache. The board adds a typical small round of 4 turns.
- **Fresh card:** the 40,700-token start (F8), plus what this card spent finding its way the first time:
  its own reading before its first edit, measured with the step-0 logic (moved into `memory.ts`). A new
  card has to find the same files.
- **Dollars:** the board has no Claude price list (the SDK reports the cost). It uses **your own runs**:
  the average cost per weighted token for that model over its last runs. With no history it shows
  tokens only.

### 3.3 The rule (the board recommends; the chat decides; you can override)

| Situation | Route |
|---|---|
| The card is **running** | **Steer** it (exists today, D215) |
| The card is **in Review**, and the request refines that unapproved work | **Add to this round**: continue the coder, and the change joins the same approval |
| The card is done, its memory is **warm**, and its context is under 60% | **New round**: continuing is cheaper and keeps the design decisions |
| The card is done, its memory is **cool**, and `continue_cost` ≤ `fresh_cost` | **New round** (say it re-reads the memory once) |
| Its memory is cool and continuing costs more, **or** the context is over 60% | **Fresh card with handoff** (D56's follow-up, plus the files it changed) |
| Its memory is **gone** (over 30 days, other provider) | **Fresh card with handoff** |
| New work in the same area that should run **in parallel**, or while this card is busy or in Review | **Fork**: a new card that starts with a copy of the coder's memory (warm or cool), otherwise a fresh card with handoff |
| **Unrelated** to any card | A new card, as today |

The thresholds (55 minutes, 60%, 4 turns) are starting values that step 1 and step 8 measure. The board
recommends; the chat applies judgement about whether the request really is the same work ("the same
page, same design" versus "a different page that happens to use the same file").

### 3.4 How the chat finds the right card

- **New tool `board_related_cards({ request, files? })`.** The chat passes the user's words and any
  files it has already looked at. The board scores cards by overlap with the files they changed and by
  the board's own search over titles, specs and results (`searchBoard`), and returns the top 3 with
  every field from 3.1.
- **New tool `board_continue_task({ task_id, how, request, review? })`**, where `how` is `add_to_round`,
  `new_round` or `fork`. The board checks the route is allowed and refuses with a plain reason when it
  isn't. "Fresh card" stays `board_create_task`, now with `follows: <task id>` so the handoff is written
  for it.
- **Prompt rules** in `chat.ts`, replacing the "only when the user asked" line:
  - Before making a change card, call `board_related_cards`.
  - Take the board's recommendation unless the request is clearly not the same work.
  - Say in one line which card the request went to, which route, and roughly what it saves.
  - What the user says always wins.
- **Setting `followUpRouting`**: *Send follow-ups where the memory is* (default) / *Ask me each time* /
  *Always a new card*. Per the CLAUDE.md rule it lives in five places: `types.ts`, `db.ts`,
  `repo.getSettings`, `routes/settings.ts` and `Settings.tsx`.

---

## 4. How a round works (the mechanics)

1. **Starting a round** on a done card:
   - The board recreates the working copy at the same path from the current main (F6), records a
     `task_rounds` row (number, the request, the new base, its time), and sets the card back to Running.
   - Supervised cards without their own branch have no working copy, so they continue in the project
     folder as today.
2. **The round's prompt** continues the **coder's** session, not the reviewer's. The stage that did the
   work is the latest run of `code`, or of the answer or custom stage on cards without one. The prompt
   carries:
   - the request,
   - *"Since your last round: these files you changed were changed by others: …"* (`git diff --stat <your
     landing>..HEAD -- <its files>`),
   - and *"Read a file again before you edit it"*.
3. **Review in a round:** off for a refinement, on when the chat marks it as new work or the card is
   live (D233). A review is a fresh session over **this round's** changes only.
4. **To-do list:** each item gets a `round` number. The card shows each round's list under its own
   heading. A continued session keeps its numbering (runner.ts:1651), so the board only adds the round.
5. **Approve** lands the round like a card today. The cost ceiling (`maxCostPerTaskUsd`) applies **per
   round**, so a card with ten small rounds isn't stopped by its history.
6. **Too big:** when a card's context passes 60%, the chat is told to stop adding rounds and offer a
   fresh card with handoff. Claude Code compacts long sessions, but quality and price get worse.
7. **Memory gone:** a round can't start. The route becomes a fresh card with handoff, and the card shows
   *"Memory expired on <date>"*.

---

## 5. What you will see

- **On the board card:** a small **R2** chip, and a memory dot (green warm, grey cool, none when gone)
  with *"Memory warm until 14:32"* on hover.
- **In the task drawer:**
  - the Result and Changes tabs split by round, with a round picker at the top;
  - the to-do list in round sections;
  - the cost per round in the cost table;
  - the same cache bar the chat has (`CacheStrip`), reused.
- **In the AI Manager:**
  - the chat's line saying where a request went and why;
  - the card chip names the round ("Main page · round 2");
  - the right pane shows the round's own to-do list.
- **The chat's reply** names the route in plain words, for example "sent to the page card as round 2",
  "added to the change waiting for your review", or "a new small card, because the page card's memory
  is old".

---

## 6. Steps (one at a time; each one finished, tested and approved before the next)

### Before the rounds: two quick improvements (asked for on 2026-10-05)

**U1. "Studio" becomes "AI Manager", everywhere, code included.** The name fits what the page is becoming: the
place where Claude manages your cards and sends work where the memory is.

- **What you see:** the tab (`✦ AI Manager`, shortcut `0` stays), the side panel's `⤢ AI Manager` button,
  every hint and tooltip, the Tour (`features.ts`), the Welcome where it applies, and the README.
- **Code:** `views/Studio.tsx` → `views/AiManager.tsx`, the component and its helpers, the route view
  `"studio"` → `"ai-manager"` (`lib/router.ts`, `App.tsx`), the Tour id, and comments in `server/` and `web/`
  that name the page (`chat.ts`, `chats.ts`, `schema.sql`, `types.ts`, `chatSignal.ts`, `CacheStrip.tsx`,
  `useChats.ts`, `index.css`), plus the test message in `landing.test.ts`.
- **Kept working:** an old `#/studio/<project>` link opens the AI Manager. Your saved column widths and
  grouping (`kanban.studio.left`, `.right`, `.groupBy`) are read from the old names once and saved under the
  new ones, so nothing resets.
- **Not touched:** "LM Studio", "Model Studio", "Visual Studio Code" and "studio photo" are other things; past
  `DECISIONS.md` entries are history and keep the old name. A new entry records the rename.
- **Done when:** a search for `studio` finds only those other things and the history; an old link still
  opens the page; your column widths survive; the server and web checks pass.

**U2. "asks me" shows it belongs to autonomous: one joined highlight, the same switch everywhere.**

- **One shared switch** (`RunStyleSwitch` in `components/ui.tsx`) replaces the five copies: the chat (AI
  Manager and side panel, `ChatThread.tsx`), the New task form (`forms.tsx`), a card's setup (`RunSetup.tsx`),
  the task drawer (`TaskDrawer.tsx`) and Settings (`Settings.tsx`). Same labels, tooltips and rules
  (`noAuto` still greys out the autonomous choices).
- **The look:** a single highlight slides between the choices in about 200 ms. On *supervised* it covers
  supervised (cyan); on *autonomous* it covers autonomous (amber). On *asks me* it **stretches over autonomous
  and asks me as one piece**, amber fading into violet, with a small ▸ between the two words. That reads as
  "autonomous, and it asks me". It uses the board's own colour tokens, so it works in light and dark.
- **Calm:** under *reduce motion* the highlight moves without sliding (as the step ring does, D367).
  Keyboard and screen readers work as today (a radio group; only the picked choice is "checked").
- **Done when:** all five places use the one switch; picking each choice looks right in light and dark;
  the web builds; checked in the running board.

| Step | What | Done when | Size |
|---|---|---|---|
| **0** | Measure today: run `measure-chat-handoff.ts` on your board (PR #23) | You have the numbers: the baseline to beat | Done, waiting for your run |
| **1** | **Spike on the test board** (`scripts/test-board.mjs`, real Haiku runs, a few cents): (a) a finished card's worktree recreated at the same path, and its coder session continued, works and **hits the cache within the hour**; (b) a continued session can **switch model**; (c) a **fork** into another card's folder works; (d) an edit to a file changed since the session read it is caught (Claude Code asks to re-read) | Each answered yes or no, with numbers, in a D-entry. A "no" changes the plan before any building | S |
| **2** | **Follow-ups reach the coder**: `runner.chat` continues the work stage's session, not the reviewer's; in Review the change joins the round | A test proves the coder's session id is resumed; the card returns to Review | S |
| **3** | **Memory facts**: `engine/memory.ts` computes 3.1 and 3.2 for every card, exposed on the task API and in the chat's card brief | Unit tests for warm, cool and gone, the thresholds and both costs | M |
| **4** | **Rounds on a done card**: the `task_rounds` table, worktree re-created, the round prompt with "since your last round", checklist rounds, per-round diff, approval and cost ceiling | Tests: a landed card gets round 2 in the same folder, continues the coder session, lands round 2 alone | L |
| **5** | **The chat routes**: `board_related_cards`, `board_continue_task`, `follows` on create, prompt rules, the `followUpRouting` setting | Tests with the fake model: a warm related card gets a round; a cool big one gets a fresh card with handoff; the user's override wins; the reply names the route | M |
| **6** | **What you see**: chips, memory dot, round sections in the drawer and the AI Manager, the cache bar on cards | Web builds; checked in the running board | M |
| **7** | **Fork for parallel work** (`how: "fork"`) | Test: a fork resumes with `forkSession` in its own folder, with the note about where the files are | S |
| **8** | **Measure again and tune**: extend the step-0 script with rounds (cache read on the first turn, cost per round against fresh cards of similar size), then set the thresholds from your data | A before/after table in a D-entry | S |
| **9** | **Tell people**: the Tour, the Welcome, the README, and D-entries (D373 onward, including the D56 amendment) | CLAUDE.md's "every feature change" list done | S |
| 10 | *Optional, from Projects:* the chat can **save a lesson** ("remember: buttons use the brand blue"), which every later card starts with. The board's notes exist (D305–D309); the chat can only read them today | Test: a saved note reaches the next card's prompt | S |

Every step runs `cd server && npx tsc --noEmit && npm test`, and `cd web && npx tsc --noEmit -p . && npm
run build` when the web changes. Tests are named as behaviours.

---

## 7. What this plan deliberately does not do

- **Keep-warm pings for cards.** A ping every hour on every card in Review costs money every hour for a
  follow-up that may never come. The chat's own Keep warm (D332) stays as it is.
- **Copying the chat's own session into a card.** The tools and system prompt differ, so the cache
  doesn't carry over (F2, D370). The chat→card path stays a written handoff.
- **Unlimited rounds.** Above 60% context, a fresh card with a handoff is cheaper and sharper.
- **Merging rounds automatically.** Every round lands only on your Approve, as every card does now.

## 8. Risks, and what handles them

| Risk | Handled by |
|---|---|
| The coder remembers files that others changed since | The "since your last round" list, a "read before you edit" rule, and Claude Code's own check (spike 1d) |
| Two cards change the same files | Conflict warnings already run per branch (D359) |
| The coder's memory is huge and slow | The 60% limit; past it, a fresh card with handoff |
| A session was deleted (30 days) or ran on another provider | `memory: gone` → a fresh card with handoff, never an error |
| The chat sends something to the wrong card | It names the card and route in every reply; you can say "no, new card"; the setting *Ask me each time* |
| The estimates are wrong | Shown as approximate; step 8 tunes them on your data; the board learns its dollar rate from your own runs |

## 9. Decisions this plan will record

- **D371:** "Studio" is renamed "AI Manager" in the product and the code; old links and saved layout carry over.
- **D372:** one mode switch everywhere; "asks me" is drawn as part of autonomous.
- **D373 (amends D56):** sessions are reopened when the memory is warm, or when it's cool but cheaper
  than starting fresh; otherwise D56's handoff card.
- **D374:** rounds, meaning one card, many approvals, a recreated working copy at the same path.
- **D375:** the chat routes follow-ups by the board's memory facts and says where it sent them; the
  `followUpRouting` setting.
- Plus one entry for each spike result in step 1.
