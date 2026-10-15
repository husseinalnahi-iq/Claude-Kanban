/**
 * A Claude Code hook for your own sessions in a project the board also works on (D432). Wired in that
 * project's `.claude/settings.local.json` (see `scripts/live-lock-setup.mjs`):
 *
 *   PreToolUse  → `node liveLockHook.ts pre`: before a command that may reach a live system, take the
 *                 project's live lock, or — while a board card holds it — ask you first.
 *   Stop        → `node liveLockHook.ts stop`: give the lock back at the end of each reply.
 *
 * It never blocks on its own failure: anything unexpected exits 0 and the command goes ahead.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { lockOn, mayReachLive, releaseForSession, takeForSession } from "./liveLock.ts";

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: unknown };
}

/** The main checkout, also from a worktree: where the lock lives. */
function mainCheckout(cwd: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return common.endsWith(".git") ? dirname(common) : null;
  } catch {
    return null;
  }
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function main(): void {
  // The board's own runs have their own lock handling; this hook is only for your sessions.
  if (process.env.KANBAN_TASK_ID) return;
  const input = JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput;
  const root = input.cwd ? mainCheckout(input.cwd) : null;
  if (!root || !lockOn(root) || !input.session_id) return;
  if (process.argv[2] === "stop") return releaseForSession(root, input.session_id);
  if (!mayReachLive(input.tool_name ?? "", String(input.tool_input?.command ?? ""))) return;
  const board = takeForSession(root, input.session_id);
  if (!board) return;
  const cards = (board.tasks ?? []).map((t) => `“${t.title}”`).join(", ");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        `A Claude Kanban card is working on this project's live systems right now: ${cards} (since ${hhmm(board.since)}). ` +
        "Running this at the same time could change the same records. Allow only if it does not touch what that card is changing; otherwise wait for the card to finish.",
    },
  }));
}

try {
  main();
} catch {
  // A broken lock check must never stop your own work.
}
