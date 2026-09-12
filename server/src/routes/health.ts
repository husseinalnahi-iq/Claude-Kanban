import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AppDeps } from "../app.ts";
import { realProbe } from "../setup/probe.ts";

const require = createRequire(import.meta.url);

/** The SDK doesn't export ./package.json, so read it off the resolved entry point. */
function sdkVersion(): string {
  try {
    const pkg = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export interface CliHealth {
  loggedIn: boolean;
  authMethod: string | null;
  cliVersion: string | null;
  sdkVersion: string;
  error: string | null;
  checkedAt: string;
}

/** The SDK's own Claude binary when there is one, so a separate Claude Code install is optional. */
function claude(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return realProbe.run(realProbe.claudeBin, args, { timeoutMs: 15_000 }).then((r) => ({ code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr }));
}

let cache: { at: number; value: CliHealth } | null = null;

export async function cliHealth(maxAgeMs = 10_000): Promise<CliHealth> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  const value: CliHealth = { loggedIn: false, authMethod: null, cliVersion: null, sdkVersion: sdkVersion(), error: null, checkedAt: new Date().toISOString() };
  try {
    const status = await claude(["auth", "status"]);
    const json = JSON.parse(status.stdout) as { loggedIn?: boolean; authMethod?: string };
    value.loggedIn = json.loggedIn === true;
    value.authMethod = json.authMethod ?? null;
    const v = await claude(["--version"]);
    value.cliVersion = v.stdout.trim().split(/\s+/)[0] || null;
  } catch (err) {
    value.error = err instanceof Error ? err.message : String(err);
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Opens a real terminal running Claude's login (it needs a TTY). The binary is the SDK's own when there is one. */
function openLoginTerminal(): void {
  const bin = realProbe.claudeBin;
  if (process.platform === "win32") {
    // cmd's own quoting: the outer quotes wrap the /k command, the inner ones the path (which may have
    // spaces). Verbatim, because Node's escaping of embedded quotes is not what cmd expects.
    execFile("cmd.exe", ["/c", `start "Claude login" cmd /k ""${bin}" auth login"`], { windowsHide: false, windowsVerbatimArguments: true }, () => {});
    return;
  }
  const cmd = `'${bin.replace(/'/g, `'\\''`)}' auth login`;
  const term = process.platform === "darwin"
    ? ["osascript", ["-e", `tell app "Terminal" to do script "${cmd.replace(/["\\]/g, "\\$&")}"`]]
    : ["x-terminal-emulator", ["-e", cmd]];
  execFile(term[0] as string, term[1] as string[], () => {});
}

export async function healthRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get("/health", async () => cliHealth());

  /** Starts the login and waits (up to ~4 min) for the CLI to report a session, so the UI can confirm it. */
  app.post("/auth/login", async () => {
    cache = null;
    const before = await cliHealth(0);
    if (before.loggedIn) return { started: false, ...before };
    openLoginTerminal();
    void (async () => {
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        cache = null;
        const h = await cliHealth(0);
        deps.bus.publish({ type: "health.updated", health: h });
        if (h.loggedIn) return;
      }
    })();
    return { started: true, ...before };
  });
}
