import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { glob } from "node:fs/promises";

/** Total bytes we are willing to copy into a worktree. Keeps a stray `node_modules/**` pattern harmless. */
const MAX_COPY_BYTES = 64 * 1024 * 1024;
const MAX_COPY_FILES = 500;

export interface CopyReport {
  copied: string[];
  skippedTracked: string[];
  skippedTooBig: string[];
}

/**
 * Patterns of gitignored files to seed a worktree with: the repo's `.worktreeinclude`
 * (same convention as Claude Code and Conductor) plus any extra patterns from project settings.
 */
export function readWorktreeInclude(projectPath: string, extra: string[] = []): string[] {
  const file = join(projectPath, ".worktreeinclude");
  const fromFile = existsSync(file)
    ? readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    : [];
  return [...new Set([...fromFile, ...extra.map((e) => e.trim()).filter(Boolean)])];
}

function isIgnored(projectPath: string, relPath: string): Promise<boolean> {
  return new Promise((res) => {
    execFile("git", ["check-ignore", "-q", "--", relPath], { cwd: projectPath, windowsHide: true }, (err) => {
      // exit 0 = ignored, 1 = not ignored, anything else = treat as "not ignored" (fail closed)
      res(!err);
    });
  });
}

/**
 * Copies gitignored files (.env and friends) from the main checkout into a fresh worktree.
 * Never copies a tracked file — a file must match a pattern AND be ignored by git — and never
 * writes outside the worktree. This is a local convenience, not secret management.
 */
export async function seedWorktree(projectPath: string, worktreePath: string, patterns: string[]): Promise<CopyReport> {
  const report: CopyReport = { copied: [], skippedTracked: [], skippedTooBig: [] };
  if (!patterns.length) return report;
  let budget = MAX_COPY_BYTES;

  for (const pattern of patterns) {
    let matches: string[] = [];
    try {
      for await (const m of glob(pattern, { cwd: projectPath })) matches.push(String(m));
    } catch {
      continue; // a bad pattern must not break the run
    }
    for (const raw of matches) {
      const rel = raw.replace(/\\/g, "/"); // glob yields OS separators; keep reports and git args uniform
      if (report.copied.length >= MAX_COPY_FILES) return report;
      const src = resolve(projectPath, rel);
      const dest = resolve(worktreePath, rel);
      // Refuse anything that escapes either side (a pattern like ../../secrets).
      if (relative(projectPath, src).startsWith("..") || relative(worktreePath, dest).startsWith("..")) continue;
      if (!existsSync(src) || !statSync(src).isFile()) continue;
      if (!(await isIgnored(projectPath, rel))) {
        report.skippedTracked.push(rel);
        continue;
      }
      const size = statSync(src).size;
      if (size > budget) {
        report.skippedTooBig.push(rel);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      budget -= size;
      report.copied.push(rel);
    }
  }
  return report;
}

/** A free TCP port for this task's dev server, exported to setup/verify/agent as KANBAN_PORT. */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
    srv.on("error", rej);
  });
}

const run = (file: string, args: string[]) =>
  new Promise<string>((res) => execFile(file, args, { windowsHide: true, timeout: 15_000 }, (_err, stdout) => res(String(stdout ?? ""))));

/** PIDs listening on a TCP port on this machine. */
export async function listenersOn(port: number): Promise<number[]> {
  const pids = new Set<number>();
  if (process.platform === "win32") {
    for (const line of (await run("netstat", ["-ano", "-p", "TCP"])).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // Proto  Local Address  Foreign Address  State  PID
      if (cols.length >= 5 && /LISTEN/i.test(cols[3]) && cols[1].endsWith(`:${port}`)) pids.add(Number(cols[4]));
    }
  } else {
    for (const pid of (await run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"])).split(/\s+/)) if (pid) pids.add(Number(pid));
  }
  return [...pids].filter((p) => Number.isInteger(p) && p > 0);
}

/**
 * Stops whatever a task left listening on its reserved port — a dev server started with `&` and
 * never stopped would otherwise outlive the task. By PID and process tree, never by name: the port
 * was reserved for this one task, so whatever holds it is that task's. The board's own process is
 * never touched.
 */
export async function stopListeners(port: number): Promise<number[]> {
  const pids = (await listenersOn(port)).filter((p) => p !== process.pid);
  for (const pid of pids) {
    if (process.platform === "win32") await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  return pids;
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs a project-configured shell command (setup / verify) in a workspace and captures its tail. */
export function runProjectCommand(
  command: string,
  cwd: string,
  opts: { env?: Record<string, string>; timeoutMs?: number; tailBytes?: number } = {},
): Promise<CommandResult> {
  const tail = opts.tailBytes ?? 8000;
  return new Promise((res) => {
    const child = execFile(
      command,
      { cwd, shell: true, windowsHide: true, timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...opts.env } },
      (err, stdout, stderr) => {
        const text = `${stdout ?? ""}${stderr ?? ""}`.trim();
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        res({
          ok: !e,
          code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
          output: text.length > tail ? `…(${text.length - tail} bytes trimmed)…\n${text.slice(-tail)}` : text,
          timedOut: Boolean(e?.killed),
        });
      },
    );
    child.on("error", () => {});
  });
}
