import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { SecretStore } from "../src/secrets.ts";
import type { WsMessage } from "../src/types.ts";

export type Call = { prompt: string; options: Record<string, any> };

export interface FakeOpts {
  sessionId?: string;
  fail?: boolean;
  /** End with the SDK's turn-cap result (error_max_turns): the session is intact. */
  maxTurns?: boolean;
  askWrite?: boolean;
  result?: string;
  /** Override the result's cost / usage (foreign providers report $0 from the SDK). */
  cost?: number;
  modelUsage?: Record<string, any>;
  /** Extra messages yielded before the result, e.g. rate_limit_event or assistant turns with usage. */
  extra?: any[];
  /** Per-call overrides by call index: lets one fake play plan, critic and revision differently. */
  byCall?: (index: number) => Partial<FakeOpts> | undefined;
}

/** Fake SDK: records calls, optionally asks permission for a Write, then returns a result. */
export function fakeQuery(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const decisions: any[] = [];
  const fn: QueryFn = (params) => {
    return (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const index = calls.length;
      calls.push({ prompt, options: params.options as Record<string, any> });
      const o = { ...opts, ...(opts.byCall?.(index) ?? {}) };
      const session_id = o.sessionId ?? "s1";
      yield { type: "system", subtype: "init", session_id, model: params.options.model } as any;
      if (o.askWrite) {
        const d = await params.options.canUseTool!("Write", { file_path: "x.txt", content: "hi" }, {
          signal: new AbortController().signal, toolUseID: "tu1", title: "Claude wants to write x.txt",
        } as any);
        decisions.push(d);
      }
      for (const m of o.extra ?? []) {
        if (params.options.abortController?.signal.aborted) return;
        yield { session_id, ...m } as any;
      }
      if (params.options.abortController?.signal.aborted) return;
      yield { type: "assistant", session_id, message: { content: [{ type: "text", text: "working" }] } } as any;
      if (o.maxTurns) {
        yield { type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (60)"], total_cost_usd: 0.003, session_id, modelUsage: {} } as any;
        return;
      }
      if (o.fail) {
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [typeof o.fail === "string" ? o.fail : "boom"], total_cost_usd: 0.002, session_id, modelUsage: {} } as any;
        throw new Error("Claude Code process exited with code 1");
      }
      yield {
        type: "result", subtype: "success", is_error: false, result: o.result ?? "DONE", total_cost_usd: o.cost ?? 0.01, session_id,
        modelUsage: o.modelUsage ?? { m: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      } as any;
    })();
  };
  return { fn, calls, decisions };
}

export function setup(queryFn: QueryFn, policy: Record<string, unknown> = {}, extra: { secrets?: SecretStore } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "krun-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const seen: WsMessage[] = [];
  bus.subscribe((m) => seen.push(m));
  const project = repo.createProject({
    name: "scratch", path: dir,
    policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3, ...policy } as any,
  });
  const secrets = extra.secrets ?? new SecretStore(":memory:");
  const runner = new TaskRunner({ repo, bus, queryFn, secrets });
  // On Windows a git subprocess can still hold a handle briefly; a failed rm must not fail the test.
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* temp dir; the OS reclaims it */
    }
  };
  return { dir, repo, bus, seen, project, runner, secrets, cleanup };
}

export async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
