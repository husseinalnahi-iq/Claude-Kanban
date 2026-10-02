import { z } from "zod";
import type { ClaudeModelsResult, CliPreset, Provider, ProviderOut, SetupCheckResult, Settings } from "../types.ts";
import { badClaudePicks } from "../engine/claudeModels.ts";
import { bundledClaude, pickBrowser, sdkVersion, type Probe } from "./probe.ts";
import { ENGINE_LATEST_URL, ENGINE_PACKAGE, shouldInstall } from "./engine.ts";
import { readFileSync } from "node:fs";
import { isLmStudio, isLocal, isOllama } from "../engine/providers/catalog.ts";
import { codexStatus } from "../engine/providers/codexLocal.ts";
import { codexPlanProvider } from "../engine/codexLink.ts";
import { codexImagePart } from "../engine/codexImages.ts";
import type { SecretStore } from "../secrets.ts";
import { hardware, lmsPath, PICKS, SETUP_PICKS, verdictFor, verdictText, type Pick } from "./local.ts";
import { join } from "node:path";
import { loadPty, pwshPath } from "../terminal.ts";
import { CLOUDFLARE_TOKEN_REF, POLLINATIONS_KEY_REF, claudeCodeArgs, claudeCodeCommand, imageReadiness } from "../engine/images.ts";
import { IMAGE_SERVER } from "../types.ts";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../skills/catalog.ts";
import { entryStatus } from "../skills/install.ts";

/** The Claude Kanban folder (package.json with both workspaces). */
const BOARD_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/** The engine version this board was tested on (server/package.json): updates stay within its minor. */
const ENGINE_FLOOR: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(BOARD_DIR, "server", "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies[ENGINE_PACKAGE];
  } catch {
    return "";
  }
})();

export interface CheckCtx {
  probe: Probe;
  settings: Settings;
  hasSecret: (name: string) => boolean;
  /** The Claude models your login can use (free to read); absent in tests that do not need it. */
  claudeModels?: () => Promise<ClaudeModelsResult>;
  /** Delegated providers that ran out. */
  providerOuts?: () => ProviderOut[];
  /** Where ~/.claude is; tests point it at a temp folder. */
  home?: string;
  /** Suggested skills being installed or removed right now (the Skills tab's queue). */
  skillsBusy?: () => string[];
}

export interface Detected {
  ok: boolean;
  detail: string;
  /** Can't be fixed until this other check passes (identity needs git; models need Ollama). */
  blockedBy?: string;
  /** Works, but not the way you probably mean it: shown amber (Codex signed in with an API key, D296). */
  warn?: boolean;
  /** The one thing to press now, by the board's own endpoint — offered even when the row passes. */
  action?: { label: string; endpoint: string };
  /** false: the install and "Fix with Claude" buttons do not fit this state (it is installed). */
  offerFixes?: boolean;
}

/** A built-in command. The only user values that reach one are validated form fields. */
export interface FixCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
  /** Where to run it; the board's own folder for its own parts. */
  cwd?: string;
}

export interface FormField {
  name: string;
  label: string;
  placeholder: string;
  schema: z.ZodType<string>;
}

export interface SetupCheck {
  id: string;
  title: string;
  level: SetupCheckResult["level"];
  why: string;
  detect(ctx: CheckCtx): Promise<Detected>;
  /** One click: the board runs these itself. */
  run?: (input: Record<string, string>) => FixCommand[];
  /** The one-click button's word, when "Install" is not it ("Turn on", "Download"). */
  runLabel?: string;
  form?: FormField[];
  /** For a supervised Claude session; checks with only `run` get a generic goal as a fallback. */
  claude?: { goal: string; doneWhen: string };
  /** Claude's own login terminal. */
  login?: true;
  link?: { label: string; href: string };
  manual?: Partial<Record<NodeJS.Platform, string>>;
}

const MIN = 60_000;
const ok = (detail: string): Detected => ({ ok: true, detail });
const bad = (detail: string, blockedBy?: string): Detected => (blockedBy ? { ok: false, detail, blockedBy } : { ok: false, detail });
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";
const everywhere = (cmd: string) => ({ win32: cmd, darwin: cmd, linux: cmd });

async function gitVersion(p: Probe): Promise<string | null> {
  const r = await p.run("git", ["--version"]);
  return r.code === 0 ? firstLine(r.stdout) : null;
}

const node: SetupCheck = {
  id: "node",
  title: "Node.js 24 or newer",
  level: "required",
  why: "The board itself runs on it.",
  async detect() {
    const major = Number(process.versions.node.split(".")[0]);
    return major >= 24 ? ok(`v${process.versions.node}`) : bad(`v${process.versions.node} — the board needs 24 or newer`);
  },
};

const claudeLogin: SetupCheck = {
  id: "claude-login",
  title: "Claude login",
  level: "required",
  why: "Every run uses your Claude subscription (or an API key).",
  login: true,
  async detect({ probe }) {
    if (probe.env.ANTHROPIC_API_KEY) return ok("Using ANTHROPIC_API_KEY");
    const r = await probe.run(probe.claudeBin, ["auth", "status"], { timeoutMs: 15_000 });
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (!j.loggedIn) return bad("Not logged in");
      return ok(`Logged in with ${j.authMethod ?? "Claude"}${j.subscriptionType ? ` (${j.subscriptionType})` : ""}`);
    } catch {
      return bad(firstLine(r.stderr) || "Claude's login check did not answer");
    }
  },
};

const git: SetupCheck = {
  id: "git",
  title: "git",
  level: "required",
  why: "Autonomous runs work in git worktrees, and every change is reviewed as a diff.",
  claude: { goal: "Install git on this computer.", doneWhen: "git --version" },
  manual: { win32: "winget install --id Git.Git -e", darwin: "xcode-select --install", linux: "sudo apt install git" },
  async detect({ probe }) {
    const v = await gitVersion(probe);
    return v ? ok(v) : bad("git is not installed, or not on PATH");
  },
};

const gitIdentity: SetupCheck = {
  id: "git-identity",
  title: "git name and email",
  level: "required",
  why: "Approving a task makes a commit, and git refuses to commit without them.",
  form: [
    { name: "name", label: "Name", placeholder: "Ada Lovelace", schema: z.string().trim().min(1).max(100).regex(/^[^\r\n"]+$/, "No quotes or line breaks") },
    { name: "email", label: "Email", placeholder: "ada@example.com", schema: z.string().trim().max(200).regex(/^[^\s@"]+@[^\s@"]+$/, "Not an email address") },
  ],
  run: (input) => [
    { command: "git", args: ["config", "--global", "user.name", input.name] },
    { command: "git", args: ["config", "--global", "user.email", input.email] },
  ],
  manual: everywhere('git config --global user.name "Your Name"\ngit config --global user.email you@example.com'),
  async detect({ probe }) {
    if (!(await gitVersion(probe))) return bad("Install git first", "git");
    const name = firstLine((await probe.run("git", ["config", "--global", "user.name"])).stdout);
    const email = firstLine((await probe.run("git", ["config", "--global", "user.email"])).stdout);
    if (name && email) return ok(`${name} <${email}>`);
    return bad(`Missing ${[!name && "name", !email && "email"].filter(Boolean).join(" and ")}`);
  },
};

const BROWSER_LABEL = { chrome: "Chrome", msedge: "Edge", chromium: "Playwright Chromium" } as const;
const INSTALL_BROWSER = ["-y", "@playwright/mcp@latest", "install-browser", "chromium"];

const browser: SetupCheck = {
  id: "browser",
  title: "A browser for browser checks",
  level: "recommended",
  why: "Runs open what they built in a headless browser to look at it. Without one they skip that step.",
  // Playwright's own download, matched to the version the board's browser server uses.
  run: () => [{ command: "npx", args: INSTALL_BROWSER, timeoutMs: 10 * MIN }],
  manual: everywhere(`npx ${INSTALL_BROWSER.join(" ")}`),
  async detect({ probe }) {
    const b = pickBrowser(probe);
    return b ? ok(`${BROWSER_LABEL[b.browser]} — ${b.path}`) : bad("No Chrome, Edge or Playwright Chromium found");
  },
};

const MODEL_ID = /^[\w.:/-]{1,100}$/;

/** `lms` is rarely on PATH: the one-click fixes call it by its full path. */
const lmsHere = () => lmsPath({ env: process.env, platform: process.platform } as Probe);

/** Is LM Studio on this computer? Its command-line tool appears after the first launch; the app folder before. */
const lmStudioInstalled = (probe: Probe) =>
  probe.exists(lmsPath(probe)) ||
  (probe.platform === "win32" && probe.exists(join(probe.env.LOCALAPPDATA ?? "", "Programs", "LM Studio"))) ||
  (probe.platform === "darwin" && probe.exists("/Applications/LM Studio.app"));

/**
 * LM Studio is offered to everyone, as optional: free AI on this computer. Three steps, each its own
 * row so each has its own one-click fix: the app (installed by hand), its server, and a model or two.
 */
const lmStudioApp: SetupCheck = {
  id: "lmstudio",
  title: "LM Studio — free AI on this computer",
  level: "optional",
  why: "Runs AI models on your own computer: free, and nothing leaves it. Less capable than Claude — good for small tasks and reviews. The board works without it.",
  claude: { goal: "Install LM Studio (the desktop app from lmstudio.ai) on this computer, then open it once so it sets up its `lms` command.", doneWhen: "the file ~/.lmstudio/bin/lms (lms.exe on Windows) exists" },
  manual: { win32: "winget install --id ElementLabs.LMStudio -e", darwin: "brew install --cask lm-studio", linux: "Download the AppImage from https://lmstudio.ai/download" },
  link: { label: "Download LM Studio", href: "https://lmstudio.ai/download" },
  async detect({ probe }) {
    if (!lmStudioInstalled(probe)) return bad("Not installed (optional)");
    return probe.exists(lmsPath(probe)) ? ok("Installed") : bad("Installed — open it once so it finishes setting up");
  },
};

const lmStudioServer = (origin: string, onBoard: boolean): SetupCheck => ({
  id: "lmstudio-server",
  title: "LM Studio's server",
  level: "optional",
  why: "The board talks to LM Studio through its local server. “Turn on” starts it; in the app it is Settings → Local Model API.",
  run: () => [{ command: lmsHere(), args: ["server", "start"], timeoutMs: 2 * MIN }],
  runLabel: "Turn on",
  link: { label: "Step-by-step guide", href: "#/settings?tab=providers" },
  async detect({ probe }) {
    if (!lmStudioInstalled(probe) || !probe.exists(lmsPath(probe))) return bad("Install LM Studio first", "lmstudio");
    const board = onBoard ? "" : " · add it to the board in Settings → Providers";
    try {
      const j = (await probe.fetchJson(`${origin}/api/v1/models`)) as { models?: { type?: string; loaded_instances?: unknown[] }[] };
      const llms = (j.models ?? []).filter((m) => m.type !== "embedding");
      const loaded = llms.filter((m) => m.loaded_instances?.length).length;
      return ok(`On at ${origin} · ${llms.length} model${llms.length === 1 ? "" : "s"} downloaded, ${loaded} loaded${board}`);
    } catch (err) {
      if (/HTTP 40[13]/.test(err instanceof Error ? err.message : "")) return ok(`On at ${origin} (asks for a token)${board}`);
      return bad("Off");
    }
  },
});

const lmStudioModel = (pick: Omit<Pick, "verdict">, title: string): SetupCheck => ({
  id: `lmstudio-model:${pick.key}`,
  title,
  level: "optional",
  why: `${pick.note[0].toUpperCase()}${pick.note.slice(1)}. A one-time ${pick.sizeGB} GB download into LM Studio.`,
  run: () => [{ command: lmsHere(), args: ["get", pick.key!, "--yes"], timeoutMs: 120 * MIN }],
  runLabel: "Download",
  async detect({ probe }) {
    if (!lmStudioInstalled(probe) || !probe.exists(lmsPath(probe))) return bad("Install LM Studio first", "lmstudio");
    const r = await probe.run(lmsPath(probe), ["ls", "--json"], { timeoutMs: 20_000 });
    let keys: string[] = [];
    try {
      keys = (JSON.parse(r.stdout) as { modelKey?: string }[]).map((m) => m.modelKey ?? "");
    } catch {
      // an older lms without --json: treat as not downloaded
    }
    // The QAT and plain builds are the same model for this purpose.
    const base = pick.key!.replace(/-qat$/, "");
    if (keys.some((k) => k === pick.key || k === base)) return ok("Downloaded");
    const hw = await hardware(probe);
    const v = verdictFor(pick.sizeGB, pick.moe, hw);
    const detail = `Not downloaded · ${pick.sizeGB} GB · ${verdictText(v, hw)}`;
    // Too big: no Download button, just the reason.
    return v === "too-big" ? bad(detail, "hardware") : bad(detail);
  },
});

const ollama = (origin: string): SetupCheck => ({
  id: "ollama",
  title: "Ollama",
  level: "optional",
  why: "An Ollama provider is set up in Settings → Providers; it needs Ollama running on this computer.",
  claude: { goal: "Install Ollama on this computer and start it.", doneWhen: `a request to ${origin}/api/version answers` },
  manual: { win32: "winget install --id Ollama.Ollama -e", darwin: "brew install ollama && ollama serve", linux: "curl -fsSL https://ollama.com/install.sh | sh" },
  link: { label: "Open the step-by-step guide", href: "#/settings?tab=providers" },
  async detect({ probe }) {
    try {
      const j = (await probe.fetchJson(`${origin}/api/version`)) as { version?: string };
      return ok(`Ollama ${j.version ?? ""} at ${origin}`.replace("  ", " "));
    } catch {
      return bad(`Nothing answers at ${origin}. Install Ollama, or start it.`);
    }
  },
});

const ollamaModel = (origin: string, model: string): SetupCheck => ({
  id: `ollama-model:${model}`,
  title: `Ollama model ${model}`,
  level: "optional",
  why: "A provider in Settings → Providers lists this model.",
  run: () => [{ command: "ollama", args: ["pull", model], timeoutMs: 60 * MIN }],
  manual: everywhere(`ollama pull ${model}`),
  async detect({ probe }) {
    let tags: { models?: { name: string }[] };
    try {
      tags = (await probe.fetchJson(`${origin}/api/tags`)) as typeof tags;
    } catch {
      return bad("Start Ollama first", "ollama");
    }
    const names = (tags.models ?? []).map((m) => m.name);
    return names.some((n) => n === model || n === `${model}:latest`) ? ok("Pulled") : bad("Not pulled yet");
  },
});

/** The agent CLIs the board can drive, and how each is installed. */
const CLI: Record<Exclude<CliPreset, "custom">, { command: string; pkg?: string; login?: string; url: string }> = {
  codex: { command: "codex", pkg: "@openai/codex", login: "codex login", url: "https://github.com/openai/codex" },
  gemini: { command: "gemini", pkg: "@google/gemini-cli", login: "gemini", url: "https://github.com/google-gemini/gemini-cli" },
  kimi: { command: "kimi", login: "kimi login", url: "https://code.kimi.com" },
  opencode: { command: "opencode", url: "https://opencode.ai" },
};

const cliCheck = (p: Provider, preset: Exclude<CliPreset, "custom">): SetupCheck => {
  const c = CLI[preset];
  return {
    id: `cli-${preset}`,
    title: p.label,
    level: "optional",
    why: `Provider “${p.label}” runs the “${c.command}” command.`,
    ...(c.pkg ? { run: () => [{ command: "npm", args: ["install", "-g", c.pkg!], timeoutMs: 10 * MIN }] } : {}),
    claude: { goal: `Install the \`${c.command}\` command-line tool on this computer, following ${c.url}.`, doneWhen: `${c.command} --version` },
    manual: everywhere([c.pkg ? `npm install -g ${c.pkg}` : `See ${c.url}`, c.login ? `${c.login}   # then log in once` : ""].filter(Boolean).join("\n")),
    link: { label: c.url.replace(/^https:\/\//, ""), href: c.url },
    async detect({ probe }) {
      const r = await probe.run(c.command, ["--version"], { timeoutMs: 10_000 });
      return r.code === 0 ? ok(firstLine(r.stdout) || "Installed") : bad(`“${c.command}” is not installed, or not on PATH`);
    },
  };
};

/**
 * Codex, offered whether or not it is on the board (D296), one state at a time: install it; sign in; an
 * amber warning when it is signed in with an API key (the "ChatGPT subscription" entry would bill the
 * API account); one click to put it on the board; or done.
 */
const codexCheck = (settings: Settings): SetupCheck => ({
  id: "codex",
  title: "Codex on your ChatGPT plan",
  level: "optional",
  why: "OpenAI's Codex can run task stages, argue with plans and make pictures on the ChatGPT plan you already pay for: no API key and no per-token bill.",
  run: () => [{ command: "npm", args: ["install", "-g", "@openai/codex"], timeoutMs: 10 * MIN }],
  claude: { goal: "Install OpenAI's `codex` command-line tool on this computer, following https://github.com/openai/codex.", doneWhen: "codex --version" },
  manual: everywhere("npm install -g @openai/codex\ncodex login   # choose “Sign in with ChatGPT”"),
  link: { label: "github.com/openai/codex", href: "https://github.com/openai/codex" },
  async detect({ hasSecret }) {
    const st = await codexStatus(true);
    if (!st.found) return bad("Not on this computer: install the CLI here, or the Codex app");
    const v = st.version ?? "Codex";
    if (!st.signedIn) return { ok: false, detail: `${v} · not signed in`, offerFixes: false, action: { label: "Sign in", endpoint: "/codex/login" } };
    if (st.signedIn === "api-key") {
      return { ok: false, warn: true, offerFixes: false, detail: `${v} · signed in with an API key, so the “ChatGPT subscription” option would bill your API account`, action: { label: "Sign in with ChatGPT", endpoint: "/codex/login" } };
    }
    return codexPlanProvider(settings, hasSecret)?.enabled
      ? ok(`${v} · ChatGPT · on the board`)
      : { ok: false, offerFixes: false, detail: `${v} · signed in with ChatGPT · not on the board yet`, action: { label: "Use it", endpoint: "/codex/link" } };
  },
});

const keyCheck = (p: Provider): SetupCheck => ({
  id: `key-${p.id}`,
  title: `${p.label} key`,
  level: "optional",
  why: `Provider “${p.label}” needs ${p.authRef}.`,
  link: { label: "Settings → Providers", href: "#/settings" },
  async detect({ hasSecret }) {
    return hasSecret(p.authRef) ? ok("Key is set") : bad("No key yet");
  },
});

const terminal: SetupCheck = {
  id: "terminal",
  title: "The built-in terminal",
  level: "recommended",
  why: "The Terminal panel (Ctrl + `) is your own terminal inside the board. Without its terminal part it still runs commands, but not programs that take over the screen (editors, pickers, Claude Code itself), and colours and arrow keys are limited.",
  // npm installs whatever part is missing — here the optional node-pty — and leaves the rest alone.
  run: () => [{ command: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: BOARD_DIR, timeoutMs: 10 * MIN }],
  runLabel: "Repair",
  manual: everywhere("In the Claude Kanban folder: npm install  (or run the install line again)"),
  async detect() {
    return (await loadPty()) ? ok("Full terminal") : bad("Basic mode: commands work, full-screen programs don't");
  },
};

const pwsh: SetupCheck = {
  id: "pwsh",
  title: "PowerShell 7 for the terminal",
  level: "optional",
  why: "The terminal uses PowerShell 7 when it is installed: quicker, clearer colours and errors, better Tab completion, and it reads and writes every language's letters by default. Windows PowerShell, which every PC has, works too.",
  run: () => [{
    command: "winget",
    args: ["install", "--id", "Microsoft.PowerShell", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
    timeoutMs: 15 * MIN,
  }],
  manual: { win32: "winget install --id Microsoft.PowerShell -e" },
  link: { label: "About PowerShell 7", href: "https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows" },
  async detect({ probe }) {
    const p = pwshPath(probe.env, probe.exists);
    return p ? ok(`Installed — new terminals use it`) : bad("Not installed (optional) — the terminal uses Windows PowerShell");
  },
};

const plugins: SetupCheck = {
  id: "plugins",
  title: "Plugins and skills",
  level: "info",
  why: "No board feature needs a plugin. Runs load the ones you enabled in Claude Code, and the Skills tab recommends a few skills and tools worth having, with an Install button.",
  link: { label: "Open Skills", href: "#/skills" },
  async detect({ settings }) {
    return ok(settings.loadUserPlugins ? "Runs load your Claude Code plugins" : "Runs load no global plugins (Settings → Runs & limits)");
  },
};

/** The starter pack of the Skills tab's Suggested list (D317): optional, so it never adds to the Setup badge. */
const starterSkills: SetupCheck = {
  id: "starter-skills",
  title: "Recommended skills",
  level: "optional",
  why: "Five skills that make unattended tasks test before they finish, find the real cause of a bug, write less code and tidy what they wrote. Each can be switched off in the Skills tab.",
  link: { label: "Open Skills", href: "#/skills" },
  async detect({ home, skillsBusy }) {
    const starter = CATALOG.filter((e) => e.starter);
    const missing = starter.filter((e) => entryStatus(e, home) === "not-installed");
    const have = `${starter.length - missing.length} of ${starter.length} installed`;
    if (!missing.length) return ok(have);
    const busy = new Set(skillsBusy?.() ?? []);
    const installing = missing.filter((e) => busy.has(e.id));
    // No button while they install: a second click would only be refused.
    if (installing.length) return { ok: false, offerFixes: false, detail: `${have} · installing ${installing.map((e) => e.name).join(", ")}…` };
    return {
      ok: false,
      offerFixes: false,
      detail: `${have} · missing: ${missing.map((e) => e.name).join(", ")}`,
      action: { label: "Install the starter pack", endpoint: "/skills/suggested/starter" },
    };
  },
};

const claudeModelIds: SetupCheck = {
  id: "claude-models",
  title: "Claude models in your settings",
  level: "recommended",
  why: "Stages, tiers, the plan critic and the intake jobs each name a Claude model. A misspelt one is only noticed when a run on it fails, so each is checked against the models your Claude login has.",
  link: { label: "Open Models & pipeline", href: "#/settings?tab=models" },
  manual: everywhere("Settings → Models & pipeline: pick each model from the list, and remove rows marked in red"),
  async detect({ settings, claudeModels }) {
    const list = claudeModels ? await claudeModels() : null;
    const bad = badClaudePicks(settings, list);
    if (bad.length) {
      const shown = bad.slice(0, 3).map((p) => `${p.where}: “${p.id}”`).join(" · ");
      return { ok: false, detail: `${bad.length === 1 ? "1 model is" : `${bad.length} models are`} not on your Claude login's list — ${shown}${bad.length > 3 ? " …" : ""}` };
    }
    if (!list || list.source !== "live") return ok("Not checked: Claude Code could not be asked for its list");
    return ok(`Every pick is one of your ${list.models.length} Claude models`);
  },
};

const claudeEngine: SetupCheck = {
  id: "claude-engine",
  title: "Claude's engine is up to date",
  level: "recommended",
  why: "The list of Claude models comes from the engine inside the board (Claude Code). A model that shipped after it does not show up until the engine is updated. The board updates it by itself each time it starts.",
  manual: everywhere("node scripts/update-engine.mjs --force   (in the Claude Kanban folder, then start the board again)"),
  link: { label: "Open Models & pipeline", href: "#/settings?tab=models" },
  async detect({ probe, settings }) {
    const installed = sdkVersion();
    let latest: string | undefined;
    try {
      latest = ((await probe.fetchJson(ENGINE_LATEST_URL, 5000)) as { version?: string }).version;
    } catch {
      return ok(`${installed} — could not reach npm to see if there is a newer one`);
    }
    if (!shouldInstall({ installed, latest, floor: ENGINE_FLOOR })) return ok(`${installed} — the newest this board can use`);
    const how = settings.autoUpdateEngine
      ? "quit Claude Kanban (right-click its icon by the clock, or close its black window) and open it again to get it"
      : "updates are switched off in Settings → Models & pipeline";
    return bad(`${installed} installed, ${latest} is out — ${how}`);
  },
};

const providerCredit: SetupCheck = {
  id: "provider-credit",
  title: "Credit left on your other providers",
  level: "recommended",
  why: "A stage on a provider whose plan or credit ran out cannot run. A used-up usage window comes back by itself and tasks wait for it; credit that ran out needs topping up, or a fallback in Settings → Providers.",
  link: { label: "Open Providers", href: "#/settings?tab=providers" },
  manual: everywhere("Top up the provider, or set “When it runs out” on it in Settings → Providers"),
  async detect({ settings, providerOuts }) {
    const label = (id: string) => settings.providers.find((p) => p.id === id)?.label ?? id;
    const outs = (providerOuts?.() ?? []).filter((o) => settings.providers.some((p) => p.id === o.provider_id && p.enabled));
    const broke = outs.filter((o) => o.kind === "credit");
    if (broke.length) return { ok: false, detail: broke.map((o) => `${label(o.provider_id)}: ${o.reason}`).join(" · ") };
    const waiting = outs.filter((o) => o.resets_at);
    if (waiting.length) {
      return ok(waiting.map((o) => `${label(o.provider_id)} is out until ${new Date(o.resets_at!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; its tasks wait`).join(" · "));
    }
    return ok("None has run out");
  },
};

const images: SetupCheck = {
  id: "images",
  title: "Pictures for tasks",
  level: "optional",
  why: "A task that needs an illustration, an icon or a placeholder photo makes one instead of leaving a grey box — with Codex on your ChatGPT plan once Codex is on the board, or Cloudflare Workers AI or Pollinations.ai with your own key. With none of them, tasks simply run without a picture tool.",
  link: { label: "Settings → Browser, images & plugins", href: "#/settings?tab=tools" },
  async detect({ settings, hasSecret }) {
    const r = imageReadiness({
      provider: settings.imageProvider,
      pollinationsKey: hasSecret(POLLINATIONS_KEY_REF) ? "set" : null,
      cloudflareAccountId: settings.cloudflareAccountId,
      cloudflareToken: hasSecret(CLOUDFLARE_TOKEN_REF) ? "set" : null,
      // Only asks Codex when it is on the board; never runs a picture from here.
      codex: await codexImagePart(settings, { has: hasSecret } as unknown as SecretStore, () => {}),
    });
    return r.ready ? ok(r.detail) : bad(r.detail);
  },
};

/** Your own Claude Code (the terminal one) gets the same tool: one `claude mcp add`, undone with `claude mcp remove`. */
const imagesInClaudeCode: SetupCheck = {
  id: "images-claude-code",
  title: "The image tool in your own Claude Code",
  level: "optional",
  why: "The same generate_image tool in the Claude Code you run yourself, reading the provider and key set on the board. Nothing else is installed: it points Claude Code at the board's folder.",
  // The board's own Claude binary writes the same ~/.claude.json the Claude Code you run reads.
  run: () => [{ command: bundledClaude() ?? "claude", args: claudeCodeArgs(), timeoutMs: MIN }],
  runLabel: "Add",
  manual: everywhere(claudeCodeCommand()),
  async detect({ probe }) {
    const r = await probe.run(probe.claudeBin, ["mcp", "get", IMAGE_SERVER], { timeoutMs: 15_000 });
    return r.code === 0 && !/No MCP server/i.test(r.stdout) ? ok("Added to your Claude Code (user scope)") : bad("Not added yet");
  },
};

/** The checks that apply right now: always the core, then only what your settings switch on. */
export function buildChecks(settings: Settings): SetupCheck[] {
  const list: SetupCheck[] = [node, claudeLogin, claudeEngine, claudeModelIds, git, gitIdentity];
  if (settings.browserChecks) list.push(browser);
  if (settings.imageProvider !== "off") list.push(images, imagesInClaudeCode);
  const enabled = settings.providers.filter((p) => p.enabled);
  const local = enabled.filter(isOllama);
  if (local.length) {
    // One Ollama per machine in practice; the first one's address is the one checked.
    const origin = new URL(local[0].baseUrl!).origin;
    list.push(ollama(origin));
    // Models in the providers' lists, and any the default pipeline, tiers or critic picked from the live list.
    const onOllama = new Set(local.map((p) => p.id));
    const picked = [
      ...settings.defaultPipeline.map((s) => ({ provider: s.provider, model: s.model })),
      ...Object.values(settings.tiers),
      settings.debate.critic,
    ].filter((r) => r.provider && onOllama.has(r.provider)).map((r) => r.model);
    const models = [...new Set([...local.flatMap((p) => p.models.map((m) => m.id)), ...picked])].filter((m) => MODEL_ID.test(m));
    for (const m of models) list.push(ollamaModel(origin, m));
  }
  // LM Studio is offered whether or not it is set up: it is the easiest way to free local AI.
  const studio = settings.providers.find(isLmStudio);
  list.push(lmStudioApp, lmStudioServer(new URL(studio?.baseUrl || "http://localhost:1234").origin, Boolean(studio?.enabled)));
  const titles: Record<string, string> = {
    "google/gemma-4-12b-qat": "Gemma 4 12B — a small model for simple tasks",
    "qwen/qwen3.8-27b": "Qwen3.8 27B — a smarter model, for a strong PC",
  };
  for (const key of SETUP_PICKS) {
    const pick = PICKS.find((p) => p.key === key);
    if (pick) list.push(lmStudioModel(pick, titles[key] ?? pick.name));
  }
  const presets = new Set<string>();
  for (const p of enabled) {
    const preset = p.kind === "cli" ? p.cli?.preset : undefined;
    // Codex has its own row below, there whether or not it is on the board (D296).
    if (preset && preset !== "custom" && preset !== "codex" && !presets.has(preset)) {
      presets.add(preset);
      list.push(cliCheck(p, preset));
    }
  }
  list.push(codexCheck(settings));
  for (const p of enabled) if (p.kind !== "cli" && p.authRef && !isLocal(p)) list.push(keyCheck(p));
  if (enabled.some((p) => !isLocal(p))) list.push(providerCredit);
  list.push(plugins, starterSkills, terminal);
  if (process.platform === "win32") list.push(pwsh);
  return list;
}
