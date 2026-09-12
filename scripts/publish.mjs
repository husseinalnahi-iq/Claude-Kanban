#!/usr/bin/env node
// Publish the current work to the PUBLIC repo as one clean commit.
//
// The public history is a fresh start: one squashed release commit and one commit per update, with
// no development history, no personal paths and no private project names. Working branches (with the
// real, detailed history) go to the `private` remote instead, never to `origin`.
//
//   node scripts/publish.mjs --message "What changed, in a line"       # build the commit, don't push
//   node scripts/publish.mjs --message "…" --push                      # …and push it to origin/main
//   node scripts/publish.mjs --message "…" --push --backup             # …and push this branch to private
//
// What it does: take the tree of the current branch, drop the paths in `exclude`, refuse if the diff
// against origin/main contains any word in `blocklist`, then commit that tree on top of origin/main.
// Nothing in the working tree is touched, and origin/main is only ever fast-forwarded.
//
// The words and paths live in a file that is NOT published: .claude/publish.local.json
//   { "blocklist": ["internal-project-name", "employer", "C:\\\\Users\\\\me"], "exclude": ["docs/private-note.md"] }
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? null : process.argv[i + 1] ?? "";
};
const has = (name) => process.argv.includes(`--${name}`);
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

const message = arg("message");
if (!message) die('Say what changed: node scripts/publish.mjs --message "Plan approval, live tasks"');
if (/\n/.test(message.trim()) === false && message.length > 72) console.warn("! The subject line is long; keep it short and plain.");

const root = git(["rev-parse", "--show-toplevel"]);
process.chdir(root);
if (git(["status", "--porcelain"])) die("The working tree has uncommitted changes. Commit them on your branch first.");

const configPath = join(root, ".claude", "publish.local.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const blocklist = (config.blocklist ?? []).filter(Boolean);
const exclude = (config.exclude ?? []).filter(Boolean);
if (!blocklist.length) console.warn(`! No blocklist in ${configPath}: publishing without a name check.`);

git(["fetch", "origin", "main"]);
const base = git(["rev-parse", "origin/main"]);
const source = git(["rev-parse", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

// Build the tree to publish in a throwaway index, so the working tree is never touched.
const dir = mkdtempSync(join(tmpdir(), "kanban-publish-"));
const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
let tree;
try {
  git(["read-tree", source], { env });
  for (const path of exclude) git(["rm", "--cached", "-r", "--quiet", "--ignore-unmatch", path], { env });
  tree = git(["write-tree"], { env });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const diff = git(["diff", "--unified=0", base, tree]);
if (!diff.trim()) die("Nothing to publish: this tree matches origin/main already.");

const hits = [];
for (const line of diff.split("\n")) {
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  for (const word of blocklist) if (line.toLowerCase().includes(word.toLowerCase())) hits.push({ word, line: line.slice(0, 140) });
}
if (hits.length) {
  console.error("\n✗ Private words in what would be published:\n");
  for (const h of hits.slice(0, 20)) console.error(`  ${h.word}\n    ${h.line}`);
  if (hits.length > 20) console.error(`  …and ${hits.length - 20} more`);
  die("Reword those lines (or add the file to `exclude`), commit, and run this again.");
}

const files = git(["diff", "--name-status", base, tree]);
const commit = git(["commit-tree", tree, "-p", base, "-m", message], { env: { ...process.env } });
console.log(`\nPublishing ${files.split("\n").length} changed file(s) as ${commit.slice(0, 8)} on top of ${base.slice(0, 8)}:\n`);
console.log(files.replace(/^/gm, "  "));
console.log(`\n  message: ${message.split("\n")[0]}`);

if (!has("push")) {
  console.log(`\nNot pushed (no --push). To push it yourself:\n  git push origin ${commit}:refs/heads/main\n`);
  process.exit(0);
}
git(["push", "origin", `${commit}:refs/heads/main`]);
git(["update-ref", "refs/heads/main", commit]);
console.log(`\n✓ Pushed to origin/main and moved local main to ${commit.slice(0, 8)}.`);

if (has("backup")) {
  git(["push", "-u", "private", `${branch}:${branch}`]);
  console.log(`✓ Pushed ${branch} (full history) to the private remote.`);
} else {
  console.log(`! Your detailed history is only local. Back it up with: git push private ${branch}`);
}
