import type { Approval } from "../../../server/src/types.ts";

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export const isQuestion = (a: Pick<Approval, "tool_name">) => a.tool_name === "AskUserQuestion";

/** The questions inside an AskUserQuestion card, tolerant of anything malformed. */
export function questionsOf(a: Approval): Question[] {
  const raw = (a.input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is Question => !!q && typeof q.question === "string")
    .map((q) => ({ ...q, options: Array.isArray(q.options) ? q.options.filter((o) => o && typeof o.label === "string") : [] }));
}

/** First question's text, for alerts and the board: "Which colour should the button be?". */
export function questionTitle(a: Approval): string {
  return questionsOf(a)[0]?.question ?? "Claude has a question";
}

