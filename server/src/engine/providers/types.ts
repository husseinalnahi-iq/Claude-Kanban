import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, Mode, Project, Provider, ProviderKind, ProviderTestResult, Run, Task } from "../../types.ts";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

/** Everything an adapter needs to run one stage without reaching back into the runner. */
export interface StageInvocation {
  run: Run;
  task: Task;
  project: Project;
  prompt: string;
  cwd: string;
  provider: Provider;
  model: string;
  effort: Effort;
  /** Plan/review stage, or a CLI provider that may not edit: launch without write access. */
  readOnly: boolean;
  mode: Mode;
  abort: AbortSignal;
  timeoutMs: number;
  secret: string | null;
  /** Board-side events (`delegate:command`, …). The runner stores and broadcasts them; payloads must already be redacted. */
  emit: (type: string, payload: unknown) => void;
  log: (line: string) => void;
}

/**
 * One way of running a stage. SDK-backed kinds reshape the Options the runner built; the others
 * produce the same SDK-shaped message stream the runner already knows how to consume — so cost,
 * transcript, loop detection and results all keep working (docs/DECISIONS.md D121).
 */
export interface ProviderAdapter {
  kind: ProviderKind | "anthropic";
  /** Can a later stage or chat continue this run's session? Only real Claude Code sessions can. */
  canResume: boolean;
  /** Does the model get tools? Text-only adapters are limited to plan and review stages. */
  hasTools: boolean;
  applyOptions?(options: Options, inv: { provider: Provider; model: string; secret: string | null }): Options;
  run?(inv: StageInvocation): AsyncIterable<SDKMessage>;
  test(p: Provider, model: string, secret: string | null, queryFn: QueryFn): Promise<ProviderTestResult>;
}

export interface Resolved {
  id: string;
  /** null for the built-in Anthropic provider. */
  provider: Provider | null;
  adapter: ProviderAdapter;
  secret: string | null;
  label: string;
}

/** Token counts in the SDK's own vocabulary, so one estimator serves every adapter. */
export interface TokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}
