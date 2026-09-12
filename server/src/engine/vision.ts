import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Provider } from "../types.ts";
import type { Resolved, StageInvocation } from "./providers/types.ts";
import { LEAN } from "./lean.ts";

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

function userMessage(content: string | unknown[]): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** The API takes an inline image up to 5 MB once base64-encoded; bigger files are opened with Read instead. */
const MAX_INLINE_BYTES = 3_700_000;

/**
 * A short brief instead of Claude Code's full system prompt. That prompt is tens of thousands of
 * tokens and is sent again on every turn: for a one-image job it was nearly all of the cost, and on
 * a large screenshot it ran the call into its budget cap before the answer came back.
 */
const VISION_SYSTEM =
  "You look at one image and describe it for a software engineer who cannot see it. Be concrete and complete; " +
  "copy visible text exactly. Answer with the structured output you are given.";

/**
 * Looks at one image with the cheap vision model and writes down what is in it.
 *
 * Done once, when the image is attached, so the stages that follow read a paragraph instead of
 * opening the image with whatever expensive model they happen to run on. The path still goes into
 * the prompt, so a stage that needs the pixels can open it — but it is no longer obliged to.
 */
export async function describeImage(
  input: { path: string; model: string; apply?: (o: Options) => Options },
  queryFn: QueryFn = query as unknown as QueryFn,
): Promise<{ text: string; cost_usd: number } | null> {
  // The image goes in the message itself: one turn, no tool call to open a file. Only a file too big
  // to send inline is opened with Read.
  const mime = IMAGE_MIME[extname(input.path).toLowerCase()];
  let inline: string | null = null;
  try {
    if (mime && statSync(input.path).size <= MAX_INLINE_BYTES) inline = readFileSync(input.path).toString("base64");
  } catch {
    inline = null;
  }
  const base: Options = {
    model: input.model,
    // Looking, not reasoning: low effort is the right setting, and the cheapest.
    effort: "low",
    cwd: dirname(input.path),
    systemPrompt: VISION_SYSTEM,
    ...LEAN,
    permissionMode: "dontAsk",
    // No tools when the picture is in the message; Read, for this one file, when it is not.
    tools: inline ? [] : ["Read"],
    maxTurns: 4,
    maxBudgetUsd: 0.15,
    outputFormat: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
  };
  // Claude Code on another endpoint (Kimi, GLM, Ollama, LM Studio…): the same job, pointed elsewhere.
  const options = input.apply ? input.apply(base) : base;
  const prompt = inline
    ? [{ type: "image", source: { type: "base64", media_type: mime, data: inline } }, { type: "text", text: "Describe this image." }]
    : `Read the image file \`${basename(input.path)}\` in this folder and describe it.`;

  let structured: unknown;
  let resultText = "";
  let cost = 0;
  try {
    for await (const msg of queryFn({ prompt: userMessage(prompt), options })) {
      if (msg.type === "result") {
        const r = msg as Extract<SDKMessage, { type: "result" }>;
        cost = r.total_cost_usd ?? 0;
        structured = (r as { structured_output?: unknown }).structured_output;
        if (r.subtype === "success" && !r.is_error) resultText = r.result ?? "";
      }
    }
  } catch {
    return null;
  }
  const s = structured as { description?: unknown; text_in_image?: unknown } | undefined;
  // A model that does not do structured output still usually answers in words: take those.
  const parsed = typeof s?.description === "string" && s.description.trim()
    ? { description: s.description.trim(), text: typeof s.text_in_image === "string" ? s.text_in_image.trim() : "" }
    : parseDescription(resultText);
  if (!parsed) return null;
  return { text: format(parsed), cost_usd: cost };
}

const format = (p: { description: string; text: string }) =>
  (p.text ? `${p.description}\n\nText in the image: ${p.text}` : p.description).slice(0, 2000);

/** What a model says when it could not actually see the picture. Treated as a failure, so the fallback runs. */
const BLIND = /\b(can(?:not|'t)|unable to|don't have the ability to|do not have the ability to)\s+(?:see|view|open|access|read|look at|process)\b[^.]{0,40}\b(image|picture|file|attachment)|\bno image (?:was |has been )?(?:attached|provided|included)/i;

/** The description out of a free-text answer: the JSON it was asked for, or failing that the words themselves. */
export function parseDescription(raw: string): { description: string; text: string } | null {
  const t = (raw ?? "").trim();
  if (!t || BLIND.test(t)) return null;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(t.slice(start, end + 1)) as { description?: unknown; text_in_image?: unknown };
      if (typeof j.description === "string" && j.description.trim()) {
        if (BLIND.test(j.description)) return null;
        return { description: j.description.trim(), text: typeof j.text_in_image === "string" ? j.text_in_image.trim() : "" };
      }
    } catch {
      // not JSON after all: use the text
    }
  }
  return t.length >= 20 ? { description: t.replace(/^```\w*\n?|```$/g, "").trim(), text: "" } : null;
}

/** For models without the SDK's structured output: the same brief, and the JSON shape to answer in. */
export const VISION_PROMPT =
  "Look at the attached image. Describe it for an engineer who cannot see it: what kind of image it is (screenshot, mockup, diagram, photo, error dialog), " +
  "what it shows, and anything obviously wrong or highlighted. Be concrete; no preamble. Then copy every piece of visible text verbatim. " +
  'Reply with only this JSON and nothing else: {"description": "...", "text_in_image": "..."}';

/**
 * Describes an image with whichever provider Settings → Intake models names. Claude and Claude Code
 * on other endpoints read the file through the SDK; a plain chat API gets the image inline; another
 * agent's CLI gets it attached (a copy with a plain name, so no path needs escaping). null when that
 * model could not produce a description — the caller then falls back to Claude.
 */
export async function describeImageVia(
  res: Resolved,
  model: string,
  path: string,
  deps: { queryFn: QueryFn; timeoutMs: number },
): Promise<{ text: string; cost_usd: number } | null> {
  const kind = res.adapter.kind;
  if (kind === "anthropic" || kind === "anthropic-compatible") {
    const apply = res.adapter.applyOptions && res.provider ? (o: Options) => res.adapter.applyOptions!(o, { provider: res.provider!, model, secret: res.secret }) : undefined;
    return describeImage({ path, model, apply }, deps.queryFn);
  }
  if (!res.adapter.run || !res.provider) return null;

  const dir = mkdtempSync(join(tmpdir(), "kanban-vision-"));
  const copy = join(dir, `image${extname(path).toLowerCase() || ".png"}`);
  try {
    copyFileSync(path, copy);
    const abort = new AbortController();
    const inv: StageInvocation = {
      run: { id: `vision-${Date.now()}` } as StageInvocation["run"], task: { id: "vision" } as StageInvocation["task"], project: {} as StageInvocation["project"],
      prompt: `${VISION_PROMPT}\n\nThe image is \`${basename(copy)}\` in the current folder (${copy}).`,
      cwd: dir, provider: res.provider as Provider, model, effort: "low", readOnly: true, mode: "supervised",
      abort: abort.signal, timeoutMs: deps.timeoutMs, secret: res.secret, images: [copy], emit: () => {}, log: () => {},
    };
    let text = "";
    for await (const msg of res.adapter.run(inv)) {
      if (msg.type === "result") {
        const r = msg as Extract<SDKMessage, { type: "result" }>;
        if (r.subtype === "success" && !r.is_error) text = r.result ?? "";
      }
    }
    const parsed = parseDescription(text);
    return parsed ? { text: format(parsed), cost_usd: 0 } : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a temp folder
    }
  }
}
