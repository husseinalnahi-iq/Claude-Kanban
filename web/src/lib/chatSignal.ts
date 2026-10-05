import { stoppedBy, type Approval, type TaskCard } from "../../../server/src/types.ts";
import { isQuestion } from "./questions.ts";

/**
 * One light per chat in the AI Manager's list: what its cards are up to, read without opening it. A chat
 * can start several cards, so it shows the one that most wants you — the order of SIGNALS is that
 * ranking, and a new state goes where it belongs in it rather than at the end.
 */
export type SignalKind =
  | "question" | "permission" | "plan" | "failed" | "conflict"
  | "working" | "paused" | "queued" | "review" | "merged" | "done" | "backlog";

export interface Signal {
  kind: SignalKind;
  /** Short, for the row: "asks you a question". */
  label: string;
  /** Longer, for the hover. */
  title: string;
  /** How many of the chat's cards are in this state. */
  count: number;
}

const SIGNALS: Record<SignalKind, { label: string; title: string }> = {
  question: { label: "asks you a question", title: "Claude asked you something — open the chat to answer" },
  permission: { label: "needs your OK", title: "Waiting for you to allow something, or to decide how it carries on" },
  plan: { label: "plan ready", title: "A plan is ready — open it to approve, change or send it back" },
  failed: { label: "failed", title: "It stopped with an error — open it to see why and try again" },
  conflict: { label: "conflict", title: "Its changes clash with what landed meanwhile — Claude is fixing it, or it needs you" },
  working: { label: "working", title: "Claude is working on it" },
  paused: { label: "paused", title: "Paused by a usage limit — it carries on by itself" },
  queued: { label: "queued", title: "Waiting for its turn, or for another task to finish" },
  review: { label: "ready for review", title: "Finished — look at the work and approve it" },
  merged: { label: "merged", title: "Finished, and its changes are merged into your project" },
  done: { label: "done", title: "Finished, nothing left for you" },
  backlog: { label: "not started", title: "Written down but not started yet" },
};
const RANK = Object.keys(SIGNALS) as SignalKind[];

/** Which signal one card gives. `waiting` is its approvals still undecided. */
export function cardSignal(card: TaskCard, waiting: Approval[]): SignalKind {
  // A question it carried on past still waits for an answer, so a finished card with one is not "done" yet.
  if (waiting.some(isQuestion) || (card.status === "failed" && stoppedBy(card)?.ask) || card.questions.some((q) => q.answer === null)) return "question";
  if (card.status === "approval" && card.plan_gate) return "plan";
  if (waiting.length || card.status === "approval") return "permission";
  // A cost ceiling, or a provider out of credit with no time to come back, waits on you; a usage limit does not.
  if (card.status === "paused") return card.pause_reason === "cost" || (card.pause_reason === "provider" && !card.resume_at) ? "permission" : "paused";
  if (card.status === "failed") return "failed";
  const r = card.resolution?.state;
  if (card.status === "review" && (card.conflict_risk || r === "resolving" || r === "checking" || r === "reviewing" || r === "failed")) return "conflict";
  if (card.status === "running" || card.status === "planning") return "working";
  if (card.status === "queued") return "queued";
  if (card.status === "review") return "review";
  if (card.status === "done") return card.merged_at ? "merged" : "done";
  return "backlog";
}

/** The chat's signal: its most urgent card's, or "working" while Claude writes a reply. Null for a chat with no cards. */
export function chatSignal(cards: TaskCard[], pending: Approval[], busy: boolean): Signal | null {
  const kinds = cards.map((c) => cardSignal(c, pending.filter((a) => a.task_id === c.id)));
  const kind = RANK.find((k) => kinds.includes(k) || (busy && k === "working"));
  if (!kind) return null;
  // The count is of cards: a reply being written is not one, so it never turns "2 working" into "3".
  return { kind, ...SIGNALS[kind], count: Math.max(1, kinds.filter((k) => k === kind).length) };
}

/** Signals that want you, then ones still moving: the AI Manager's "Group by status" sections. */
export const NEEDS_YOU = new Set<SignalKind>(["question", "permission", "plan"]);
export const MOVING = new Set<SignalKind>(["working", "paused", "queued"]);
