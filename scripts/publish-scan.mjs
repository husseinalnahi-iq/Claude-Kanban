// What scripts/publish.mjs checks before anything reaches the public repo (D369).
//
// Two levels:
//   block  — refused outright: a blocklisted word, a person or company name from your private data,
//            an id from your own board, an email address, your home folder, something shaped like a key.
//   review — published only with --reviewed, after someone has read each line: big amounts, web
//            addresses outside a short list of public ones. They are often fine, and sometimes a
//            customer's figure or a private system's address.
//
// Nothing here knows a private name: they come from .claude/publish.local.json (not published) and the
// files it points at, read fresh on every publish so a supplier added last week is covered too.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// \b only knows ASCII word characters; a name may start or end with a letter it does not count.
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, "iu");

/** Words in a company or person name that say nothing about who it is. */
const GENERIC = new Set(
  ("store stores shop shops company co center centre group trading general for the and of al el abu home house " +
    "office market supplies supply services service international iraq iraqi baghdad basra erbil online mall " +
    "electronics medical sport sports fashion family gift gifts world land star golden new best smart city " +
    "consignment cash fulfillment marketplace mp cons ltd llc inc limited branch main").split(" "),
);

/**
 * Names from the files `nameSources` lists. A source is { file, json: "key" | ["k1","k2"] } (an array of
 * objects, or { data: [...] }) or { file, csv: "column" }; { dir, each } reads the file `each` in
 * every sub-folder of `dir` (a month's payroll, say).
 */
export function loadNames(sources = [], baseDir = process.cwd()) {
  const names = new Set();
  const add = (v) => {
    if (typeof v !== "string") return;
    const n = v.replace(/^\[[^\]]*\]\s*/, "").trim(); // "[Consignment] Name" → "Name"
    if (n.length >= 3) names.add(n);
  };
  const files = [];
  for (const s of sources) {
    const at = (p) => (/^[a-zA-Z]:[\\/]|^\//.test(p) ? p : join(baseDir, p));
    if (s.dir && s.each) {
      const dir = at(s.dir);
      if (!existsSync(dir)) continue;
      for (const sub of readdirSafe(dir)) files.push({ ...s, file: join(dir, sub, s.each) });
    } else if (s.file) files.push({ ...s, file: at(s.file) });
  }
  for (const s of files) {
    if (!existsSync(s.file)) continue;
    const text = readFileSync(s.file, "utf8").replace(/^﻿/, "");
    if (s.json) {
      const j = JSON.parse(text);
      const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Object.values(j ?? {});
      const keys = [s.json].flat();
      for (const r of rows) for (const k of keys) add(r?.[k]);
    } else if (s.csv) {
      const [head, ...lines] = text.split(/\r?\n/);
      const col = splitCsv(head).indexOf(s.csv);
      if (col < 0) continue;
      for (const line of lines) add(splitCsv(line)[col]);
    }
  }
  return names;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") out.push(cur), (cur = "");
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * The words a leak would show: each whole name, and each word of it that is long enough, not generic,
 * and nowhere in the public tree already (`publicWords`) — "Qorvan" from "Jane Qorvan Trading" is caught
 * on its own, while "Store" or a word the project already uses is not.
 */
export function nameMatchers(names, publicWords, allow = [], publicText = "") {
  const allowed = new Set(allow.map((a) => a.toLowerCase()));
  const known = publicText.toLowerCase();
  const whole = new Map();
  const words = new Map();
  for (const name of names) {
    const low = name.toLowerCase();
    if (allowed.has(low)) continue;
    // A one-word name ("Slack", "Google", a supplier called "test") is judged as a word, below; a
    // longer one is refused whole unless the project already says it.
    if (/[\s,&]/.test(low.trim()) && !known.includes(low)) whole.set(low, name);
    for (const w of name.split(/[\s\-_.,&/()'"]+/)) {
      const lw = w.toLowerCase();
      if (lw.length < 4 || GENERIC.has(lw) || /\d/.test(lw) || allowed.has(lw) || publicWords.has(lw)) continue;
      if (!words.has(lw)) words.set(lw, name);
    }
  }
  return { whole, words };
}

/** Every word in a body of public text, lower-cased: what the project already says in the open. */
export function wordsOf(text) {
  const set = new Set();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) set.add(m[0]);
  return set;
}

const SECRET_SHAPES = [
  [/sk-ant-[a-z0-9]{2,6}-[A-Za-z0-9_-]{40,}/, "an Anthropic key"],
  [/\bsk-[a-z0-9]{20,}/i, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "a signed token (JWT)"],
  [/\b(?:api[_-]?key|api[_-]?secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, "a credential written in"],
];
// Made-up addresses in tests and docs: the example domains, Anthropic's noreply, and two-letter domains
// like x.io or e.com that no real mailbox here uses.
const PUBLIC_MAIL = /@(?:example\.(?:com|org|net)|anthropic\.com|users\.noreply\.github\.com|[a-z0-9-]+\.(?:test|example|invalid|localhost)|localhost|[a-z0-9]{1,2}\.[a-z]{2,3})$/i;
const PUBLIC_HOSTS = /(?:^|\.)(?:github\.com|githubusercontent\.com|anthropic\.com|claude\.(?:ai|com)|npmjs\.(?:com|org)|nodejs\.org|example\.(?:com|org|net)|localhost|w3\.org|mozilla\.org|microsoft\.com|google\.com|googleapis\.com|openai\.com|python\.org|wikipedia\.org|shields\.io|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|playwright\.dev|vitejs\.dev|tailwindcss\.com|react\.dev|sqlite\.org|fastify\.dev|zod\.dev|modelcontextprotocol\.io|semver\.org|keepachangelog\.com|rolldown\.rs|iana\.org|ietf\.org|schema\.org)$/i;

/**
 * Reads each added line and says what in it is private. `ctx`: { blocklist, names, boardIds, homes, wordsToReview }.
 * Returns [{ level: "block" | "review", why, line, file }].
 */
export function scanAdded(diff, ctx) {
  const found = [];
  let file = "";
  const block = (why, line) => found.push({ level: "block", why, line: line.slice(0, 160), file });
  const review = (why, line) => found.push({ level: "review", why, line: line.slice(0, 160), file });
  const homes = (ctx.homes ?? []).filter(Boolean).map((h) => h.toLowerCase());
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    if (!raw.startsWith("+")) continue;
    const line = raw.slice(1);
    const low = line.toLowerCase();
    for (const w of ctx.blocklist ?? []) if (low.includes(w.toLowerCase())) block(`blocklisted word "${w}"`, line);
    if (ctx.names) {
      for (const [lw, name] of ctx.names.whole) if (low.includes(lw) && wordRe(lw).test(line)) block(`a name from your private data ("${name}")`, line);
      // An audit has no public text to tell the project's own words from a name's, so a single word is only shown.
      const word = ctx.wordsToReview ? review : block;
      for (const [lw, name] of ctx.names.words) if (low.includes(lw) && wordRe(lw).test(line)) word(`"${lw}", part of a name from your private data ("${name}")`, line);
    }
    for (const m of line.matchAll(/\b[tpcr]_[0-9a-f]{8,16}\b/g)) if (ctx.boardIds?.has(m[0])) block(`an id from your own board (${m[0]})`, line);
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!PUBLIC_MAIL.test(m[0])) block(`an email address (${m[0]})`, line);
    for (const h of homes) if (low.includes(h)) block(`your own home folder (${h})`, line);
    for (const [re, what] of SECRET_SHAPES) if (re.test(line)) block(`something shaped like ${what}`, line);
    for (const m of line.matchAll(/\b\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?\b|\b\d{1,3},\d{3}\b(?=\s*(?:IQD|USD|\$|dinar|د\.ع))/gi)) review(`an amount (${m[0]}): a real customer's figure?`, line);
    for (const m of line.matchAll(/\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) if (!PUBLIC_HOSTS.test(m[1])) review(`a web address (${m[1]}): a public site, or a private system's?`, line);
  }
  return found;
}

/** The home folders a published file must never show: this machine's, in the spellings tools print. */
export function homeFolders() {
  const user = userInfo().username;
  const home = homedir();
  return [home, home.replace(/\\/g, "/"), `/c/users/${user}`, `/users/${user}`, `/home/${user}`].filter((h) => h.length > 4);
}

/** Every id the user's own board has handed out: a task, project, chat or run id is private (D369). */
export async function boardIds(stateDir = join(homedir(), ".claude-kanban")) {
  const file = join(stateDir, "kanban.db");
  if (!existsSync(file)) return new Set();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    const ids = new Set();
    for (const t of ["tasks", "projects", "chats", "runs"]) {
      for (const r of db.prepare(`SELECT id FROM ${t}`).all()) ids.add(String(r.id));
    }
    db.close();
    return ids;
  } catch {
    return new Set();
  }
}
