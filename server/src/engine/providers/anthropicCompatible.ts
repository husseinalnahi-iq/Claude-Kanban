import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Provider, ProviderTestResult } from "../../types.ts";
import type { ProviderAdapter, QueryFn } from "./types.ts";

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

/**
 * The real Claude Code, pointed at another Anthropic-shaped endpoint (docs/DECISIONS.md D122).
 *
 * Everything the board relies on — the board MCP server, canUseTool, hooks, the worktree, the
 * transcript — is Claude Code's, so it all keeps working; only the model behind the API changes.
 * Claude-only controls (effort, fast mode) are dropped: a foreign endpoint rejects or ignores them.
 * Every model alias Claude Code might reach for (opus, sonnet, haiku, fable, subagents) is pinned
 * to the same id, so a subagent or a background call never asks a GLM endpoint for "claude-haiku".
 * Claude Code's own budget ceiling is dropped too: it prices a model id it does not know as a Claude
 * model, so a free local model hit a $0.20 cap on a one-word test. The board meters these stages
 * itself from your price table (D124).
 */
export function applyAnthropicCompatible(options: Options, inv: { provider: Provider; model: string; secret: string | null }): Options {
  const { effort: _effort, settings: _settings, maxBudgetUsd: _budget, ...rest } = options;
  // Most endpoints take the key as a bearer token; Kimi Code documents it as an API key. Only one is
  // ever set: the other is blanked, so a key the board itself runs with never leaves for this endpoint.
  const asKey = inv.provider.authStyle === "api-key";
  return {
    ...rest,
    model: inv.model,
    env: {
      ...(options.env ?? {}),
      ANTHROPIC_BASE_URL: inv.provider.baseUrl ?? "",
      ANTHROPIC_AUTH_TOKEN: asKey ? "" : inv.secret ?? "",
      ANTHROPIC_API_KEY: asKey ? inv.secret ?? "" : "",
      ANTHROPIC_MODEL: inv.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: inv.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: inv.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: inv.model,
      ANTHROPIC_DEFAULT_FABLE_MODEL: inv.model,
      CLAUDE_CODE_SUBAGENT_MODEL: inv.model,
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
    },
  };
}

export const anthropicCompatibleAdapter: ProviderAdapter = {
  kind: "anthropic-compatible",
  canResume: true,
  hasTools: true,
  applyOptions: applyAnthropicCompatible,
  test: (provider, model, secret, queryFn) => testThroughSdk(provider, model, secret, queryFn, applyAnthropicCompatible),
};

/** The built-in default: Claude through your Claude Code login. Options pass through untouched. */
export const anthropicAdapter: ProviderAdapter = {
  kind: "anthropic",
  canResume: true,
  hasTools: true,
  test: (provider, model, secret, queryFn) => testThroughSdk(provider, model, secret, queryFn, (o) => o),
};

/** One tiny turn through the exact options a stage would use (docs/DECISIONS.md D136). */
export async function testThroughSdk(
  provider: Provider,
  model: string,
  secret: string | null,
  queryFn: QueryFn,
  apply: (o: Options, inv: { provider: Provider; model: string; secret: string | null }) => Options,
): Promise<ProviderTestResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  const t0 = Date.now();
  const out: ProviderTestResult = { ok: false, latencyMs: 0, modelEcho: null, usageReported: false, costReported: false, error: null };
  const base: Options = {
    model, cwd: process.cwd(), maxTurns: 1, maxBudgetUsd: 0.2, tools: [], settingSources: [], permissionMode: "dontAsk",
    abortController: abort, env: { ...process.env },
  };
  try {
    for await (const msg of queryFn({ prompt: userMessage("Reply with exactly: ok"), options: apply(base, { provider, model, secret }) })) {
      const m = msg as SDKMessage & { model?: string; subtype?: string };
      if (m.type === "system" && m.subtype === "init") out.modelEcho = m.model ?? null;
      if (m.type === "result") {
        const r = m as Extract<SDKMessage, { type: "result" }>;
        out.usageReported = Object.keys(r.modelUsage ?? {}).length > 0;
        out.costReported = (r.total_cost_usd ?? 0) > 0;
        out.ok = r.subtype === "success" && !r.is_error;
        if (!out.ok) out.error = r.subtype === "success" ? r.result : (r.errors ?? []).join("\n") || r.subtype;
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  out.latencyMs = Date.now() - t0;
  if (!out.ok && !out.error) out.error = "The session ended without a result.";
  return out;
}
