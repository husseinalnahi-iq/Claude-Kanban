import { z } from "zod";
import type { CliPreset, Provider, SetupCheckResult, Settings } from "../types.ts";
import { pickBrowser, type Probe } from "./probe.ts";
import { isLmStudio, isLocal, isOllama } from "../engine/providers/catalog.ts";
import { hardware, lmsPath, PICKS, SETUP_PICKS, verdictFor, verdictText, type Pick } from "./local.ts";
import { join } from "node:path";

export interface CheckCtx {
  probe: Probe;
  settings: Settings;
  hasSecret: (name: string) => boolean;
}

export interface Detected {
  ok: boolean;
  detail: string;
  /** Can't be fixed until this other check passes (identity needs git; models need Ollama). */
  blockedBy?: string;
}

/** A built-in command. The only user values that reach one are validated form fields. */
export interface FixCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
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

const plugins: SetupCheck = {
  id: "plugins",
  title: "Plugins and skills",
  level: "info",
  why: "No board feature needs a plugin. Runs load the ones you enabled in Claude Code.",
  link: { label: "Open Skills", href: "#/skills" },
  async detect({ settings }) {
    return ok(settings.loadUserPlugins ? "Runs load your Claude Code plugins" : "Runs load no global plugins (Settings → Runs & limits)");
  },
};

/** The checks that apply right now: always the core, then only what your settings switch on. */
export function buildChecks(settings: Settings): SetupCheck[] {
  const list: SetupCheck[] = [node, claudeLogin, git, gitIdentity];
  if (settings.browserChecks) list.push(browser);
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
    if (preset && preset !== "custom" && !presets.has(preset)) {
      presets.add(preset);
      list.push(cliCheck(p, preset));
    }
  }
  for (const p of enabled) if (p.kind !== "cli" && p.authRef && !isLocal(p)) list.push(keyCheck(p));
  list.push(plugins);
  return list;
}
