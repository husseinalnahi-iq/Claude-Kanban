import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TaskRunner } from "./runner.ts";
import { DEFAULT_VISION_MODEL } from "../db.ts";
import { ConflictError } from "./runner.ts";

/**
 * A command the fixed table (explain.ts) does not know, explained by Claude's cheapest model on request
 * (D336): one short answer, no tools, remembered for the life of the process so the same command is
 * never paid for twice. Only when a person presses the button; nothing here runs on its own.
 */
export class ExplainService {
  private cache = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();

  constructor(private runner: TaskRunner) {}

  explain(command: string): Promise<string> {
    const key = command.trim();
    if (!key) throw new ConflictError("Nothing to explain.");
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.ask(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async ask(command: string): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 45_000);
    timer.unref?.();
    const options: Options = {
      model: DEFAULT_VISION_MODEL,
      cwd: process.cwd(),
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      permissionMode: "dontAsk",
      maxTurns: 1,
      maxBudgetUsd: 0.05,
      abortController: abort,
      systemPrompt: "You explain shell commands to people who are not programmers. Answer in one or two short sentences: what the command does and what it changes, in plain words, no jargon unexplained, no preamble.",
    };
    let text = "";
    try {
      const prompt = (async function* () {
        yield { type: "user", message: { role: "user", content: `Explain this command:\n\n${command}` }, parent_tool_use_id: null } as SDKUserMessage;
      })();
      for await (const raw of this.runner.sdkQuery({ prompt, options })) {
        const msg = raw as { type?: string; result?: string; is_error?: boolean; errors?: string[]; message?: { content?: { type: string; text?: string }[] } };
        if (msg.type === "assistant") for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
        if (msg.type === "result" && msg.is_error) throw new Error((msg.errors ?? []).join("; ") || "Claude could not answer.");
      }
    } finally {
      clearTimeout(timer);
    }
    const answer = text.trim();
    if (!answer) throw new ConflictError("Claude gave no answer. Try again in a moment.");
    this.cache.set(command, answer);
    return answer;
  }
}
