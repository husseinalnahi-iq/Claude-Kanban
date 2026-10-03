import { DEBATE_ROUND_CEILING, type Objection } from "../types.ts";
import { clamp } from "./prompts.ts";

/**
 * Plan debate (docs/DECISIONS.md D131, D339): a critic lists objections, the planner answers each and
 * revises, and a human picks. No voting — the objections are the product. Settings decide how many
 * rounds: one, a fixed number, or until the critic has nothing left to object to.
 */

const LIMITS = { spec: 6000, plan: 12000, critique: 6000, answers: 3000 };

/**
 * Where a round stands, so both models argue knowing the shape of the debate: a critic that knows
 * there is no second chance lists everything; a planner on the last round knows its plan is final.
 * `of` is absent when the debate runs until the critic agrees.
 */
export interface DebateRound {
  n: number;
  of?: number;
  last: boolean;
}

/** One sentence each model is told about the round it is in. */
function roundNote(round: DebateRound | undefined, who: "critic" | "planner"): string[] {
  if (!round) return [];
  if (round.of === 1) {
    return [who === "critic"
      ? "This is a one-time debate: there is no second round, so list everything that matters now. The planner answers once and a human picks."
      : "This is a one-time debate: there is no second round, so your revised plan is final — fold in everything you accept."];
  }
  if (round.of !== undefined) {
    const where = `Round ${round.n} of ${round.of}`;
    if (round.last) {
      return [who === "critic"
        ? `${where}: this is the last round. Only objections that still matter belong here — the planner revises once more and a human picks.`
        : `${where}: this is the last round. Your revised plan is final — fold in everything you accept.`];
    }
    return [`${where}. ${who === "critic" ? "The planner answers, then you see the revised plan again." : "The critic reads your revised plan again next round."}`];
  }
  return [who === "critic"
    ? `Round ${round.n}. The debate goes on until you have no objections left: object only to what truly matters, and answer \`No objections.\` as soon as the plan is sound.`
    : `Round ${round.n}. The debate goes on until the critic has no objections left: settle what you can now.`];
}

export function buildCriticPrompt(ctx: {
  title: string; spec_md: string; plan: string; earlier?: { stage: string; result: string }[];
  round?: DebateRound;
  /** The planner's ACCEPT / REBUT answers from the previous round, so the critic does not repeat a settled point. */
  previousAnswers?: string;
}): string {
  return [
    "# Plan critique",
    "Another model wrote an implementation plan for the task below. You are the critic: find what is wrong, risky, missing or " +
      "over-built before any code is written. Do not praise, do not rewrite the plan, do not pad. Verify what you can by reading the code.",
    ...roundNote(ctx.round, "critic"),
    "",
    "Answer with a numbered list of at most 8 objections, most important first, each in exactly this shape:",
    "",
    "1. Severity: high | medium | low",
    "   Claim: <what is wrong, in one or two sentences>",
    "   Change: <the concrete change to the plan that fixes it>",
    "",
    "If the plan is sound, answer with the single line `No objections.`",
    "",
    `## Task: ${ctx.title}`,
    clamp(ctx.spec_md, LIMITS.spec) || "(no spec — the title is all there is)",
    ...(ctx.earlier ?? []).map((e) => `\n## Earlier stage result (${e.stage})\n${clamp(e.result, 1500)}`),
    ...(ctx.previousAnswers?.trim()
      ? ["", "## The planner's answers to the previous round", "Do not repeat a point the planner rebutted unless the rebuttal is wrong.", clamp(ctx.previousAnswers, LIMITS.answers)]
      : []),
    "",
    ctx.round && ctx.round.n > 1 ? "## The revised plan" : "## The plan",
    clamp(ctx.plan, LIMITS.plan),
  ].join("\n");
}

/**
 * Sent back to the planner. When its session can be resumed it already holds the plan; when it
 * cannot (HTTP / CLI provider), the current plan travels with the critique.
 */
export function buildRevisionPrompt(critique: string, originalPlan?: string, round?: DebateRound): string {
  return [
    "# Revision",
    "A second model reviewed your plan and raised the objections below. For each one, write `ACCEPT` or `REBUT` followed by one line " +
      "saying why. Then write the complete plan again — with the accepted changes folded in — under a heading `## Revised plan`. " +
      "Keep everything that still holds; do not shorten the plan to save space.",
    ...roundNote(round, "planner"),
    ...(originalPlan ? ["", "## Your plan", clamp(originalPlan, LIMITS.plan)] : []),
    "",
    "## Objections",
    clamp(critique, LIMITS.critique),
  ].join("\n");
}

/** Reads the critic's list. Tolerant: numbered or bulleted, bold or plain labels; anything else becomes one objection. */
export function parseCritique(text: string): { raw: string; objections: Objection[] } {
  const raw = text.trim();
  if (!raw || /^\W*no objections?\b/i.test(raw)) return { raw, objections: [] };
  const objections: Objection[] = [];
  // Split on list markers that start a line: "1." "1)" "-" "*"
  const items = raw.split(/\n(?=\s*(?:\d+[.)]|[-*•])\s+)/);
  for (const item of items) {
    const sev = /\bseverity\b\W*\s*(high|medium|low)/i.exec(item);
    const claim = /\bclaim\b\W*\s*([\s\S]*?)(?=\n\s*\**\s*change\b|$)/i.exec(item);
    const change = /\bchange\b\W*\s*([\s\S]*?)$/i.exec(item);
    if (!sev && !claim) continue;
    objections.push({
      n: objections.length + 1,
      severity: (sev?.[1]?.toLowerCase() as Objection["severity"]) ?? "medium",
      claim: (claim?.[1] ?? item).replace(/\s+/g, " ").trim().slice(0, 600),
      change: (change?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
    });
  }
  if (!objections.length) objections.push({ n: 1, severity: "medium", claim: raw.replace(/\s+/g, " ").slice(0, 600), change: "" });
  return { raw, objections: objections.slice(0, 8) };
}

const REVISED_HEADING = /^#{1,3}\s*revised plan\s*$/im;

/** The plan after revision: the `## Revised plan` section when present, else the whole answer. */
export function extractRevisedPlan(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  const m = REVISED_HEADING.exec(t);
  return m ? t.slice(m.index + m[0].length).trim() : t;
}

/** The planner's ACCEPT / REBUT lines: what comes before `## Revised plan`, or nothing when there is no such heading. */
export function extractRevisionAnswers(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  const m = REVISED_HEADING.exec(t);
  return m ? t.slice(0, m.index).trim() : "";
}

/** How many rounds a debate may run, by mode; `undefined` for a debate that runs until the critic agrees. */
export function debateRoundLimit(d: { mode?: string; rounds?: number }): number | undefined {
  if (d.mode === "until_agree") return undefined;
  if (d.mode === "rounds") return Math.max(1, Math.min(DEBATE_ROUND_CEILING, Math.floor(d.rounds ?? 1)));
  return 1;
}
