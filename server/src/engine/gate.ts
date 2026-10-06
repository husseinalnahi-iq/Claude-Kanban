import * as nodePath from "node:path";
import { BROWSER_SERVER, CHROME_PREFIX, PLAYWRIGHT_PLUGIN_TOOLS } from "./browser.ts";
import { IMAGE_PREFIX, MARKITDOWN_SERVER, MARKITDOWN_TOOL } from "../types.ts";
import { credentialRisk } from "./credentials.ts";

export type GateResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * Tools that never change anything. Everything else is a write for approval purposes. The Task*
 * names are the SDK's to-do list (the successor of TodoWrite): they only touch the run's own
 * checklist, and leaving them out cost one supervised run 30 of its 68 cards (D363).
 */
export const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "TodoRead", "Skill",
  "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "BashOutput", "TaskOutput",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
]);

/** MCP servers every run may use without approval: the board itself and read-only docs lookup. */
export const SAFE_MCP_PREFIXES = ["mcp__board__", "mcp__plugin_context7_context7__"];

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export const PATH_KEYS: Record<string, string> = {
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
/**
 * In the project folder (D398) git only looks: staging or committing would mix the task's work into
 * the owner's own index and history, and the board commits the task's files itself on Approve.
 */
const FOLDER_GIT = new Set([...ALLOWED_GIT].filter((sub) => !["add", "commit", "mv", "rm", "apply"].includes(sub)));
/** A word naming the folder's .git or the board's .kanban (other tasks' copies live there). `.gitignore` is not one. */
const BOARD_FOLDERS = /(^|[\s"'=/\\])\.(git|kanban)(?=[/\\\s"';|&)]|$)/i;
/** Global git options that point git at a different repo or work tree. */
const RETARGET = /^(-C|--git-dir|--work-tree|--namespace)(=|$)/;

export function isSafeMcp(toolName: string): boolean {
  return SAFE_MCP_PREFIXES.some((p) => toolName.startsWith(p));
}

const OWN_RULE_PREFIXES = [CHROME_PREFIX, `mcp__${BROWSER_SERVER}__`, `${PLAYWRIGHT_PLUGIN_TOOLS}__`, IMAGE_PREFIX, `mcp__${MARKITDOWN_SERVER}__`, "mcp__computer-use__"];
const READ_VERBS = new Set(["get", "list", "search", "read", "fetch", "find", "count", "describe", "lookup", "query"]);
// Any one of these anywhere in the name makes it a write, so `get_or_create_x` or `find_and_delete`
// still asks. Nouns that only look like verbs (`get_agent_run`, `get_issue`) are left off. `query` counts as a read only beside a word that says so (`query_logs`): a bare
// `query` / `execute_sql` can change rows.
const WRITE_VERBS = new Set([
  "send", "create", "update", "delete", "trash", "apply", "execute", "exec", "deploy", "write", "set",
  "add", "remove", "post", "merge", "reset", "pause", "unpause", "restore", "buy", "upload", "label", "unlabel",
  "mark", "unmark", "cancel", "move", "copy", "share", "submit", "schedule", "respond", "forward", "reply",
  "draft", "edit", "patch", "put", "insert", "replace", "rename", "approve", "assign", "invalidate", "kill",
  "stop", "start", "rollback", "promote", "transfer", "join", "accept", "sign", "revoke", "activate",
  "rebase", "sql", "migration", "click", "type", "navigate",
]);

/**
 * A connector tool whose name says it only reads — `get_values`, `slack_search_public_and_private`,
 * `list_events` — judged by its words, since an MCP server declares nothing the board can trust. The
 * read verb must be the first or second word (the second covers a server prefix such as `slack_`),
 * and no word may be a write verb. Wrongly calling a write a read is the costly mistake, so the
 * write list is long and wins every tie (D363).
 */
export function isReadOnlyMcp(toolName: string): boolean {
  if (!toolName.startsWith("mcp__")) return false;
  // Servers that see your screen, your own browser or make files keep their own rules: "reading"
  // your clipboard or a logged-in Chrome tab is exactly what a card is for.
  if (OWN_RULE_PREFIXES.some((p) => toolName.startsWith(p))) return false;
  const action = toolName.slice(toolName.lastIndexOf("__") + 2).toLowerCase();
  const words = action.split(/[_\-]+/).filter(Boolean);
  if (words.some((w) => WRITE_VERBS.has(w))) return false;
  const lead = words.slice(0, 2).findIndex((w) => READ_VERBS.has(w));
  if (lead < 0) return false;
  return words[lead] !== "query" || words.length > lead + 1;
}

/** How the board treats one MCP server's tools, in the words the Settings page shows. */
export function serverRule(prefix: string, opts: { markitdown?: boolean } = {}): string {
  if (prefix === "mcp__board__") return "The board's own tools — always allowed.";
  if (SAFE_MCP_PREFIXES.includes(prefix)) return "Read-only lookups — always allowed.";
  if (prefix === `mcp__${BROWSER_SERVER}__`) return "The board's browser — looking at local pages is free; see Browser checks.";
  if (prefix === `${PLAYWRIGHT_PLUGIN_TOOLS}__`) return "Hidden: runs use the board's own browser instead, one per task.";
  if (prefix === CHROME_PREFIX) return "Your own Chrome — supervised runs only, every action approved.";
  if (prefix === IMAGE_PREFIX) return "Free image generation — saves inside the task's folder; supervised runs approve each image on a card.";
  if (prefix === `mcp__${MARKITDOWN_SERVER}__` && opts.markitdown) {
    return "Documents to Markdown — a web page or a file in the task's own folders is a read, without a card; other files are refused (autonomous) or asked (supervised).";
  }
  return "Autonomous runs: refused. Supervised runs: an approval card for every call, except tools whose name says they only read (get, list, search…) when read-only work is allowed without a card.";
}

// ---------------------------------------------------------------- paths

const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(p);

/**
 * Paths are judged the way the task's own folder reads them, not the way the machine running the board
 * does: a `C:\…` folder follows Windows rules and a `/…` folder POSIX ones, so the answer is the same
 * wherever this runs.
 */
const pathsFor = (cwd: string) => (isWindowsPath(cwd) ? nodePath.win32 : cwd.startsWith("/") ? nodePath.posix : nodePath);

function inside(cwd: string, p: string): boolean {
  const P = pathsFor(cwd);
  const rel = P.relative(P.resolve(cwd), P.resolve(cwd, p));
  return rel === "" || (!rel.startsWith("..") && !P.isAbsolute(rel));
}

/** "/c/Users/x" (Git Bash) → "C:\Users\x" when the folder is a Windows one; other paths unchanged. */
function normalizeShellPath(p: string, windows = true): string {
  if (!windows) return p;
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
  return pathsAt(cmd, /(?<![\w])[a-zA-Z]:[\\/]|(?<![\w.])\/[a-zA-Z]\//g);
}

function pathsAt(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const quote = text[start - 1];
    let end: number;
    if (quote === '"' || quote === "'") {
      end = text.indexOf(quote, start);
      if (end < 0) end = text.length;
    } else {
      const stop = /[\s;&|<>`"'()]/.exec(text.slice(start));
      end = stop ? start + stop.index : text.length;
    }
    out.push(text.slice(start, end).replace(/[,]+$/, ""));
    re.lastIndex = Math.max(end, start + 1);
  }
  return out;
}

/**
 * `..` as a whole path segment, wherever it sits: after a space, a quote or an operator, and also in
 * the middle of a path. The first version only looked after a space, so `./../../../.env` and
 * `src/../../x` walked straight out.
 */
const TRAVERSAL = /(^|[\s"'=;&|(`\\/:,<>@])\.\.([\\/]|$|[\s"';&|)`,<>])/;

/**
 * Anything that names the home folder: `~` and `~user`, the variables each shell keeps it in (with or
 * without braces), and the calls a one-line script would use to ask for it.
 */
const HOME_VARS = "HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|CLOUDSYNC";
const HOME_REF = new RegExp(
  String.raw`(^|[\s"'=;&|(:<>,\`])~[\w.+-]*([\\/]|$|[\s"';&|)<>,\`])` +
    String.raw`|\$\{?(?:${HOME_VARS})\}?(?![\w])|\$env:(?:${HOME_VARS})\b|%(?:${HOME_VARS})%` +
    String.raw`|\bhomedir\s*\(|\bexpanduser\b|\bPath\.home\s*\(|\bGetFolderPath\b`,
  "i",
);

/**
 * Top-level folders that exist on a real machine. A path that starts at one of them is a path, however
 * it is written — `/Users/me/x`, `\Users\me\x` (PowerShell reads that from the drive's root), inside a
 * one-line script. A string that only looks like one, such as the route `/api/orders`, is left alone:
 * refusing every leading slash would refuse half the searches a run makes.
 */
const KNOWN_ROOTS =
  "users|home|etc|root|var|private|volumes|mnt|media|proc|sys|dev|cygdrive|srv|run|boot|windows|programdata|program files(?: \\(x86\\))?|documents and settings|library|system|applications";
const ROOTED = () => new RegExp(String.raw`(?<=^|[\s"'=(<>,;|&@\`])[\\/](?:${KNOWN_ROOTS})(?=[\\/]|$|[\s"';&|)<>,\`])`, "gi");

/** Outside the worktree, and fine: the null device and friends, the system's own programs, scratch space. */
const SYSTEM_PATH = /^\/(?:dev\/(?:null|stdin|stdout|stderr|tty|zero|u?random|fd\/\d+)$|(?:usr|bin|sbin|opt|lib|lib64|tmp)(?:\/|$))/i;

const UNC = /^(?:\\\\|\/\/)[^\s\\/]+[\\/][^\s\\/]/;

// ---------------------------------------------------------------- reading a command

export type ShellFlavour = "bash" | "powershell" | "cmd";

/** One simple command: what a shell would run after it has dealt with quotes, pipes and lists. */
export interface ShellCommand {
  /** Its words, with the shell's own quoting removed. */
  words: string[];
  /** Which of those words are where a `>` or `<` points. */
  redirect: boolean[];
  /** The separator in front of it: "" for the first, else `;` `&` `&&` `||` `|` a newline, a bracket or a backtick. */
  op: string;
  /** It runs inside `$(…)`, `<(…)`, `(…)` or backticks. */
  sub: boolean;
  /** Commands share a number until a `;`, `&`, `&&`, `||` or newline: one pipeline with its substitutions. */
  group: number;
  /** Text fed to it with `<<TAG`. */
  heredocs: string[];
}

const HARD_SEPARATORS = new Set([";", "&", "&&", "||", "\n"]);

function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Splits a command line into the simple commands a shell would run. It knows the three dialects runs
 * use, because they disagree on what escapes a quote: bash uses a backslash, PowerShell a backtick
 * (so `"C:\dir\"` is a whole string there and an open one in bash), and cmd has only double quotes.
 *
 * `unsure` is set when the line cannot be read with confidence — a quote left open — and every caller
 * treats that as "no": a command the board cannot read is not one it can vouch for.
 */
export function lexShell(
  src: string, flavour: ShellFlavour = "bash", inherit: { sub: boolean; group: number } | null = null,
): { cmds: ShellCommand[]; unsure: string | null } {
  const cmds: ShellCommand[] = [];
  const n = src.length;
  let unsure: string | null = null;
  let group = inherit?.group ?? 0;
  let depth = 0;
  let ticks = false;
  const fresh = (op: string): ShellCommand => ({ words: [], redirect: [], op, sub: Boolean(inherit?.sub) || depth > 0 || ticks, group, heredocs: [] });
  let cmd = fresh("");
  let cur = "";
  let has = false;
  let redirectNext = false;
  const pending: { tag: string; strip: boolean; owner: ShellCommand }[] = [];

  const endWord = () => {
    if (has) {
      cmd.words.push(cur);
      cmd.redirect.push(redirectNext);
      redirectNext = false;
    }
    cur = "";
    has = false;
  };
  const endCmd = (op: string) => {
    endWord();
    redirectNext = false;
    if (cmd.words.length) cmds.push(cmd);
    // A substitution stays in the pipeline that contains it, whatever separators it has inside.
    if (HARD_SEPARATORS.has(op) && !inherit) group++;
    cmd = fresh(op);
  };
  const nested = (text: string) => {
    const inner = lexShell(text, flavour, { sub: true, group });
    cmds.push(...inner.cmds);
    unsure ??= inner.unsure;
  };
  const heredocTag = (from: number): number => {
    let j = from;
    let strip = false;
    if (src[j] === "-") {
      strip = true;
      j++;
    }
    while (src[j] === " " || src[j] === "\t") j++;
    let tag = "";
    const q = src[j];
    if (q === "'" || q === '"') {
      const end = src.indexOf(q, j + 1);
      if (end < 0) {
        unsure = "a quote is not closed";
        return n;
      }
      tag = src.slice(j + 1, end);
      j = end + 1;
    } else {
      const m = /^[^\s;&|<>()]+/.exec(src.slice(j));
      if (m) {
        tag = m[0].replace(/\\/g, "");
        j += m[0].length;
      }
    }
    if (tag) pending.push({ tag, strip, owner: cmd });
    return j - 1;
  };

  for (let i = 0; i < n && !unsure; i++) {
    const c = src[i];

    if (c === "\n") {
      // The heredoc bodies announced on this line are data for their command, not commands themselves.
      let pos = i + 1;
      for (const h of pending.splice(0)) {
        const lines: string[] = [];
        while (pos < n) {
          let end = src.indexOf("\n", pos);
          if (end < 0) end = n;
          const line = src.slice(pos, end).replace(/\r$/, "");
          pos = end + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.tag) break;
          lines.push(line);
        }
        h.owner.heredocs.push(lines.join("\n"));
      }
      i = pos - 1;
      endCmd("\n");
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      continue;
    }
    if (c === "#" && !has && flavour !== "cmd") {
      // A comment runs to the end of the line; an apostrophe in one is not an open quote.
      const end = src.indexOf("\n", i);
      i = (end < 0 ? n : end) - 1;
      continue;
    }
    if (c === "\\" && flavour === "bash") {
      if (src[i + 1] === "\n") i++;
      else if (src[i + 1] === "\r" && src[i + 2] === "\n") i += 2;
      else {
        cur += c + (src[i + 1] ?? "");
        has = true;
        i++;
      }
      continue;
    }
    if (c === "`" && flavour === "powershell") {
      if (src[i + 1] === "\n") i++;
      else if (src[i + 1] === "\r" && src[i + 2] === "\n") i += 2;
      else {
        cur += src[i + 1] ?? "";
        has = true;
        i++;
      }
      continue;
    }

    if (c === "'" && flavour !== "cmd") {
      let end: number;
      if (flavour === "powershell" && src[i - 1] === "@" && /^\r?\n/.test(src.slice(i + 1))) {
        // A PowerShell here-string: everything up to a line that starts with '@.
        const close = /\r?\n'@/.exec(src.slice(i + 1));
        end = close ? i + 1 + close.index + close[0].length - 2 : -1;
      } else if (flavour === "bash" && has && cur.endsWith("$")) {
        // $'…' is the one single-quoted form where a backslash escapes.
        end = i + 1;
        while (end < n && src[end] !== "'") end += src[end] === "\\" ? 2 : 1;
        if (end >= n) end = -1;
      } else {
        end = src.indexOf("'", i + 1);
      }
      if (end < 0) {
        unsure = "a quote is not closed";
        break;
      }
      cur += src.slice(i + 1, end);
      has = true;
      i = end;
      continue;
    }
    if (c === '"') {
      const hereString = flavour === "powershell" && src[i - 1] === "@" && /^\r?\n/.test(src.slice(i + 1));
      let j = i + 1;
      let body = "";
      for (; j < n; j++) {
        const d = src[j];
        if (hereString) {
          if (d === "\n" && src[j + 1] === '"' && src[j + 2] === "@") {
            j++;
            break;
          }
        } else {
          if (d === "\\" && flavour === "bash" && j + 1 < n) {
            body += d + src[j + 1];
            j++;
            continue;
          }
          if (d === "`" && flavour === "powershell" && j + 1 < n) {
            body += src[j + 1];
            j++;
            continue;
          }
          if (d === '"' && src[j + 1] === '"' && flavour !== "bash") {
            body += d;
            j++;
            continue;
          }
          if (d === '"') break;
        }
        // Double quotes do not stop a substitution from running: what is inside is a command too.
        if (d === "$" && src[j + 1] === "(" && flavour !== "cmd") {
          const end = closingParen(src, j + 1);
          if (end < 0) {
            unsure = "a bracket is not closed";
            break;
          }
          nested(src.slice(j + 2, end));
          body += src.slice(j, end + 1);
          j = end;
          continue;
        }
        if (d === "`" && flavour === "bash") {
          const end = src.indexOf("`", j + 1);
          if (end < 0) {
            unsure = "a backtick is not closed";
            break;
          }
          nested(src.slice(j + 1, end));
          body += src.slice(j, end + 1);
          j = end;
          continue;
        }
        body += d;
      }
      if (unsure) break;
      if (j >= n) {
        unsure = "a quote is not closed";
        break;
      }
      cur += body;
      has = true;
      i = j;
      continue;
    }

    if (c === ";") {
      endCmd(";");
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === "&") {
        endCmd("&&");
        i++;
      } else if (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">") {
        cur += c; // part of a redirection: 2>&1, &>file
        has = true;
      } else endCmd("&");
      continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") {
        endCmd("||");
        i++;
      } else {
        if (src[i + 1] === "&") i++;
        endCmd("|");
      }
      continue;
    }
    if (c === "(") {
      depth++;
      endCmd("(");
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      endCmd(")");
      continue;
    }
    if (c === "{") {
      if (has && cur.endsWith("$")) {
        // ${NAME} is part of the word it sits in, not a block.
        const end = src.indexOf("}", i);
        cur += src.slice(i, end < 0 ? n : end + 1);
        i = end < 0 ? n : end;
        continue;
      }
      endCmd("{");
      continue;
    }
    if (c === "}") {
      endCmd("}");
      continue;
    }
    if (c === "`" && flavour === "bash") {
      ticks = !ticks;
      endCmd("`");
      continue;
    }
    if (c === "<" || c === ">") {
      // A number (or & or *) glued to the front is which stream, not a word: 2>file, &>file.
      if (has && /^(\d+|&|\*)$/.test(cur)) {
        cur = "";
        has = false;
      }
      endWord();
      if (c === "<" && src.startsWith("<<<", i)) {
        i += 2; // a here-string: the next word is data
        continue;
      }
      if (c === "<" && src[i + 1] === "<" && flavour === "bash") {
        i = heredocTag(i + 2);
        continue;
      }
      if (src[i + 1] === "(") continue; // <(…) and >(…): the bracket opens a command
      if (c === ">" && (src[i + 1] === ">" || src[i + 1] === "|")) i++;
      if (src[i + 1] === "&") {
        i++;
        const fd = /^(\d+|-)/.exec(src.slice(i + 1));
        if (fd) {
          i += fd[0].length;
          continue;
        }
      }
      redirectNext = true;
      continue;
    }

    cur += c;
    has = true;
  }
  endCmd("");
  return { cmds, unsure };
}

/** The program a word names: `C:\tools\Git.EXE` and `/usr/bin/git` are both `git`. */
const programOf = (word: string) => (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");

/** Words that run the command after them rather than being it. */
const RUNNERS = new Set([
  "sudo", "doas", "env", "command", "builtin", "exec", "time", "nohup", "nice", "ionice", "stdbuf", "timeout", "xargs", "winpty", "npx",
  "then", "do", "else", "elif", "if", "while", "until", "!",
]);

/**
 * Where the command proper may begin: at the first word, or after runner words (`sudo -u root rm …`),
 * their options and the values those take, and `NAME=value` settings.
 */
function commandStarts(words: string[]): number[] {
  const starts = [0];
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    const leading = RUNNERS.has(programOf(w)) || /^[A-Za-z_]\w*=/.test(w);
    const trailing = i > 0 && (w.startsWith("-") || /^\d+$/.test(w) || words[i - 1].startsWith("-"));
    if (!leading && !trailing) break;
    starts.push(i + 1);
  }
  return starts;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
/** PowerShell options that take a value, so the word after them is not the command. */
const PS_VALUE_OPTIONS = /^-(ex|ep|executionpolicy|w|windowstyle|inputformat|outputformat|wd|workingdirectory|configurationname|version|psconsolefile|settingsfile)$/i;

/**
 * Commands handed to another shell as a string: `bash -c '…'`, `eval …`, `cmd /c …`,
 * `powershell -Command …`, `Invoke-Expression …`, and a script fed to a shell with `<<`. Each comes
 * back to be checked like the line itself. `opaque` is set when there is one that cannot be read.
 */
function innerScripts(c: ShellCommand): { scripts: { text: string; flavour: ShellFlavour }[]; opaque: string | null } {
  const scripts: { text: string; flavour: ShellFlavour }[] = [];
  let opaque: string | null = null;
  const { words } = c;
  for (let i = 0; i < words.length; i++) {
    const name = programOf(words[i]);
    const rest = words.slice(i + 1);
    if (SHELLS.has(name)) {
      const at = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/i.test(w));
      if (at >= 0 && rest[at + 1] !== undefined) scripts.push({ text: rest[at + 1], flavour: "bash" });
      for (const body of c.heredocs) scripts.push({ text: body, flavour: "bash" });
    } else if (name === "eval" || name === "wsl") {
      const from = rest.findIndex((w) => !w.startsWith("-"));
      if (from >= 0) scripts.push({ text: rest.slice(from).join(" "), flavour: "bash" });
    } else if (name === "cmd") {
      const at = rest.findIndex((w) => /^\/{1,2}[ck]$/i.test(w));
      if (at >= 0 && rest.length > at + 1) scripts.push({ text: rest.slice(at + 1).join(" "), flavour: "cmd" });
    } else if (name === "iex" || name === "invoke-expression") {
      if (rest.length) scripts.push({ text: rest.join(" "), flavour: "powershell" });
    } else if (POWERSHELLS.has(name)) {
      for (let j = 0; j < rest.length; j++) {
        const w = rest[j];
        if (/^-(e|ec|enc\w*)$/i.test(w)) {
          opaque = "an encoded PowerShell command";
          break;
        }
        if (/^-f(ile)?$/i.test(w)) break;
        if (/^-c(o(m(m(a(nd?)?)?)?)?)?$/i.test(w)) {
          if (rest.length > j + 1) scripts.push({ text: rest.slice(j + 1).join(" "), flavour: "powershell" });
          break;
        }
        if (w.startsWith("-")) {
          if (PS_VALUE_OPTIONS.test(w)) j++;
          continue;
        }
        scripts.push({ text: rest.slice(j).join(" "), flavour: "powershell" });
        break;
      }
    }
  }
  return { scripts, opaque };
}

/** Programs whose first plain argument is what to look for, not a file to open. */
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "findstr", "sed", "awk", "gawk", "jq", "yq", "select-string", "sls"]);
/** Programs whose arguments are text they print. */
const PRINTERS = new Set(["echo", "printf", "write-output", "write-host"]);
const FIND_PATTERNS = /^-(i?name|i?path|i?regex|i?wholename|i?lname)$/;
/** Options that carry the pattern themselves. Case matters: grep's `-E` and `-F` take no value. */
const PATTERN_OPTION = /^(-e|--regexp|-[Pp]attern)$/;
/** Options whose value is a file-name filter or a setting, not a file: `--include '*.ts'`, `awk -F /`. */
const FILTER_OPTION = /^(--include|--exclude|--exclude-dir)$/;
const OWN_VALUE_OPTIONS: Record<string, RegExp> = {
  awk: /^(-F|-v)$/,
  gawk: /^(-F|-v)$/,
  rg: /^(-g|--glob|--iglob|-t|--type|-T|--type-not)$/,
};
const ANY_PATTERN = /^(--grep|--regexp|--pattern|--match|--testnamepattern|--filter)$/i;
const MESSAGE = /^(-m|--message)$/;
const CURL_TEXT = /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-H|--header|-A|--user-agent|-X|--request)$/;

/**
 * The words of a command that are text for the program — a search pattern, a script, a message — and
 * never a file it opens. `grep -rn "/api/orders" src` searches for a string that only looks like a
 * path; `grep secret /etc/passwd` opens one, and so does `grep -e secret /etc/passwd`, where the
 * pattern came with an option and every plain word is a file. With `search`, only what a search tool
 * is told to look for counts: a printed or sent string can still be a command for whatever reads it.
 */
function textArgs(words: string[], kind: "paths" | "search"): Set<number> {
  const out = new Set<number>();
  const start = commandStarts(words).at(-1) ?? 0;
  const program = programOf(words[start] ?? "");
  const args = (from: number) => words.map((w, i) => ({ w, i })).slice(from);
  const pattern = (from: number, own: string) => {
    let next: "pattern" | "value" | null = null;
    let given = false;
    let first = -1;
    for (const { w, i } of args(from)) {
      if (next) {
        out.add(i);
        given ||= next === "pattern";
        next = null;
      } else if (PATTERN_OPTION.test(w)) next = "pattern";
      else if (FILTER_OPTION.test(w) || OWN_VALUE_OPTIONS[own]?.test(w)) next = "value";
      else if (first < 0 && !w.startsWith("-") && !/^\d+$/.test(w) && !/^\/{1,2}[a-z]$/i.test(w)) first = i;
    }
    // PowerShell names its arguments: a plain word later in the line belongs to whatever option came before it.
    const positional = own === "select-string" || own === "sls" ? first === from : first >= 0;
    if (!given && positional) out.add(first);
  };
  if (SEARCHERS.has(program)) pattern(start + 1, program);
  if (program === "find") for (const { w, i } of args(start + 1)) if (FIND_PATTERNS.test(w)) out.add(i + 1);
  if (program === "git") {
    const sub = words.findIndex((w, i) => i > start && !w.startsWith("-"));
    if (sub >= 0 && words[sub] === "grep") pattern(sub + 1, "grep");
    for (const { w, i } of args(start + 1)) if (w === "-S" || w === "-G") out.add(i + 1);
  }
  for (const { w, i } of args(start + 1)) if (ANY_PATTERN.test(w)) out.add(i + 1);
  if (kind === "paths") {
    if (PRINTERS.has(program)) for (const { i } of args(start + 1)) out.add(i);
    if (program === "curl" || program === "wget") for (const { w, i } of args(start + 1)) if (CURL_TEXT.test(w) && !words[i + 1]?.startsWith("@")) out.add(i + 1);
    if (program === "git") for (const { w, i } of args(start + 1)) if (MESSAGE.test(w)) out.add(i + 1);
  }
  return out;
}

const CD_PROGRAMS = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
/** Programs that take a single character as a separator, so a lone `/` is not the root folder. */
const DELIMITER_PROGRAMS = new Set(["cut", "tr", "paste", "column", "sort", "awk", "gawk", "sed", "grep", "egrep", "fgrep", "rg", "jq", "echo", "printf"]);

/** Where `cd` and its cousins would go, when that is not somewhere the board can see is inside. */
function cdViolation(words: string[], cwd: string): string | null {
  const start = commandStarts(words).at(-1) ?? 0;
  const program = programOf(words[start] ?? "");
  if (!CD_PROGRAMS.has(program)) return null;
  const rest = words.slice(start + 1);
  const target = rest.find((w, i) => (w === "-" || !w.startsWith("-")) && !(/^\/[a-z]$/i.test(w) && i < rest.length - 1));
  if (target === undefined) return program === "cd" || program === "set-location" || program === "sl" ? "it changes to your home directory" : null;
  if (target === "-") return null;
  // `cd "$dir"` could be anywhere. The folder it is already in is the one exception.
  if (/[$`]|%\w+%/.test(target) && !/^(\$pwd|\$\{pwd\}|\$\(pwd\)|\$env:pwd)([\\/]|$)/i.test(target)) {
    return `it changes folder to \`${target}\`, and the board cannot tell where that is`;
  }
  return inside(cwd, normalizeShellPath(target, isWindowsPath(cwd))) ? null : `it changes folder to ${target}, outside the worktree`;
}

/**
 * The first path in a command that leaves the folder, or null. `strict` is for commands that run with
 * no card at all: there every leading `/` or `\` is a path unless it is plainly something else.
 */
function outsidePath(c: Pick<ShellCommand, "words" | "redirect" | "heredocs">, cwd: string, strict: boolean): string | null {
  const windows = isWindowsPath(cwd);
  const escapes = (p: string) => !SYSTEM_PATH.test(p.replace(/\\/g, "/")) && !inside(cwd, normalizeShellPath(p, windows));
  const text = textArgs(c.words, "paths");
  const program = programOf(c.words[commandStarts(c.words).at(-1) ?? 0] ?? "");
  for (let k = 0; k < c.words.length; k++) {
    if (text.has(k) && !c.redirect[k]) continue;
    const word = c.words[k];
    for (const p of pathsAt(word, ROOTED())) if (escapes(p)) return p;
    // `--out=/x/y` and `DIR=/x/y cmd`: the path is what follows the `=`.
    const keyed = /^(--?[\w-]+|[A-Za-z_]\w*)=/.exec(word);
    if (keyed && ANY_PATTERN.test(keyed[1])) continue;
    const value = keyed ? word.slice(keyed[0].length) : word;
    if (!value || /\s/.test(value)) continue;
    if (UNC.test(value)) return value;
    // A Windows switch that carries a value (`/p:Out=bin/Release`) is a setting, not a path from the root.
    if (windows && /^\/[\w?]+[:=]/.test(value)) continue;
    if (value.startsWith("/") && !value.startsWith("//")) {
      const segments = value.split("/").filter(Boolean).length;
      // On Windows a single `/word` is a switch (`/PID`, `/T`); two segments or more is a path.
      if ((segments >= 2 || (segments === 1 && strict && !windows)) && escapes(value)) return value;
      if (segments === 0 && strict && !DELIMITER_PROGRAMS.has(program)) return value;
    }
    if (strict && /^\\[^\s\\]/.test(value) && escapes(value)) return value;
  }
  for (const body of c.heredocs) for (const p of pathsAt(body, ROOTED())) if (escapes(p)) return p;
  return null;
}

/** Every `git` in the words, not just the first: `git status & git push` is two of them. */
function gitViolation(words: string[], folder = false): string | null {
  const allowed = folder ? FOLDER_GIT : ALLOWED_GIT;
  for (let at = 0; at < words.length; at++) {
    // `g\it` is `git` to bash; on Windows so is `Git.EXE`.
    if (programOf(words[at]) !== "git" && programOf(words[at].replace(/\\/g, "")) !== "git") continue;
    let i = at + 1;
    while (i < words.length && words[i].startsWith("-") && words[i] !== "--version") {
      if (RETARGET.test(words[i])) return `\`git ${words[i]}\` points git at another repository`;
      if (words[i] === "-c") i++; // `-c key=value`
      i++;
    }
    const sub = words[i];
    if (sub && !allowed.has(sub)) {
      return folder
        ? `\`git ${sub}\` would change your own repository; in the project folder git only looks (status, diff, log…), and the board commits this task's files when it is approved`
        : `\`git ${sub}\` is managed by the board (allowed: ${[...ALLOWED_GIT].slice(0, 12).join(", ")}…)`;
    }
  }
  return null;
}

const MAX_NESTING = 3;

/**
 * Returns why a shell command is not allowed in an autonomous worktree, or null when it is fine.
 * `folder`: the task works in the project folder itself (D398) — git only looks, and .git and .kanban are off limits.
 */
export function shellViolation(cmd: string, cwd: string, shell: ShellFlavour = "bash", folder = false): string | null {
  return violationIn(cmd, cwd, shell, 0, folder);
}

function violationIn(cmd: string, cwd: string, shell: ShellFlavour, depth: number, folder = false): string | null {
  if (depth > MAX_NESTING) return "it wraps one command inside another too many times for the board to check";
  if (folder && BOARD_FOLDERS.test(cmd)) return "it reaches into .git or .kanban, which hold your repository's history and other tasks' copies";
  if (TRAVERSAL.test(cmd)) return "it walks out of the worktree with `..`";
  if (HOME_REF.test(cmd)) return "it references your home directory";
  const windows = isWindowsPath(cwd);
  for (const c of absolutePaths(cmd)) {
    const p = normalizeShellPath(c, windows);
    if (!inside(cwd, p)) return `it touches ${p}, outside the worktree`;
  }
  const lex = lexShell(cmd, shell);
  if (lex.unsure) return `the board cannot read it safely (${lex.unsure}), and an unattended run does not get the benefit of the doubt`;
  // `W="C:/…/wt/t1"; cd "$W/scripts"`: a name set to a plain path earlier in the same command is
  // that path. Seen stopping a live task five refusals in (D390); anything else stays unknown.
  const known = new Map<string, string>();
  const expand = (w: string) => w.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a: string | undefined, b: string | undefined) => known.get((a ?? b)!) ?? m);
  for (const c of lex.cmds) {
    if (c.words.length && c.words.every((w) => /^[A-Za-z_]\w*=/.test(w))) {
      for (const w of c.words) {
        const eq = w.indexOf("=");
        const value = w.slice(eq + 1);
        if (/[$`]/.test(value)) known.delete(w.slice(0, eq));
        else known.set(w.slice(0, eq), value);
      }
    }
    const away = cdViolation(c.words.map(expand), cwd);
    if (away) return away;
    const out = outsidePath(c, cwd, false);
    if (out) return `it touches ${out}, outside the worktree`;
    const git = gitViolation(c.words, folder);
    if (git) return git;
    const inner = innerScripts(c);
    if (inner.opaque) return `it runs ${inner.opaque}, which the board cannot read`;
    for (const s of inner.scripts) {
      const why = violationIn(s.text, cwd, s.flavour, depth + 1, folder);
      if (why) return why;
    }
  }
  return null;
}

// ---------------------------------------------------------------- commands refused in both modes

const FLAVOURS: ShellFlavour[] = ["bash", "powershell"];

/** Different names for the same thing, so a rule written with one catches the others. */
const SAME_PROGRAM: string[][] = [
  ["sh", "bash", "zsh", "dash", "ksh"],
  ["iex", "invoke-expression"],
  ["iwr", "irm", "invoke-webrequest", "invoke-restmethod", "curl", "wget"],
];
const sameProgram = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || SAME_PROGRAM.some((g) => g.includes(a) && g.includes(b));

/** The long spelling of the flags a rule usually writes short: `rm --recursive --force` is `rm -rf`. */
const LONG_FLAG: Record<string, string> = { r: "--recursive", f: "--force" };

const longFlagIs = (flag: string, word: string) => word === flag || word.startsWith(`${flag}=`) || word.startsWith(`${flag}-`);

/** `/*`, `~/` and `$HOME` are `/` and `~` to a rule that names the place a command must not touch. */
function place(word: string): string {
  if (/^(\$\{?home\}?|\$env:userprofile|%userprofile%)[\\/]?\*?$/.test(word)) return "~";
  const bare = word.replace(/\*$/, "");
  return bare.length > 1 ? bare.replace(/[\\/]$/, "") : bare || word;
}

interface BlockRule {
  rule: string;
  program: string;
  flags: string[];
  plain: string[];
  /** For `curl | sh`: the program the output is piped into. */
  tail: string | null;
}

function parseRule(rule: string): BlockRule | null {
  const text = rule.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const [head, tail] = text.includes("|") ? text.split("|").map((x) => x.trim()) : [text, null];
  const tokens = head.split(" ").filter(Boolean);
  if (!tokens.length || tail === "") return null;
  return {
    rule,
    program: tokens[0],
    flags: tokens.slice(1).filter((t) => t.startsWith("-")),
    plain: tokens.slice(1).filter((t) => !t.startsWith("-")),
    tail: tail ? tail.split(" ")[0] : null,
  };
}

/** Does this one command, read from word `start`, do what the rule names? */
function commandMatches(r: BlockRule, words: string[], start: number): boolean {
  if (!sameProgram(programOf(words[start] ?? ""), r.program)) return false;
  const args = words.slice(start + 1);
  const flags = args.filter((a) => a.startsWith("-"));
  const plain = args.filter((a) => !a.startsWith("-"));
  const letters = new Set(flags.filter((f) => /^-[a-z]+$/.test(f)).flatMap((f) => [...f.slice(1)]));
  const hasFlag = (flag: string) =>
    flag.startsWith("--")
      ? flags.some((f) => longFlagIs(flag, f))
      : [...flag.slice(1)].every((l) => letters.has(l) || (LONG_FLAG[l] !== undefined && flags.some((f) => longFlagIs(LONG_FLAG[l], f))));
  // `git push origin +main` forces the push without any flag: the `+` in front of the branch does it.
  const forcedByRefspec = r.program === "git" && r.plain[0] === "push" && plain[0] === "push" && plain.some((p) => /^\+\S/.test(p));
  if (!r.flags.every(hasFlag) && !(forcedByRefspec && r.flags.every((f) => f === "-f" || f === "--force"))) return false;
  // A subcommand is the word right after the program (`git push`, not `git stash push`); a place may sit anywhere.
  let from = 0;
  for (const [n, want] of r.plain.entries()) {
    const at = plain.findIndex((p, i) => i >= from && (p === want || place(p) === want));
    if (at < 0 || (n === 0 && /^[a-z][\w-]*$/.test(want) && at !== 0)) return false;
    from = at + 1;
  }
  return true;
}

function rulesHit(cmds: ShellCommand[], rules: BlockRule[], flavour: ShellFlavour, depth: number): string | null {
  for (const r of rules) {
    for (const [i, c] of cmds.entries()) {
      const hits = commandStarts(c.words).some((s) => commandMatches(r, c.words, s));
      if (!hits) continue;
      if (!r.tail) return r.rule;
      // `curl … | sh`, and the same thing written as `sh -c "$(curl …)"` or `sh <(curl …)`.
      const runsIt = (o: ShellCommand) => commandStarts(o.words).some((s) => sameProgram(programOf(o.words[s] ?? ""), r.tail!));
      const piped = cmds.some((o, j) => j > i && o.group === c.group && o.op === "|" && runsIt(o));
      const substituted = c.sub && cmds.some((o) => o !== c && o.group === c.group && runsIt(o));
      if (piped || substituted) return r.rule;
    }
  }
  if (depth >= MAX_NESTING) return null;
  // What a command hands to something else to run: a shell's script, and any argument that is itself
  // a sentence — `psql -c "DROP DATABASE prod"`, `ssh host "rm -rf /"`.
  for (const c of cmds) {
    const inner = innerScripts(c).scripts.map((s) => s.text);
    const patterns = textArgs(c.words, "search");
    const sentences = c.words.filter((w, i) => i > 0 && /\s/.test(w) && !patterns.has(i));
    for (const text of new Set([...inner, ...sentences, ...c.heredocs])) {
      const hit = blockedIn(text.replace(/\/\*[\s\S]*?\*\//g, " "), rules, flavour, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function blockedIn(text: string, rules: BlockRule[], flavour: ShellFlavour, depth: number): string | null {
  const lex = lexShell(text, flavour);
  return lex.unsure ? blockedBySubstring(text, rules.map((r) => r.rule)) : rulesHit(lex.cmds, rules, flavour, depth);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first matcher: the rule's words anywhere in the line. Kept for a line that cannot be read properly. */
function blockedBySubstring(cmd: string, blocked: string[]): string | null {
  const flat = cmd.toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
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

/**
 * Commands refused in BOTH modes, before anything else is considered — not even an approval card is
 * offered. An approval card assumes a human reads it; the commands on this list are the ones where
 * a mis-click is unrecoverable, so the answer is "no", not "are you sure?".
 *
 * A rule is a command, matched as one: its program at the start of a command (after `sudo` and the
 * like), its flags anywhere among that command's flags (`-rf` is `-fr` is `-r -f`), and its other words
 * in order. So `git push origin main --force` matches `git push --force`, while the word "shutdown" in
 * a commit message or as something to search for does not match `shutdown` — the substring matcher
 * this replaces missed the first and refused the second. A rule with `|` names a download piped into
 * a shell. Quoting and case are the shell's business and are ignored, and a line too mangled to read
 * falls back to the substring match: nothing that was refused before gets through for being unreadable.
 */
export function blockedCommand(cmd: string, blocked: string[]): string | null {
  const rules = blocked.map(parseRule).filter((r): r is BlockRule => r !== null);
  if (!rules.length) return null;
  const text = cmd.toLowerCase();
  // The board is not told which shell a command is for, and the two read quotes differently.
  for (const flavour of FLAVOURS) {
    const hit = blockedIn(text, rules, flavour, 0);
    if (hit) return hit;
  }
  return null;
}

/**
 * Commands that kill processes by name or pattern rather than by id. Seen in a real run: asked to stop
 * the dev server it had started, a session ran `taskkill /F /IM node.exe` — which killed every Node
 * process on the machine, the board running it included. Refused in both modes, and not editable:
 * there is no version of this a card makes safe.
 */
const KILL_BY_NAME: [RegExp, string][] = [
  [/\btaskkill\b[^|;&]*\s[-/]{1,2}(im|fi)\b/i, "taskkill /IM"],
  [/(^|[\s;&|(/\\])(pkill|killall)(\s|$)/i, "pkill / killall"],
  [/\b(stop-process|spps)\b[^|;&]*-(name|processname)\b/i, "Stop-Process -Name"],
  [/\bget-process\b[^|;&]*\|\s*(stop-process|spps|kill)\b/i, "Get-Process | Stop-Process"],
  [/\bwmic\b[^|;&]*\bprocess\b[^|;&]*\b(delete|terminate)\b/i, "wmic process delete"],
  [/(^|[\s;&|(])kill\s+(-[a-z0-9]+\s+)*-1(\s|$)/i, "kill -1"],
];
/** Ways to end a process by name that never name a killing program at the start of a command. */
const KILL_ANYWHERE: [RegExp, string][] = [
  [/\b(get-process|gps)\b[^;\n]*\.kill\(/i, "Get-Process … .Kill()"],
  [/\b(get-ciminstance|gcim|get-wmiobject|gwmi)\b[^;\n]*win32_process[^;\n]*\bterminate\b/i, "Win32_Process … Terminate"],
];

const LISTS_PROCESSES = new Set(["pgrep", "pidof", "ps", "tasklist", "get-process", "gps"]);
const KILLS = new Set(["kill", "stop-process", "spps", "taskkill"]);

function killIn(text: string, flavour: ShellFlavour, depth: number): string | null {
  const lex = lexShell(text, flavour);
  if (lex.unsure) {
    const flat = text.replace(/["'`]/g, "");
    for (const [re, label] of [...KILL_BY_NAME, ...KILL_ANYWHERE]) if (re.test(text) || re.test(flat)) return label;
    return null;
  }
  for (const [re, label] of KILL_ANYWHERE) if (re.test(text)) return label;
  const programs = (c: ShellCommand) => commandStarts(c.words).map((s) => ({ name: programOf(c.words[s] ?? ""), args: c.words.slice(s + 1).map((a) => a.toLowerCase()) }));
  for (const c of lex.cmds) {
    for (const { name, args } of programs(c)) {
      if (name === "taskkill" && args.some((a) => /^[-/]{1,2}(im|fi)$/.test(a))) return "taskkill /IM";
      if (name === "pkill" || name === "killall") return "pkill / killall";
      if (name === "tskill" && args[0] && !/^\d+$/.test(args[0])) return "tskill <name>";
      if ((name === "fkill" || name === "fkill-cli") && args.some((a) => !a.startsWith("-") && !/^:?\d+$/.test(a))) return "fkill <name>";
      if (name === "wmic" && args.includes("process") && args.some((a) => a === "delete" || a === "terminate")) return "wmic process delete";
      if (name === "kill" || name === "stop-process" || name === "spps") {
        // PowerShell takes any unambiguous start of `-Name`; bash's `kill -n 9 1234` names a signal, not a process.
        const named = args.findIndex((a) => /^-(n|na|nam|name|processname)$/.test(a));
        if (named >= 0 && args[named + 1] && !/^\d+$/.test(args[named + 1])) return "Stop-Process -Name";
        if (name === "kill" && args.at(-1) === "-1" && args.every((a) => a.startsWith("-"))) return "kill -1";
      }
    }
    // Listing processes by name and killing what comes back is the same thing in two steps:
    // `Get-Process node | Stop-Process`, `kill $(pgrep node)`, `pgrep -f vite | xargs kill`.
    const lister = programs(c).find((p) => LISTS_PROCESSES.has(p.name));
    if (lister && lex.cmds.some((o) => o !== c && o.group === c.group && programs(o).some((p) => KILLS.has(p.name)))) {
      return lister.name === "get-process" || lister.name === "gps" || lister.name === "ps" ? "Get-Process | Stop-Process" : `${lister.name} … kill`;
    }
    if (depth < MAX_NESTING) {
      for (const s of innerScripts(c).scripts) {
        const hit = killIn(s.text, s.flavour, depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

export function killsByName(command: string): string | null {
  for (const flavour of FLAVOURS) {
    const hit = killIn(command, flavour, 0);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- reads

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
  const windows = isWindowsPath(cwd);
  for (const key of READ_PATH_KEYS[toolName] ?? []) {
    const raw = input[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    // A Glob pattern is only a path when it is absolute; `**/*.ts` is relative to the search root —
    // unless it climbs out of that root, which `../../**/*.env` does.
    if (key === "pattern" && !pathsFor(cwd).isAbsolute(raw) && !/^\/[a-zA-Z]\//.test(raw)) {
      if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return `Autonomous runs read only inside the task worktree (${cwd}); refused ${raw}.`;
      continue;
    }
    const p = normalizeShellPath(key === "pattern" ? raw.replace(/[*?[{].*$/, "") || raw : raw, windows);
    if (inside(cwd, p) || readRoots.some((root) => inside(root, p))) continue;
    return `Autonomous runs read only inside the task worktree (${cwd}); refused ${p}.`;
  }
  return null;
}

/**
 * MarkItDown's `convert_to_markdown(uri)` judged as the read it is (D316): a web page or inline data
 * like WebFetch, a `file:` URI like Read — inside the task's folders, or refused with Read's own words.
 * Its server reads anything your user can, so a file URI is the one thing that needs a rule.
 */
export function markitdownRead(input: Record<string, unknown>, cwd: string, readRoots: string[] = []): { ok: true; path?: string } | { ok: false; message: string } {
  const uri = typeof input.uri === "string" ? input.uri.trim() : "";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, message: `MarkItDown needs a URI (https:, file: or data:); got "${uri.slice(0, 80)}".` };
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:") return { ok: true };
  if (url.protocol !== "file:") return { ok: false, message: `MarkItDown in a task reads https:, file: and data: URIs only; refused ${url.protocol}.` };
  // file://server/share is another computer's folder: never one of the task's.
  if (url.hostname && url.hostname !== "localhost") return { ok: false, message: `Autonomous runs read only inside the task worktree (${cwd}); refused ${uri}.` };
  let path = decodeURIComponent(url.pathname);
  // file:///C:/x reads as /C:/x; a Windows path starts at the drive.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  const refused = readViolation("Read", { file_path: path }, cwd, readRoots);
  return refused ? { ok: false, message: refused } : { ok: true, path };
}

/**
 * Added to every autonomous refusal. The run it was written for tried four ways round the sandbox —
 * the main checkout's secrets twice, the environment, then a browser at the live site — instead of
 * saying it needed a supervised run (docs/DECISIONS.md D186). Saying so no longer ends the run: it is
 * a suggestion on the card, and the run does the rest (D382).
 */
export function escalationHint(refusals: number): string {
  const base =
    " If the task needs this, do not look for another way in: call `board_report_blocked` with needs \"supervised\" once, saying what access you need and why — " +
    "it puts a suggestion on the card and does not stop the run, and the person can switch the task to supervised later, where it runs in the main checkout with every write approved. " +
    "Then carry on with what can be done inside your folder, and list this step under `## Left for a supervised run`.";
  return refusals >= 3 ? `${base} This is refusal number ${refusals} in this stage: stop trying to reach it — a few more and the board stops this stage. Report it and carry on with the rest.` : base;
}

// ---------------------------------------------------------------- read-only commands (supervised)

/** Splits a command into tokens, honouring "double" and 'single' quotes. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
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

/**
 * True when every quote wraps a whole word. `cat .e''nv` is `cat .env` to the shell, but reads as
 * three harmless scraps to anything that looks at it piece by piece — so a quote glued into the middle
 * of a word means the word is not what it looks like.
 */
function quotesWrapWords(text: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c !== quote) continue;
      quote = null;
      if (i + 1 < text.length && !/[\s;|&)>,]/.test(text[i + 1])) return false;
    } else if (c === '"' || c === "'") {
      if (i > 0 && !/[\s=(;|&<>,:]/.test(text[i - 1])) return false;
      quote = c;
    }
  }
  return true;
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

/** Programs that show names and sizes, never what is in a file — so a wildcard cannot print a secret. */
const SHOWS_NAMES_ONLY = new Set([
  "ls", "dir", "find", "stat", "file", "du", "df", "basename", "dirname", "realpath", "readlink", "which", "where",
  "get-childitem", "gci", "get-item", "test-path", "resolve-path", "cd", "pushd", "popd", "pwd", "echo", "printf", "true",
]);
/** A wildcard ending in one of these can only match source or prose, never `.env` or a key file. */
const SOURCE_GLOB = /\.(?:md|mdx|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|css|scss|html|vue|svelte|sql|sh|ps1)$/i;

/**
 * A wildcard that could print a file nobody named. `cat .en*` shows `.env` without the word ever
 * appearing, so the credentials rule never sees it; `grep -n TODO docs/*.md` cannot.
 */
function hasOpenWildcard(tokens: string[]): boolean {
  const program = programOf(tokens[0] ?? "");
  if (SHOWS_NAMES_ONLY.has(program)) return false;
  const text = textArgs(tokens, "paths");
  return tokens.some((t, i) => i > 0 && !text.has(i) && /[*?[]/.test(t) && !SOURCE_GLOB.test(t));
}

/**
 * A command the board can read word for word: the text with harmless redirections to nowhere taken
 * out, or null when something in it could write a file or run a command the board cannot see.
 */
function plainShell(text: string): string | null {
  // Folded in from the public lineage's detector (D228): an escaped or unbalanced quote can make the
  // tokenizer misread where a command ends, and a script block or a lone `&` runs something else.
  if (/\\["']/.test(text)) return null;
  if ((text.match(/"/g) ?? []).length % 2 || (text.match(/'/g) ?? []).length % 2) return null;
  if (!quotesWrapWords(text)) return null;
  if (/[{}]|\$\{|(^|[^&>])&($|[^&>])/.test(text.replace(/"[^"]*"|'[^']*'/g, "Q"))) return null;
  const stripped = text.replace(/\d?>\s*(?:\/dev\/null|\$null|nul)\b/gi, "").replace(/2>&1/g, "");
  if (/[>`]|\$\(|<\(|<<|\bInvoke-Expression\b|\biex\b|\|\s*Out-File\b|\bSet-Content\b|\bAdd-Content\b/i.test(stripped)) return null;
  return stripped;
}

/**
 * True when a shell command can only read — so a supervised run may run it without a card (D202).
 * Deliberately narrow: no redirection into a file, no command substitution, no heredoc, no interpreter,
 * no variable (the board cannot see where `$X` points), no `..` or home folder, every program on the
 * list, every path inside the project, no wildcard that could match a file nobody named, and nothing
 * that touches a credentials file (those always get a card, see credentials.ts). When in doubt: false,
 * and a card.
 */
export function isReadOnlyShell(cmd: string, cwd: string): boolean {
  const text = cmd.trim();
  if (!text || credentialRisk("Bash", { command: text })) return false;
  const stripped = plainShell(text);
  if (stripped === null) return false;
  if (TRAVERSAL.test(text) || HOME_REF.test(text)) return false;
  // Single quotes keep a `$` literal in both shells (`sed -n '$p'`); anywhere else it is a variable.
  if (/\$[A-Za-z_]|%[A-Za-z_][\w()]{2,}%/.test(stripped.replace(/'[^']*'/g, "Q"))) return false;
  const windows = isWindowsPath(cwd);
  for (const p of absolutePaths(text)) if (!inside(cwd, normalizeShellPath(p, windows))) return false;
  for (const segment of shellSegments(stripped)) {
    const tokens = tokenize(segment).map((t) => t.replace(/^<+/, "")).filter(Boolean);
    if (!tokens.length) continue;
    const program = programOf(tokens[0]);
    if (/^\w+=/.test(tokens[0])) return false; // VAR=x cmd — could be anything
    if (cdViolation(tokens, cwd)) return false;
    if (outsidePath({ words: tokens, redirect: tokens.map(() => false), heredocs: [] }, cwd, true)) return false;
    if (hasOpenWildcard(tokens)) return false;
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
export function autonomousGate(toolName: string, input: Record<string, unknown>, cwd: string, readRoots: string[] = [], opts: { markitdown?: boolean; folder?: boolean } = {}): GateResult {
  if (!opts.folder) return worktreeGate(toolName, input, cwd, readRoots, opts);
  // In the project folder (D398): the same walls, worded for the folder, plus its .git and the board's
  // .kanban (other tasks' copies) are off limits, and git only looks.
  const decision = worktreeGate(toolName, input, cwd, readRoots, opts);
  if (decision.behavior === "deny") return { behavior: "deny", message: decision.message.replace(/the task worktree|the worktree/g, "the project folder") };
  const windows = isWindowsPath(cwd);
  const denied = [".git", ".kanban"].map((d) => pathsFor(cwd).join(cwd, d));
  for (const key of [...(READ_PATH_KEYS[toolName] ?? []), PATH_KEYS[toolName]]) {
    const raw = key ? input[key] : undefined;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const p = normalizeShellPath(key === "pattern" ? raw.replace(/[*?[{].*$/, "") || raw : raw, windows);
    const abs = pathsFor(cwd).isAbsolute(p) ? p : pathsFor(cwd).join(cwd, p);
    if (denied.some((d) => inside(d, abs))) {
      return { behavior: "deny", message: `Autonomous runs in the project folder stay out of .git and .kanban (your repository's history and other tasks' copies); refused ${raw}.` };
    }
  }
  if (SHELL_TOOLS.has(toolName)) {
    const why = shellViolation(String(input.command ?? ""), cwd, toolName === "PowerShell" ? "powershell" : "bash", true);
    if (why) return { behavior: "deny", message: `Refused because ${why}. Autonomous runs stay inside ${cwd}.`.replace(/the worktree/g, "the project folder") };
  }
  return decision;
}

function worktreeGate(toolName: string, input: Record<string, unknown>, cwd: string, readRoots: string[], opts: { markitdown?: boolean }): GateResult {
  if (opts.markitdown && toolName === MARKITDOWN_TOOL) {
    const read = markitdownRead(input, cwd, readRoots);
    return read.ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: read.message };
  }
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
    const why = shellViolation(String(input.command ?? ""), cwd, toolName === "PowerShell" ? "powershell" : "bash");
    if (why) {
      return { behavior: "deny", message: `Refused because ${why}. Autonomous runs stay inside ${cwd}; the board handles branches, merges and cleanup.` };
    }
  }
  return { behavior: "allow", updatedInput: input };
}

// ---------------------------------------------------------------- trusted commands (D353)

/** Programs that run the file they are given: the rule names the file, never the program alone. */
const SCRIPT_RUNNERS = new Set(["bash", "sh", "zsh", "python", "python3", "py", "node", "tsx", "deno", "bun", "pwsh", "powershell", "ruby", "php", "perl"]);
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn"]);

/**
 * What "Always allow" remembers for one simple command: the program and the script or subcommand it
 * names (`bash scripts/get.sh`, `git push`, `npm run test`), so different arguments still match. Null
 * when there is nothing lasting to name — `python -c "…"` runs whatever is written after it.
 */
function trustRuleOf(tokens: string[]): string | null {
  if (!tokens.length || /^\w+=/.test(tokens[0])) return null;
  const program = programOf(tokens[0]);
  const next = tokens[1];
  if (SCRIPT_RUNNERS.has(program)) return next && !next.startsWith("-") ? `${tokens[0]} ${next}` : null;
  // A script run by its own path is the whole rule.
  if (/[\\/]/.test(tokens[0]) || !next || !/^[a-z][\w:-]*$/i.test(next)) return tokens[0];
  if (PACKAGE_RUNNERS.has(program) && next === "run" && tokens[2]) return `${tokens[0]} run ${tokens[2]}`;
  return `${tokens[0]} ${next}`;
}

/** The simple commands of a shell command that are neither a `cd` inside the project nor read-only. */
function unreadSegments(stripped: string, cwd: string): string[][] {
  const out: string[][] = [];
  for (const segment of shellSegments(stripped)) {
    const tokens = tokenize(segment).filter(Boolean);
    if (!tokens.length) continue;
    if (CD_PROGRAMS.has(programOf(tokens[0])) && !cdViolation(tokens, cwd)) continue;
    if (isReadOnlyShell(segment, cwd)) continue;
    out.push(tokens);
  }
  return out;
}

const matchesRule = (tokens: string[], rule: string): boolean => {
  const line = tokens.join(" ");
  return line === rule || line.startsWith(`${rule} `);
};

/** Tools "Always allow" can cover: a command, or a connector's tool by name. Never a file edit. */
const trustable = (toolName: string) => SHELL_TOOLS.has(toolName) || toolName.startsWith("mcp__");

/**
 * The rules "Always allow" would add for this call, or null when it cannot be covered: a file edit,
 * something that shows a credentials file, or a command the board cannot read word for word.
 */
export function trustRules(toolName: string, input: Record<string, unknown>, cwd: string): string[] | null {
  if (!trustable(toolName)) return null;
  if (!SHELL_TOOLS.has(toolName)) return [toolName];
  const text = String(input.command ?? "").trim();
  if (!text || credentialRisk(toolName, { command: text })?.level === "prints") return null;
  const stripped = plainShell(text);
  if (stripped === null) return null;
  const rules = new Set<string>();
  for (const tokens of unreadSegments(stripped, cwd)) {
    const rule = trustRuleOf(tokens);
    if (!rule) return null;
    rules.add(rule);
  }
  return rules.size ? [...rules] : null;
}

/**
 * True when the project's trusted list covers this call: every part of the command is read-only, a
 * `cd` inside the project, or starts with a trusted rule. Showing a credentials file is never covered.
 */
export function isTrusted(toolName: string, input: Record<string, unknown>, cwd: string, rules: string[]): boolean {
  if (!rules.length || !trustable(toolName)) return false;
  if (!SHELL_TOOLS.has(toolName)) return rules.includes(toolName);
  const text = String(input.command ?? "").trim();
  if (!text || credentialRisk(toolName, { command: text })?.level === "prints") return false;
  const stripped = plainShell(text);
  if (stripped === null) return false;
  const rest = unreadSegments(stripped, cwd);
  return rest.length > 0 && rest.every((tokens) => rules.some((rule) => matchesRule(tokens, rule)));
}

// ---------------------------------------------------------------- a lookup with nobody asked (D352)

/**
 * Gate for an autonomous lookup where the project gives it full access: it works in the project's own
 * folder and reaches what the project reaches, and nothing waits on a card. What is left are the two
 * things no setting allows: a lookup changing a file, and credentials landing in the transcript.
 */
export function handsOffGate(toolName: string, input: Record<string, unknown>): GateResult {
  if (toolName === "AskUserQuestion") {
    return { behavior: "deny", message: "No one is watching this run. Make a reasonable choice, say so in your answer, and continue." };
  }
  if (PATH_KEYS[toolName]) {
    return {
      behavior: "deny",
      message: "A lookup changes nothing, so it does not write or edit files. Work it out with a command instead of saving a script; if the answer truly needs a file changed, say which and why in your reply.",
    };
  }
  const risk = credentialRisk(toolName, input);
  if (risk?.level === "prints") {
    return {
      behavior: "deny",
      message: `Refused: that would put what is in ${risk.files.slice(0, 3).join(", ")} (passwords or keys) into the transcript, which the board keeps. Let a script load the file instead of showing it.`,
    };
  }
  return { behavior: "allow", updatedInput: input };
}
