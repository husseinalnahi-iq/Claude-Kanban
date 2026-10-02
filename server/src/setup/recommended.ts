import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { scanSkills } from "../skills.ts";
import { MARKITDOWN_SERVER } from "../types.ts";
import type { FixCommand, SetupCheck } from "./checks.ts";
import { bundledClaude, type Probe } from "./probe.ts";

const MIN = 60_000;

/** A skill copied into ~/.claude/skills by `npx skills add`, or a Claude Code plugin from its marketplace. */
type Install = { kind: "skill"; source: string } | { kind: "plugin"; marketplace: string; plugin: string };

/** What the Skills page offers to install, each with the people who made it and where it comes from. */
interface SkillPick {
  /** The skill's own name (its SKILL.md `name`): the folder it lands in, or the part after `plugin:`. */
  skill: string;
  title: string;
  why: string;
  install: Install;
  link: string;
}

const SKILLS: SkillPick[] = [
  {
    skill: "frontend-design",
    title: "Frontend Design — Anthropic's official skill",
    why: "Anthropic's own guidance for building screens with a clear look of their own: a deliberate style, type that suits it, and choices that don't read as a template.",
    install: { kind: "skill", source: "anthropics/skills" },
    link: "https://github.com/anthropics/skills/tree/main/skills/frontend-design",
  },
  {
    skill: "emil-design-eng",
    title: "Emil Kowalski — design engineering",
    why: "Interfaces that feel finished: when to animate and how fast, easing that feels natural, buttons that respond to a press, menus that open from where you clicked. From the maker of Sonner and Vaul.",
    install: { kind: "skill", source: "emilkowalski/skills" },
    link: "https://github.com/emilkowalski/skills",
  },
  {
    skill: "design-taste-frontend",
    title: "Taste — pages that don't look generic",
    why: "Stops the look every AI-made page shares: plain layouts, default fonts, no motion. Claude settles how bold, how lively and how dense the page should be before it builds it.",
    install: { kind: "skill", source: "Leonxlnx/taste-skill" },
    link: "https://github.com/Leonxlnx/taste-skill",
  },
  {
    skill: "ui-ux-pro-max",
    title: "UI/UX Pro Max — a design library to search",
    why: "Claude looks up styles, colour palettes, font pairings, chart types and the rules for your framework before it designs, instead of guessing. Comes as a plugin of 7 design skills (brand, slides, banners and more). Needs Python 3.",
    // A plugin, as its authors ship it: its skill runs its search script from ${CLAUDE_PLUGIN_ROOT},
    // which only a plugin has. Copied in as a plain skill, that path points nowhere.
    install: { kind: "plugin", marketplace: "nextlevelbuilder/ui-ux-pro-max-skill", plugin: "ui-ux-pro-max@ui-ux-pro-max-skill" },
    link: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
  },
];

/**
 * `npx skills add` (vercel-labs/skills) for this user and Claude Code only. `--copy` puts real files in
 * ~/.claude/skills: a link into ~/.agents is not a folder to the scanner, and Windows may refuse to make one.
 */
export const skillInstallArgs = (p: { source: string; skill: string }) =>
  ["-y", "skills@latest", "add", p.source, "-g", "-a", "claude-code", "-s", p.skill, "-y", "--copy"];

/** Both are safe to repeat (checked with Claude Code 2.1.285), and installing again turns a plugin you switched off back on. */
export const pluginInstallArgs = (p: { marketplace: string; plugin: string }) => [
  ["plugin", "marketplace", "add", p.marketplace],
  ["plugin", "install", p.plugin],
];

function commands(p: SkillPick): FixCommand[] {
  if (p.install.kind === "skill") return [{ command: "npx", args: skillInstallArgs({ source: p.install.source, skill: p.skill }), timeoutMs: 5 * MIN }];
  // The board's own Claude binary writes the same ~/.claude the Claude Code you run reads.
  const claude = bundledClaude() ?? "claude";
  return pluginInstallArgs(p.install).map((args) => ({ command: claude, args, timeoutMs: 5 * MIN }));
}

/** The command lines to copy, with `claude` as you would type it. */
function manual(p: SkillPick): string {
  if (p.install.kind === "skill") return `npx ${skillInstallArgs({ source: p.install.source, skill: p.skill }).join(" ")}`;
  return pluginInstallArgs(p.install).map((a) => `claude ${a.join(" ")}`).join("\n");
}

function goal(p: SkillPick): { goal: string; doneWhen: string } {
  if (p.install.kind === "skill") {
    return {
      goal: `Install the "${p.skill}" skill from github.com/${p.install.source} for Claude Code, for this user, so it is at ~/.claude/skills/${p.skill}/SKILL.md. Install only that one skill from the repository.`,
      doneWhen: `~/.claude/skills/${p.skill}/SKILL.md exists and starts with "name: ${p.skill}" in its frontmatter`,
    };
  }
  return {
    goal: `Install the Claude Code plugin ${p.install.plugin} for this user: add the plugin marketplace ${p.install.marketplace} (github.com/${p.install.marketplace}), then install the plugin from it, at user scope.`,
    doneWhen: `\`claude plugin list\` shows ${p.install.plugin} as enabled`,
  };
}

function skillCheck(p: SkillPick, home: () => string): SetupCheck {
  const how = manual(p);
  return {
    id: `skill:${p.skill}`,
    title: p.title,
    level: "optional",
    why: p.why,
    run: () => commands(p),
    claude: goal(p),
    manual: { win32: how, darwin: how, linux: how },
    link: { label: "See it on GitHub", href: p.link },
    async detect() {
      // By name, wherever it is: installed by hand into another folder, or as part of a plugin, it counts.
      const found = scanSkills({ home: home() }).filter((s) => s.name === p.skill || s.name.endsWith(`:${p.skill}`));
      const on = found.find((s) => s.pluginEnabled);
      if (on) return { ok: true, detail: on.source === "plugin" ? `Installed with the ${on.plugin} plugin` : "Installed", offerFixes: false };
      if (found.length) return { ok: false, warn: true, detail: `Its ${found[0].plugin} plugin is switched off in Claude Code. Install turns it back on.` };
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
      const platform = process.platform;
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
  return [...SKILLS.map((p) => skillCheck(p, home)), markitdownCheck(home)];
}
