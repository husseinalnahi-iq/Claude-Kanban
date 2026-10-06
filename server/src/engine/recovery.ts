import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import { nowIso } from "../db.ts";
import { RECOVERY_ATTEMPTS, stoppedBy, type EventRow, type Task, type TaskRecovery } from "../types.ts";
import type { QueryFn, TaskRunner } from "./runner.ts";
import { isTransient } from "./providers/limits.ts";
import { LEAN } from "./lean.ts";

export interface RecoveryDeps {
  repo: Repo;
  bus: Bus;
  runner: TaskRunner;
  /** Defaults to the runner's, so a test's fake SDK drives both. */
  queryFn?: QueryFn;
}

type Decision = { action: "retry_same" | "retry_from" | "needs_user"; stage?: number; reason: string };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason"],
  properties: {
    action: { type: "string", enum: ["retry_same", "retry_from", "needs_user"] },
    stage: { type: "integer", minimum: 1, description: "With retry_from: the stage number to run again, fresh, counting from 1." },
    reason: { type: "string", description: "One plain sentence for the person: what went wrong and what you decided." },
  },
};

const GUIDANCE =
  "You look after a board that runs coding tasks in stages. One task just failed and nobody is watching. " +
  "Decide, from the error and the last things the stage did, whether the board should try again by itself or leave it for the person.\n" +
  "- retry_same: the stage can carry on in the same session — it died in the middle of ordinary work (a tool crashed, a command hung, the process exited) and nothing suggests it would fail the same way again.\n" +
  "- retry_from: a stage should run again from scratch, in a fresh session — its session is confused (looping, lost, out of context) or an earlier stage's output was the problem; name the stage.\n" +
  "- needs_user: the failure needs a person — a missing program or key, a wrong spec, a decision, a check that fails for a real reason the stage could not fix, or anything that has already failed the same way.\n" +
  "Answer in the JSON shape given. Be brief and plain; the reason is shown on the card to someone who is not a programmer.";

/** Who may be recovered: failed for a reason that is not a stop, a block, a usage pause or a connection retry already under way. */
function recoverable(task: Task): boolean {
  if (task.status !== "failed" || task.archived_at || task.start_at || !task.error) return false;
  if (/stopped by user|^interrupted/i.test(task.error)) return false;
  if (stoppedBy(task) || task.blocked) return false;
  if (isTransient(task.error)) return false;
  return (task.recovery?.attempts ?? 0) < RECOVERY_ATTEMPTS;
}

/** A tool call or a sentence per line: enough to see what the stage was doing when it died. */
export function eventLines(events: EventRow[], max = 40): string[] {
  const out: string[] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (e.type === "assistant") {
      const msg = p.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
      for (const b of blocks) {
        if (b.type === "tool_use") out.push(`tool ${String(b.name)} ${JSON.stringify(b.input ?? {}).slice(0, 160)}`);
        else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(`said: ${b.text.trim().replace(/\s+/g, " ").slice(0, 200)}`);
      }
    } else if (e.type === "user") {
      const msg = p.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as { text?: string }[]).map((c) => c.text ?? "").join(" ") : "";
        if (b.is_error || /error|failed|not found|denied|refused/i.test(text)) out.push(`result: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
      }
    } else if (e.type === "board:note" || e.type.startsWith("board:")) {
      out.push(`board: ${JSON.stringify(p).slice(0, 160)}`);
    }
  }
  return out.slice(-max);
}

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

/**
 * Failures get a second look before they wait for a person (D411). A connection problem is retried by
 * the runner itself; anything else comes here: one cheap read-only call to the triage model, which may
 * retry a stage (same session, or fresh from a stage it names) or say what the person has to do. Two
 * attempts per task, then the card says what was tried and waits.
 */
export class RecoveryService {
  private inFlight = new Set<string>();

  constructor(private deps: RecoveryDeps) {
    deps.bus.subscribe((m) => {
      if (m.type !== "task.updated" || m.task.status !== "failed") return;
      void this.consider(m.task.id).catch((err) => console.error("Recovery could not look at a failed task:", err));
    });
  }

  /** Look at one failed task now (the bus does this on its own; tests and a restart call it directly). */
  async consider(taskId: string): Promise<Decision | null> {
    const { repo } = this.deps;
    if (!repo.getSettings().autoRecover || this.inFlight.has(taskId)) return null;
    const task = repo.getTask(taskId);
    if (!task || !recoverable(task)) return null;
    this.inFlight.add(taskId);
    try {
      const decision = await this.decide(task);
      // The task may have moved on while the model thought (a retry by hand, a stop): then its word is stale.
      const now = repo.getTask(taskId);
      if (!now || now.status !== "failed" || now.updated_at !== task.updated_at) return null;
      this.apply(now, decision);
      return decision;
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  private async decide(task: Task): Promise<Decision> {
    const { repo } = this.deps;
    const settings = repo.getSettings();
    const run = repo.latestRun(task.id);
    const lines = run ? eventLines(repo.recentEvents(run.id, 120)) : [];
    const stages = task.pipeline.map((s, i) => `${i + 1}. ${s.stage}${run?.stage_index === i ? " ← failed here" : ""}`).join("\n");
    const prompt = [
      GUIDANCE,
      `\n## Task\n${task.title}`,
      `\n## Stages\n${stages}`,
      `\n## The error\n${task.error}`,
      task.recovery?.last ? `\n## What the board already tried\n${task.recovery.last.action}: ${task.recovery.last.reason}` : "",
      lines.length ? `\n## The last things the stage did\n${lines.join("\n")}` : "\n## The last things the stage did\n(nothing was recorded)",
    ].filter(Boolean).join("\n");
    const options: Options = {
      model: settings.triageModel,
      effort: "low",
      cwd: process.cwd(),
      ...LEAN,
      permissionMode: "dontAsk",
      systemPrompt: "",
      tools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.1,
      outputFormat: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    };
    const queryFn = this.deps.queryFn ?? this.deps.runner.sdkQuery;
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
    } catch (err) {
      return { action: "needs_user", reason: `The board could not judge this failure (${err instanceof Error ? err.message : String(err)}).` };
    }
    repo.addIntakeCost({ task_id: task.id, kind: "recovery", model: settings.triageModel, cost_usd: cost });
    const s = (structured ?? {}) as Partial<Decision>;
    const reason = typeof s.reason === "string" && s.reason.trim() ? s.reason.trim().slice(0, 400) : "No reason was given.";
    if (s.action === "retry_same") return { action: "retry_same", reason };
    if (s.action === "retry_from") {
      const stage = Number(s.stage);
      if (Number.isInteger(stage) && stage >= 1 && stage <= task.pipeline.length) return { action: "retry_from", stage: stage - 1, reason };
      return { action: "retry_same", reason };
    }
    return { action: "needs_user", reason };
  }

  private apply(task: Task, d: Decision): void {
    const { repo, runner, bus } = this.deps;
    const attempts = (task.recovery?.attempts ?? 0) + (d.action === "needs_user" ? 0 : 1);
    const recovery: TaskRecovery = { ...(task.recovery ?? {}), attempts, last: { at: nowIso(), action: d.action, reason: d.reason, stage: d.stage } };
    const run = repo.latestRun(task.id);
    if (run) {
      const event = repo.insertEvent(run.id, "recovery:decided", { type: "recovery_decided", action: d.action, stage: d.stage, reason: d.reason, attempt: attempts });
      bus.publish({ type: "event", runId: run.id, taskId: task.id, event });
    }
    if (d.action === "needs_user") {
      const tried = task.recovery?.attempts ? ` (the board tried ${task.recovery.attempts} time${task.recovery.attempts === 1 ? "" : "s"} already)` : "";
      bus.publish({ type: "task.updated", task: repo.updateTask(task.id, { recovery, note: `Needs you: ${d.reason}${tried}`.slice(0, 600) }) });
      return;
    }
    const where = d.action === "retry_from" ? `the ${task.pipeline[d.stage!]?.stage ?? "work"} stage again, fresh` : "the stage that failed, in its own session";
    repo.updateTask(task.id, { recovery, note: `The board is trying ${where} (${attempts} of ${RECOVERY_ATTEMPTS}): ${d.reason}`.slice(0, 600) });
    try {
      if (d.action === "retry_from") runner.retryTask(task.id, d.stage, false, true);
      else runner.retryTask(task.id);
    } catch (err) {
      // Its project or settings do not allow a start right now: the card says why and waits.
      bus.publish({ type: "task.updated", task: repo.updateTask(task.id, { note: `Could not try again: ${err instanceof Error ? err.message : String(err)}` }) });
    }
  }
}
