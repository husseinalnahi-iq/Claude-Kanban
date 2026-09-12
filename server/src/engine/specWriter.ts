import { existsSync } from "node:fs";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import { NOTES_IN_PROMPT } from "../repo.ts";
import type { Effort, Project, SpecVersion, Task } from "../types.ts";
import { ConflictError, NotFoundError, type TaskRunner } from "./runner.ts";
import { describeTool } from "./chat.ts";

/**
 * ✦ Rewrite on a task's Spec: a strong model (Opus by default) reads the part of the project the
 * request is about, then rewrites the request into a spec a coding agent can start from — naming the
 * real files and the real verify command. Read-only: it can look, never change anything.
 *
 * Every version is kept (spec_versions). A rewrite always starts from *your* latest words, never
 * from an earlier rewrite, so trying another model compares like with like instead of compounding.
 */

/** Looking only. */
export const SPEC_READ_TOOLS = ["Read", "Glob", "Grep"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["spec_md", "summary"],
  properties: {
    spec_md: { type: "string", description: "The rewritten spec, in markdown." },
    summary: {
      type: "string",
      description: "One sentence to the requester on what you changed, e.g. “Named the two files involved and turned ‘make it faster’ into a check you can measure.”",
    },
  },
} as const;

export function specPrompt(input: { project: Project; title: string; source: string; instruction?: string | null; memory: string[] }): string {
  return [
    "You rewrite one task card's spec on a software task board. A coding agent will do the work from what you write, starting cold.",
    "",
    "First, understand the request: look at the parts of the project it is about (Glob, Grep, Read). Read only what you need — you cannot change anything, and a spec is not the implementation.",
    "",
    "Then write the spec in markdown:",
    "- A short opening: what should change and why, in the requester's own terms.",
    "- `## Where` — the files, screens, functions or commands involved, as you found them. Name only things that exist.",
    "- `## Done when` — a checklist. Every line must be checkable by running or looking at something; never “works well”.",
    "- `## Out of scope` — only when it is not obvious what to leave alone.",
    "- `## Verify` — the project's real command (from its scripts) or exactly what to open and look at.",
    "",
    "Rules:",
    "- Keep the requester's intent exactly. Never add features, constraints or polish they did not ask for.",
    "- Keep every concrete detail they gave: names, numbers, wording, links, examples.",
    "- If something cannot be decided from the request or the code, write it inline as `[NEEDS CLARIFICATION: question]` — at most 3.",
    "- Write in the language the request is written in.",
    "- Be brief. A good spec is usually under 40 lines.",
    "",
    `## Project\n${input.project.name}`,
    input.memory.length ? `\n## What the board already knows about this project\n${input.memory.map((m) => `- ${m}`).join("\n")}` : "",
    input.instruction?.trim() ? `\n## What the requester wants from this rewrite\n${input.instruction.trim()}` : "",
    `\n## Task title\n${input.title}`,
    `\n## The request, as written\n${input.source.trim() || "(empty — work from the title)"}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

export interface RewriteOptions {
  model?: string;
  effort?: Effort;
  /** "Focus on the mobile layout", "Split the checks by screen"… */
  instruction?: string;
}

export class SpecWriter {
  private live = new Map<string, { ctl: AbortController; note: string; model: string }>();

  constructor(private deps: { repo: Repo; bus: Bus; runner: TaskRunner }) {}

  /** The versions, and the rewrite in progress if there is one — for a drawer opened mid-rewrite. */
  status(taskId: string): { versions: SpecVersion[]; rewriting: { model: string; note: string } | null } {
    const r = this.live.get(taskId);
    return { versions: this.deps.repo.specVersions(taskId), rewriting: r ? { model: r.model, note: r.note } : null };
  }

  private load(taskId: string): { task: Task; project: Project } {
    const task = this.deps.repo.getTask(taskId);
    if (!task) throw new NotFoundError(`No task ${taskId}`);
    const project = this.deps.repo.getProject(task.project_id);
    if (!project) throw new NotFoundError("This task's project is gone.");
    return { task, project };
  }

  /**
   * The current text as a version: the stored one it matches, else saved now as yours (the original
   * before a first rewrite, or an edit you made since). Nothing you wrote is ever lost.
   */
  private keepCurrent(task: Task): SpecVersion {
    const versions = this.deps.repo.specVersions(task.id);
    const same = versions.findLast((v) => v.spec_md === task.spec_md);
    return same ?? this.deps.repo.addSpecVersion({
      task_id: task.id, kind: "yours", spec_md: task.spec_md, model: null, effort: null, source_id: null, instruction: null, summary: null, cost_usd: 0,
    });
  }

  private publish(taskId: string, state: "running" | "done" | "failed" | "stopped", extra: { note?: string; error?: string } = {}) {
    this.deps.bus.publish({ type: "spec.rewrite", taskId, state, ...extra });
  }

  /** Starts a rewrite and returns at once; progress and the result arrive as `spec.rewrite` events. */
  start(taskId: string, opts: RewriteOptions = {}): { started: true; model: string } {
    const { task, project } = this.load(taskId);
    if (this.live.has(taskId)) throw new ConflictError("A rewrite of this spec is already running.");
    if (this.deps.runner.isBusy(taskId)) throw new ConflictError("Stop the task first: its stages read this spec.");
    const settings = this.deps.repo.getSettings();
    const model = opts.model?.trim() || settings.specModel;
    const effort = opts.effort ?? settings.specEffort;

    this.keepCurrent(task);
    // Your latest words — never an earlier rewrite — are what every model rewrites.
    const source = this.deps.repo.specVersions(taskId).findLast((v) => v.kind === "yours")!;
    const ctl = new AbortController();
    this.live.set(taskId, { ctl, note: "reading the request", model });
    this.publish(taskId, "running", { note: "reading the request" });

    void this.run(task, project, source, { model, effort, instruction: opts.instruction }, ctl).finally(() => this.live.delete(taskId));
    return { started: true, model };
  }

  stop(taskId: string): boolean {
    const r = this.live.get(taskId);
    r?.ctl.abort();
    return Boolean(r);
  }

  private async run(task: Task, project: Project, source: SpecVersion, o: { model: string; effort: Effort; instruction?: string }, ctl: AbortController) {
    const { repo, runner } = this.deps;
    // A task that already ran reads its own copy of the code, which may be ahead of the main checkout.
    const cwd = task.worktree_path && existsSync(task.worktree_path) ? task.worktree_path : project.path;
    const options: Options = {
      model: o.model,
      effort: o.effort,
      cwd,
      // The project's CLAUDE.md helps it understand; your global tool servers and plugins would only add cost.
      settingSources: ["project"],
      strictMcpConfig: true,
      mcpServers: {},
      skills: [],
      plugins: [],
      extraArgs: { "no-chrome": null },
      tools: SPEC_READ_TOOLS,
      allowedTools: SPEC_READ_TOOLS,
      permissionMode: "dontAsk",
      maxTurns: 30,
      maxBudgetUsd: 3,
      outputFormat: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
      abortController: ctl,
    };
    const prompt = specPrompt({
      project, title: task.title, source: source.spec_md, instruction: o.instruction,
      memory: repo.notes(project.id, NOTES_IN_PROMPT).map((n) => n.text),
    });

    let structured: unknown;
    let cost = 0;
    let failure: string | null = null;
    try {
      for await (const raw of runner.sdkQuery({ prompt: userMessage(prompt), options })) {
        const msg = raw as SDKMessage & Record<string, any>;
        if (msg.type === "assistant" && !msg.parent_tool_use_id) {
          for (const block of msg.message?.content ?? []) {
            if (block.type !== "tool_use") continue;
            const note = describeTool(block.name, (block.input ?? {}) as Record<string, unknown>, cwd);
            const live = this.live.get(task.id);
            if (live) live.note = note;
            this.publish(task.id, "running", { note });
          }
        } else if (msg.type === "result") {
          cost = Number(msg.total_cost_usd ?? 0);
          structured = msg.structured_output;
          if (msg.is_error) failure = (msg.errors ?? []).join("; ") || String(msg.subtype ?? "the rewrite failed");
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (ctl.signal.aborted) return this.publish(task.id, "stopped");
    const s = structured as { spec_md?: unknown; summary?: unknown } | undefined;
    const spec = typeof s?.spec_md === "string" ? s.spec_md.trim() : "";
    if (!spec) {
      return this.publish(task.id, "failed", { error: failure ?? "It answered without a spec. Try again, or another model." });
    }
    const fresh = repo.getTask(task.id);
    if (!fresh) return;
    // You may have edited the spec while it worked: that edit is kept as a version before the rewrite lands.
    this.keepCurrent(fresh);
    repo.addSpecVersion({
      task_id: task.id, kind: "ai", spec_md: spec, model: o.model, effort: o.effort, source_id: source.id,
      instruction: o.instruction?.trim() || null, summary: typeof s?.summary === "string" ? s.summary.trim().slice(0, 400) : null, cost_usd: cost,
    });
    this.deps.bus.publish({ type: "task.updated", task: repo.updateTask(task.id, { spec_md: spec }) });
    this.publish(task.id, "done");
  }

  /** Puts any version back as the spec. What is there now is kept first, so this is never a loss. */
  restore(taskId: string, versionId: string): Task {
    const { task } = this.load(taskId);
    const v = this.deps.repo.getSpecVersion(versionId);
    if (!v || v.task_id !== taskId) throw new NotFoundError("No such version of this spec.");
    if (this.live.has(taskId)) throw new ConflictError("Wait for the rewrite to finish, or stop it.");
    if (this.deps.runner.isBusy(taskId)) throw new ConflictError("Stop the task first: its stages read this spec.");
    this.keepCurrent(task);
    const updated = this.deps.repo.updateTask(taskId, { spec_md: v.spec_md });
    this.deps.bus.publish({ type: "task.updated", task: updated });
    return updated;
  }
}
