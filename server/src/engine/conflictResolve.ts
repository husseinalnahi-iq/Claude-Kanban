/**
 * Conflict resolution (D107, D354–D358): what the session that wrote a task is told when the base it is
 * about to land on has moved and now conflicts with it, and what a second model is asked about the
 * result. Pure, so it can be tested and imported by the web.
 */
import type { LostLines, ResolutionCheck } from "../types.ts";

/** One change that arrived on the base since the task's branch split from it. */
export interface OtherSide {
  title: string;
  /** What that change was for — its task's summary or spec — when the board knows. */
  goal?: string | null;
}

/** Tries before a conflict goes back to you: one, and one more told exactly what failed. */
export const RESOLVE_ATTEMPTS = 2;

const GOAL_LIMIT = 600;

function clip(text: string, limit: number): string {
  const t = text.trim().replace(/\s+\n/g, "\n");
  return t.length > limit ? `${t.slice(0, limit).trimEnd()}…` : t;
}

function othersBlock(base: string, landed: OtherSide[]): string[] {
  if (!landed.length) return [];
  // Without this the resolver only sees code it did not write, and "keep their change" means nothing.
  const lines = [`What landed on "${base}" since this task started — each was made deliberately and must survive:`];
  for (const o of landed) {
    lines.push(`- ${o.title}`);
    if (o.goal?.trim()) lines.push(...clip(o.goal, GOAL_LIMIT).split("\n").map((l) => `  ${l}`));
  }
  return [...lines, ""];
}

export function buildResolvePrompt(ctx: {
  branch: string;
  base: string;
  baseSha: string;
  conflicts: string[];
  landed: OtherSide[];
  /** Why the previous attempt was set aside, when this is a retry. */
  problems?: string[];
}): string {
  const lines: string[] = [];
  if (ctx.problems?.length) {
    lines.push(
      "Your previous resolution was checked by the board and set aside — the branch is back where it was before it. What failed:",
      ...ctx.problems.map((p) => `- ${p}`),
      "",
      "The merge has been started again. Resolve it once more, fixing exactly that.",
      "",
    );
  }
  lines.push(
    `"${ctx.base}" has moved on since this task started, and the board is merging it (commit ${ctx.baseSha.slice(0, 10)}) into "${ctx.branch}" in this worktree. These files conflict: ${ctx.conflicts.join(", ")}.`,
    "",
    ...othersBlock(ctx.base, ctx.landed),
    // zdiff3 adds the common original between the two sides; seeing what both started from is what
    // lets a conflict be combined rather than decided.
    "The merge is already in progress. Each conflict shows this task's side, the original (after `|||||||`), and the other side.",
    "",
    "Rules:",
    "- Keep both sides' intent. Combine them; never resolve a conflict by taking one side whole.",
    "- Edit only the conflicted files. Every other file was merged by git already and must stay as it is.",
    "- Remove every conflict marker. Do not commit, abort, rebase or reset: the board commits the merge and then checks it.",
    "- Make sure the project's checks still pass.",
    "",
    "The board then checks that no conflict marker is left, that both histories are in the merge, that files outside the conflict match git's own merge, and that every line either side added is still there or explained. A second reviewer reads the result.",
    "",
    "Report, for each conflicted file: what you kept from this task, what you kept from the other side, and any line you changed or dropped and why.",
  );
  return lines.join("\n");
}

const DIFF_LIMIT = 12_000;

export function buildReviewPrompt(ctx: {
  title: string;
  goal: string;
  base: string;
  landed: OtherSide[];
  conflicts: string[];
  /** merge-base → this task, merge-base → the base, merge-base → the result, for the conflicted files. */
  taskSide: string;
  baseSide: string;
  result: string;
  lost: LostLines[];
  outside: string[];
  report: string;
}): string {
  const lines = [
    `Two changes to the same code met in a merge, and another session resolved the conflict. You check that nothing either side meant to do was lost. You change nothing.`,
    "",
    `This task: ${ctx.title}`,
    ...(ctx.goal.trim() ? clip(ctx.goal, GOAL_LIMIT).split("\n").map((l) => `  ${l}`) : []),
    "",
    ...othersBlock(ctx.base, ctx.landed),
    `Conflicted files: ${ctx.conflicts.join(", ")}`,
    "",
    "What this task changed (from where the two split):",
    "```diff", clip(ctx.taskSide, DIFF_LIMIT), "```",
    "",
    `What "${ctx.base}" changed meanwhile:`,
    "```diff", clip(ctx.baseSide, DIFF_LIMIT), "```",
    "",
    "The resolved result, against that same starting point:",
    "```diff", clip(ctx.result, DIFF_LIMIT), "```",
    "",
  ];
  if (ctx.lost.length) {
    lines.push("Lines a side added that the result no longer has word for word — each must be justified (merged into a combined line, or genuinely superseded), or it was lost:");
    for (const l of ctx.lost) lines.push(`- ${l.file} (${l.side === "task" ? "this task" : ctx.base}): ${l.lines.map((x) => `\`${x}\``).join(", ")}`);
    lines.push("");
  }
  if (ctx.outside.length) lines.push(`Files changed outside the conflict (git had merged these itself): ${ctx.outside.join(", ")}. Each needs a reason.`, "");
  lines.push(
    "The resolver's own account:",
    clip(ctx.report || "(none given)", 4000),
    "",
    "Answer in a few lines: anything from either side that is missing or changed in meaning, with the file. Then end with exactly one line:",
    "VERDICT: BOTH KEPT — every change from both sides survives, in intent if not word for word",
    "VERDICT: LOST — something either side did is missing or broken (say what above)",
  );
  return lines.join("\n");
}

/** The reviewer's last VERDICT line. null when it gave none: an unconfirmed review is not a pass. */
export function parseReviewVerdict(text: string | null | undefined): "kept" | "lost" | null {
  const matches = [...(text ?? "").matchAll(/VERDICT:\s*\**\s*(BOTH KEPT|LOST)/gi)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].toUpperCase() === "LOST" ? "lost" : "kept";
}

/** What the next attempt is told, from what failed. */
export function problemsFrom(checks: ResolutionCheck[], review: string | null): string[] {
  const out = checks.filter((c) => !c.ok).map((c) => c.detail);
  if (review?.trim() && checks.some((c) => c.id === "review" && !c.ok)) out.push(`The reviewer said: ${clip(review, 1500)}`);
  return out;
}
