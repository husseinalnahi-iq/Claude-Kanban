import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CliPreset } from "../../../types.ts";

export interface CliFinish {
  text: string | null;
  sessionId?: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number };
  error?: string;
}

/**
 * Turns one agent CLI's line-based output into the SDK-shaped assistant / tool_use / tool_result
 * messages the runner already renders. `onLine` returns the messages for that line (usually zero or
 * one); anything it does not understand becomes a `delegate:raw` note, never a throw.
 */
export interface CliTranslator {
  onLine(line: string): { messages: SDKMessage[]; raw?: string };
  finish(code: number | null): CliFinish;
}

const assistantText = (session_id: string, text: string): SDKMessage =>
  ({ type: "assistant", session_id, message: { role: "assistant", content: [{ type: "text", text }] } }) as unknown as SDKMessage;
const thinking = (session_id: string, text: string): SDKMessage =>
  ({ type: "assistant", session_id, message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } }) as unknown as SDKMessage;
const toolUse = (session_id: string, id: string, name: string, input: unknown): SDKMessage =>
  ({ type: "assistant", session_id, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }) as unknown as SDKMessage;
const toolResult = (session_id: string, id: string, content: string, isError = false): SDKMessage =>
  ({ type: "user", session_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } }) as unknown as SDKMessage;

/** OpenAI Codex `codex exec --json`: a stream of `{ type, ... }` events. */
export function codexTranslator(session_id: string): CliTranslator {
  let sid: string | undefined;
  let lastText: string | null = null;
  let usage: CliFinish["usage"];
  let error: string | undefined;
  let toolN = 0;
  return {
    onLine(line) {
      const t = line.trim();
      if (!t.startsWith("{")) return { messages: [] };
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(t);
      } catch {
        return { messages: [], raw: t };
      }
      const type = String(ev.type ?? "");
      const msgs: SDKMessage[] = [];
      if (type === "thread.started") sid = String((ev.thread_id ?? ev.session_id) ?? "");
      else if (type === "turn.completed" || type === "turn.failed") {
        const u = (ev.usage ?? {}) as Record<string, number>;
        // Keep raw and cached apart: the runner sums input + cacheRead itself.
        usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadInputTokens: u.cached_input_tokens ?? 0 };
        if (type === "turn.failed") error = String((ev.error as { message?: string })?.message ?? "the Codex turn failed");
      } else if (type === "error") error = String((ev as { message?: string }).message ?? "Codex error");
      else if (type === "item.completed" || type === "item.updated") {
        const item = (ev.item ?? {}) as Record<string, unknown>;
        const itype = String(item.type ?? item.item_type ?? "");
        if (itype === "agent_message" && typeof item.text === "string") {
          lastText = item.text;
          if (type === "item.completed") msgs.push(assistantText(session_id, item.text));
        } else if (itype === "reasoning" && typeof item.text === "string") {
          msgs.push(thinking(session_id, item.text));
        } else if (itype === "command_execution") {
          const id = `codex-cmd-${++toolN}`;
          msgs.push(toolUse(session_id, id, "Bash", { command: item.command ?? "" }));
          const code = Number(item.exit_code ?? 0);
          msgs.push(toolResult(session_id, id, String(item.aggregated_output ?? item.output ?? ""), code !== 0));
        } else if (itype === "file_change" && Array.isArray(item.changes)) {
          for (const ch of item.changes as { path?: string; kind?: string }[]) {
            msgs.push(toolUse(session_id, `codex-edit-${++toolN}`, "Edit", { file_path: ch.path ?? "", kind: ch.kind ?? "update" }));
          }
        }
      }
      return { messages: msgs };
    },
    finish(code) {
      return { text: lastText, sessionId: sid, usage, error: error ?? (code && code !== 0 ? `Codex exited with code ${code}.` : undefined) };
    },
  };
}

/** Google Gemini `gemini --output-format stream-json`: `{ type: "message"|"tool_use"|"result", ... }`. */
export function geminiTranslator(session_id: string): CliTranslator {
  let sid: string | undefined;
  let lastText: string | null = null;
  let usage: CliFinish["usage"];
  let error: string | undefined;
  let toolN = 0;
  return {
    onLine(line) {
      const t = line.trim();
      if (!t.startsWith("{")) return { messages: [] };
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(t);
      } catch {
        return { messages: [], raw: t };
      }
      const type = String(ev.type ?? "");
      const msgs: SDKMessage[] = [];
      if (type === "init" || type === "session") sid = String(ev.session_id ?? ev.sessionId ?? "");
      else if (type === "message" || type === "assistant") {
        const text = typeof ev.content === "string" ? ev.content : String((ev as { text?: string }).text ?? "");
        if (text) {
          lastText = text;
          msgs.push(assistantText(session_id, text));
        }
      } else if (type === "tool_use" || type === "tool_call") {
        const id = `gemini-tool-${++toolN}`;
        msgs.push(toolUse(session_id, id, String(ev.name ?? "Tool"), ev.input ?? ev.args ?? {}));
      } else if (type === "tool_result") {
        msgs.push(toolResult(session_id, `gemini-tool-${toolN}`, String((ev as { output?: string }).output ?? ""), Boolean(ev.is_error)));
      } else if (type === "result") {
        const stats = (ev.stats ?? {}) as Record<string, number>;
        usage = { inputTokens: stats.input_tokens ?? stats.promptTokenCount ?? 0, outputTokens: stats.output_tokens ?? stats.candidatesTokenCount ?? 0 };
        if (typeof ev.response === "string" && ev.response) lastText = ev.response;
        if (String(ev.status ?? "") === "error" || ev.error) error = String((ev.error as { message?: string })?.message ?? ev.error ?? "Gemini reported an error");
      }
      return { messages: msgs };
    },
    finish(code) {
      return { text: lastText, sessionId: sid, usage, error: error ?? (code && code !== 0 ? `Gemini exited with code ${code}.` : undefined) };
    },
  };
}

/**
 * Fallback for a CLI whose event stream we do not parse (custom commands, and OpenCode / Kimi until a
 * fixture pins their shape): keep every line as the result text, translate nothing.
 */
export function plainTranslator(_session_id: string): CliTranslator {
  const lines: string[] = [];
  return {
    onLine(line) {
      if (line.trim()) lines.push(line);
      return { messages: [] };
    },
    finish(code) {
      const text = lines.join("\n").trim() || null;
      return { text, error: code && code !== 0 ? `The command exited with code ${code}.` : undefined };
    },
  };
}

export function translatorFor(preset: CliPreset, session_id: string): CliTranslator {
  switch (preset) {
    case "codex":
      return codexTranslator(session_id);
    case "gemini":
      return geminiTranslator(session_id);
    default:
      return plainTranslator(session_id);
  }
}
