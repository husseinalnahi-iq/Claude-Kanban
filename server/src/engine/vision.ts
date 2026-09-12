import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { basename, dirname } from "node:path";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "text_in_image"],
  properties: {
    description: {
      type: "string",
      description:
        "What is in the image, for an engineer who cannot see it. Say what kind of image it is (screenshot, mockup, diagram, photo, error dialog), what it shows, and anything obviously wrong or highlighted. Concrete and specific; no preamble, no 'this image shows'.",
    },
    text_in_image: {
      type: "string",
      description: "Every piece of text visible in the image, verbatim — error messages, labels, numbers. Empty string if there is none.",
    },
  },
} as const;

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

/**
 * Looks at one image with the cheap vision model and writes down what is in it.
 *
 * Done once, when the image is attached, so the stages that follow read a paragraph instead of
 * opening the image with whatever expensive model they happen to run on. The path still goes into
 * the prompt, so a stage that needs the pixels can open it — but it is no longer obliged to.
 */
export async function describeImage(
  input: { path: string; model: string },
  queryFn: QueryFn = query as unknown as QueryFn,
): Promise<{ text: string; cost_usd: number } | null> {
  const options: Options = {
    model: input.model,
    effort: "low",
    cwd: dirname(input.path),
    // Read is the only tool it gets, and only so it can open this one file.
    settingSources: [],
    permissionMode: "dontAsk",
    tools: ["Read"],
    maxTurns: 4,
    maxBudgetUsd: 0.15,
    outputFormat: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
  };
  const prompt = `Read the image file \`${basename(input.path)}\` in this folder and describe it.`;

  let structured: unknown;
  let cost = 0;
  try {
    for await (const msg of queryFn({ prompt: userMessage(prompt), options })) {
      if (msg.type === "result") {
        const r = msg as Extract<SDKMessage, { type: "result" }>;
        cost = r.total_cost_usd ?? 0;
        structured = (r as { structured_output?: unknown }).structured_output;
      }
    }
  } catch {
    return null;
  }
  const s = structured as { description?: unknown; text_in_image?: unknown } | undefined;
  const description = typeof s?.description === "string" ? s.description.trim() : "";
  if (!description) return null;
  const text = typeof s?.text_in_image === "string" ? s.text_in_image.trim() : "";
  return { text: text ? `${description}\n\nText in the image: ${text}`.slice(0, 2000) : description.slice(0, 2000), cost_usd: cost };
}
