---
name: publish-public
description: Use whenever anything is about to go to the PUBLIC Claude Kanban repo — "publish", "push to public", "commit on the public repo", "release it", "update the public repo", "commit on public and private". Makes sure only things about the project leave this machine, never private data from the work it was used on (people, suppliers, customers, amounts, ids, private systems, paths, keys). Runs the scan in scripts/publish.mjs (D369), reads what it shows, fixes the source, and pushes only on the owner's go.
---

# Publishing to the public repo

The public repo gets the **project**: the board's code, its tests, its docs. It never gets what the
board was *used on*. Every change here was found while running real work, so the decision log, the
README, test fixtures and commit messages are where private details slip in — a supplier's name in a
"why", an amount from a ledger, a task id from the owner's own board, a private system's address.

`scripts/publish.mjs` refuses most of it by itself (scan in `scripts/publish-scan.mjs`, D369). This flow
is what the scan cannot do: read the change like a stranger would, and fix the source.

## The flow

1. **Private first.** The change is committed on a branch, merged into the private repo's `main` (PR
   on `origin`). The public repo only ever gets the scrubbed tree, never a branch or its history.
2. **Read what you wrote, as a stranger.** Before any publish, go through the diff of `docs/`,
   `README.md`, `CLAUDE.md`, `server/test/` and the commit message, and look for:
   - a person, supplier, customer or reseller by name (also a first name alone)
   - an amount, account number, document id (`ACC-PAY-…`, invoice numbers) from real books
   - an id from the owner's board (`t_…`, `p_…`, `c_…`, `r_…`), a chat or run id
   - an address of a private system, a local path, an email, anything key-shaped
   Rewrite it **in the source** in neutral words — "a supplier", "a live accounting system", "one
   supervised task" — keeping the evidence that made the decision (counts, what happened) and the
   owner's own words. A decision's WHY must survive the rewrite; only the identifying detail goes.
3. **Dry run**: `node scripts/publish.mjs --message "What changed, in a line" --remote public`
   (`--remote public` from this private checkout; refused if it points at the private repo).
   - `✗ Private things…` lines are refused. Reword the source, commit (step 1 again), run again.
     A word that only *looks* like a name (a supplier called "Smart") goes in `allow` in
     `.claude/publish.local.json`, with a note to the owner of which word and why.
   - `? Read these…` lines (big amounts, unknown web addresses) need a person's eye: reword the ones
     that are real data; the ones that are the project's own (a cost from a test run, a docs link)
     stay, and you say which you kept and why.
   - The file list: everything since the last publish goes, not only today's change. Say so to the
     owner when earlier private work rides along.
4. **Teach the scan what it missed.** A private name you found by reading that the scan did not flag
   goes into `.claude/publish.local.json` the same turn: `names` for a person or company,
   `nameSources` for a whole list (a CSV column or JSON key in the private data, read fresh on every
   publish), `blocklist` for any other word. That file is gitignored and never published.
5. **Ask before pushing.** Show the owner the file count, what rides along, and the review lines you
   kept. Push only on their go: add `--push`, and `--reviewed` when step 3 had review lines.
6. **Check what is public.** `node scripts/publish.mjs --audit --remote public` scans the whole public
   tree as it is now. Run it after a push, and whenever the scan learned a new name: something
   published before the name was known shows up here. A hit means: fix the source, publish again.

## What the scan checks (scripts/publish-scan.mjs)

| Refused | Shown for reading |
|---|---|
| `blocklist` words (substring) | amounts with digit grouping (`123,456,789`, `45,000 IQD`) |
| names from `names` and `nameSources`: a full name, and each distinctive word of it that the public repo does not already use | web addresses outside a short list of public sites |
| ids the owner's board handed out (read from `~/.claude-kanban/kanban.db`) | single name-words during `--audit` |
| email addresses (made-up test ones pass) | |
| this machine's home folder | |
| key-shaped strings (real lengths) | |

The commit message is scanned too: it is public.

## Never

- Push a working branch, or its history, to the public repo.
- Put a private name in this skill, in `scripts/publish-scan.mjs` or anywhere else that is published.
  They live only in `.claude/publish.local.json` and the private files it points at.
- Use `--reviewed` without having read each review line.
