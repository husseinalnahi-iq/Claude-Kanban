import type { ChecklistItem } from "../types.ts";

/**
 * Claude's own to-do list for the stage it is running, read off the tool calls it makes to keep it
 * (TodoWrite, or TaskCreate / TaskUpdate in newer Claude Code). The card shows it as "3/7 · Writing
 * the login form": the one progress signal that reads the same on ten cards at once. Pure.
 */

/** Long lists are a sign of a list nobody reads; the card shows a count and the current step anyway. */
const MAX_ITEMS = 40;
const clip = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
const STATUSES = new Set(["pending", "in_progress", "completed"]);

/** The list after one tool call, or null when the call is not about the list (most are not). */
export function applyChecklistTool(list: ChecklistItem[], tool: string, input: Record<string, unknown> | null | undefined): ChecklistItem[] | null {
  const i = input ?? {};
  if (tool === "TodoWrite") {
    if (!Array.isArray(i.todos)) return null;
    return (i.todos as Record<string, unknown>[])
      .filter((t) => t && clip(t.content))
      .slice(0, MAX_ITEMS)
      .map((t, n) => ({ id: String(n + 1), text: clip(t.content), doing: clip(t.activeForm) || undefined, status: STATUSES.has(String(t.status)) ? (t.status as ChecklistItem["status"]) : "pending" }));
  }
  if (tool === "TaskCreate") {
    if (!clip(i.subject) || liveChecklist(list).length >= MAX_ITEMS) return null;
    // Claude Code numbers a session's tasks 1, 2, 3… in the order they are created, and TaskUpdate
    // names them by that number — so the position here is the id it will use. A deleted item still
    // holds its place for that reason.
    return [...list, { id: String(list.length + 1), text: clip(i.subject), doing: clip(i.activeForm) || undefined, status: "pending" }];
  }
  if (tool === "TaskUpdate") {
    const id = String(i.taskId ?? "");
    if (!list.some((x) => x.id === id)) return null;
    if (i.status === "deleted") return list.map((x) => (x.id === id ? { ...x, deleted: true as const } : x));
    return list.map((x) =>
      x.id !== id
        ? x
        : {
            ...x,
            text: clip(i.subject) || x.text,
            doing: clip(i.activeForm) || x.doing,
            status: STATUSES.has(String(i.status)) ? (i.status as ChecklistItem["status"]) : x.status,
          },
    );
  }
  return null;
}

/** The items to show: the ones Claude has not deleted. */
export const liveChecklist = (list: ChecklistItem[] | null | undefined): ChecklistItem[] => (list ?? []).filter((x) => !x.deleted);

/** "3/7 · Writing the login form" — done count, and what is being done now. Empty when there is no list. */
export function checklistSummary(list: ChecklistItem[] | null | undefined): { done: number; total: number; now: string | null } | null {
  const live = liveChecklist(list);
  if (!live.length) return null;
  const doing = live.find((x) => x.status === "in_progress");
  return { done: live.filter((x) => x.status === "completed").length, total: live.length, now: doing ? doing.doing || doing.text : null };
}
