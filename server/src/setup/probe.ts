import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RunResult {
  /** null when the program could not be started at all (not installed). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Everything a setup check may ask of the machine, in one place, so tests pass a fake and nothing in
 * the checks themselves touches the OS.
 */
export interface Probe {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** The Claude binary for login and status: the SDK's own, so Claude Code need not be installed separately. */
  claudeBin: string;
  run(command: string, args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** Like run, but hands output over as it arrives. Resolves with the exit code (null: never started). */
  stream(command: string, args: string[], opts: { timeoutMs: number; cwd?: string }, onChunk: (s: string) => void): Promise<number | null>;
  exists(path: string): boolean;
  list(dir: string): string[];
  fetchJson(url: string, timeoutMs?: number): Promise<unknown>;
  /** Windows: pick up PATH changes an installer just made, so the new program works without a restart. */
  refreshPath(): Promise<void>;
}

/**
 * Windows `.cmd` shims need a shell (Node 24 refuses to spawn them otherwise). Only these names get
 * one, and only with the fixed arguments the checks use; git and anything taking a user value never do.
 */
const SHIMS = new Set(["npm", "npx", "claude", "codex", "gemini", "kimi", "opencode"]);
/** What may cross a shell: no spaces, quotes or metacharacters, so there is nothing for cmd to expand. */
const SHELL_SAFE = /^[\w.\-:@/=]+$/;

/**
 * How to start a command: a shim on Windows goes through cmd as one checked string (Node deprecates
 * passing arguments alongside `shell`); everything else is spawned directly with its argument list.
 */
function launch(command: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32" || !SHIMS.has(command)) return { file: command, args, shell: false };
  const bad = args.find((a) => !SHELL_SAFE.test(a));
  if (bad !== undefined) throw new Error(`Refusing to pass "${bad}" through a shell.`);
  return { file: [command, ...args].join(" "), args: [], shell: true };
}

const require = createRequire(import.meta.url);

/** The binary the Agent SDK bundles for this platform, or null (then a global `claude` is tried). */
export function bundledClaude(): string | null {
  try {
    const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    for (const name of [`claude-agent-sdk-${process.platform}-${process.arch}`, `claude-agent-sdk-${process.platform}-${process.arch}-musl`]) {
      const p = join(sdkDir, "..", name, exe);
      if (existsSync(p)) return p;
    }
  } catch {
    // SDK not resolvable: fall through to a global install.
  }
  return null;
}

function run(command: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let l: ReturnType<typeof launch>;
    try {
      l = launch(command, args);
    } catch (e) {
      return resolve({ code: null, stdout: "", stderr: (e as Error).message });
    }
    execFile(l.file, l.args, { windowsHide: true, shell: l.shell, timeout: opts.timeoutMs ?? 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === null ? err.message : "") });
    });
  });
}

export const realProbe: Probe = {
  platform: process.platform,
  env: process.env,
  claudeBin: bundledClaude() ?? "claude",
  run,
  stream: (command, args, opts, onChunk) =>
    new Promise((resolve) => {
      let l: ReturnType<typeof launch>;
      try {
        l = launch(command, args);
      } catch (e) {
        onChunk(`${(e as Error).message}
`);
        return resolve(null);
      }
      const child = spawn(l.file, l.args, { windowsHide: true, shell: l.shell, cwd: opts.cwd });
      const timer = setTimeout(() => child.kill(), opts.timeoutMs);
      child.stdout?.on("data", (d) => onChunk(String(d)));
      child.stderr?.on("data", (d) => onChunk(String(d)));
      child.on("error", (e) => {
        clearTimeout(timer);
        onChunk(`${e.message}\n`);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    }),
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  fetchJson: async (url, timeoutMs = 3000) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  refreshPath: async () => {
    if (process.platform !== "win32") return;
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], { timeoutMs: 10_000 });
    if (r.code !== 0) return;
    // Keep what the board started with first (npm adds its own bin folders), then anything new.
    const merged = new Set([...(process.env.PATH ?? "").split(";"), ...r.stdout.trim().split(";")].filter(Boolean));
    process.env.PATH = [...merged].join(";");
  },
};

export type BrowserChoice = { browser: "chrome" | "msedge" | "chromium"; path: string };

/** Where Chrome and Edge install themselves, per OS. Chrome first: it is what the MCP server defaults to. */
function browserCandidates(p: Probe): BrowserChoice[] {
  if (p.platform === "win32") {
    const roots = [p.env.PROGRAMFILES, p.env["PROGRAMFILES(X86)"], p.env.LOCALAPPDATA].filter(Boolean) as string[];
    return [
      ...roots.map((r) => ({ browser: "chrome" as const, path: join(r, "Google", "Chrome", "Application", "chrome.exe") })),
      ...roots.map((r) => ({ browser: "msedge" as const, path: join(r, "Microsoft", "Edge", "Application", "msedge.exe") })),
    ];
  }
  if (p.platform === "darwin") {
    return [
      { browser: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { browser: "msedge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ];
  }
  return [
    { browser: "chrome", path: "/opt/google/chrome/chrome" },
    { browser: "msedge", path: "/opt/microsoft/msedge/msedge" },
  ];
}

/** Playwright's own download folder (PLAYWRIGHT_BROWSERS_PATH wins, as in Playwright). */
function playwrightCache(p: Probe): string {
  if (p.env.PLAYWRIGHT_BROWSERS_PATH) return p.env.PLAYWRIGHT_BROWSERS_PATH;
  if (p.platform === "win32") return join(p.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  if (p.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  return join(homedir(), ".cache", "ms-playwright");
}

/** A browser the board's Playwright server can launch: Chrome, then Edge, then a downloaded Chromium. */
export function pickBrowser(p: Probe): BrowserChoice | null {
  const found = browserCandidates(p).find((c) => p.exists(c.path));
  if (found) return found;
  const cache = playwrightCache(p);
  const chromium = p.list(cache).find((n) => /^chromium-\d+$/.test(n));
  return chromium ? { browser: "chromium", path: join(cache, chromium) } : null;
}
