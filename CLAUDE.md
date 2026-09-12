# Claude Kanban — working notes

A board that runs Claude Code sessions as tasks. `server/` is the Fastify + SQLite engine, `web/` the
React board, `docs/DECISIONS.md` the log of every decision worth remembering (D1…; add one when you make
a call someone would otherwise undo).

## Before you finish

```bash
cd server && npx tsc --noEmit && npm test
```

```bash
cd web && npx tsc --noEmit -p . && npm run build
```

The board serves `web/dist`, so a UI change needs that build. Restart the board to pick up server
changes: run `Start Claude Kanban.cmd` again — it stops an older instance when the code on disk is newer.

Every feature change also updates what tells people about it: the **Tour** (`web/src/components/tour/features.ts`),
the **Welcome** pop-up, the **Setup** checklist where it applies, and the **README**.

## Publishing

Two remotes, on purpose:

| Remote | What it holds |
|---|---|
| `origin` | **Public.** A fresh history: one release commit, then one commit per update. No development history, no personal paths, no private project names. |
| `private` | **Private backup.** The working branches with their real, detailed history. |

Work on a branch and commit as often as you like — those commits are yours and stay off `origin`.
When something is ready for people to see:

```bash
node scripts/publish.mjs --message "Plan approval, live tasks, own branch" --push --backup
```

It takes the current branch's tree, drops the paths listed in `exclude`, refuses to publish if the diff
contains any word in `blocklist`, then commits that tree on top of `origin/main` and pushes it. The
working tree is never touched, and `origin/main` is only fast-forwarded, so the branch protection there
(no force-push, no delete) is never in the way. `--backup` also pushes the branch to `private`.

**The words and paths it checks live in `.claude/publish.local.json`, which is gitignored and must stay
that way** — it is the list of things that must not become public. Add to it whenever a new internal
name shows up in your work.

Rules that do not change:

- Never push a working branch, or anything based on the old full history, to `origin`.
- Keep this checkout's `git config user.email` as the GitHub noreply address; don't commit here with a
  work email.
- Before publishing, read the file list the script prints. Docs and test fixtures are where private
  names slip in: write examples with neutral names (`C:\work\proj`, `fix_access.py`) from the start.
- A published commit message is public too: describe the change, not the customer, the employer or the
  system it was found on.

## House style

- Comments say **why**, not what; a comment that explains a trap earns its place, one that narrates the
  next line does not.
- Tests are named as the behaviour they protect, in a sentence.
- Anything a user sees — a label, a hint, an error — is written for someone who is not a programmer.
