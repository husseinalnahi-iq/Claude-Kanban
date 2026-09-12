# v1 verification

**All six pass — 2026-09-11.** Run against the real Agent SDK after `claude auth login`, in a throwaway repo `kanban-scratch` (deleted afterwards, along with its worktrees, branches, DB rows and run logs).

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | `npm test`: migrations, queue order + caps, worktree add/merge/remove on a temp repo, prompt builder parent/sibling context | ✅ pass | 31/31 green, incl. conflict-abort, gate bypasses, stop/approve races, host/origin guard, forced-ask hook |
| 2 | **Autonomous E2E**: Plan (fable-5-1, medium) → Code (sonnet-5, medium) → Review (sonnet-5, low) | ✅ pass | Worktree `kanban/t_e05b3d7d` created; 3 runs succeeded ($0.667 + $0.177 + $0.155 = **$0.999**); review ended `VERDICT: APPROVE`; Diff tab showed `A hello.md +3 −0`; **Approve** merged `--no-ff` (commit `96e6ee0`, two parents), removed the worktree, deleted the branch; `git worktree list` = 1 entry, `git branch` = `main`, `git status` clean, file content exactly the three lines |
| 3 | **Supervised E2E**: Deny once (no edit), Allow once (edit), follow-up chat resumes the session | ✅ pass | Write to `notes.md` → approval card → **Deny** with note "write to scratch-notes.md instead" → no file created, Claude followed the note; **Allow** → `scratch-notes.md` written; chat "append a second line" resumed session `7640bc4a…` (same run row, cost accumulated), remembered the file unprompted, its Edit was approved → file = `supervised write` + `chat resumed` |
| 4 | **Context bus**: parent Plan creates two subtasks; children see parent spec + sibling summary; child message reaches the parent | ✅ pass | Plan stage called `board_create_subtasks` → `Add greetings.md`, `Add farewells.md` (both autonomous). Child B's stored stage prompt contains `## Parent task: Two greeting files` and `## Sibling tasks — Add greetings.md — review — ✓ Created greetings.md with content 'hello'`. Parent's Messages tab shows both children's `board_post_message` posts |
| 5 | **that project policy** (`worktrees: forbidden, autonomous: forbidden`) | ✅ pass | Queuing an autonomous task → **409** "Project "the supervised-only project" forbids autonomous runs (policy.autonomous = "forbidden"). Switch this task to supervised mode…" (API + drawer). A supervised task ran in the main checkout: even `git status --short` raised an approval card, was allowed, reported "working tree clean". Repo after: HEAD `09440f2a` unchanged, `git worktree list` = 1, `git branch` = `main`, status clean, no `.kanban/`, `.git/info/exclude` untouched |
| 6 | **Skills view** | ✅ pass | 2 user skills (`gemini-image`, `ui-ux-pro-max`), 17 plugin skills (active installs only — stale cached versions ignored), project group verified with a temporary `.claude/skills/scratch-demo` (removed after) |

## Cleanup after verification

`kanban-scratch` repo deleted · all task worktrees/branches discarded (`git worktree list` clean before deletion) · scratch project and both that project test tasks deleted from `kanban.db` (0 runs left) · run logs cleared. The that project project stays registered with `worktrees: forbidden, autonomous: forbidden` so the board is ready to use.

## Cost note

A trivial Haiku run costs ~$0.07 because `settingSources: ["user", "project"]` loads the user's plugins, hooks and skills into every session (~76k input tokens). That is what makes project CLAUDE.md and skills available to runs; drop `"user"` in `runner.ts` if a cheaper, bare session is ever wanted.
