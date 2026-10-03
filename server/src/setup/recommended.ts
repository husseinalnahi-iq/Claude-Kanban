import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { scanSkills } from "../skills.ts";
import { CATALOG, checkOf, linkOf, pluginKey, skillDir, type CatalogPlugin, type CatalogSkill } from "../skills/catalog.ts";
import { entryStatus } from "../skills/install.ts";
import { MARKITDOWN_SERVER } from "../types.ts";
import type { SetupCheck } from "./checks.ts";
import { bundledClaude, type Probe } from "./probe.ts";

const MIN = 60_000;

/**
 * "Install with Claude" for a skill or plugin of the Skills tab's Recommended list (D321): a supervised
 * session that installs the very version the board's own Install would. The one-click Install is the
 * board's (`skills/install.ts`): a skill copied from its pinned commit with the board's marker.
 */
function goal(e: CatalogSkill | CatalogPlugin): { goal: string; doneWhen: string } {
  if (e.kind === "skill") {
    const dest = `~/.claude/skills/${skillDir(e)}`;
    const tool = e.npmTool ? ` First install its command with \`npm install -g ${e.npmTool}\`.` : "";
    return {
      goal: `Install one skill for Claude Code, for this user: copy the folder \`${e.path}\` of github.com/${e.repo}, at commit ${e.commit}, to ${dest}/. Copy only that folder, nothing else from the repository, and not from a newer commit.${tool}`,
      doneWhen: `${dest}/SKILL.md exists`,
    };
  }
  return {
    goal: `Install the Claude Code plugin ${pluginKey(e)} for this user: add the plugin marketplace ${e.marketplaceRepo} (github.com/${e.marketplaceRepo}), then install the plugin from it, at user scope (\`--scope user\`).`,
    doneWhen: `\`claude plugin list\` shows ${pluginKey(e)} as enabled`,
  };
}

/** The command lines to copy, with `claude` as you would type it. */
function manual(e: CatalogSkill | CatalogPlugin): string {
  if (e.kind === "plugin") return `claude plugin marketplace add ${e.marketplaceRepo} --scope user\nclaude plugin install ${pluginKey(e)} --scope user`;
  return [
    ...(e.npmTool ? [`npm install -g ${e.npmTool}`] : []),
    `git clone --filter=blob:none --sparse https://github.com/${e.repo}.git skill-src`,
    `git -C skill-src sparse-checkout set ${e.path}`,
    `git -C skill-src checkout ${e.commit}`,
    `copy the folder skill-src/${e.path} to ~/.claude/skills/${skillDir(e)}`,
  ].join("\n");
}

function catalogCheck(e: CatalogSkill | CatalogPlugin, home: () => string): SetupCheck {
  const how = manual(e);
  return {
    id: checkOf(e),
    title: e.name,
    level: "optional",
    why: e.what,
    claude: goal(e),
    manual: { win32: how, darwin: how, linux: how },
    link: { label: "See it on GitHub", href: linkOf(e) },
    async detect() {
      const status = entryStatus(e, home());
      if (e.kind === "plugin") {
        // Installed but switched off in Claude Code: runs do not get it, so it does not count.
        const found = scanSkills({ home: home() }).filter((s) => s.plugin === e.plugin);
        if (status === "installed" && found.length && !found.some((s) => s.pluginEnabled)) {
          return { ok: false, warn: true, detail: `Its ${e.plugin} plugin is switched off in Claude Code.` };
        }
      }
      if (status === "installed") return { ok: true, detail: "Installed", offerFixes: false };
      if (status === "installed-elsewhere") return { ok: true, detail: "Already on this computer", offerFixes: false };
      return { ok: false, detail: "Not installed" };
    },
  };
}

// ---------------------------------------------------------------- MarkItDown

/**
 * MarkItDown's own Python environment: in your home rather than the board's state folder, because your
 * Claude Code keeps pointing at it whichever board started it. Its own, so pip never meets a Python
 * that refuses outside packages (Homebrew, Debian) or upsets anything else you installed.
 */
const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
export const markitdownDir = (home: string, platform: NodeJS.Platform) => pathFor(platform).join(home, ".claude-kanban", "tools", "markitdown");
export const venvPython = (dir: string, platform: NodeJS.Platform) =>
  platform === "win32" ? win32.join(dir, "Scripts", "python.exe") : posix.join(dir, "bin", "python");

/** Where to look for Python, most likely first. `py` is the launcher every python.org install on Windows has. */
const PYTHONS: Record<"win32" | "other", [string, string[]][]> = {
  win32: [["py", ["-3"]], ["python", []], ["python3", []]],
  other: [["python3", []], ["python", []]],
};
const ASK_PYTHON = ["-c", "import sys; print(sys.executable); print('%d.%d' % sys.version_info[:2])"];

/** markitdown-mcp needs 3.10 or newer, and markitdown itself is not built for 3.15 yet (checked 2026-10-02). */
const pythonFits = (v: string) => {
  const [major, minor] = v.split(".").map(Number);
  return major === 3 && minor >= 10 && minor <= 14;
};

async function findPython(probe: Probe): Promise<{ path: string; version: string } | { path: null; seen: string[] }> {
  const seen: string[] = [];
  for (const [command, pre] of PYTHONS[probe.platform === "win32" ? "win32" : "other"]) {
    const r = await probe.run(command, [...pre, ...ASK_PYTHON], { timeoutMs: 15_000 });
    const [path, version] = r.stdout.trim().split(/\r?\n/);
    if (r.code !== 0 || !path || !version) continue;
    if (pythonFits(version)) return { path, version };
    seen.push(version);
  }
  return { path: null, seen };
}

function markitdownCheck(home: () => string): SetupCheck {
  // What the last look found, for the one-click fix that follows it.
  let python: string | null = null;
  let registered = false;
  // The machine the last look ran on: the fix builds its paths for that one, not for whichever runs this code.
  let platform: NodeJS.Platform = process.platform;
  const claude = () => bundledClaude() ?? "claude";
  const manualFor = (platform: NodeJS.Platform) => {
    const dir = markitdownDir(home(), platform);
    const py = venvPython(dir, platform);
    return [
      `${platform === "win32" ? "py -3" : "python3"} -m venv "${dir}"`,
      `"${py}" -m pip install --upgrade markitdown-mcp`,
      `claude mcp add -s user ${MARKITDOWN_SERVER} -- "${py}" -m markitdown_mcp`,
    ].join("\n");
  };
  return {
    id: "tool:markitdown",
    title: "MarkItDown — read PDFs, Word and Excel (Microsoft)",
    level: "optional",
    why: "A tool rather than a skill: Claude turns PDFs, Word, Excel and PowerPoint files and web pages into text it can read. Added to your Claude Code in a Python environment of its own, so it works in your terminal and in board tasks. Needs Python 3.10 or newer.",
    run: () => {
      const dir = markitdownDir(home(), platform);
      const py = venvPython(dir, platform);
      return [
        // Making it again over an existing one is harmless, and repairs one whose Python moved.
        { command: python ?? (platform === "win32" ? "py" : "python3"), args: ["-m", "venv", dir], timeoutMs: 3 * MIN },
        { command: py, args: ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "markitdown-mcp"], timeoutMs: 15 * MIN },
        // `claude mcp add` refuses a name that is taken, and `remove` fails on one that is not.
        ...(registered ? [{ command: claude(), args: ["mcp", "remove", "-s", "user", MARKITDOWN_SERVER], timeoutMs: MIN }] : []),
        { command: claude(), args: ["mcp", "add", "-s", "user", MARKITDOWN_SERVER, "--", py, "-m", "markitdown_mcp"], timeoutMs: MIN },
      ];
    },
    claude: {
      goal: `Set up Microsoft's MarkItDown MCP server (the markitdown-mcp Python package, github.com/microsoft/markitdown) for this user's Claude Code: install it into its own Python virtual environment at ${markitdownDir(home(), process.platform)}, then add it at user scope under the name "${MARKITDOWN_SERVER}", running that environment's Python with \`-m markitdown_mcp\`. It needs Python 3.10 to 3.14.`,
      doneWhen: `\`claude mcp get ${MARKITDOWN_SERVER}\` reports it as connected`,
    },
    manual: { win32: manualFor("win32"), darwin: manualFor("darwin"), linux: manualFor("linux") },
    link: { label: "See it on GitHub", href: "https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp" },
    async detect({ probe }) {
      platform = probe.platform;
      const r = await probe.run(probe.claudeBin, ["mcp", "get", MARKITDOWN_SERVER], { timeoutMs: 60_000 });
      registered = r.code === 0 && !/No MCP server/i.test(r.stdout);
      // `mcp get` starts the server to say whether it answers: "Status: √ Connected" or "✗ Failed to connect".
      const status = /Status:\s*(.*)/.exec(r.stdout)?.[1]?.trim() ?? "";
      if (registered && /connected/i.test(status) && !/fail|not|error/i.test(status)) {
        return { ok: true, detail: "Added to your Claude Code", offerFixes: false };
      }
      const found = await findPython(probe);
      python = found.path;
      if (found.path === null) {
        const other = found.seen.length ? ` (found Python ${found.seen.join(", ")})` : "";
        return { ok: false, detail: `Needs Python 3.10 to 3.14, not found on this computer${other}. Install it from python.org, then press Check again.`, offerFixes: false };
      }
      if (registered) return { ok: false, warn: true, detail: `In your Claude Code, but it does not start (${status || "no answer"}). Install sets it up again.` };
      return { ok: false, detail: `Not added yet — will use Python ${found.version}` };
    },
  };
}

/** The recommended skills and tools, in the order the Skills page shows them. `home` is for tests. */
export function recommendedChecks(home: () => string = homedir): SetupCheck[] {
  const tools: Record<string, (home: () => string) => SetupCheck> = { "tool:markitdown": markitdownCheck };
  return CATALOG.map((e) => {
    if (e.kind !== "tool") return catalogCheck(e, home);
    const make = tools[e.check];
    if (!make) throw new Error(`The catalog names a tool with no Setup check: ${e.check}`);
    return make(home);
  });
}
