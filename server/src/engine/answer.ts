import { ANTHROPIC_PROVIDER_ID, type Settings, type Stage } from "../types.ts";

/**
 * An answer card: one stage that finds what was asked and reports it, changing nothing (D284). A
 * lookup run through plan → code → review on Opus cost $1.57 to read one number. It is a `custom`
 * stage carrying this prompt, so no schema learns a new stage name. Pure: the web imports it.
 */
const ANSWER_HEAD = "Answer the request below: find what it asks for and report it.";

export const ANSWER_PROMPT = [
  ANSWER_HEAD,
  "Change nothing: no file in the project, and nothing in any live system or account. Read, query and look only. If the answer can only be had by changing something, stop and say what change and why instead of making it.",
  "Use whatever reaches the answer most directly — the project's own scripts, tools and notes, a read-only query, an API read — and build nothing new for it.",
  "Reply with the answer itself first, plainly, in a line or a short table; then, in a sentence, where it came from. Your reply is shown to the person as it is.",
].join("\n");

/** Recognised by the prompt's first line, so a later rewording of the rest still counts old cards as answers. */
export const isAnswerStage = (s: Pick<Stage, "stage" | "prompt">): boolean => s.stage === "custom" && Boolean(s.prompt?.startsWith(ANSWER_HEAD));

export const isAnswerPipeline = (p: Pick<Stage, "stage" | "prompt">[]): boolean => p.length > 0 && p.every(isAnswerStage);

/**
 * The everyday model at medium effort: reading and reporting is not where Opus earns its price. A
 * lookup needs tools, which only a Claude login gives, so another provider's balanced tier is not used.
 */
export function answerStage(settings: Pick<Settings, "tiers">): Stage {
  const t = settings.tiers.balanced;
  const model = !t.provider || t.provider === ANTHROPIC_PROVIDER_ID ? t.model : "sonnet";
  return { stage: "custom", model, effort: "medium", prompt: ANSWER_PROMPT };
}

/** "answer" for an answer stage, the stage's own name otherwise: what a pipeline line shows. */
export const stageLabel = (s: Pick<Stage, "stage" | "prompt">): string => (isAnswerStage(s) ? "answer" : s.stage);
