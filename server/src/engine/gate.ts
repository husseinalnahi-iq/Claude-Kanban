import { isAbsolute, relative, resolve } from "node:path";
import { BROWSER_SERVER, CHROME_PREFIX, PLAYWRIGHT_PLUGIN_TOOLS } from "./browser.ts";
import { credentialRisk } from "./credentials.ts";

export type GateResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Tools that never change anything. Everything else is a write for approval purposes. */
export const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "TodoRead", "Skill",
  "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "BashOutput", "TaskOutput",
]);

/** MCP servers every run may use without approval: the board itself and read-only docs lookup. */
export const SAFE_MCP_PREFIXES = ["mcp__board__", "mcp__plugin_context7_context7__"];

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

const PATH_KEYS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/** git subcommands an autonomous run may use inside its worktree. The board does branch/merge/cleanup. */
const ALLOWED_GIT = new Set([
  "status", "diff", "log", "show", "add", "commit", "ls-files", "grep", "blame", "rev-parse", "describe",
  "shortlog", "cat-file", "check-ignore", "mv", "rm", "apply", "help", "version", "--version",
]);
/** Global git options that point git at a different repo or work tree. */
const RETARGET = /^(-C|--git-dir|--work-tree|--namespace)(=|$)/;

export function isSafeMcp(toolName: string): boolean {
  return SAFE_MCP_PREFIXES.some((p) => toolName.startsWith(p));
}

/**
 * Commands that kill processes by name or pattern rather than by id. Seen in a real run: asked to stop
 * the dev server it had started, a session ran `taskkill /F /IM node.exe` — which killed every Node
 * process on the machine, the board running it included. Refused in both modes, and not editable:
 * there is no version of this a card makes safe.
 */
const KILL_BY_NAME: [RegExp, string][] = [
  [/\btaskkill\b[^|;&]*\s[-/]{1,2}(im|fi)\b/i, "taskkill /IM"],
  [/(^|[\s;&|(])(pkill|killall)(\s|$)/i, "pkill / killall"],
  [/\b(stop-process|spps)\b[^|;&]*-(name|processname)\b/i, "Stop-Process -Name"],
  [/\bget-process\b[^|;&]*\|\s*(stop-process|spps|kill)\b/i, "Get-Process | Stop-Process"],
  [/\bwmic\b[^|;&]*\bprocess\b[^|;&]*\b(delete|terminate)\b/i, "wmic process delete"],
  [/(^|[\s;&|(])kill\s+(-[a-z0-9]+\s+)*-1(\s|$)/i, "kill -1"],
];

export function killsByName(command: string): string | null {
  for (const [re, label] of KILL_BY_NAME) if (re.test(command)) return label;
  return null;
}

/** How the board treats one MCP server's tools, in the words the Settings page shows. */
export function serverRule(prefix: string): string {
  if (prefix === "mcp__board__") return "The board's own tools — always allowed.";
  if (SAFE_MCP_PREFIXES.includes(prefix)) return "Read-only lookups — always allowed.";
  if (prefix === `mcp__${BROWSER_SERVER}__`) return "The board's browser — looking at local pages is free; see Browser checks.";
  if (prefix === `${PLAYWRIGHT_PLUGIN_TOOLS}__`) return "Hidden: runs use the board's own browser instead, one per task.";
  if (prefix === CHROME_PREFIX) return "Your own Chrome — supervised runs only, every action approved.";
  return "Autonomous runs: refused. Supervised runs: an approval card for every call.";
}

function inside(cwd: string, p: string): boolean {
  const rel = relative(resolve(cwd), resolve(cwd, p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** "/c/Users/x" (Git Bash) → "C:\Users\x"; other paths unchanged. */
function normalizeShellPath(p: string): string {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}` : p;
}

/**
 * Every absolute path in a command, read the way a shell would: a quoted path runs to its own closing
 * quote, spaces and all; a bare one to the next space or operator. Each path is measured from where it
 * starts, so quotes paired wrongly elsewhere (an apostrophe in a heredoc body) cannot cut it short.
 * A drive letter must not follow a word character, so the `s://` inside `https://` is not a path.
 */
export function absolutePaths(cmd: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w])[a-zA-Z]:[\\/]|(?<![\w.])\/[a-zA-Z]\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const start = m.index;
    const quote = cmd[start - 1];
    let end: number;
    if (quote === '"' || quote === "'") {
      end = cmd.indexOf(quote, start);
      if (end < 0) end = cmd.length;
    } else {
      const stop = /[\s;&|<>`"'()]/.exec(cmd.slice(start));
      end = stop ? start + stop.index : cmd.length;
    }
    out.push(cmd.slice(start, end).replace(/[,]+$/, ""));
    re.lastIndex = Math.max(end, start + 1);
  }
  return out;
}

/** Splits a command into tokens, honouring "double" and 'single' quotes. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/**
 * Commands refused in BOTH modes, before anything else is considered — not even an approval card is
 * offered. An approval card assumes a human reads it; the commands on this list are the ones where
 * a mis-click is unrecoverable, so the answer is "no", not "are you sure?".
 *
 * Matching is on a normalised command: collapsed whitespace, lowercased, and with the shell's own
 * quoting removed, so `git push  --force` and `git push "--force"` both match `git push --force`.
 */
export function blockedCommand(cmd: string, blocked: string[]): string | null {
  const flat = cmd.toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  // Pipes are written many ways; normalise "curl … | sh" down to "curl | sh".
  const piped = flat.replace(/\|\s*(sudo\s+)?/g, "| ").replace(/\s*\|\s*/g, " | ");
  for (const rule of blocked) {
    const needle = rule.toLowerCase().replace(/\s+/g, " ").trim();
    if (!needle) continue;
    if (needle.includes("|")) {
      const [head, tail] = needle.split("|").map((x) => x.trim());
      if (head && tail && new RegExp(`\\b${escapeRe(head)}\\b.*\\|\\s*${escapeRe(tail)}\\b`).test(piped)) return rule;
      continue;
    }
    if (flat.includes(needle)) return rule;
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns why a shell command is not allowed in an autonomous worktree, or null when it is fine. */
export function shellViolation(cmd: string, cwd: string): string | null {
  if (/(^|[\s"'=;&|(`])\.\.([\\/]|$|[\s"';&|)])/.test(cmd)) return "it walks out of the worktree with `..`";
  if (/(^|[\s"'=;&|(])~([\\/]|$|\s)|\$HOME\b|\$env:(USERPROFILE|HOME|HOMEPATH)\b|%USERPROFILE%|%HOMEPATH%/i.test(cmd)) {
    return "it references your home directory";
  }
  for (const c of absolutePaths(cmd)) {
    const p = normalizeShellPath(c);
    if (!inside(cwd, p)) return `it touches ${p}, outside the worktree`;
  }
  // Every git invocation: reject retargeting global options and any subcommand outside the allow-list.
  for (const segment of cmd.split(/&&|\|\||[;|\n]|\bthen\b|\bdo\b/)) {
    const tokens = tokenize(segment);
    const at = tokens.findIndex((t) => /^git(\.exe)?$/i.test(t.split(/[\\/]/).pop() ?? ""));
    if (at < 0) continue;
    let i = at + 1;
    while (i < tokens.length && tokens[i].startsWith("-") && tokens[i] !== "--version") {
      if (RETARGET.test(tokens[i])) return `\`git ${tokens[i]}\` points git at another repository`;
      if (tokens[i] === "-c") i++; // `-c key=value`
      i++;
    }
    const sub = tokens[i];
    if (sub && !ALLOWED_GIT.has(sub)) return `\`git ${sub}\` is managed by the board (allowed: ${[...ALLOWED_GIT].slice(0, 12).join(", ")}…)`;
  }
  return null;
}

/** Tools that read a path the model names. Checked in autonomous runs so a read can't fetch what a command may not. */
const READ_PATH_KEYS: Record<string, string[]> = {
  Read: ["file_path"],
  NotebookRead: ["notebook_path"],
  LS: ["path"],
  Grep: ["path"],
  Glob: ["path", "pattern"],
};

/**
 * Why an autonomous read is refused, or null when it may go ahead. Reads stay inside the worktree plus
 * a few named folders (this task's attachments, the skills Claude loads). The main checkout's
 * gitignored files are exactly what a worktree leaves out — `.env`, API keys — and a Read would hand
 * them to a run that no one approves (docs/DECISIONS.md D187).
 */
export function readViolation(toolName: string, input: Record<string, unknown>, cwd: string, readRoots: string[] = []): string | null {
  for (const key of READ_PATH_KEYS[toolName] ?? []) {
    const raw = input[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    // A Glob pattern is only a path when it is absolute; `**/*.ts` is relative to the search root.
    if (key === "pattern" && !isAbsolute(raw) && !/^\/[a-zA-Z]\//.test(raw)) continue;
    const p = normalizeShellPath(key === "pattern" ? raw.replace(/[*?[{].*$/, "") || raw : raw);
    if (inside(cwd, p) || readRoots.some((root) => inside(root, p))) continue;
    return `Autonomous runs read only inside the task worktree (${cwd}); refused ${p}.`;
  }
  return null;
}

/**
 * Added to every autonomous refusal. The run it was written for tried four ways round the sandbox —
 * the main checkout's secrets twice, the environment, then a browser at the live site — instead of
 * saying it needed a supervised run (docs/DECISIONS.md D186).
 */
export function escalationHint(refusals: number): string {
  const base =
    " If the task cannot be done without this, do not look for another way in: call `board_report_blocked` with needs \"supervised\", " +
    "say what access you need and why, then end your turn. The person can switch the task to supervised, where it runs in the main checkout with every write approved.";
  return refusals >= 3 ? `${base} This is refusal number ${refusals} in this stage: stop trying and report it now.` : base;
}

/**
 * The simple commands in a pipeline or list, split on `&&`, `||`, `;`, `|` and newlines — but not
 * inside quotes, where `grep -E "rail|pay"` keeps its `|`. An unclosed quote runs to the end.
 */
export function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Programs that only read and print. Anything not listed — interpreters, awk, xargs, editors — gets a card. */
const READ_ONLY_PROGRAMS = new Set([
  "ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "findstr", "sort",
  "cut", "tr", "file", "stat", "basename", "dirname", "realpath", "readlink", "echo", "printf", "true", "which", "where",
  "du", "df", "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "jq", "column", "nl", "cd", "pushd", "popd",
  "get-childitem", "gci", "get-content", "gc", "select-string", "sls", "select-object", "measure-object", "get-item",
  "test-path", "get-location", "resolve-path", "format-list", "format-table", "sort-object", "set-location", "out-string",
]);
/** git subcommands that never change the repository. `branch` only when it just lists. */
const READ_ONLY_GIT = new Set(["status", "log", "show", "diff", "grep", "blame", "ls-files", "rev-parse", "describe", "shortlog", "cat-file"]);

/**
 * True when a shell command can only read — so a supervised run may run it without a card (D202).
 * Deliberately narrow: no redirection into a file, no command substitution, no heredoc, no interpreter,
 * every program on the list, every absolute path inside the project, and nothing that touches a
 * credentials file (those always get a card, see credentials.ts). When in doubt: false, and a card.
 */
export function isReadOnlyShell(cmd: string, cwd: string): boolean {
  const text = cmd.trim();
  if (!text || credentialRisk("Bash", { command: text })) return false;
  // Folded in from the public lineage's detector (D228): an escaped or unbalanced quote can make the
  // tokenizer misread where a command ends, and a script block or a lone `&` runs something else.
  if (/\\["']/.test(text)) return false;
  if ((text.match(/"/g) ?? []).length % 2 || (text.match(/'/g) ?? []).length % 2) return false;
  if (/[{}]|\$\{|(^|[^&>])&($|[^&>])/.test(text.replace(/"[^"]*"|'[^']*'/g, "Q"))) return false;
  // Harmless redirections to nowhere, then anything that could still write or run something else.
  const stripped = text.replace(/\d?>\s*(?:\/dev\/null|\$null|nul)\b/gi, "").replace(/2>&1/g, "");
  if (/[>`]|\$\(|<\(|<<|\bInvoke-Expression\b|\biex\b|\|\s*Out-File\b|\bSet-Content\b|\bAdd-Content\b/i.test(stripped)) return false;
  for (const p of absolutePaths(text)) if (!inside(cwd, normalizeShellPath(p))) return false;
  for (const segment of shellSegments(stripped)) {
    const tokens = tokenize(segment);
    if (!tokens.length) continue;
    const program = (tokens[0].split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
    if (/^\w+=/.test(tokens[0])) return false; // VAR=x cmd — could be anything
    if (program === "git") {
      const rest = tokens.slice(1).filter((t) => t !== "--no-pager");
      const sub = rest[0];
      if (sub === "branch") {
        if (rest.slice(1).some((t) => !["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all"].includes(t))) return false;
        continue;
      }
      if (sub === "worktree" && rest[1] === "list") continue;
      if (!sub || sub.startsWith("-") || !READ_ONLY_GIT.has(sub)) return false;
      // Options that write a file or run another program (the last three from the public lineage's list).
      if (rest.some((t) => /^--output(=|$)|^--ext-diff$|^--exec(=|$)|^--upload-pack(=|$)|^(-O|--open-files-in-pager)/.test(t))) return false;
      continue;
    }
    if (program === "sed") {
      // Only `sed -n 'N,Mp;Kp' file`: print lines, nothing else (sed can also write files and run commands).
      const args = tokens.slice(1);
      if (!args.includes("-n") || args.some((t) => /^-i|^--in-place/.test(t))) return false;
      const script = args.find((t) => !t.startsWith("-"));
      if (!script || !/^(?:(\d+|\$)(,(\d+|\$))?p;?)+$/.test(script)) return false;
      continue;
    }
    if (program === "find") {
      if (tokens.some((t) => /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(t))) return false;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    // Listed programs with a flag that writes a file or runs another program.
    if (program === "sort" && tokens.some((t) => /^(-o|--output)(=|$)/.test(t))) return false;
    if (program === "rg" && tokens.some((t) => /^--pre(=|$)/.test(t))) return false;
  }
  return true;
}

/** Permission gate for autonomous runs (no human watching). See docs/DECISIONS.md D6/D19. */
export function autonomousGate(toolName: string, input: Record<string, unknown>, cwd: string, readRoots: string[] = []): GateResult {
  if (toolName.startsWith("mcp__") && !isSafeMcp(toolName)) {
    return { behavior: "deny", message: `Autonomous runs can't call external MCP tools (${toolName}).` };
  }
  // The runner sends questions to you before this gate; one that gets here anyway is decided alone.
  if (toolName === "AskUserQuestion") {
    return { behavior: "deny", message: "No one is watching this autonomous run. Make a reasonable choice, note it in your summary, and continue." };
  }
  const read = readViolation(toolName, input, cwd, readRoots);
  if (read) return { behavior: "deny", message: read };
  const key = PATH_KEYS[toolName];
  if (key) {
    const p = input[key];
    if (typeof p === "string" && !inside(cwd, p)) {
      return { behavior: "deny", message: `Autonomous runs may only write inside the task worktree (${cwd}); refused ${p}.` };
    }
  }
  if (SHELL_TOOLS.has(toolName)) {
    const why = shellViolation(String(input.command ?? ""), cwd);
    if (why) {
      return { behavior: "deny", message: `Refused because ${why}. Autonomous runs stay inside ${cwd}; the board handles branches, merges and cleanup.` };
    }
  }
  return { behavior: "allow", updatedInput: input };
}
