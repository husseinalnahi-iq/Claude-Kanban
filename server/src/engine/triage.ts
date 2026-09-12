import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, Priority, Stage, StageName, TaskType } from "../types.ts";
import { EFFORTS, PRIORITIES, TASK_TYPES } from "../types.ts";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

export interface TriageSubtask {
  title: string;
  spec_md: string;
  type: TaskType;
  /** 1-based indexes of the subtasks in this list that must finish first. */
  depends_on: number[];
  /** Files/globs this subtask will touch. Overlapping subtasks are serialised, never run in parallel. */
  files: string[];
}

/** The board's own call on whether this is one task or several, with the reason shown to the user. */
export interface SplitDecision {
  decision: "single" | "subtasks";
  reason: string;
}

/** A tier, not a model id: the board maps it to the id configured in Settings, so nothing is invented. */
export type Tier = "cheap" | "balanced" | "strong";
export const TIERS: Tier[] = ["cheap", "balanced", "strong"];

export interface SizedStage {
  stage: StageName;
  tier: Tier;
  effort: Effort;
}

/** The pipeline this task deserves, and why — proposed, never applied without a human. */
export interface Sizing {
  stages: SizedStage[];
  reason: string;
}

export interface TriageResult {
  title: string;
  type: TaskType;
  priority: Priority;
  labels: string[];
  spec_md: string;
  questions: string[];
  subtasks: TriageSubtask[];
  split: SplitDecision;
  /** null when the model gave nothing usable; the caller then keeps the project default. */
  sizing: Sizing | null;
  /** How sure the model is about type/labels, 0–1. Low confidence applies nothing. */
  confidence: number;
  cost_usd: number;
  model: string;
}

/** Below this, triage records a suggestion instead of labelling the task. */
export const CONFIDENCE_TO_APPLY = 0.7;

/** Shape the model must return. Small and closed: open vocabularies produce inconsistent labelling. */
function schemaFor(labelVocabulary: string[]) {
  return {
  type: "object",
  additionalProperties: false,
  required: ["title", "type", "priority", "labels", "spec_md", "questions", "split_reason", "subtasks", "confidence", "pipeline", "pipeline_reason"],
  properties: {
    title: { type: "string", description: "A short imperative title, max 70 characters." },
    type: { type: "string", enum: TASK_TYPES },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "How sure you are of type and labels. Below 0.7 the board keeps them as a suggestion for the human instead of applying them.",
    },
    priority: {
      type: "string",
      enum: PRIORITIES,
      description: "Suggestion only, a human decides: p0 = production broken or everything blocked, p1 = important and soon, p2 = normal, p3 = nice to have.",
    },
    labels: labelVocabulary.length
      ? { type: "array", maxItems: 3, items: { type: "string", enum: labelVocabulary }, description: "Pick only from this project's existing labels. Never invent one." }
      : { type: "array", maxItems: 0, items: { type: "string" }, description: "This project has no label vocabulary yet: return an empty list." },
    spec_md: {
      type: "string",
      description:
        "The rewritten task in markdown, in this order: what to change and why · '## Done when' — a checklist where each line is testable, written as 'WHEN <trigger> THE SYSTEM SHALL <behavior>' where that fits · '## Out of scope' · '## Verify' naming the command or the thing to look at. " +
        "Keep the requester's intent; invent nothing. Put anything genuinely unknown inline as '[NEEDS CLARIFICATION: question]', at most 3.",
    },
    questions: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
      description: "Multiple-choice-able questions for the human, asked once. Empty when the request is clear enough to start.",
    },
    pipeline: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description:
        "The stages this task actually needs, in order, each with the cheapest model tier that can do it well. " +
        "Most work does NOT need a plan stage or the strong tier: a one-file change is one `code` stage on `cheap` or `balanced`. " +
        "Reserve `strong` for work that is genuinely hard to get right — tricky logic, a design with real trade-offs, something touching many files at once. " +
        "Reserve `plan` for work where deciding the approach is the hard part, and `review` for work where a mistake would be expensive or hard to spot.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stage", "tier", "effort"],
        properties: {
          stage: { type: "string", enum: ["plan", "code", "review"] },
          tier: { type: "string", enum: ["cheap", "balanced", "strong"], description: "cheap = small fast model; balanced = the everyday model; strong = the most capable and most expensive." },
          effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "How long it may think. `low` for mechanical work; `high` and above only where thinking actually changes the answer." },
        },
      },
    },
    pipeline_reason: {
      type: "string",
      description: "One sentence to the requester on why that pipeline fits this task — name what makes it easy or hard, not a generality.",
    },
    split_reason: {
      type: "string",
      description:
        "One sentence, addressed to the requester, saying why you are splitting this or why you are keeping it as one task. Name the actual reason (\"the API and the UI can be built and checked separately\", \"this is a two-line change in one file\"), not a generality.",
    },
    subtasks: {
      type: "array",
      maxItems: 6,
      description:
        "Split ONLY when parts can be built and verified separately, and only into 3 or more pieces — otherwise return an empty list and let one session do it. Fewer, larger pieces beat many thin ones. Every subtask costs a full pipeline of its own, so splitting work that one session would do in one pass makes it slower and more expensive, not better.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "spec_md", "type", "depends_on", "files"],
        properties: {
          title: { type: "string" },
          spec_md: { type: "string", description: "Self-contained: a session sees this plus the parent spec, not the other subtasks' internals." },
          type: { type: "string", enum: TASK_TYPES },
          depends_on: {
            type: "array",
            items: { type: "integer", minimum: 1 },
            description: "1-based positions of EARLIER items in this list that must finish first.",
          },
          files: {
            type: "array",
            maxItems: 10,
            items: { type: "string" },
            description: "Files or globs this subtask will edit. Be honest and specific: the board runs subtasks in parallel only when their files do not overlap.",
          },
        },
      },
    },
  },
  } as const;
}

const GUIDANCE = `You are the intake desk of a software task board. You receive requests from people who are often not engineers.

Rules:
- Keep the requester's intent exactly. Never invent features, deadlines or constraints they did not ask for.
- Write the spec so a coding agent can start without asking anything: what changes, where, and how anyone can tell it worked.
- "Done when" items must be checkable by running or looking at something, never vague like "works well".
- Ask a question ONLY if you genuinely cannot write a sensible spec without the answer. Prefer a sensible default plus a note over a question.
- YOU decide whether this is one task or several — the requester should not have to. Say why in \`split_reason\` either way.
- Default to ONE task. Each subtask re-sends the system prompt, the skills and the context, and runs its own plan/code/review stages: three subtasks cost roughly three times one task. Splitting is only worth that when the parts can genuinely be built and verified separately, or when they must be owned by different sessions because they touch different files.
- If the whole change could be described in one sentence, or it lives in a single file, do not split it: return no subtasks.
- Split only into parts that can be built and verified separately, and give each the files it will touch. Two subtasks that edit the same file must depend on each other — parallel sessions editing one file overwrite each other.
- Choose the pipeline honestly. The strong tier and high effort cost several times what the cheap tier costs, and most tasks do not need them; a rename, a copy change, a config tweak or a small bug fix is one \`code\` stage on \`cheap\` or \`balanced\` at \`low\` effort. Spending more than the work needs is a defect, not caution.
- Priority is a suggestion for the human: p0 only for "production is broken or everything is blocked". Most things are p2.
- Be honest in \`confidence\`. A vague one-line request rarely deserves more than 0.5.`;

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

export interface TriageInput {
  title: string;
  spec_md: string;
  projectName: string;
  /** Recent project memory, so labels and conventions match what the board already knows. */
  memory?: string[];
  /** The project's closed label vocabulary. Triage may pick from it and nothing else. */
  knownLabels?: string[];
  /** Refine rewrites the spec and proposes subtasks; classify only fills in type/priority/labels. */
  mode: "classify" | "refine";
  cwd: string;
  model: string;
}

/**
 * One structured, read-only call. It never edits files: this is intake, not implementation.
 * Returns null when the model produced nothing usable, so callers can carry on without it.
 */
export async function triageTask(input: TriageInput, queryFn: QueryFn = query as unknown as QueryFn): Promise<TriageResult | null> {
  const parts = [
    GUIDANCE,
    input.mode === "classify"
      ? "\nClassify this request. Keep `spec_md` exactly as given and return no subtasks."
      : "\nRewrite this request into a proper task. Decide yourself whether it is one task or several, and justify that decision in `split_reason` — the requester is not expected to know.",
    `\n## Project\n${input.projectName}`,
    input.knownLabels?.length ? `\n## The only labels this project uses\n${input.knownLabels.join(", ")}` : "",
    input.memory?.length ? `\n## What the board knows about this project\n${input.memory.map((m) => `- ${m}`).join("\n")}` : "",
    `\n## Request title\n${input.title}`,
    `\n## Request body\n${input.spec_md.trim() || "(empty — work from the title)"}`,
  ];

  const options: Options = {
    model: input.model,
    effort: "low",
    cwd: input.cwd,
    // Intake reads nothing and writes nothing: no repo access, no tools, no user plugins or hooks.
    settingSources: [],
    permissionMode: "dontAsk",
    tools: [],
    maxTurns: 2,
    maxBudgetUsd: 0.5,
    outputFormat: { type: "json_schema", schema: schemaFor(input.knownLabels ?? []) as unknown as Record<string, unknown> },
  };

  let structured: unknown;
  let cost = 0;
  try {
    for await (const msg of queryFn({ prompt: userMessage(parts.filter(Boolean).join("\n")), options })) {
      if (msg.type === "result") {
        const r = msg as Extract<SDKMessage, { type: "result" }>;
        cost = r.total_cost_usd ?? 0;
        structured = (r as { structured_output?: unknown }).structured_output;
      }
    }
  } catch {
    return null;
  }
  if (!structured || typeof structured !== "object") return null;
  const s = structured as Record<string, unknown>;

  const type = TASK_TYPES.includes(s.type as TaskType) ? (s.type as TaskType) : "feature";
  const priority = PRIORITIES.includes(s.priority as Priority) ? (s.priority as Priority) : "p2";
  const raw = Array.isArray(s.subtasks)
    ? (s.subtasks as Record<string, unknown>[])
        .filter((x) => typeof x?.title === "string" && (x.title as string).trim())
        .slice(0, 6)
        .map((x, i, all) => ({
          title: String(x.title).slice(0, 120),
          spec_md: String(x.spec_md ?? ""),
          type: TASK_TYPES.includes(x.type as TaskType) ? (x.type as TaskType) : type,
          // Drop self-references and anything outside the list: a cycle would never become runnable.
          depends_on: Array.isArray(x.depends_on)
            ? (x.depends_on as number[]).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= all.length && n !== i + 1)
            : [],
          files: Array.isArray(x.files) ? (x.files as unknown[]).map(String).filter(Boolean).slice(0, 10) : [],
        }))
    : [];
  // Two subtasks that touch the same file must not run at once, whatever the model said.
  // Below three pieces the overhead of extra sessions outruns the benefit, so it stays one task.
  const subtasks = raw.length >= 3 ? serialiseFileConflicts(raw) : [];
  const modelReason = typeof s.split_reason === "string" ? s.split_reason.trim().slice(0, 300) : "";
  const split: SplitDecision = {
    decision: subtasks.length ? "subtasks" : "single",
    reason:
      subtasks.length || raw.length === 0
        ? modelReason || (subtasks.length ? "The parts can be built and checked separately." : "Small enough for one session to do in one pass.")
        : `Kept as one task: ${raw.length === 1 ? "only one piece was identified" : "two pieces is not enough to be worth a second session"}, and each extra subtask costs a full pipeline of its own.`,
  };

  const rawStages = Array.isArray(s.pipeline) ? (s.pipeline as Record<string, unknown>[]) : [];
  const stages: SizedStage[] = rawStages
    .filter((x) => ["plan", "code", "review"].includes(String(x?.stage)))
    .slice(0, 3)
    .map((x) => ({
      stage: String(x.stage) as StageName,
      tier: TIERS.includes(x.tier as Tier) ? (x.tier as Tier) : "balanced",
      effort: EFFORTS.includes(x.effort as Effort) ? (x.effort as Effort) : "medium",
    }));
  // A pipeline with no code stage would never change anything, whatever the model said.
  const sizing: Sizing | null = stages.some((x) => x.stage === "code")
    ? { stages, reason: typeof s.pipeline_reason === "string" ? s.pipeline_reason.trim().slice(0, 300) : "" }
    : null;

  return {
    title: String(s.title ?? input.title).slice(0, 120) || input.title,
    type,
    confidence: typeof s.confidence === "number" ? Math.min(1, Math.max(0, s.confidence)) : 0,
    priority,
    labels: Array.isArray(s.labels) ? (s.labels as unknown[]).map((l) => String(l).toLowerCase().trim()).filter(Boolean).slice(0, 4) : [],
    spec_md: input.mode === "classify" ? input.spec_md : String(s.spec_md ?? input.spec_md),
    questions: Array.isArray(s.questions) ? (s.questions as unknown[]).map(String).filter(Boolean).slice(0, 3) : [],
    subtasks,
    split,
    sizing,
    cost_usd: cost,
    model: input.model,
  };
}

/** Normalises a path/glob enough to spot "these two will fight over the same file". */
function fileKey(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function overlaps(a: string[], b: string[]): boolean {
  for (const x of a.map(fileKey)) {
    for (const y of b.map(fileKey)) {
      if (x === y) return true;
      // A directory glob covering the other's path counts as a conflict.
      const xDir = x.replace(/\/?\*+.*$/, "");
      const yDir = y.replace(/\/?\*+.*$/, "");
      if (xDir && (y.startsWith(`${xDir}/`) || y === xDir)) return true;
      if (yDir && (x.startsWith(`${yDir}/`) || x === yDir)) return true;
    }
  }
  return false;
}

/**
 * Adds a dependency between any two subtasks whose file sets overlap, so they run one after the other.
 * Anthropic's guidance is explicit that two agents editing the same file overwrite each other.
 */
export function serialiseFileConflicts(subtasks: TriageSubtask[]): TriageSubtask[] {
  return subtasks.map((s, i) => {
    const deps = new Set(s.depends_on);
    for (let j = 0; j < i; j++) {
      if (s.files.length && subtasks[j].files.length && overlaps(s.files, subtasks[j].files)) deps.add(j + 1);
    }
    return { ...s, depends_on: [...deps].sort((a, b) => a - b) };
  });
}

/** Pipeline for a subtask created by triage: inherit the parent's, else the project/board default. */
export function inheritPipeline(parent: Stage[], fallback: Stage[]): Stage[] {
  return parent.length ? parent : fallback;
}
