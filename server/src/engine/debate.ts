import type { Objection } from "../types.ts";
import { clamp } from "./prompts.ts";

/**
 * One round of plan debate (docs/DECISIONS.md D131): a critic lists objections, the planner answers
 * each and revises, and a human picks. No voting, no loop — the objections are the product.
 */

const LIMITS = { spec: 6000, plan: 12000, critique: 6000 };

export function buildCriticPrompt(ctx: { title: string; spec_md: string; plan: string; earlier?: { stage: string; result: string }[] }): string {
  return [
    "# Plan critique",
    "Another model wrote an implementation plan for the task below. You are the critic: find what is wrong, risky, missing or " +
      "over-built before any code is written. Do not praise, do not rewrite the plan, do not pad. Verify what you can by reading the code.",
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
    "",
    "## The plan",
    clamp(ctx.plan, LIMITS.plan),
  ].join("\n");
}

/**
 * Sent back to the planner. When its session can be resumed it already holds the plan; when it
 * cannot (HTTP / CLI provider), the original plan travels with the critique.
 */
export function buildRevisionPrompt(critique: string, originalPlan?: string): string {
  return [
    "# Revision",
    "A second model reviewed your plan and raised the objections below. For each one, write `ACCEPT` or `REBUT` followed by one line " +
      "saying why. Then write the complete plan again — with the accepted changes folded in — under a heading `## Revised plan`. " +
      "Keep everything that still holds; do not shorten the plan to save space.",
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

/** The plan after revision: the `## Revised plan` section when present, else the whole answer. */
export function extractRevisedPlan(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  const m = /^#{1,3}\s*revised plan\s*$/im.exec(t);
  return m ? t.slice(m.index + m[0].length).trim() : t;
}
