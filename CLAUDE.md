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

The public repo is published from the working repo with one script, which squashes the current tree
onto the public `main` as a single commit:

```bash
node scripts/publish.mjs --message "What changed, in a line" --remote public
```

Name the remote that points at the **public** repo (`origin` in a clone of the public repo, `public`
in the working one). The script refuses a remote whose URL is a `-private` repo, and moves local
`main` only when publishing to `origin` (D242). Leave out `--push` to see exactly what would be
published first; add it only when that list is right.

Everything private is handled by the gitignored `.claude/publish.local.json`, which must never be
committed: `exclude` (paths left out), `replace` (real names swapped for neutral ones in the published
copy only — the working tree keeps the real ones, D214, D247) and `blocklist` (checked after the
swaps; any hit refuses the publish).

Rules that do not change:

- Never push a working branch, or its history, to the public repo.
- Docs and test fixtures are where private names slip in: prefer neutral names (`C:\work\proj`,
  `fix_access.py`) from the start, and add a `replace` pair when a real one is needed.
- A published commit message is public too: describe the change, not the customer or the system it
  was found on.

## House style

- Comments say **why**, not what; a comment that explains a trap earns its place, one that narrates the
  next line does not.
- Tests are named as the behaviour they protect, in a sentence.
- Anything a user sees — a label, a hint, an error — is written for someone who is not a programmer.
