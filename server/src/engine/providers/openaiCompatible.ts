import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Provider, ProviderTestResult } from "../../types.ts";
import type { ProviderAdapter, StageInvocation } from "./types.ts";

export type FetchFn = typeof fetch;

/** Injectable for tests; the real fetch otherwise. */
let fetchFn: FetchFn = (...args) => fetch(...args);
export function setFetch(fn: FetchFn): void {
  fetchFn = fn;
}

const SYSTEM =
  "You are one stage of a software task pipeline. You have no tools and cannot read files or run commands: work only from " +
  "what the message contains, say plainly what you could not check, and answer in markdown.";

interface ChatResponse {
  choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string } | string;
}

const isOpenRouter = (url: string) => /openrouter\.ai/i.test(url);

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** An image as a chat-completions content part: inlined, since the endpoint cannot read our disk. */
function imagePart(path: string) {
  const ext = extname(path).slice(1).toLowerCase();
  return { type: "image_url", image_url: { url: `data:${MIME[ext] ?? "image/png"};base64,${readFileSync(path).toString("base64")}` } };
}

function textOf(r: ChatResponse): string {
  const c = r.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => b.text ?? "").join("");
  return "";
}

/** Redact-safe error text: the status and a short piece of the body, never headers. */
function clip(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * One chat-completions call, presented as the SDK-shaped stream the runner already consumes
 * (docs/DECISIONS.md D121, D128). Text in, text out: no tools, so plan and review stages only.
 * OpenRouter is asked to include the price in `usage.cost`; other endpoints are priced from the table.
 */
export async function* runOpenAiCompatible(inv: StageInvocation): AsyncIterable<SDKMessage> {
  const base = (inv.provider.baseUrl ?? "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const t0 = Date.now();
  const session_id = inv.run.id;
  inv.emit("delegate:command", { kind: "http", method: "POST", url, model: inv.model });
  yield {
    type: "system", subtype: "init", session_id, model: inv.model, cwd: inv.cwd, tools: [], permissionMode: "dontAsk", mcp_servers: [],
    apiKeySource: "none", claude_code_version: "board-http", slash_commands: [], output_style: "", skills: [], plugins: [], agents: [],
  } as unknown as SDKMessage;

  const fail = (message: string): SDKMessage =>
    ({
      type: "result", subtype: "error_during_execution", is_error: true, session_id, errors: [message], num_turns: 1,
      duration_ms: Date.now() - t0, duration_api_ms: Date.now() - t0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
    }) as unknown as SDKMessage;

  if (inv.abort.aborted) {
    yield fail("stopped by user");
    return;
  }
  const timeout = AbortSignal.timeout(inv.timeoutMs);
  const signal = AbortSignal.any([inv.abort, timeout]);
  let res: Response;
  let body: ChatResponse;
  try {
    res = await fetchFn(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(inv.secret ? { authorization: `Bearer ${inv.secret}` } : {}),
        ...(isOpenRouter(base) ? { "HTTP-Referer": "https://github.com/claude-kanban", "X-OpenRouter-Title": "Claude Kanban" } : {}),
      },
      body: JSON.stringify({
        model: inv.model,
        stream: false,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: inv.images?.length ? [{ type: "text", text: inv.prompt }, ...inv.images.map(imagePart)] : inv.prompt }],
        ...(isOpenRouter(base) ? { usage: { include: true } } : {}),
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      yield fail(`HTTP ${res.status} from ${inv.provider.label}: ${clip(raw.replace(/\s+/g, " "))}`);
      return;
    }
    try {
      body = JSON.parse(raw) as ChatResponse;
    } catch {
      yield fail(`${inv.provider.label} returned something that is not JSON: ${clip(raw)}`);
      return;
    }
  } catch (err) {
    if (inv.abort.aborted) yield fail("stopped by user");
    else if (timeout.aborted) yield fail(`Timed out after ${Math.round(inv.timeoutMs / 60_000)} min waiting for ${inv.provider.label}.`);
    else yield fail(`Could not reach ${inv.provider.label} at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (body.error) {
    yield fail(`${inv.provider.label}: ${typeof body.error === "string" ? body.error : body.error.message ?? "error"}`);
    return;
  }
  const text = textOf(body);
  const u = body.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const inputTokens = Math.max(0, (u.prompt_tokens ?? 0) - cached);
  const outputTokens = u.completion_tokens ?? 0;
  const priced = typeof u.cost === "number";
  const contextWindow = inv.provider.models.find((m) => m.id === inv.model)?.contextWindow ?? 0;
  yield {
    type: "assistant", session_id, parent_tool_use_id: null,
    message: { role: "assistant", model: inv.model, content: [{ type: "text", text }], usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } },
  } as unknown as SDKMessage;
  yield {
    type: "result", subtype: "success", is_error: false, session_id, result: text, num_turns: 1, stop_reason: "end_turn",
    duration_ms: Date.now() - t0, duration_api_ms: Date.now() - t0,
    total_cost_usd: priced ? u.cost : 0,
    // Read by the runner: "provider" means the API itself priced the call (OpenRouter does).
    cost_source: priced ? "provider" : undefined,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
    modelUsage: {
      [inv.model]: {
        inputTokens, outputTokens, cacheReadInputTokens: cached, cacheCreationInputTokens: 0, webSearchRequests: 0,
        costUSD: priced ? u.cost : 0, contextWindow, maxOutputTokens: 0,
      },
    },
    permission_denials: [],
  } as unknown as SDKMessage;
}

export const openaiCompatibleAdapter: ProviderAdapter = {
  kind: "openai-compatible",
  canResume: false,
  hasTools: false,
  run: runOpenAiCompatible,
  async test(provider: Provider, model: string, secret: string | null): Promise<ProviderTestResult> {
    const out: ProviderTestResult = { ok: false, latencyMs: 0, modelEcho: null, usageReported: false, costReported: false, error: null };
    const t0 = Date.now();
    const abort = new AbortController();
    const inv: StageInvocation = {
      run: { id: "test" } as StageInvocation["run"], task: {} as StageInvocation["task"], project: {} as StageInvocation["project"],
      prompt: "Reply with exactly: ok", cwd: process.cwd(), provider, model, effort: "low", readOnly: true, mode: "supervised",
      abort: abort.signal, timeoutMs: 90_000, secret, emit: () => {}, log: () => {},
    };
    for await (const msg of runOpenAiCompatible(inv)) {
      if (msg.type === "result") {
        const r = msg as Extract<SDKMessage, { type: "result" }>;
        out.ok = r.subtype === "success" && !r.is_error;
        out.usageReported = Object.values(r.modelUsage ?? {}).some((m) => (m.inputTokens ?? 0) + (m.outputTokens ?? 0) > 0);
        out.costReported = (r.total_cost_usd ?? 0) > 0;
        out.modelEcho = out.ok ? model : null;
        if (!out.ok) out.error = (r as { errors?: string[] }).errors?.join("\n") ?? r.subtype;
      }
    }
    out.latencyMs = Date.now() - t0;
    return out;
  },
};
