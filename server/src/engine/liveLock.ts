/**
 * One lock per project on its live systems, shared by the board's cards and your own Claude Code
 * sessions in the same project (D432). The board keeps its cards apart by their footprints (D400), but
 * it cannot see a Claude Code session you run yourself: both could write the same ERP records at once.
 *
 * Opt-in per project: the lock exists only where `.kanban/locks/` does (the setup makes it). The file
 * is plain JSON in the main checkout, so a session in a worktree finds the same one.
 *
 * Erasable TypeScript and node built-ins only: the Claude Code hook (`liveLockHook.ts`) runs this file
 * with plain `node`, which strips the types.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialRisk } from "./credentials.ts";

export const LOCK_DIR = join(".kanban", "locks");
/** A session that has not run a live command for this long has gone quiet: its lock no longer holds. */
export const STALE_MS = 30 * 60_000;

export interface LiveLock {
  owner: "board" | "claude-code";
  /** The board's server process: its lock dies with it. */
  pid?: number;
  /** The cards holding it, for the message the other side sees. */
  tasks?: { id: string; title: string }[];
  /** The Claude Code session holding it. */
  session?: string;
  since: string;
  beat: string;
}

/** A command that runs a program, or touches a key file, may write to a live system; git, ls, grep cannot. */
const RUNS_PROGRAM = /(?:^|[\s;&|(`"'])(?:python3?|py|node|npx|tsx|deno|bun|curl|wget|pwsh|powershell(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest|irm|iwr)(?=[\s"'`;)]|$)/i;

export function mayReachLive(toolName: string, command: string): boolean {
  if (toolName !== "Bash" && toolName !== "PowerShell") return false;
  return RUNS_PROGRAM.test(command) || credentialRisk(toolName, { command }) !== null;
}

export const lockOn = (projectPath: string): boolean => existsSync(join(projectPath, LOCK_DIR));
const fileOf = (projectPath: string) => join(projectPath, LOCK_DIR, "live.json");
const iso = (ms: number) => new Date(ms).toISOString();

export function readLock(projectPath: string): LiveLock | null {
  try {
    return JSON.parse(readFileSync(fileOf(projectPath), "utf8")) as LiveLock;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isStale(lock: LiveLock, now = Date.now()): boolean {
  if (lock.owner === "board") return !lock.pid || !alive(lock.pid) || !lock.tasks?.length;
  return now - Date.parse(lock.beat) > STALE_MS;
}

// ponytail: read-then-write, so two takers in the same instant can both win; the window is a few
// milliseconds against minutes of work. An exclusive create + retry closes it if it ever matters.
function write(projectPath: string, lock: LiveLock): void {
  const file = fileOf(projectPath);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock, null, 1));
  renameSync(tmp, file);
}

/** Take the lock for a card; returns the session's lock instead when one of yours holds it. */
export function takeForBoard(projectPath: string, task: { id: string; title: string }, pid: number, now = Date.now()): LiveLock | null {
  const cur = readLock(projectPath);
  if (cur && cur.owner === "claude-code" && !isStale(cur, now)) return cur;
  // The board's own cards share it: keeping them apart is the queue's job (D400).
  const mine = cur?.owner === "board" && cur.pid === pid && !isStale(cur, now) ? cur : null;
  write(projectPath, { owner: "board", pid, tasks: [...(mine?.tasks ?? []).filter((t) => t.id !== task.id), task], since: mine?.since ?? iso(now), beat: iso(now) });
  return null;
}

export function releaseForBoard(projectPath: string, taskId: string, pid: number): void {
  const cur = readLock(projectPath);
  if (!cur || cur.owner !== "board" || cur.pid !== pid) return;
  const tasks = (cur.tasks ?? []).filter((t) => t.id !== taskId);
  if (tasks.length) write(projectPath, { ...cur, tasks });
  else rmSync(fileOf(projectPath), { force: true });
}

/** Take the lock for a Claude Code session; returns the board's lock instead when a card holds it. */
export function takeForSession(projectPath: string, session: string, now = Date.now()): LiveLock | null {
  const cur = readLock(projectPath);
  if (cur && cur.owner === "board" && !isStale(cur, now)) return cur;
  const mine = cur?.owner === "claude-code" && cur.session === session && !isStale(cur, now) ? cur : null;
  write(projectPath, { owner: "claude-code", session, since: mine?.since ?? iso(now), beat: iso(now) });
  return null;
}

export function releaseForSession(projectPath: string, session: string): void {
  const cur = readLock(projectPath);
  if (cur?.owner === "claude-code" && cur.session === session) rmSync(fileOf(projectPath), { force: true });
}
