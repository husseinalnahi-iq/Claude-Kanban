import { stoppedBy, type TaskCard, type TaskStatus } from "../../../server/src/types.ts";

/** The provider of the stage a paused task stopped on: the first one that has not succeeded. */
export function stoppedProvider(card: TaskCard): string | null {
  const i = card.stage_states.findIndex((s) => s !== "success");
  return card.pipeline[i < 0 ? card.pipeline.length - 1 : i]?.provider ?? null;
}

/** The in-progress badge: which stage is running, or why it is waiting. */
export function phase(card: TaskCard, asking?: boolean): { text: string; tone: string; title: string } {
  if (card.status === "approval" && asking) return { text: "asks you", tone: "border-iris/60 text-iris", title: "Claude has a question for you — open the task to answer" };
  if (card.status === "approval" && card.plan_gate) return { text: "approve plan", tone: "border-iris/60 text-iris", title: "The plan is waiting for you — open the task to approve, edit or send it back" };
  if (card.status === "approval") return { text: "needs you", tone: "border-rose/60 text-rose", title: "Waiting for you to allow or deny something — open the task" };
  if (card.status === "paused" && card.pause_reason === "cost") return { text: "needs you · cost", tone: "border-rose/60 text-rose", title: "It reached its cost ceiling — open the task and press Continue or Stop" };
  if (card.status === "paused" && card.pause_reason === "provider") {
    const who = stoppedProvider(card) ?? "provider";
    return card.resume_at
      ? { text: `paused · ${who}`, tone: "border-iris/50 text-iris", title: `${who} ran out of usage; it carries on by itself, or open it to switch provider` }
      : { text: `needs you · ${who}`, tone: "border-rose/60 text-rose", title: `${who} ran out of credit — open the task to switch provider, or top it up and try again` };
  }
  if (card.status === "paused") return { text: "paused · limit", tone: "border-iris/50 text-iris", title: "Paused by your Claude usage limit; it carries on by itself" };
  if (card.status === "planning") return { text: "planning", tone: "border-cyan/50 text-cyan", title: "The plan stage is running" };
  const i = card.stage_states.indexOf("running");
  const stage = i >= 0 ? card.pipeline[i]?.stage : undefined;
  const word = stage === "code" ? "coding" : stage === "review" ? "reviewing" : stage === "plan" ? "planning" : "running";
  return { text: word, tone: "border-amber/50 text-amber", title: stage ? `The ${stage} stage is running` : "A stage is running" };
}

/**
 * Whether a card waits on you, for its pulse (D383). `chip` is the word to add when nothing else on the
 * card already says so; null means another chip or panel on it says it, and a second one would only crowd it.
 */
export function waitsOnYou(card: TaskCard, asking?: boolean): { chip: string | null; title: string } | null {
  if (card.archived_at) return null;
  const said = (title: string) => ({ chip: null, title });
  if (card.questions?.some((q) => !q.answer)) return said("Claude asked you something — open the task to answer");
  if (card.status === "approval") return said(phase(card, asking).title);
  if (card.status === "paused" && (card.pause_reason === "cost" || (card.pause_reason === "provider" && !card.resume_at))) return said(phase(card).title);
  if (card.status === "backlog" && card.setup_pending) return said("Check its mode and models, then press Start");
  if (card.status === "review") {
    if (card.resolution?.state === "failed") return said("The conflict could not be resolved safely — open the task");
    // Claude is still at work on it: the review stage, or combining it with what landed meanwhile.
    if (card.resolution && ["resolving", "checking", "reviewing"].includes(card.resolution.state)) return null;
    if (card.stage_states.includes("running")) return null;
    if (card.blocked?.advisory && card.mode === "autonomous") return said("Ready for your review; some live steps were left for a supervised run");
    return { chip: "your review", title: "Every stage finished — open it to approve, send it back or discard it" };
  }
  if (card.status === "failed") {
    // Stopped on purpose, or set to try again by itself: nothing to decide.
    if (card.error === "stopped by user" || card.start_at) return null;
    if (stoppedBy(card)) return said("It was blocked — open the task for what it needs");
    return { chip: "needs you", title: "It failed — open it to retry, change it or drop it" };
  }
  return null;
}

type Linked = { id: string; title: string; status: TaskStatus };

/** What a task still waits for: the tasks it depends on that are not done (merged) yet (D52, D289). */
export function waitingOn(task: { depends_on: string[] }, byId: Map<string, Linked>): Linked[] {
  return task.depends_on.map((id) => byId.get(id)).filter((t): t is Linked => Boolean(t) && t!.status !== "done");
}

/** One line on what a waiting task needs, naming the one that needs you first: a failure, then a review. */
export function waitLine(blockers: Linked[]): string | null {
  if (!blockers.length) return null;
  const failed = blockers.find((b) => b.status === "failed");
  if (failed) return `“${failed.title}” failed — retry it, or remove the link to start without it`;
  const review = blockers.find((b) => b.status === "review");
  if (review) return `“${review.title}” is in review — approve it and this starts`;
  const names = blockers.map((b) => `“${b.title}”`);
  return `Starts after ${names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ")} ${names.length === 1 ? "is" : "are"} done`;
}
