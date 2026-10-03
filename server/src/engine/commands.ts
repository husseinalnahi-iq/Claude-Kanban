import type { Approval, EventRow, Run } from "../types.ts";
import { commandOf } from "./explain.ts";

/**
 * One shell command a task ran, is running, or is waiting to run (D337). Read off the transcript, so
 * autonomous runs, which never show an approval card, are covered too.
 */
export interface TaskCommand {
  /** The tool call's id, or the approval's for one not yet in the transcript. */
  id: string;
  run_id: string | null;
  stage: string | null;
  stage_index: number | null;
  tool: string;
  command: string;
  ts: string;
  status: "waiting" | "running" | "done" | "failed" | "denied" | "stopped";
  /** How the run itself let it through: a card you allowed, the board's read-only rule, or an autonomous run's own say-so. */
  via: "approval" | "auto" | "autonomous" | null;
}

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean };

const blocks = (e: EventRow): Block[] => {
  const p = (e.payload ?? {}) as { type?: string; message?: { content?: unknown } };
  return Array.isArray(p.message?.content) ? (p.message!.content as Block[]) : [];
};

/**
 * Every command across a task's runs, oldest first. A tool call is "done" or "failed" once its result
 * is in the transcript; before that it is "waiting" when an approval card for it is open, "running"
 * while the run is live, and "stopped" when the run ended without a result. Pending approvals that
 * are not in the transcript yet (the card is made before the call is recorded) are listed too.
 */
export function commandsForTask(runs: Run[], eventsOf: (runId: string) => EventRow[], approvals: Approval[]): TaskCommand[] {
  const out: TaskCommand[] = [];
  const seen = new Set<string>();
  const pendingByCommand = new Map<string, Approval>();
  for (const a of approvals) {
    const c = commandOf(a.tool_name, (a.input ?? {}) as Record<string, unknown>);
    if (c && !a.decision) pendingByCommand.set(`${a.run_id}:${c}`, a);
  }
  for (const run of runs) {
    const events = eventsOf(run.id);
    const results = new Map<string, boolean>(); // tool_use_id → is_error
    const autoAllowed = new Set<string>();
    for (const e of events) {
      const p = (e.payload ?? {}) as { type?: string; command?: string };
      if (p.type === "auto_allowed" && typeof p.command === "string") autoAllowed.add(p.command);
      if (p.type === "user") for (const b of blocks(e)) if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, Boolean(b.is_error));
    }
    const decided = new Map<string, Approval>();
    for (const a of approvals) {
      const c = commandOf(a.tool_name, (a.input ?? {}) as Record<string, unknown>);
      if (c && a.run_id === run.id) decided.set(c, a);
    }
    for (const e of events) {
      const p = (e.payload ?? {}) as { type?: string };
      if (p.type !== "assistant") continue;
      for (const b of blocks(e)) {
        if (b.type !== "tool_use" || !b.name) continue;
        const command = commandOf(b.name, b.input);
        if (!command) continue;
        const id = b.id ?? `${run.id}:${e.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const approval = decided.get(command);
        const result = results.get(b.id ?? "");
        const status: TaskCommand["status"] =
          result !== undefined ? (result ? "failed" : "done")
          : approval?.decision === "deny" ? "denied"
          : approval && !approval.decision ? "waiting"
          : run.status === "running" || run.status === "approval" ? "running"
          : "stopped";
        pendingByCommand.delete(`${run.id}:${command}`);
        out.push({
          id, run_id: run.id, stage: run.stage, stage_index: run.stage_index, tool: b.name, command, ts: e.ts, status,
          via: approval ? "approval" : autoAllowed.has(command) ? "auto" : "autonomous",
        });
      }
    }
  }
  // A card can be open before the call is in the transcript: show it as waiting rather than nowhere.
  for (const a of pendingByCommand.values()) {
    const run = runs.find((r) => r.id === a.run_id);
    out.push({
      id: a.id, run_id: a.run_id, stage: run?.stage ?? null, stage_index: run?.stage_index ?? null, tool: a.tool_name,
      command: commandOf(a.tool_name, (a.input ?? {}) as Record<string, unknown>)!, ts: a.created_at, status: "waiting", via: "approval",
    });
  }
  return out.sort((x, y) => x.ts.localeCompare(y.ts));
}
