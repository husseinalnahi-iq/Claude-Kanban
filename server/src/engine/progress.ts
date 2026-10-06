import type { EventRow } from "../types.ts";

/** Tools whose call changes a file: the plainest sign a code stage is getting somewhere. */
const WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** The to-do tools: a list that moves is progress even between edits. */
const TODO = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

export interface Progress {
  edits: number;
  tools: number;
  checklist: boolean;
}

/**
 * What a stage's run did, from its recorded SDK messages: the stage's own tool calls (a subagent's are
 * its own business). Pure, so the ceilings and the tests share it (D412).
 */
export function stageProgress(events: EventRow[], afterEventId = 0): Progress {
  const out: Progress = { edits: 0, tools: 0, checklist: false };
  for (const e of events) {
    if (e.id <= afterEventId || e.type !== "assistant") continue;
    const p = e.payload as { parent_tool_use_id?: string | null; message?: { content?: unknown } } | null;
    if (!p || p.parent_tool_use_id) continue;
    const blocks = Array.isArray(p.message?.content) ? (p.message!.content as { type?: string; name?: string }[]) : [];
    for (const b of blocks) {
      if (b.type !== "tool_use" || !b.name) continue;
      out.tools++;
      if (WRITES.has(b.name)) out.edits++;
      if (TODO.has(b.name)) out.checklist = true;
    }
  }
  return out;
}

/**
 * Is a stage that ran out of turns or money still working? A stage that writes is judged by its writes
 * and its to-do list; one that only reads (plan, review) by whether it called anything at all. A stage
 * that looped is stopped by the loop detector before this is asked.
 */
export function isProgressing(p: Progress, stage: string): boolean {
  if (stage === "plan" || stage === "review") return p.tools > 0;
  return p.edits > 0 || p.checklist;
}
