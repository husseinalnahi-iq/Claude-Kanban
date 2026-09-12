import { isAbsolute, relative, resolve } from "node:path";
import { BROWSER_SERVER, CHROME_PREFIX, PLAYWRIGHT_PLUGIN_TOOLS } from "./browser.ts";

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
  for (const raw of tokenize(cmd)) {
    const candidates = raw.match(/[a-zA-Z]:[\\/][^;&|<>`]*|(?<![\w.])\/[a-zA-Z]\/[^\s;&|<>`]*/g) ?? [];
    for (const c of candidates) {
      const p = normalizeShellPath(c.replace(/[)"',]+$/, ""));
      if (!inside(cwd, p)) return `it touches ${p}, outside the worktree`;
    }
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

/** Permission gate for autonomous runs (no human watching). See docs/DECISIONS.md D6/D19. */
export function autonomousGate(toolName: string, input: Record<string, unknown>, cwd: string): GateResult {
  if (toolName.startsWith("mcp__") && !isSafeMcp(toolName)) {
    return { behavior: "deny", message: `Autonomous runs can't call external MCP tools (${toolName}). Ask for a supervised task if this is needed.` };
  }
  if (toolName === "AskUserQuestion") {
    return { behavior: "deny", message: "No one is watching this autonomous run. Make a reasonable choice, note it in your summary, and continue." };
  }
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
