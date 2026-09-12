import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliPreset, Effort, Provider, ProviderTestResult } from "../../../types.ts";
import type { ProviderAdapter, StageInvocation } from "../types.ts";
import type { SecretStore } from "../../../secrets.ts";
import { childEnv } from "./env.ts";
import { spawnCli, type SpawnFn } from "./spawn.ts";
import { translatorFor } from "./translate.ts";

/** Test seam: the runner passes its SecretStore in; adapters resolve auth vars through it. */
let secretStore: SecretStore | null = null;
export function setCliSecrets(s: SecretStore): void {
  secretStore = s;
}
/** Test seam for the child process. */
let spawnFn: SpawnFn | undefined;
export function setCliSpawn(fn: SpawnFn | undefined): void {
  spawnFn = fn;
}

const EFFORT_TO_CODEX: Record<Effort, string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/** How each preset is invoked. The prompt always arrives on stdin (or a temp file for `custom`). */
function buildInvocation(inv: StageInvocation): { command: string; args: string[]; stdin?: string; promptFile?: string; lastMsgFile?: string } {
  const preset: CliPreset = inv.provider.cli?.preset ?? "custom";
  const extra = inv.provider.cli?.extraArgs ?? [];
  switch (preset) {
    case "codex": {
      const lastMsgFile = join(tmpDir(), `${inv.run.id}.last.md`);
      return {
        command: "codex",
        args: [
          "exec", "--json", "--skip-git-repo-check", "-C", inv.cwd, "-m", inv.model,
          "-s", inv.readOnly ? "read-only" : "workspace-write", "-a", "never",
          "-c", `model_reasoning_effort=${EFFORT_TO_CODEX[inv.effort]}`, "-o", lastMsgFile,
          // Codex attaches images to the first message itself.
          ...(inv.images ?? []).flatMap((p) => ["-i", p]),
          ...extra, "-",
        ],
        stdin: inv.prompt,
        lastMsgFile,
      };
    }
    case "gemini":
      return {
        command: "gemini",
        args: ["--output-format", "stream-json", "--approval-mode", inv.readOnly ? "plan" : "auto_edit", "-m", inv.model, ...extra],
        // Gemini reads a file named with @ in the prompt, images included.
        stdin: inv.images?.length ? `${inv.images.map((p) => `@${p}`).join(" ")}\n\n${inv.prompt}` : inv.prompt,
      };
    case "kimi":
      return {
        command: "kimi",
        args: ["--print", "--output-format", "stream-json", "-w", inv.cwd, "-m", inv.model, ...(inv.readOnly ? ["--plan"] : []), ...extra],
        stdin: inv.prompt,
      };
    case "opencode":
      return {
        command: "opencode",
        args: ["run", "--format", "json", "-m", inv.model, "--dir", inv.cwd, ...(inv.readOnly ? [] : ["--auto"]), ...extra],
        stdin: inv.prompt,
      };
    default: {
      // Custom: a template with {prompt_file} {cwd} {model} {mode}. The prompt is written to a file.
      const promptFile = join(tmpDir(), `${inv.run.id}.prompt.md`);
      const template = inv.provider.cli?.command ?? "";
      const parts = template.split(/\s+/).filter(Boolean).map((p) =>
        p.replace("{prompt_file}", promptFile).replace("{cwd}", inv.cwd).replace("{model}", inv.model).replace("{mode}", inv.readOnly ? "read-only" : "write"),
      );
      return { command: parts[0] ?? "", args: parts.slice(1), promptFile };
    }
  }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kanban-cli-"));
}

/** Redacts the secret from a line before it is stored or logged. */
function redactor(secret: string | null): (s: string) => string {
  return (s) => (secret && secret.length >= 8 ? s.split(secret).join("•••") : s);
}

async function* runCli(inv: StageInvocation): AsyncIterable<SDKMessage> {
  const preset: CliPreset = inv.provider.cli?.preset ?? "custom";
  const session_id = inv.run.id;
  const redact = redactor(inv.secret);
  const spec = buildInvocation(inv);
  if (!spec.command) {
    yield errorResult(session_id, "This custom provider has no command configured.");
    return;
  }
  if (spec.promptFile) writeFileSync(spec.promptFile, inv.prompt, "utf8");

  inv.emit("delegate:command", { kind: "cli", command: spec.command, args: spec.args.map(redact), cwd: inv.cwd, readOnly: inv.readOnly });
  yield sdkInit(session_id, inv);

  const translator = translatorFor(preset, session_id);
  const queue: SDKMessage[] = [];
  let stderr = "";
  const env = secretStore ? childEnv(inv.provider, secretStore, { KANBAN_TASK_ID: inv.task.id }) : { PATH: process.env.PATH ?? "" };

  const result = await spawnCli(
    { command: spec.command, args: spec.args },
    {
      stdin: spec.stdin,
      onLine: (line) => {
        const out = translator.onLine(line);
        for (const m of out.messages) queue.push(m);
        if (out.raw) inv.emit("delegate:raw", { line: redact(out.raw).slice(0, 2000) });
      },
      onStderr: (chunk) => {
        stderr += chunk;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      },
    },
    { cwd: inv.cwd, env, timeoutMs: inv.timeoutMs, abort: inv.abort, spawnFn },
  ).finally(() => {
    if (spec.promptFile) try { rmSync(spec.promptFile, { force: true }); } catch { /* temp */ }
  });

  for (const m of queue) yield m;

  const fin = translator.finish(result.code);
  let text = fin.text;
  if (spec.lastMsgFile) {
    try {
      const fromFile = readFileSync(spec.lastMsgFile, "utf8").trim();
      if (fromFile) text = fromFile;
    } catch {
      /* the CLI may not have written it */
    } finally {
      try { rmSync(spec.lastMsgFile, { force: true }); } catch { /* temp */ }
    }
  }
  if (stderr.trim()) inv.emit("delegate:stderr", { text: redact(stderr).slice(-4000) });

  if (result.stopped) {
    yield errorResult(session_id, "stopped by user");
    return;
  }
  if (result.timedOut) {
    yield errorResult(session_id, `Timed out after ${Math.round(inv.timeoutMs / 60_000)} min running ${spec.command}.`);
    return;
  }
  if (fin.error) {
    yield errorResult(session_id, redact(fin.error));
    return;
  }
  const u = fin.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  // The CLI's own session id (Codex thread, Gemini session) is kept for the record, though we cannot resume it.
  const finalSid = fin.sessionId || session_id;
  yield {
    type: "result", subtype: "success", is_error: false, session_id: finalSid, result: text ?? "(the provider produced no text)", num_turns: 1, stop_reason: "end_turn",
    duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0,
    usage: { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadInputTokens ?? 0, cache_creation_input_tokens: 0 },
    modelUsage: { [inv.model]: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadInputTokens: u.cacheReadInputTokens ?? 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: inv.provider.models.find((m) => m.id === inv.model)?.contextWindow ?? 0, maxOutputTokens: 0 } },
    permission_denials: [],
  } as unknown as SDKMessage;
}

function sdkInit(session_id: string, inv: StageInvocation): SDKMessage {
  return {
    type: "system", subtype: "init", session_id, model: inv.model, cwd: inv.cwd, tools: [], permissionMode: inv.readOnly ? "plan" : "acceptEdits",
    mcp_servers: [], apiKeySource: "none", claude_code_version: `board-cli:${inv.provider.cli?.preset ?? "custom"}`, slash_commands: [], output_style: "", skills: [], plugins: [], agents: [],
  } as unknown as SDKMessage;
}

function errorResult(session_id: string, message: string): SDKMessage {
  return {
    type: "result", subtype: "error_during_execution", is_error: true, session_id, errors: [message], num_turns: 1,
    duration_ms: 0, duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
  } as unknown as SDKMessage;
}

export const cliAdapter: ProviderAdapter = {
  kind: "cli",
  canResume: false,
  hasTools: true,
  run: runCli,
  async test(provider: Provider, model: string): Promise<ProviderTestResult> {
    const out: ProviderTestResult = { ok: false, latencyMs: 0, modelEcho: null, usageReported: false, costReported: false, error: null };
    const t0 = Date.now();
    const abort = new AbortController();
    const inv: StageInvocation = {
      run: { id: `test-${Date.now()}` } as StageInvocation["run"], task: { id: "test" } as StageInvocation["task"], project: {} as StageInvocation["project"],
      prompt: "Reply with exactly: ok", cwd: process.cwd(), provider, model, effort: "low", readOnly: true, mode: "supervised",
      abort: abort.signal, timeoutMs: 120_000, secret: secretStore?.get(provider.authRef) ?? null, emit: () => {}, log: () => {},
    };
    for await (const msg of runCli(inv)) {
      if (msg.type === "result") {
        const r = msg as Extract<SDKMessage, { type: "result" }>;
        out.ok = r.subtype === "success" && !r.is_error;
        out.usageReported = Object.values(r.modelUsage ?? {}).some((m) => (m.inputTokens ?? 0) + (m.outputTokens ?? 0) > 0);
        out.modelEcho = out.ok ? model : null;
        if (!out.ok) out.error = (r as { errors?: string[] }).errors?.join("\n") ?? r.subtype;
      }
    }
    out.latencyMs = Date.now() - t0;
    return out;
  },
};
