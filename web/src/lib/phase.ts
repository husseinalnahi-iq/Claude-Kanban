import { PREPARING_COPY, accessAsk, stoppedBy, type TaskCard, type TaskStatus } from "../../../server/src/types.ts";

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
  // Approve met a conflict: Claude is combining it with what landed meanwhile, and it lands by itself
  // after. "coding" here read as the work being redone after you approved it.
  if (card.resolution && ["resolving", "checking", "reviewing"].includes(card.resolution.state)) {
    return { text: "merging", tone: "border-moss/60 text-moss", title: `You approved it. It conflicted with what landed on ${card.resolution.base} meanwhile, so Claude is combining the two — it lands by itself when that passes` };
  }
  // Started, making its own copy of the project before the first stage (D416).
  if (card.summary === PREPARING_COPY) return { text: "preparing", tone: "border-slate/50 text-slate", title: "Making its own copy of the project — a minute or two on a big one; then the first stage starts" };
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
export function waitsOnYou(card: TaskCard, asking?: boolean): { chip: string | null; title: string; action: string } | null {
  if (card.archived_at) return null;
  // `action` is the card's "your turn" line: chips alone were too quiet to tell a plan waiting for you
  // from one still being written.
  const said = (title: string, action: string) => ({ chip: null, title, action });
  const open = card.questions?.filter((q) => !q.answer).length ?? 0;
  if (card.status === "approval" && card.plan_gate && !asking) return said(phase(card, asking).title, "Approve the plan");
  if (open) return said("Claude asked you something — open the task to answer", `Answer ${open} question${open === 1 ? "" : "s"}`);
  if (card.status === "approval") return said(phase(card, asking).title, asking ? "Answer its question" : "Allow or deny a step");
  if (card.status === "paused" && (card.pause_reason === "cost" || (card.pause_reason === "provider" && !card.resume_at))) return said(phase(card).title, card.pause_reason === "cost" ? "Continue or stop — cost limit" : "Switch provider or top up");
  if (card.status === "backlog" && card.setup_pending) return said("Check its mode and models, then press Start", "Check setup, then Start");
  if (card.status === "review") {
    if (card.resolution?.state === "failed") return said("The conflict could not be resolved safely — open the task", "Fix the conflict");
    // Claude is still at work on it: the review stage, or combining it with what landed meanwhile.
    if (card.resolution && ["resolving", "checking", "reviewing"].includes(card.resolution.state)) return null;
    if (card.stage_states.includes("running")) return null;
    // An autonomous run that reached review but still lacks an access it named: the card asks for exactly
    // that, and signing in (or adding the key) runs the stage again on its own (D410).
    if (card.blocked?.advisory && card.mode === "autonomous" && card.blocked.needs_access) return said(`It is done bar one step that needs access — ${accessAsk(card.blocked)?.toLowerCase()}`, accessAsk(card.blocked) ?? "Give it the access it named");
    if (card.blocked?.advisory && card.mode === "autonomous") return said("Ready for your review; a step was left that needs access you can give", "Review it");
    return said("Every stage finished — open it to approve, send it back or discard it", "Review and approve");
  }
  if (card.status === "failed") {
    // Stopped on purpose, or set to try again by itself: nothing to decide.
    if (card.error === "stopped by user" || card.start_at) return null;
    if (stoppedBy(card)) return said("It was blocked — open the task for what it needs", "See what it needs");
    return said("It failed — open it to retry, change it or drop it", "Retry, change or drop it");
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
