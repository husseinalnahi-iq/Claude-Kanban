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
//   node scripts/publish.mjs --message "…" --remote public             # from the private checkout (D242)
//
// What it does: take the tree of the current branch, drop the paths in `exclude`, swap the `replace`
// pairs for neutral names in the published copy, refuse if the diff
// against origin/main contains any word in `blocklist`, then commit that tree on top of origin/main.
// Nothing in the working tree is touched, and origin/main is only ever fast-forwarded.
//
// The words and paths live in a file that is NOT published: .claude/publish.local.json
//   { "blocklist": ["internal-project-name", "employer", "C:\\\\Users\\\\me"], "exclude": ["docs/private-note.md"],
//     "replace": [["internal-project-name", "sample-app"]] }
// The blocklist check runs after the swaps, so a name the list forgot is still refused.
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
// [from, to] pairs, applied to the published copy only: this tree keeps its real names (D214, D247).
// Matched case-insensitively and written back in the match's case (INTERNAL → SAMPLE, internal → sample),
// longest first, so a test that asserts on a name still finds the same neutral name it was given.
const replace = (config.replace ?? []).filter((r) => Array.isArray(r) && r[0]).sort((a, b) => b[0].length - a[0].length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inCase = (match, to) =>
  match === match.toLowerCase() ? to.toLowerCase() : match === match.toUpperCase() ? to.toUpperCase() : to;
function scrub(env) {
  if (!replace.length) return [];
  const pattern = new RegExp(replace.map(([from]) => escapeRe(from)).join("|"), "gi");
  const to = new Map(replace.map(([from, dest]) => [from.toLowerCase(), dest]));
  const changed = [];
  for (const entry of git(["ls-files", "-s"], { env }).split("\n").filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    const [mode, hash] = meta.split(" ");
    const blob = execFileSync("git", ["cat-file", "blob", hash]);
    if (blob.includes(0)) continue; // binary: images, icons
    const text = blob.toString("utf8");
    const out = text.replace(pattern, (m) => inCase(m, to.get(m.toLowerCase())));
    if (out === text) continue;
    const next = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: out, encoding: "utf8" }).trim();
    git(["update-index", "--cacheinfo", `${mode},${next},${path}`], { env });
    changed.push(path);
  }
  return changed;
}

// Where the public repo is. In the public clone that is `origin`; in the private checkout `origin` is the
// private repo, so pass `--remote public` there (docs/DECISIONS.md D242).
const remote = arg("remote") || "origin";
const url = (() => {
  try {
    return git(["remote", "get-url", remote]);
  } catch {
    return die(`There is no remote called "${remote}". Add the public repo: git remote add ${remote} <its URL>`);
  }
})();
// Publishing squashes onto the target's main: aimed at the private repo, that would overwrite its history
// view with a scrubbed copy. Refuse, whatever the flags say.
if (/-private(\.git)?$/i.test(url)) die(`"${remote}" is the private repo (${url}). Publish to the public one: --remote <name of the public remote>.`);
if (!/^https?:\/\/|^git@|^ssh:/.test(url)) die(`"${remote}" points at ${url}, not at GitHub. Point it at the public repo's URL first.`);

git(["fetch", remote, "main"]);
const base = git(["rev-parse", `${remote}/main`]);
const source = git(["rev-parse", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

// Build the tree to publish in a throwaway index, so the working tree is never touched.
const dir = mkdtempSync(join(tmpdir(), "kanban-publish-"));
const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
let tree;
try {
  git(["read-tree", source], { env });
  for (const path of exclude) git(["rm", "--cached", "-r", "--quiet", "--ignore-unmatch", path], { env });
  const rewritten = scrub(env);
  if (rewritten.length) console.log(`Neutral names swapped in ${rewritten.length} file(s): ${rewritten.join(", ")}`);
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
  console.log(`\nNot pushed (no --push). To push it yourself:\n  git push ${remote} ${commit}:refs/heads/main\n`);
  process.exit(0);
}
git(["push", remote, `${commit}:refs/heads/main`]);
if (remote === "origin") {
  // The public clone's own main is the published history, so it follows.
  git(["update-ref", "refs/heads/main", commit]);
  console.log(`\n✓ Pushed to ${remote}/main and moved local main to ${commit.slice(0, 8)}.`);
} else {
  // Anywhere else, local main is someone's real history: leave it alone.
  console.log(`\n✓ Pushed to ${remote}/main (${commit.slice(0, 8)}). Local branches are untouched.`);
}

if (has("backup")) {
  git(["push", "-u", "private", `${branch}:${branch}`]);
  console.log(`✓ Pushed ${branch} (full history) to the private remote.`);
} else {
  console.log(`! Your detailed history is only local. Back it up with: git push private ${branch}`);
}
