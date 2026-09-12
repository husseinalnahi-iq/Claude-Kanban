import {
  query, type CanUseTool, type HookCallbackMatcher, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import * as gitOps from "../git/worktree.ts";
import { DEFAULT_VISION_MODEL, nowIso } from "../db.ts";
import type { Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type {
  Approval, ApprovalDecision, Project, Provider, ProviderOut, ProviderUsage, Run, SessionTools, Stage, StageName, Task, TaskStatus, TierRef, UsageLimit, UsageTotals,
} from "../types.ts";

type RateLimitInfo = {
  status?: UsageLimit["status"];
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  /** Every window at once, with its own utilization. This is where the numbers actually are. */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
};
import { RunQueue } from "./queue.ts";
import { buildStagePrompt } from "./prompts.ts";
import { autonomousGate, blockedCommand, isSafeMcp, killsByName, READ_ONLY_TOOLS, readOnlyCommand, serverRule } from "./gate.ts";
import { allowedMode, createBoardServer } from "./boardMcp.ts";
import { CONFIDENCE_TO_APPLY, serialiseFileConflicts, triageTask, type Sizing, type TriageResult, type TriageSubtask } from "./triage.ts";
import { describeImage, describeImageVia } from "./vision.ts";
import { LEAN } from "./lean.ts";
import { applyOnboardingResult } from "./onboarding.ts";
import { buildCriticPrompt, buildRevisionPrompt, extractRevisedPlan, parseCritique } from "./debate.ts";
import { BROWSER_SERVER, PLAYWRIGHT_PLUGIN_TOOLS, browserCaption, browserDecision, browserServer } from "./browser.ts";
import { BrowserWatch } from "./browserWatch.ts";
import { scanSkills } from "../skills.ts";
import { freePort, readWorktreeInclude, runProjectCommand, seedWorktree, stopListeners } from "../git/bootstrap.ts";
import { NOTES_IN_PROMPT } from "../repo.ts";
import { SecretStore } from "../secrets.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { estimateCost, sumUsage } from "./providers/cost.ts";
import { ModelCatalog, isLocal } from "./providers/catalog.ts";
import { setCliSecrets } from "./providers/cli/index.ts";
import { classifyProviderError, naiveOffsetFor, retryDelayMs, type OutKind } from "./providers/limits.ts";
import { QuotaReader, type LiveQuota } from "./providers/usage.ts";
import type { Resolved, StageInvocation } from "./providers/types.ts";
import { saveAttachment } from "../routes/attachments.ts";
import { pickBrowser, realProbe } from "../setup/probe.ts";
import { ANTHROPIC_PROVIDER_ID, ARTIFACT_EXTS, EFFORTS, usesWorktree, MAX_ATTACHMENT_BYTES, attachmentKind, supportsFastMode, type ClaudeModelsResult, type FastModeStatus } from "../types.ts";
import { fromSdk, type SdkModelInfo } from "./claudeModels.ts";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

/** The request violates a project policy (HTTP 409). */
export class PolicyError extends Error {}
/** The request conflicts with the task's current state (HTTP 409). */
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export interface RunnerDeps {
  repo: Repo;
  bus: Bus;
  queryFn?: QueryFn;
  git?: typeof gitOps;
  logDir?: string;
  /** Provider keys. Defaults to an in-memory store (tests). */
  secrets?: SecretStore;
  /** Live model lists. Defaults to one that asks the real providers. */
  catalog?: ModelCatalog;
  /** What each provider says is left of its plan. Defaults to one that asks the real providers. */
  quota?: QuotaReader;
}

interface StartOpts {
  fromStage: number;
  resume?: string;
}

/** The card note Discard leaves: not a reason for the next run. */
const DISCARDED_NOTE = "work discarded";

/** One live query() call. */
interface Active {
  runId: string;
  abort: AbortController;
  stageStatus: TaskStatus;
  /** Newest message rowid already in this stage's prompt; anything later is handed over live. */
  messageCursor: number;
  /** True for a Claude SDK run, whose hooks can carry a message in. CLI / HTTP providers cannot. */
  steerable: boolean;
}

/** A pipeline from queue start to its last stage; `stopped` is honoured between stages too. */
interface PipelineCtl {
  stopped: boolean;
}

const STAGE_STATUS: Record<StageName, TaskStatus> = { plan: "planning", code: "running", review: "review", custom: "running" };
const PLAN_DISALLOWED = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

/** What a stage that ran out of turns is told when it carries on in the same session (D201). */
const CONTINUE_PROMPT =
  "You reached this stage's turn limit before finishing. Nothing was lost: continue from exactly where you stopped. " +
  "Do not redo steps you already finished or re-read what you already know. Finish the remaining work, then end with the summary this stage asks for " +
  "(with the Plan steps checklist, if there is a plan).";
/** Nothing is withheld from every run today; questions go to you as cards (see askApproval). */
const ALWAYS_DISALLOWED: string[] = [];
export const QUESTION_TOOL = "AskUserQuestion";

/**
 * What the session gets back from a question card. An answer goes in as the tool's own `answers`
 * field (question text → label, several labels comma-separated), the way Claude Code's dialog fills
 * it in. No answer — skipped, timed out, or the run ended — tells Claude to decide for itself.
 */
export function questionResult(
  input: Record<string, unknown>, decision: ApprovalDecision, note: string | null, answers: Record<string, string> | undefined, waitMin: number,
): PermissionResult {
  if (decision === "answered" && answers && Object.keys(answers).length) return { behavior: "allow", updatedInput: { ...input, answers } };
  const why = decision === "expired" && waitMin > 0 ? `No answer after ${waitMin} minutes` : decision === "deny" ? "The user chose not to answer" : "No answer";
  return {
    behavior: "deny",
    message: `${why}${note && decision === "deny" ? ` (${note})` : ""}. Choose the most sensible option yourself, say which one and why in your summary, and continue.`,
  };
}
/** Bounded so one chatty session cannot fill the disk. */
const MAX_ARTIFACTS_PER_RUN = 20;
/** One image, one description: a CLI that has not answered in three minutes is not going to. */
const VISION_TIMEOUT_MS = 3 * 60_000;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Never keep a copy of something that is not the run's own output. */
const IGNORED_DIRS = /(^|[\\/])(node_modules|\.git|\.kanban|dist|build|\.next|coverage|vendor)([\\/]|$)/i;

/** Image blocks inside a message: directly, or nested in a tool_result's content. */
function imageBlocks(block: Record<string, unknown>): { media_type: string; data: string }[] {
  const out: { media_type: string; data: string }[] = [];
  const take = (b: unknown) => {
    const x = b as { type?: string; source?: { type?: string; media_type?: string; data?: string } };
    if (x?.type === "image" && x.source?.type === "base64" && typeof x.source.data === "string") {
      out.push({ media_type: x.source.media_type ?? "image/png", data: x.source.data });
    }
  };
  take(block);
  if (block.type === "tool_result" && Array.isArray(block.content)) for (const inner of block.content) take(inner);
  return out;
}

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

/**
 * A custom stage whose prompt is a Claude Code slash command (`/init`, `/security-review`, …) is sent
 * as-is, so Claude runs its own command. Wrapping it in the board's stage prompt would turn it into
 * text Claude reads about, rather than a command it executes.
 */
export function stagePrompt(stage: Stage, build: () => string): string {
  const raw = stage.prompt?.trim() ?? "";
  return stage.stage === "custom" && /^\/[a-z][\w:-]*(\s|$)/i.test(raw) ? raw : build();
}

/** Claude's fast-mode reason codes, in plain words. */
function fastModeMessage(state: string, reason: string | null): string {
  if (state === "on") return "Available — stages you mark ↯ run in fast mode.";
  if (state === "cooldown") return "Cooling down after a rate limit; it comes back by itself.";
  switch (reason) {
    case "extra_usage_disabled":
      return "Unavailable: fast mode is billed as extra usage, and extra usage is turned off for your account or organization.";
    case "free":
      return "Unavailable on the free plan.";
    case "model_not_allowed":
      return "Unavailable for this model — fast mode is Opus 5 and Opus 4.8 only.";
    case "disabled_by_env":
      return "Turned off by an environment setting on this machine.";
    case "not_first_party":
      return "Unavailable through this provider.";
    case "network_error":
      return "Could not check — the network request failed.";
    default:
      return reason ? `Unavailable (${reason}).` : "Unavailable.";
  }
}

/** Turns the model's tier choice into real model ids from Settings. It never names a model itself. */
export function sizedPipeline(sizing: Sizing | null, tiers: { cheap: TierRef; balanced: TierRef; strong: TierRef }): Stage[] | null {
  if (!sizing?.stages.length) return null;
  return sizing.stages.map((s) => {
    const t = tiers[s.tier] ?? tiers.balanced;
    // The provider is only written when it is not the default, so pipelines sized before providers
    // existed and ones sized now look the same.
    return { stage: s.stage, model: t.model, effort: s.effort, ...(t.provider && t.provider !== ANTHROPIC_PROVIDER_ID ? { provider: t.provider } : {}) };
  });
}

/** Reads the `VERDICT: APPROVE | CHANGES_NEEDED` line a review stage is asked to end with. */
export function verdictOf(result: string | null | undefined): "APPROVE" | "CHANGES_NEEDED" | null {
  const m = /^\s*\**VERDICT\**\s*:\s*\**\s*(APPROVE|CHANGES_NEEDED)/im.exec(result ?? "");
  return (m?.[1]?.toUpperCase() as "APPROVE" | "CHANGES_NEEDED") ?? null;
}

function firstLines(text: string | null | undefined, n: number): string {
  return (text ?? "").split(/\r?\n/).filter(Boolean).slice(0, n).join(" ").slice(0, 400);
}

function eventType(msg: SDKMessage): string {
  const m = msg as { type: string; subtype?: string };
  return m.subtype ? `${m.type}:${m.subtype}` : m.type;
}

/** A shell command a supervised run may use without a card (Settings → Guardrails, D197). */
function freeShellRead(name: string, input: unknown, readsFree: boolean): boolean {
  return readsFree && (name === "Bash" || name === "PowerShell") && readOnlyCommand(String((input as { command?: unknown })?.command ?? ""));
}

/**
 * Supervised runs: force every non-read-only tool through the approval card, even when a settings
 * file pre-allows it (a PreToolUse "ask" overrides allow rules). See docs/DECISIONS.md D20.
 */
function forceAsk(readsFree: boolean): HookCallbackMatcher[] {
  return [
    {
      hooks: [
        async (input) => {
          const { tool_name: name = "", tool_input: toolInput } = input as { tool_name?: string; tool_input?: unknown };
          if (READ_ONLY_TOOLS.has(name) || isSafeMcp(name) || freeShellRead(name, toolInput, readsFree)) return {};
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Supervised task: every write is approved on the board." } };
        },
      ],
    },
  ];
}

export class TaskRunner {
  readonly queue: RunQueue;
  private repo: Repo;
  private bus: Bus;
  private queryFn: QueryFn;
  /** The same SDK entry point for the side chat, so tests inject one fake for both. */
  get sdkQuery(): QueryFn {
    return this.queryFn;
  }
  private git: typeof gitOps;
  private logDir?: string;
  readonly secrets: SecretStore;
  readonly providers: ProviderRegistry;
  readonly catalog: ModelCatalog;
  readonly quota: QuotaReader;
  /** Times in a row each provider ran out with no reset time to go on: how long the next wait is. */
  private outStreak = new Map<string, number>();
  /** For a stage moved to another model partway: what it needs to know, put in its prompt once. */
  private handovers = new Map<string, string>();
  private active = new Map<string, Active>();
  private pipelines = new Map<string, PipelineCtl>();
  /** Tasks inside an approve / discard / chat transition (git or session work in flight). */
  private holds = new Set<string>();
  private startOpts = new Map<string, StartOpts>();
  /** Why a human sent the task back, for every stage of the run that follows (see queueTask). */
  private rejectNotes = new Map<string, string>();
  private ports = new Map<string, number>();
  /** Live pictures of each task's browser, for the Browser tab. */
  readonly browserWatch: BrowserWatch;
  /** Verification output of the failed attempt, fed back into the next run's prompt. */
  private verifyFailures = new Map<string, string>();
  private pendingNotes = new Map<string, string[]>();
  private resolvers = new Map<string, (d: { decision: ApprovalDecision; note: string | null; answers?: Record<string, string> }) => void>();
  /** One landing at a time per project: two merges into the same branch race over the same index. */
  private merging = new Map<string, Promise<void>>();
  /** taskId → the tree hash the verify command last passed on, so an unchanged tree is not re-tested. */
  private verified = new Map<string, string>();

  constructor(deps: RunnerDeps) {
    this.repo = deps.repo;
    this.bus = deps.bus;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    this.browserWatch = new BrowserWatch(deps.bus);
    this.git = deps.git ?? gitOps;
    this.logDir = deps.logDir;
    this.secrets = deps.secrets ?? new SecretStore(":memory:");
    this.providers = new ProviderRegistry(deps.repo, this.secrets);
    this.catalog = deps.catalog ?? new ModelCatalog();
    this.quota = deps.quota ?? new QuotaReader();
    setCliSecrets(this.secrets);
    this.queue = new RunQueue({
      // Serial mode overrides the number without overwriting it, so turning it off restores it.
      globalCap: () => (this.repo.getSettings().serial ? 1 : this.repo.getSettings().globalCap),
      projectCap: (pid) => this.repo.getProject(pid)?.policy.maxConcurrent || this.repo.getSettings().defaultMaxConcurrent,
      forcedCap: () => this.repo.getSettings().maxForcedParallel,
      canStart: (item) => this.mayStartNow(item.taskId),
      start: (item) => this.runPipeline(item.taskId),
      onError: (item, err) => this.failTask(item.taskId, err instanceof Error ? err.message : String(err)),
    });
  }

  // ---------------------------------------------------------------- helpers

  isBusy(taskId: string): boolean {
    return (
      this.active.has(taskId) || this.pipelines.has(taskId) || this.holds.has(taskId) ||
      this.queue.isQueued(taskId) || this.queue.isRunning(taskId)
    );
  }

  private load(taskId: string): { task: Task; project: Project } {
    const task = this.repo.getTask(taskId);
    if (!task) throw new NotFoundError(`No task ${taskId}`);
    const project = this.repo.getProject(task.project_id);
    if (!project) throw new NotFoundError(`No project ${task.project_id}`);
    return { task, project };
  }

  private setTask(taskId: string, patch: Parameters<Repo["updateTask"]>[1]): Task {
    const task = this.repo.updateTask(taskId, patch);
    this.bus.publish({ type: "task.updated", task });
    return task;
  }

  private setRun(runId: string, patch: Parameters<Repo["updateRun"]>[1]): Run {
    const run = this.repo.updateRun(runId, patch);
    this.bus.publish({ type: "run.updated", run });
    return run;
  }

  private failTask(taskId: string, error: string) {
    if (this.repo.getTask(taskId)) this.setTask(taskId, { status: "failed", error });
  }

  private log(runId: string, line: string) {
    if (!this.logDir) return;
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(join(this.logDir, `${runId}.log`), this.secrets.redact(line));
    } catch {
      // logging must never break a run
    }
  }

  /** One tiny call through the exact adapter path a stage would use (docs/DECISIONS.md D136). */
  async testProvider(id: string, model?: string): Promise<import("../types.ts").ProviderTestResult> {
    const res = this.providers.resolve(id);
    let pick = model ?? res.provider?.models[0]?.id;
    // A provider with an empty list (LM Studio) is tested on the first model it says it has.
    if (!pick && res.provider) pick = (await this.catalog.list(res.provider, res.secret)).models.find((m) => m.installed !== false)?.id;
    if (!pick && res.provider) {
      return { ok: false, latencyMs: 0, modelEcho: null, usageReported: false, costReported: false, error: `${res.label} reports no models to test with. Download or load one first.` };
    }
    pick ??= this.repo.getSettings().triageModel;
    const provider = res.provider ?? { id: res.id, label: res.label, kind: "anthropic-compatible" as const, enabled: true, authRef: "", models: [], mayEditFiles: true };
    return res.adapter.test(provider, pick, res.secret, this.queryFn);
  }

  /** Frees everything held in memory for a task that is going away. */
  forget(taskId: string): void {
    this.ports.delete(taskId);
    this.verifyFailures.delete(taskId);
    this.pendingNotes.delete(taskId);
    this.startOpts.delete(taskId);
    this.verified.delete(taskId);
    this.handovers.delete(taskId);
  }

  /** Runs `fn` while the task counts as busy, so no queue/chat/approve can interleave with it. */
  private async hold<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    if (this.isBusy(taskId)) throw new ConflictError("Task is busy; wait for the current action to finish.");
    this.holds.add(taskId);
    try {
      return await fn();
    } finally {
      this.holds.delete(taskId);
    }
  }

  /** Throws PolicyError when this task may not run in its project. */
  assertRunnable(task: Task, project: Project): void {
    if (!task.pipeline.length) throw new PolicyError("This task has no pipeline stages. Add at least one stage in the Pipeline tab.");
    if (!existsSync(project.path)) throw new PolicyError(`Project path does not exist: ${project.path}`);
    // Every stage's provider must exist, be switched on, and be allowed on that kind of stage.
    this.providers.assertPipeline(task.pipeline, task.mode);
    if (task.mode === "autonomous") {
      if (project.policy.autonomous === "forbidden") {
        throw new PolicyError(
          `Project "${project.name}" forbids autonomous runs (policy.autonomous = "forbidden"). Switch this task to supervised mode — it will run in the main checkout with every write as an approval card.`,
        );
      }
      if (project.policy.worktrees === "forbidden") {
        throw new PolicyError(
          `Project "${project.name}" forbids worktrees (policy.worktrees = "forbidden"), and autonomous runs need one. Switch this task to supervised mode.`,
        );
      }
    }
    // A supervised task on its own branch needs a worktree too, and a repository to make one in (D203).
    if (task.mode === "supervised" && task.own_branch && project.policy.worktrees === "forbidden") {
      throw new PolicyError(`Project "${project.name}" forbids worktrees (policy.worktrees = "forbidden"). Turn off “Work on its own branch” for this task, or allow worktrees on the project.`);
    }
  }

  /** Latest run per stage index. */
  private latestByStage(taskId: string): Map<number, Run> {
    const m = new Map<number, Run>();
    for (const r of this.repo.stageRuns(taskId)) m.set(r.stage_index, r);
    return m;
  }

  /** Where a retry (or a restart re-queue) should pick up: the first stage without a successful run. */
  private defaultStart(task: Task): StartOpts {
    const latest = this.latestByStage(task.id);
    let from = task.pipeline.findIndex((_, i) => latest.get(i)?.status !== "success");
    if (from < 0) from = Math.max(0, task.pipeline.length - 1);
    return { fromStage: from, resume: latest.get(from)?.session_id ?? undefined };
  }

  // ---------------------------------------------------------------- queue / pipeline

  /** Dependencies must be merged (done), not merely reviewed: unmerged work isn't visible to the next task. */
  blockers(task: Task): Task[] {
    return task.depends_on.map((id) => this.repo.getTask(id)).filter((t): t is Task => Boolean(t) && t!.status !== "done");
  }

  /**
   * `force` is "Run now": the task starts alongside whatever is already running instead of taking
   * its turn. It skips the concurrency caps, not the usage-limit gate — forcing Claude work into an
   * exhausted window does not run it, it pauses it a moment later.
   */
  queueTask(taskId: string, opts: StartOpts = { fromStage: 0 }, force = false): Task {
    const { task, project } = this.load(taskId);
    if (this.isBusy(taskId)) throw new ConflictError("Task is already queued, running, or mid-action.");
    if (!["backlog", "failed", "review"].includes(task.status)) {
      throw new ConflictError(`Cannot queue a task in status "${task.status}".`);
    }
    const blocked = this.blockers(task);
    if (blocked.length) {
      throw new ConflictError(`Waiting on ${blocked.map((b) => `"${b.title}" (${b.status})`).join(", ")}. It starts automatically once those are done.`);
    }
    this.assertRunnable(task, project);
    this.startOpts.set(taskId, opts);
    // The card's note is cleared below, so a Reject note is kept here for every stage of the new run.
    // It used to be cleared first and read after, so "Why this was sent back" never reached a prompt.
    const rejected = task.status === "backlog" && task.note && task.note !== DISCARDED_NOTE ? task.note : null;
    if (rejected) this.rejectNotes.set(taskId, rejected);
    else this.rejectNotes.delete(taskId);
    const updated = this.setTask(taskId, { status: "queued", error: null, note: null });
    this.queue.enqueue({ taskId, projectId: project.id, force });
    return updated;
  }

  retryTask(taskId: string, stageIndex?: number, force = false): Task {
    const { task } = this.load(taskId);
    if (stageIndex === undefined) return this.queueTask(taskId, this.defaultStart(task), force);
    if (stageIndex < 0 || stageIndex >= task.pipeline.length) throw new ConflictError(`No stage #${stageIndex + 1} in this pipeline.`);
    const prior = this.latestByStage(taskId).get(stageIndex);
    return this.queueTask(taskId, { fromStage: stageIndex, resume: prior?.session_id ?? undefined }, force);
  }

  private async ensureCwd(task: Task, project: Project): Promise<string> {
    if (!usesWorktree(task)) return project.path;
    if (task.worktree_path && existsSync(task.worktree_path)) return task.worktree_path;
    if (!(await this.git.isGitRepo(project.path))) {
      // isGitRepo cannot tell "no git" from "not a repository"; the fix for each is different.
      const installed = (await realProbe.run("git", ["--version"])).code === 0;
      throw new PolicyError(
        installed ? `Autonomous mode needs a git repository; ${project.path} is not one.` : "Autonomous mode needs git, and git is not installed on this computer. Open Setup to install it.",
      );
    }
    const wt = await this.git.addWorktree(project.path, task.id);
    // baseSha is null when an existing branch was re-attached: keep the stored base so the diff stays right.
    this.setTask(task.id, { branch: wt.branch, worktree_path: wt.path, base_sha: wt.baseSha ?? task.base_sha });
    await this.prepareWorkspace(task, project, wt.path);
    return wt.path;
  }

  /**
   * A worktree is a fresh checkout: gitignored files (.env and friends) are missing and dependencies
   * are not installed. Seed the declared files, then run the project's setup command.
   */
  private async prepareWorkspace(task: Task, project: Project, cwd: string): Promise<void> {
    const patterns = readWorktreeInclude(project.path, project.env.worktreeInclude);
    // The workspace is prepared before the first run row exists, so queue the notes for it.
    const note = (text: string) => {
      this.log(task.id, `${text}\n`);
      this.pendingNotes.set(task.id, [...(this.pendingNotes.get(task.id) ?? []), text]);
    };
    if (patterns.length) {
      const report = await seedWorktree(project.path, cwd, patterns);
      const parts = [`Copied ${report.copied.length} gitignored file(s) into the worktree`];
      if (report.copied.length) parts.push(report.copied.slice(0, 20).join(", "));
      if (report.skippedTracked.length) parts.push(`skipped (tracked by git, never copied): ${report.skippedTracked.slice(0, 10).join(", ")}`);
      if (report.skippedTooBig.length) parts.push(`skipped (too big): ${report.skippedTooBig.slice(0, 10).join(", ")}`);
      note(parts.join(" · "));
    }
    if (project.env.setupCommand) {
      const port = await this.portFor(task.id);
      const res = await runProjectCommand(project.env.setupCommand, cwd, { env: { KANBAN_PORT: String(port), KANBAN_PROJECT_PATH: project.path } });
      note(`Setup command \`${project.env.setupCommand}\` ${res.ok ? "succeeded" : `FAILED (exit ${res.code})`}\n${res.output.slice(-2000)}`);
      if (!res.ok) throw new PolicyError(`The project's setup command failed in the new worktree:\n${res.output.slice(-1500)}`);
    }
  }

  /** A stable free port per task so parallel dev servers don't collide. */
  private async portFor(taskId: string): Promise<number> {
    const existing = this.ports.get(taskId);
    if (existing) return existing;
    const port = await freePort();
    this.ports.set(taskId, port);
    return port;
  }

  async runPipeline(taskId: string): Promise<void> {
    const ctl: PipelineCtl = { stopped: false };
    this.pipelines.set(taskId, ctl);
    try {
      const opts = this.startOpts.get(taskId) ?? { fromStage: 0 };
      this.startOpts.delete(taskId);
      let { task, project } = this.load(taskId);
      this.assertRunnable(task, project);
      const cwd = await this.ensureCwd(task, project);
      // Reserved before the first prompt is written, so the prompt can name it.
      await this.portFor(taskId);
      let switches = 0;
      // Stage index → automatic continues used after hitting the turn cap (D201).
      const continued = new Map<number, number>();
      let continuing = false;

      for (let i = opts.fromStage; i < task.pipeline.length; i++) {
        if (ctl.stopped) {
          this.setTask(taskId, { status: "failed", error: "stopped by user" });
          return;
        }
        task = this.repo.getTask(taskId)!;
        // A per-stage cap alone lets a 3-stage task cost 3x it, and a parent with six subtasks far
        // more. Check the task's whole spend before starting another stage.
        const capped = this.taskCeiling(task);
        const spent = this.repo.taskCost(taskId);
        if (spent >= capped) {
          this.pauseForCost(taskId, spent, capped, "this task reached its ceiling");
          return;
        }
        // Its provider is known to be out: carry on where Settings say, or wait without calling it (D194).
        const pre = this.preflightProvider(task, i);
        if (pre === "paused") return;
        if (pre === "switched") {
          task = this.repo.getTask(taskId)!;
          if (i === opts.fromStage) opts.resume = undefined;
        }
        const stage = this.stageAt(task, i);
        const run = this.repo.createRun({
          task_id: taskId, stage: stage.stage, stage_index: i, model: stage.model, effort: stage.effort,
          provider: stage.provider && stage.provider !== ANTHROPIC_PROVIDER_ID ? stage.provider : null,
        });
        this.bus.publish({ type: "run.updated", run });
        this.setTask(taskId, { status: STAGE_STATUS[stage.stage], error: null });

        const gated = stage.stage === "code" || stage.stage === "custom";
        const prompt = continuing ? CONTINUE_PROMPT : await this.stagePromptFor(task, i, project, cwd);
        continuing = false;
        this.handovers.delete(taskId);
        const outcome = await this.runQuery({
          task, project, run, cwd, ctl,
          prompt,
          resume: i === opts.fromStage ? opts.resume : undefined,
          stageStatus: STAGE_STATUS[stage.stage],
          disallowedTools: stage.stage === "plan" ? PLAN_DISALLOWED : undefined,
          verifyCommand: gated ? project.env.verifyCommand : null,
        });
        // A read-only CLI provider that edited files broke its contract: fail before committing, so
        // the changes are neither kept as this stage's output nor merged (docs/DECISIONS.md D137).
        const res = this.providers.resolve(stage.provider);
        const readOnly = stage.stage === "plan" || stage.stage === "review" || !res.provider?.mayEditFiles;
        if (outcome.ok && res.adapter.kind === "cli" && readOnly && (await this.git.isDirty(cwd).catch(() => false))) {
          this.setTask(taskId, {
            status: "failed",
            error: `${res.label} was run read-only on the ${stage.stage} stage but left changes in the workspace. Nothing was committed. Inspect ${cwd}, then retry.`,
          });
          return;
        }
        if (usesWorktree(task)) {
          await this.commitWorktree(task, `kanban(${stage.stage})${outcome.ok ? "" : " [failed]"}: ${task.title}`);
        }
        if (!outcome.ok) {
          // Out of turns is not a fault either: the session is intact, so carry on in it (D201).
          const used = continued.get(i) ?? 0;
          const sessionId = this.repo.getRun(run.id)?.session_id;
          if (outcome.turnLimit && !ctl.stopped && sessionId && res.adapter.canResume && used < this.repo.getSettings().autoContinueTurns) {
            continued.set(i, used + 1);
            const note = `[board] The ${stage.stage} stage used all ${this.repo.getSettings().maxTurnsPerStage} turns — continuing in the same session (${used + 1} of ${this.repo.getSettings().autoContinueTurns}).`;
            this.log(run.id, `\n${note}\n`);
            const event = this.repo.insertEvent(run.id, "turns:continued", { type: "turns_continued", n: used + 1 });
            this.bus.publish({ type: "event", runId: run.id, taskId, event });
            opts.fromStage = i;
            opts.resume = sessionId;
            continuing = true;
            i--;
            continue;
          }
          // Money, not a fault: wait for Continue or Stop rather than fail (D185).
          if (outcome.budgetStop) {
            this.pauseForCost(taskId, this.repo.taskCost(taskId), this.taskCeiling(task), outcome.error ?? "the stage reached its ceiling");
            return;
          }
          // Ran out rather than went wrong: carry on elsewhere (the stage runs again, in this loop), or
          // wait for it to come back, or ask. Claude's windows and a provider's are handled alike (D194).
          if (!ctl.stopped) {
            // Three moves in one go is a merry-go-round, not a plan: after that it waits or asks.
            const mayMove = switches < 3;
            const next = outcome.providerId === ANTHROPIC_PROVIDER_ID
              ? this.afterClaudeLimit(taskId, i, outcome.error, run.id, mayMove)
              : await this.afterProviderOut(taskId, i, outcome.providerId, outcome.error, run.id, mayMove);
            if (next === "switched") {
              switches++;
              if (i === opts.fromStage) opts.resume = undefined;
              i--;
              continue;
            }
            if (next === "paused") return;
          }
          this.setTask(taskId, { status: "failed", error: outcome.error });
          return;
        }
        if (outcome.providerId !== ANTHROPIC_PROVIDER_ID) this.providerBack(outcome.providerId);
        // "Done" means the project's own check passes — not that the model said it was done.
        if (gated && project.env.verifyCommand) {
          const verdict = await this.verifyWorkspace(project, task, cwd, run.id);
          if (verdict && !verdict.ok) {
            this.verifyFailures.set(taskId, verdict.output);
            if (usesWorktree(task)) await this.commitWorktree(task, `kanban(${stage.stage}) [verify failed]: ${task.title}`);
            this.setTask(taskId, {
              status: "failed",
              error: `Verification failed — \`${project.env.verifyCommand}\` did not pass. Retry sends the output back to the ${stage.stage} stage.`,
            });
            return;
          }
          this.verifyFailures.delete(taskId);
        }
        // A plan can be argued over before any code is written (docs/DECISIONS.md D131).
        if (stage.stage === "plan") {
          const critic = this.providers.debateFor(stage, this.repo.getSettings());
          if (critic && (await this.debate({ task, project, planRun: run, stageIndex: i, cwd, ctl, critic }))) return;
          if (ctl.stopped) {
            this.setTask(taskId, { status: "failed", error: "stopped by user" });
            return;
          }
          // Plan approval (D200): nothing is written until the human has read the plan.
          const plan = this.repo.getRun(run.id)?.result_md ?? "";
          if (i + 1 < task.pipeline.length && plan.trim() && this.needsPlanApproval(this.repo.getTask(taskId)!)) {
            this.setTask(taskId, {
              status: "approval",
              note: "Read the plan, then approve it, edit it, or send the task back.",
              plan_gate: { kind: "approval", stage_index: i, created_at: nowIso(), original: plan },
            });
            return;
          }
        }
        // A review stage that asked for changes must not look like a pass.
        const verdict = verdictOf(this.repo.getRun(run.id)?.result_md);
        if (stage.stage === "review" && verdict === "CHANGES_NEEDED") {
          this.setTask(taskId, {
            status: "failed",
            error: `Review asked for changes — Retry from stage #${i} (code) after reading the review. ${firstLines(this.repo.getRun(run.id)?.result_md, 3)}`,
          });
          return;
        }
      }
      this.setTask(taskId, ctl.stopped ? { status: "failed", error: "stopped by user" } : { status: "review" });
    } finally {
      this.pipelines.delete(taskId);
    }
  }

  /**
   * The stage as it actually runs. A live task's review runs on Settings → liveReviewModel through
   * your Claude login, at high effort or more, whatever its pipeline says (D202): in a real run a
   * Sonnet review approved twice with real defects in a live-system change.
   */
  private stageAt(task: Task, i: number): Stage {
    const stage = task.pipeline[i];
    if (!task.live || stage.stage !== "review") return stage;
    const model = this.repo.getSettings().liveReviewModel;
    const same = stage.model === model && (!stage.provider || stage.provider === ANTHROPIC_PROVIDER_ID);
    const effort = same && EFFORTS.indexOf(stage.effort) >= EFFORTS.indexOf("high") ? stage.effort : "high";
    return { stage: "review", model, effort, ...(stage.prompt ? { prompt: stage.prompt } : {}) };
  }

  /** Whether the task waits for the human after its plan: its own choice, else Settings; always when live (D200, D202). */
  private needsPlanApproval(task: Task): boolean {
    if (task.live) return true;
    return task.plan_approval ?? this.repo.getSettings().planApproval;
  }

  /** The stage prompt, with what a tool-less model needs inlined (the diff, the file list). */
  private async stagePromptFor(task: Task, stageIndex: number, project: Project, cwd: string): Promise<string> {
    const stage = this.stageAt(task, stageIndex);
    const res = this.providers.resolve(stage.provider);
    const capabilities = res.adapter.hasTools ? (res.adapter.kind === "cli" ? "cli" : "sdk") : "text";
    const ctx = { ...this.promptCtx(task, stageIndex, project), capabilities } as ReturnType<TaskRunner["promptCtx"]> & { capabilities: "sdk" | "cli" | "text"; inlineDiff?: unknown; fileList?: unknown };
    if (capabilities === "text") {
      try {
        if (stage.stage === "review") {
          ctx.inlineDiff = task.branch && task.base_sha ? await this.git.diffTask(project.path, task.base_sha, task.branch) : await this.git.diffWorkingTree(cwd);
        }
        if (stage.stage === "plan") ctx.fileList = await this.git.lsFiles(project.path);
      } catch (err) {
        this.log(this.repo.latestRun(task.id)?.id ?? task.id, `[board] could not gather context for a text-only stage: ${String(err)}\n`);
      }
    }
    return stagePrompt(stage, () => buildStagePrompt(ctx as never));
  }

  /**
   * One round: a critic run lists objections, the planner revises in its own session, and the task
   * waits in Approval for the human to pick. Returns true when the pipeline must stop here (gated).
   * A broken or silent critic never blocks work: the plan stands and the pipeline continues.
   */
  private async debate(a: { task: Task; project: Project; planRun: Run; stageIndex: number; cwd: string; ctl: PipelineCtl; critic: { provider: string; model: string; effort: Run["effort"] } }): Promise<boolean> {
    const { task, project, stageIndex, cwd, ctl, critic } = a;
    const planRun = this.repo.getRun(a.planRun.id)!;
    const original = planRun.result_md ?? "";
    const skip = (reason: string) => {
      const event = this.repo.insertEvent(planRun.id, "debate:skipped", { type: "debate_skipped", reason });
      this.bus.publish({ type: "event", runId: planRun.id, taskId: task.id, event });
      return false;
    };
    if (!original.trim()) return skip("the plan stage produced no text to critique");
    if (ctl.stopped) return false;

    const criticRun = this.repo.createRun({
      task_id: task.id, stage: "plan", stage_index: stageIndex, model: critic.model, effort: critic.effort, role: "critic",
      provider: critic.provider && critic.provider !== ANTHROPIC_PROVIDER_ID ? critic.provider : null,
    });
    this.bus.publish({ type: "run.updated", run: criticRun });
    const earlier = this.promptCtx(task, stageIndex, project).earlierResults;
    const criticOutcome = await this.runQuery({
      task, project, run: criticRun, cwd, ctl, stageStatus: "planning", disallowedTools: PLAN_DISALLOWED, verifyCommand: null,
      prompt: buildCriticPrompt({ title: task.title, spec_md: task.spec_md, plan: original, earlier }),
    });
    if (ctl.stopped) return false;
    if (!criticOutcome.ok) return skip(`the critic failed: ${criticOutcome.error ?? "no result"}`);
    const critique = parseCritique(this.repo.getRun(criticRun.id)?.result_md ?? "");
    if (!critique.objections.length) return skip("the critic had no objections");

    // The planner answers in its own session when it has one; otherwise the plan travels with the critique.
    const planner = this.providers.resolve(planRun.provider);
    const revision = await this.runQuery({
      task, project, run: planRun, cwd, ctl, stageStatus: "planning", disallowedTools: PLAN_DISALLOWED, verifyCommand: null,
      accumulate: true, promptEvent: true,
      resume: planner.adapter.canResume ? planRun.session_id ?? undefined : undefined,
      prompt: buildRevisionPrompt(critique.raw, planner.adapter.canResume && planRun.session_id ? undefined : original),
    });
    if (ctl.stopped) return false;
    const revised = revision.ok ? extractRevisedPlan(this.repo.getRun(planRun.id)?.result_md) : "";
    // A failed revision must not leave the stage marked failed: the original plan still stands.
    if (!revision.ok) this.setRun(planRun.id, { status: "success", error: null, result_md: original });
    if (usesWorktree(task)) await this.commitWorktree(task, `kanban(debate): ${task.title}`);

    this.setTask(task.id, {
      status: "approval",
      note: "The plan was debated — pick the plan to build from.",
      plan_gate: {
        stage_index: stageIndex, critic_run_id: criticRun.id, critic: { provider: critic.provider, model: critic.model },
        created_at: nowIso(), original, critique, revised,
      },
    });
    return true;
  }

  /** The human's choice after a debate: writes the chosen plan in and continues the pipeline. */
  decidePlan(taskId: string, choice: "original" | "revised" | "custom", text?: string): Task {
    const { task } = this.load(taskId);
    const gate = task.plan_gate;
    if (!gate) throw new ConflictError("This task is not waiting on a plan decision.");
    if (this.isBusy(taskId)) throw new ConflictError("Task is busy; wait for it to settle.");
    const chosen = choice === "original" ? gate.original : choice === "revised" ? gate.revised ?? "" : (text ?? "");
    if (!chosen.trim()) throw new ConflictError(choice === "revised" ? "There is no revised plan to use — pick the original or write your own." : "The plan text is empty.");
    const planRun = this.latestByStage(taskId).get(gate.stage_index);
    if (planRun) {
      this.setRun(planRun.id, { result_md: chosen, status: "success", error: null });
      const event = gate.kind === "approval"
        ? this.repo.insertEvent(planRun.id, "plan:approved", { type: "plan_approved", edited: choice === "custom" })
        : this.repo.insertEvent(planRun.id, "debate:decision", { type: "debate_decision", choice });
      this.bus.publish({ type: "event", runId: planRun.id, taskId, event });
    }
    const next = gate.stage_index + 1;
    if (next >= task.pipeline.length) return this.setTask(taskId, { plan_gate: null, note: null, status: "review", error: null });
    const updated = this.setTask(taskId, { plan_gate: null, note: null, status: "queued", error: null });
    this.startOpts.set(taskId, { fromStage: next });
    this.queue.enqueue({ taskId, projectId: task.project_id });
    return updated;
  }

  private promptCtx(task: Task, stageIndex: number, project: Project) {
    const stage = task.pipeline[stageIndex];
    const settings = this.repo.getSettings();
    const parent = task.parent_id ? this.repo.getTask(task.parent_id) : undefined;
    const byStage = this.latestByStage(task.id);
    const prevRun = byStage.get(stageIndex - 1)?.status === "success" ? byStage.get(stageIndex - 1) : undefined;
    // Every earlier successful stage, clamped — so review sees the plan, not just the code summary.
    const earlierResults = task.pipeline
      .slice(0, Math.max(0, stageIndex - 1))
      .map((s, i) => ({ stage: s.stage, result: byStage.get(i)?.status === "success" ? byStage.get(i)!.result_md ?? "" : "" }))
      .filter((e) => e.result.trim());
    const titles = new Map<string, string>();
    const messages = this.repo.inboundMessages(task.id).map((m) => {
      let from = "the user";
      if (m.from_task_id) {
        if (!titles.has(m.from_task_id)) titles.set(m.from_task_id, this.repo.getTask(m.from_task_id)?.title ?? "?");
        from = `${m.from_task_id} (${titles.get(m.from_task_id)})`;
      }
      return { from, body: m.body };
    });
    return {
      stage: stage.stage,
      customPrompt: stage.prompt,
      mode: task.mode,
      task: { id: task.id, title: task.title, spec_md: task.spec_md },
      branch: task.branch,
      baseSha: task.base_sha,
      parent: parent ? { id: parent.id, title: parent.title, spec_md: parent.spec_md } : null,
      siblings: this.repo.siblings(task).map((s) => ({ id: s.id, title: s.title, status: s.status, summary: s.summary })),
      previousResult: stageIndex > 0 ? prevRun?.result_md ?? null : null,
      previousStage: stageIndex > 0 ? task.pipeline[stageIndex - 1]?.stage ?? null : null,
      live: task.live,
      previousFrom: prevRun?.provider ? { provider: prevRun.provider, model: prevRun.model } : null,
      earlierResults,
      skills: task.skills,
      messages,
      rejectNote: this.rejectNotes.get(task.id) ?? null,
      verificationFailure: this.verifyFailures.get(task.id) ?? null,
      handover: this.handovers.get(task.id) ?? null,
      verifyCommand: project.env.verifyCommand,
      browser: settings.browserChecks
        ? { port: this.ports.get(task.id) ?? null, chrome: settings.chromeInSupervised && task.mode !== "autonomous" }
        : null,
      memory: this.repo.notes(project.id, NOTES_IN_PROMPT).map((n) => n.text),
      // Images the user attached, by absolute path: Claude reads them with the Read tool, which
      // renders images. Ones a previous run produced are left out — it already saw those.
      images: this.repo
        .listAttachments(task.id)
        .filter((a) => a.source === "user")
        .slice(0, 8)
        .map((a) => ({ name: a.name, path: a.path, note: a.note, description: a.description, kind: attachmentKind(a.media_type) })),
      relatedTasks: task.related_to
        .map((id) => this.repo.getTask(id))
        .filter((t): t is Task => Boolean(t))
        .slice(0, 5)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, summary: t.summary })),
    };
  }

  /**
   * Skills a run may see: everything discovered minus the ones switched off in Settings.
   * A skill attached to the task always stays on. `undefined` = no filtering (CLI defaults).
   */
  private enabledSkills(project: Project, task: Task): string[] | undefined {
    const off = new Set(this.repo.getSettings().disabledSkills);
    if (!off.size) return undefined;
    const all = scanSkills({ projectPath: project.path }).map((s) => s.name);
    return all.filter((name) => !off.has(name) || task.skills.includes(name));
  }

  private async commitWorktree(task: Task, message: string) {
    const t = this.repo.getTask(task.id);
    if (!t?.worktree_path || !existsSync(t.worktree_path)) return;
    try {
      await this.git.commitAll(t.worktree_path, message);
    } catch (err) {
      this.log(this.repo.latestRun(task.id)?.id ?? "commit", `[commit failed] ${String(err)}\n`);
    }
  }

  // ---------------------------------------------------------------- one query() call

  private async runQuery(a: {
    task: Task;
    project: Project;
    run: Run;
    cwd: string;
    prompt: string;
    ctl: PipelineCtl;
    resume?: string;
    stageStatus: TaskStatus;
    disallowedTools?: string[];
    accumulate?: boolean;
    /** Record the prompt as a `user:prompt` event. Defaults to "unless accumulating" (chat writes its own). */
    promptEvent?: boolean;
    /** When set, the model can't end its turn while this command fails. */
    verifyCommand?: string | null;
  }): Promise<{ ok: boolean; error: string | null; providerId: string; budgetStop: boolean; turnLimit: boolean }> {
    const { task, run } = a;
    const abort = new AbortController();
    // Who runs this: Claude through your login, or one of the providers in Settings (D121).
    const res: Resolved = this.providers.resolve(run.provider);
    const foreign = res.id !== ANTHROPIC_PROVIDER_ID;
    this.active.set(task.id, {
      runId: run.id, abort, stageStatus: a.stageStatus,
      messageCursor: this.repo.lastMessageRow(task.id), steerable: !(res.adapter.run && res.provider),
    });
    // A Stop can land between the status change and here, before this controller existed; honour it.
    if (a.ctl.stopped) abort.abort();

    const settings = this.repo.getSettings();
    const autonomous = task.mode === "autonomous";
    // The board's own browser, one per session; see browser.ts for why not the Playwright plugin's.
    const browserDir = join(tmpdir(), "claude-kanban-browser", run.id);
    // The live view: the browser also opens a debugging port the board watches (browserWatch.ts).
    const watchPort = settings.browserChecks && settings.liveView ? await freePort().catch(() => undefined) : undefined;
    if (watchPort) this.browserWatch.begin(task.id, run.id, watchPort);
    // Board tools are always allowed; handled here rather than via allowedTools so nothing shadows this callback.
    const canUseTool: CanUseTool = async (toolName, input, o) => {
      if (toolName.startsWith("mcp__board__")) return { behavior: "allow", updatedInput: input };
      // A question for you, in both modes: it waits on a card like an approval (and, if Settings say
      // so, Claude decides for itself after a while). Before the gate, which would refuse it.
      if (toolName === QUESTION_TOOL) return this.askApproval(run, task.id, toolName, input, o);
      // The blocklist comes first, in both modes: these are the commands where an approval card
      // would just be a chance to click the wrong button.
      const command = String((input as { command?: unknown }).command ?? "");
      if (command) {
        const rule = blockedCommand(command, settings.blockedCommands);
        if (rule) {
          const note = `Refused: "${rule}" is on the board's blocked-command list (Settings → Runs & limits). Nothing was run.`;
          this.log(run.id, `
[board] ${note}
  ${command}
`);
          return { behavior: "deny", message: note };
        }
        const killer = killsByName(command);
        if (killer) {
          const note =
            `Refused: ${killer} kills every process with that name — including the board running this task and anything else on this computer. ` +
            "Stop only the process you started: stop its background shell, or kill its PID (`kill <pid>`, `taskkill /PID <pid> /T /F`). Nothing was run.";
          this.log(run.id, `\n[board] ${note}\n  ${command}\n`);
          return { behavior: "deny", message: note };
        }
        // Reading needs no card: a supervised card is for what changes something (D197).
        if (!autonomous && freeShellRead(toolName, input, settings.autoAllowReadCommands)) {
          this.log(run.id, `\n[board] read-only command, run without a card:\n  ${command}\n`);
          return { behavior: "allow", updatedInput: input };
        }
      }
      // Browser tools have their own rules: looking at a local page is not a write (docs/DECISIONS.md D128).
      const browser = browserDecision(toolName, input, autonomous, a.cwd, browserDir);
      if (browser?.behavior === "allow") return { behavior: "allow", updatedInput: browser.input };
      if (browser?.behavior === "deny") return browser;
      if (browser?.behavior === "ask") return this.askApproval(run, task.id, toolName, browser.input, o);
      return autonomous ? autonomousGate(toolName, input, a.cwd) : this.askApproval(run, task.id, toolName, input, o);
    };
    const chrome = settings.chromeInSupervised && !autonomous;
    const steer = this.steerHooks(task.id, run.id);

    // Claude's fast mode, per stage. Only Opus 5 / 4.8 support it; on anything else the flag is not
    // sent at all, so a stage moved to a cheaper model does not start failing.
    const fast = Boolean(task.pipeline[run.stage_index]?.fast) && supportsFastMode(run.model);
    const baseOptions: Options = {
      model: run.model,
      effort: run.effort,
      cwd: a.cwd,
      ...(fast ? { settings: { fastMode: true } } : {}),
      // "project" always loads (CLAUDE.md and project skills are part of the repo). "user" pulls in
      // your global plugins and hooks — measured at ~5,400 extra input tokens on every single stage.
      settingSources: settings.loadUserPlugins ? ["user", "project"] : ["project"],
      skills: this.enabledSkills(a.project, task),

      permissionMode: autonomous ? "acceptEdits" : "default",
      canUseTool,
      hooks: {
        ...(autonomous ? {} : { PreToolUse: forceAsk(settings.autoAllowReadCommands) }),
        // A message typed while the stage runs is handed over at the next tool call (D184).
        PostToolUse: steer.PostToolUse,
        // A waiting message holds the turn open first; then the deterministic gate: a code stage
        // can't end while the project's own check fails.
        Stop: [...steer.Stop, ...(a.verifyCommand ? this.verifyStopHook(a.verifyCommand, a.cwd, run.id, task.id) : [])],
      },
      env: {
        ...process.env,
        KANBAN_PORT: String(await this.portFor(task.id)),
        KANBAN_TASK_ID: task.id,
        // Opus 5 delegates to subagents readily; bound the blast radius of an unattended run.
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(settings.maxSubagentDepth),
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(settings.maxConcurrentSubagents),
      },
      // Keeps the system prompt static so it can be cached across sessions; the stripped
      // dynamic parts (cwd, git status) are re-injected as the first user message.
      systemPrompt: settings.cacheableSystemPrompt ? { type: "preset", preset: "claude_code", excludeDynamicSections: true } : undefined,
      mcpServers: {
        board: createBoardServer(this.repo, this.bus, { taskId: task.id, runId: run.id }, (parent) => this.promoteReady(parent.project_id)),
        ...(settings.browserChecks ? { [BROWSER_SERVER]: browserServer(browserDir, pickBrowser(realProbe)?.browser, watchPort) } : {}),
      },
      // Claude in Chrome is switched on per run, and explicitly off otherwise: an unattended run must
      // never drive the browser you are signed in with.
      extraArgs: chrome ? { chrome: null } : { "no-chrome": null },
      disallowedTools: [...ALWAYS_DISALLOWED, PLAYWRIGHT_PLUGIN_TOOLS, ...(a.disallowedTools ?? [])],
      // Only a real Claude Code session can be continued; HTTP and CLI runs start over (D127).
      resume: res.adapter.canResume ? a.resume : undefined,
      abortController: abort,
      // Ceilings so an unattended run can't loop forever or burn the budget (docs/DECISIONS.md D25).
      maxTurns: settings.maxTurnsPerStage,
      maxBudgetUsd: settings.maxCostPerStageUsd,
      stderr: (d) => this.log(run.id, d),
    };
    const options: Options = res.adapter.applyOptions && res.provider ? res.adapter.applyOptions(baseOptions, { provider: res.provider, model: run.model, secret: res.secret }) : baseOptions;
    const emit = (type: string, payload: unknown) => {
      const event = this.repo.insertEvent(run.id, type, payload);
      this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event });
    };
    const stream: AsyncIterable<SDKMessage> = res.adapter.run && res.provider
      ? res.adapter.run({
          run, task, project: a.project, prompt: a.prompt, cwd: a.cwd, provider: res.provider, model: run.model, effort: run.effort,
          readOnly: run.stage === "plan" || run.stage === "review" || !res.provider.mayEditFiles, mode: task.mode, abort: abort.signal,
          timeoutMs: settings.delegateTimeoutMin * 60_000, secret: res.secret, emit, log: (line) => this.log(run.id, line),
        } satisfies StageInvocation)
      : this.queryFn({ prompt: userMessage(a.prompt), options });

    for (const text of this.pendingNotes.get(task.id) ?? []) {
      const event = this.repo.insertEvent(run.id, "board:workspace", { type: "workspace", text });
      this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event });
    }
    this.pendingNotes.delete(task.id);

    // Persist what we actually sent, so the transcript shows the context this stage received.
    if (a.promptEvent ?? !a.accumulate) {
      const sent = this.repo.insertEvent(run.id, "user:prompt", { type: "stage_prompt", text: a.prompt });
      this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event: sent });
    }

    // The subscription window is what actually runs out, so note where it stood before this stage.
    const before = foreign ? null : this.fiveHourUtilization();
    if (before !== null && this.repo.getRun(run.id)?.limit_before === null) this.setRun(run.id, { limit_before: before });
    // The SDK cannot price a foreign model id (it guesses a Claude price), so its budget ceiling is
    // switched off for those; the board meters a foreign stage itself from the usage each turn reports (D124).
    let metered = 0;

    // A stage that calls the same tool with the same arguments over and over is stuck, not working.
    const repeats = { key: "", count: 0 };
    let loopStopped = false;

    let result: { ok: boolean; text: string | null; error: string | null; cost: number; inTok: number; outTok: number } | null = null;
    let thrown: string | null = null;
    let budgetStop = false;
    let turnLimit = false;
    try {
      for await (const msg of stream) {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && this.repo.getRun(run.id)!.session_id !== sid) this.setRun(run.id, { session_id: sid });
        const event = this.repo.insertEvent(run.id, eventType(msg), msg);
        this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event });

        // How full the session's context is right now (what Claude Code shows as the context bar).
        if (msg.type === "assistant") {
          for (const block of (msg.message?.content ?? []) as { type: string; name?: string; input?: Record<string, unknown> }[]) {
            const caption = block.type === "tool_use" && block.name ? browserCaption(block.name, block.input ?? {}) : null;
            if (caption) this.browserWatch.action(task.id, caption, typeof block.input?.url === "string" ? block.input.url : undefined);
          }
          const u = msg.message?.usage;
          if (u) {
            const held = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
            if (held > (this.repo.getRun(run.id)?.context_tokens ?? 0)) this.setRun(run.id, { context_tokens: held });
            if (foreign && res.provider) {
              metered += estimateCost(res.provider, run.model, {
                inputTokens: u.input_tokens ?? 0, cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
              }, this.catalog.priceOf(res.provider, run.model)).usd;
              if (metered > settings.maxCostPerStageUsd) {
                thrown = `the estimated cost passed the per-stage ceiling of $${settings.maxCostPerStageUsd.toFixed(2)} — the SDK cannot price ${run.model} itself, so the board metered it from your price table`;
                budgetStop = true;
                this.log(run.id, `\n[board] Stopped at $${metered.toFixed(2)}: ${thrown}\n`);
                abort.abort();
                break;
              }
            }
          }
        }
        if (!loopStopped && this.countRepeats(msg, repeats)) {
          loopStopped = true;
          this.log(run.id, `
[board] stopped: the same tool call was repeated ${repeats.count} times.
`);
          thrown = `Stopped after the same tool call was repeated ${repeats.count} times — the session was looping, not progressing.`;
          abort.abort();
          // Stop consuming immediately: a session that ignores the abort would otherwise keep going.
          break;
        }
        this.captureImages(msg, task.id, run.id, a.cwd);
        // Usage windows are Claude's subscription; a foreign endpoint's numbers mean nothing here.
        if (msg.type === "rate_limit_event" && !foreign) {
          this.recordRateLimit(msg as unknown as { rate_limit_info?: RateLimitInfo });
          const after = this.fiveHourUtilization();
          if (after !== null) this.setRun(run.id, { limit_after: after, ...(this.repo.getRun(run.id)?.limit_before === null ? { limit_before: after } : {}) });
        }
        if (msg.type === "result") {
          const r = msg as Extract<SDKMessage, { type: "result" }>;
          let inTok = 0;
          let outTok = 0;
          for (const u of Object.values(r.modelUsage ?? {})) {
            inTok += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
            outTok += u.outputTokens ?? 0;
          }
          const window = Math.max(0, ...Object.values(r.modelUsage ?? {}).map((u) => u.contextWindow ?? 0));
          if (window) this.setRun(run.id, { context_window: window });
          const ok = r.subtype === "success" && !r.is_error;
          // The SDK's own per-stage ceiling: the session is intact and can be resumed after Continue.
          if (r.subtype === "error_max_budget_usd") budgetStop = true;
          if (r.subtype === "error_max_turns") turnLimit = true;
          // Where the dollar figure comes from is kept on the run: prices can be edited later (D123).
          let cost = r.total_cost_usd ?? 0;
          let costSource: Run["cost_source"] = "sdk";
          if (foreign && res.provider) {
            const fromApi = (r as { cost_source?: string }).cost_source === "provider";
            if (fromApi) costSource = "provider";
            else ({ usd: cost, source: costSource } = estimateCost(res.provider, run.model, sumUsage(r.modelUsage as never), this.catalog.priceOf(res.provider, run.model)));
          }
          if (this.repo.getRun(run.id)?.cost_source !== costSource) this.setRun(run.id, { cost_source: costSource });
          result = {
            ok,
            text: r.subtype === "success" ? r.result : null,
            error: ok ? null : r.subtype === "error_max_budget_usd" ? `this stage reached its own ceiling of $${settings.maxCostPerStageUsd.toFixed(2)}` : r.subtype === "success" ? r.result || "error result" : (r.errors ?? []).join("\n") || r.subtype,
            cost,
            inTok,
            outTok,
          };
        }
      }
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    } finally {
      this.active.delete(task.id);
      this.browserWatch.end(task.id, run.id);
      for (const ap of this.repo.pendingApprovals(task.id)) this.resolvers.get(ap.id)?.({ decision: "expired", note: "run ended" });
      // Screenshots were already kept from the tool results; the rest is page snapshots and logs.
      try {
        rmSync(browserDir, { recursive: true, force: true });
      } catch {
        // Still held by a browser that is shutting down; it is in the temp folder either way.
      }
      // A dev server the stage started and forgot (or started with `&`) must not outlive it.
      const port = this.ports.get(task.id);
      if (port) {
        const stopped = await stopListeners(port).catch(() => [] as number[]);
        if (stopped.length) this.log(run.id, `\n[board] stopped what this stage left running on port ${port} (PID ${stopped.join(", ")})\n`);
      }
    }

    const error = a.ctl.stopped ? "stopped by user" : result && !result.ok ? result.error : result ? null : thrown ?? "run ended without a result";
    const prev = this.repo.getRun(run.id)!;
    const add = a.accumulate ? prev : { cost_usd: 0, input_tokens: 0, output_tokens: 0 };
    const finished = this.repo.updateRun(run.id, {
      status: error ? "failed" : "success",
      ended_at: nowIso(),
      cost_usd: add.cost_usd + (result?.cost ?? 0),
      input_tokens: add.input_tokens + (result?.inTok ?? 0),
      output_tokens: add.output_tokens + (result?.outTok ?? 0),
      result_md: result?.text ?? prev.result_md,
      error,
    });
    this.bus.publish({ type: "run.finished", run: finished });
    return { ok: !error, error, providerId: res.id, budgetStop: budgetStop && !a.ctl.stopped, turnLimit: turnLimit && !a.ctl.stopped };
  }

  /**
   * Live steering (D184): a message posted while a stage runs is handed to Claude at its next tool
   * call as extra context, and a turn is not allowed to end while one is still waiting. The cursor
   * advances synchronously before any await, so parallel tool calls cannot deliver a message twice.
   */
  private steerHooks(taskId: string, runId: string): { PostToolUse: HookCallbackMatcher[]; Stop: HookCallbackMatcher[] } {
    const take = (): string | null => {
      const active = this.active.get(taskId);
      if (!active || active.runId !== runId) return null;
      const fresh = this.repo.messagesAfter(taskId, active.messageCursor);
      if (!fresh.length) return null;
      active.messageCursor = fresh[fresh.length - 1].rid;
      const lines = fresh.map((m) => {
        const from = m.from_task_id ? `task ${m.from_task_id} (${this.repo.getTask(m.from_task_id)?.title ?? "?"})` : "the user";
        return `From ${from}, sent while you were working:\n${m.body}`;
      });
      const event = this.repo.insertEvent(runId, "board:steer", { type: "steer", count: fresh.length });
      this.bus.publish({ type: "event", runId, taskId, event });
      return `${lines.join("\n\n")}\n\nTake this into account from here on, and say in your next message how you are acting on it.`;
    };
    return {
      PostToolUse: [{ hooks: [async () => { const ctx = take(); return ctx ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } } : {}; }] }],
      Stop: [{ hooks: [async () => { const ctx = take(); return ctx ? { decision: "block" as const, reason: ctx } : {}; }] }],
    };
  }

  /**
   * Stop hook: re-runs the project's verify command when the model wants to end its turn and blocks
   * the stop while it fails, so the agent fixes it in-session instead of the board failing the task cold.
   * Claude Code stops honouring the block after 8 consecutive attempts, so this cannot loop forever.
   */
  private verifyStopHook(command: string, cwd: string, runId: string, taskId: string): HookCallbackMatcher[] {
    return [
      {
        hooks: [
          async () => {
            const res = await runProjectCommand(command, cwd, { env: { KANBAN_PORT: String(this.ports.get(taskId) ?? 0) }, timeoutMs: 10 * 60_000 });
            const event = this.repo.insertEvent(runId, res.ok ? "verify:passed" : "verify:failed", { type: "verify", command, ok: res.ok, output: res.output });
            this.bus.publish({ type: "event", runId, taskId, event });
            if (res.ok) return {};
            return {
              decision: "block" as const,
              reason:
                `\`${command}\` still fails, so this task is not done:\n\n${res.output.slice(-4000)}\n\n` +
                "Fix the cause. Do not weaken, skip or delete checks to make it pass.",
            };
          },
        ],
      },
    ];
  }

  /**
   * Land a task's branch, safely, with only one landing per project at a time.
   *
   * The order matters and is the whole point: the base is brought into the task's **worktree** first,
   * so a conflict happens there — where the session that wrote the code can fix it — and never in the
   * checkout the user is sitting in. Verification then runs against the combined result, because
   * "passed before another task landed" is not the same as "passes now". Only then is the branch
   * merged, which by that point cannot conflict.
   */
  private async landBranch(project: Project, task: Task): Promise<void> {
    const policy = project.merge;
    const branch = task.branch!;
    const base = policy.baseBranch?.trim() || (await this.git.currentBranch(project.path));

    const previous = this.merging.get(project.id) ?? Promise.resolve();
    let release = () => {};
    this.merging.set(project.id, new Promise<void>((r) => (release = r)));
    await previous;
    try {
      // Landing while the checkout has uncommitted work risks entangling it in a merge commit.
      if (await this.git.isDirty(project.path)) {
        throw new ConflictError(
          `${project.path} has uncommitted changes. Commit or stash them first — the board will not merge into a dirty checkout.`,
        );
      }
      const onBranch = await this.git.currentBranch(project.path);
      if (onBranch !== base) {
        throw new ConflictError(`This project lands work on "${base}", but the checkout is on "${onBranch}". Switch branch, or change the base in Settings → Git & merging.`);
      }

      if (policy.updateBeforeMerge && task.worktree_path && existsSync(task.worktree_path)) {
        const how = policy.strategy === "rebase" ? "rebase" : "merge";
        const update = await this.git.updateFromBase(task.worktree_path, base, how);
        if (!update.ok) {
          const files = update.conflicts.join(", ");
          const note = `"${base}" has moved on and conflicts with this task in: ${files}. Nothing was merged and your checkout is untouched.`;
          if (policy.onConflict === "claude") {
            this.setTask(task.id, { status: "backlog", note: `${note} Queued a stage to resolve it.` });
            this.queueResolveStage(task, base, update.conflicts);
            throw new ConflictError(`${note} Claude has been queued to resolve it — approve again when that finishes.`);
          }
          throw new ConflictError(`${note} Open the task's worktree at ${task.worktree_path} and resolve it, or use Follow-up to redo the work on the current code.`);
        }
        // Re-verify against the combined result: passing before another task landed proves nothing.
        if (update.pulled > 0 && policy.verifyBeforeMerge) {
          const run = this.repo.latestRun(task.id);
          const res = await this.verifyWorkspace(project, task, task.worktree_path, run?.id ?? "");
          if (res && !res.ok) {
            this.setTask(task.id, { status: "review", note: `Verification failed after updating from "${base}" (${update.pulled} new commit${update.pulled === 1 ? "" : "s"}). Nothing was merged.` });
            throw new ConflictError(`The project's verify command fails once this task is combined with "${base}". Nothing was merged.\n\n${res.output.slice(0, 2000)}`);
          }
        }
      }

      try {
        await this.git.mergeTask(project.path, branch, `Merge ${branch}: ${task.title}`, policy.strategy);
      } catch (err) {
        throw new ConflictError(`Merge into "${base}" failed. ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      release();
    }
  }

  /**
   * Put the task back to work with the conflict as its job, as a chat turn in the session that wrote
   * the code — it is already in the worktree with the context. Deliberately NOT a new pipeline stage:
   * appending one would weld a synthetic stage onto the task for the rest of its life, skewing every
   * later retry, stage count and failure statistic.
   */
  private queueResolveStage(task: Task, base: string, conflicts: string[]): void {
    const prompt = [
      `The branch "${task.branch}" is behind "${base}", and merging "${base}" into it conflicts in: ${conflicts.join(", ")}.`,
      "",
      `Run \`git merge ${base}\` in this worktree and resolve every conflict, keeping both sides' intent — the other change was made deliberately by another task, so do not discard it. Then commit the merge.`,
      "Finally make sure the project's checks still pass. Report which files you resolved and how you decided.",
    ].join("\n");
    // Deferred so the caller's hold on the task is released first.
    setImmediate(() => {
      try {
        this.chat(task.id, prompt);
      } catch {
        this.setTask(task.id, { status: "review", note: `Could not start the conflict resolution automatically. Resolve it in ${task.worktree_path}, or use Follow-up.` });
      }
    });
  }

  /** Board-side verification after a stage: the record of record for whether the work is good. */
  private async verifyWorkspace(project: Project, task: Task, cwd: string, runId: string): Promise<{ ok: boolean; output: string } | null> {
    const command = project.env.verifyCommand?.trim();
    if (!command) return null;
    // The same command can be asked for three times for one unchanged tree — by the Stop hook, by
    // the board after the stage, and again before landing. Running a real test suite three times is
    // minutes of wall clock for an answer we already have.
    const fingerprint = await this.treeFingerprint(cwd, command);
    if (fingerprint && this.verified.get(task.id) === fingerprint) {
      return { ok: true, output: `$ ${command}
(unchanged since it last passed — not re-run)` };
    }
    const res = await runProjectCommand(command, cwd, { env: { KANBAN_PORT: String(this.ports.get(task.id) ?? 0) }, timeoutMs: 10 * 60_000 });
    if (fingerprint) {
      if (res.ok) this.verified.set(task.id, fingerprint);
      else this.verified.delete(task.id);
    }
    const event = this.repo.insertEvent(runId, res.ok ? "verify:passed" : "verify:failed", {
      type: "verify", command, ok: res.ok, output: res.output, timedOut: res.timedOut,
    });
    this.bus.publish({ type: "event", runId, taskId: task.id, event });
    return { ok: res.ok, output: `$ ${command}\n${res.output}` };
  }

  /**
   * Identifies the exact contents of a working tree, so "already verified" means the same code and
   * the same command — not merely the same task. Null when it cannot be determined, which disables
   * the cache rather than risking a stale pass.
   */
  private async treeFingerprint(cwd: string, command: string): Promise<string | null> {
    try {
      // A dirty tree changes with every edit, so only a committed state can be cached.
      if (await this.git.isDirty(cwd)) return null;
      const sha = await this.git.headSha(cwd);
      return sha ? `${sha}:${command}` : null;
    } catch {
      return null;
    }
  }

  /**
   * Keeps what a session produces: screenshots that come back inside tool results, and the files it
   * writes that are output rather than source — a report, a spreadsheet, a page, a diagram. They are
   * copied into the board's own storage, so they survive the worktree being removed at approval.
   */
  /** tool_use id → tool name, so a tool result can be told apart by the tool that produced it. */
  private toolNames = new Map<string, string>();

  private captureImages(msg: SDKMessage, taskId: string, runId: string, cwd: string): void {
    if (this.repo.countAttachments(taskId, runId) >= MAX_ARTIFACTS_PER_RUN) return;
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Record<string, unknown>[]) {
      try {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") this.toolNames.set(block.id, block.name);
        // Opening an image with Read is looking at a file that already exists (often one you attached),
        // not producing one: keeping it would file a copy of your own image as a "screenshot".
        const opened = block.type === "tool_result" && this.toolNames.get(String(block.tool_use_id)) === "Read";
        if (block.type === "tool_result") this.toolNames.delete(String(block.tool_use_id));
        if (opened) continue;
        // A screenshot handed back by a tool (browser MCP, image generation, …).
        for (const img of imageBlocks(block)) {
          const data = Buffer.from(img.data, "base64");
          if (!data.byteLength || data.byteLength > MAX_ATTACHMENT_BYTES) continue;
          const at = saveAttachment(this.repo, {
            task_id: taskId, run_id: runId, source: "run", name: `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`,
            media_type: img.media_type, data, note: `screenshot from the ${this.repo.getRun(runId)?.stage ?? "code"} stage`,
          });
          this.bus.publish({ type: "attachment.added", attachment: at });
        }
        // A file the session produced: a report, a spreadsheet, a page, a diagram. Source files are
        // deliberately not kept — they are already in the diff; these are the things that are not.
        if (block.type === "tool_use" && typeof block.name === "string" && WRITE_TOOLS.has(block.name)) {
          const file = (block.input as { file_path?: string } | undefined)?.file_path;
          if (!file || !ARTIFACT_EXTS.includes(extname(file).toLowerCase())) continue;
          const abs = isAbsolute(file) ? file : join(cwd, file);
          if (IGNORED_DIRS.test(abs) || !existsSync(abs)) continue;
          // Check the size before reading it: a huge generated file would otherwise be pulled into
          // memory in full, on the event loop, only to be thrown away.
          const size = statSync(abs).size;
          if (!size || size > MAX_ATTACHMENT_BYTES) continue;
          const data = readFileSync(abs);
          // One entry per path: a file written three times should not appear three times.
          for (const old of this.repo.listAttachments(taskId)) {
            if (old.source === "run" && old.name === basename(abs)) {
              if (existsSync(old.path)) rmSync(old.path, { force: true });
              this.repo.deleteAttachment(old.id);
            }
          }
          const at = saveAttachment(this.repo, {
            task_id: taskId, run_id: runId, source: "run", name: basename(abs), data, note: `written during the ${this.repo.getRun(runId)?.stage ?? "code"} stage`,
          });
          this.bus.publish({ type: "attachment.added", attachment: at });
        }
      } catch {
        // An image is a nice-to-have; never let it break the run.
      }
    }
  }

  /**
   * Counts identical consecutive tool calls. Documented runaway agents spend hours (and real money)
   * retrying one failing call; a bounded repeat count turns that into a clean, explained failure.
   */
  private countRepeats(msg: SDKMessage, state: { key: string; count: number }): boolean {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return false;
    let hit = false;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== "tool_use") continue;
      const key = `${String(block.name)}:${JSON.stringify(block.input ?? {}).slice(0, 400)}`;
      if (key === state.key) state.count += 1;
      else {
        state.key = key;
        state.count = 1;
      }
      if (state.count >= this.repo.getSettings().maxRepeatedToolCalls) hit = true;
    }
    return hit;
  }

  /** Subscription usage windows (five_hour / seven_day…) as the CLI reports them mid-run. */
  /** The five-hour window as last reported, 0–1, or null if the CLI has not told us yet. */
  private fiveHourUtilization(): number | null {
    const row = this.repo.usageLimits().find((l) => l.type === "five_hour");
    return typeof row?.utilization === "number" ? row.utilization : null;
  }

  /**
   * Records the subscription windows the CLI reports. The percentages live in `unifiedWindows` — one
   * entry per window — not at the top level: reading only the top level recorded the five-hour window
   * with no percentage and never recorded the weekly one at all.
   */
  recordRateLimit(msg: { rate_limit_info?: RateLimitInfo }) {
    const info = msg.rate_limit_info;
    if (!info) return;
    const norm = (u: unknown) => (typeof u === "number" ? (u > 1 ? u / 100 : u) : null);
    const windows = Object.entries(info.unifiedWindows ?? {});
    for (const [type, w] of windows) {
      this.repo.upsertUsageLimit({
        type,
        // The top-level status belongs to the window named in rateLimitType; others are only "rejected" at 100%.
        status: type === info.rateLimitType ? (info.status ?? "allowed") : (norm(w.utilization) ?? 0) >= 1 ? "rejected" : "allowed",
        utilization: norm(w.utilization),
        resets_at: w.resetsAt ?? null,
      });
    }
    // Older CLIs send only the top-level fields; keep what they give rather than nothing.
    if (!windows.length && info.rateLimitType) {
      this.repo.upsertUsageLimit({ type: info.rateLimitType, status: info.status ?? "allowed", utilization: norm(info.utilization), resets_at: info.resetsAt ?? null });
    }
    this.bus.publish({ type: "limits.updated", limits: this.repo.usageLimits() });
  }

  private fastStatus: FastModeStatus | null = null;

  /**
   * Whether this account can use fast mode, read from the session's init message and aborted before
   * any model call — so it costs nothing. Cached: it only changes when your plan or org settings do.
   */
  async fastModeStatus(force = false): Promise<FastModeStatus> {
    if (this.fastStatus && !force && Date.now() - Date.parse(this.fastStatus.checked_at) < 15 * 60_000) return this.fastStatus;
    const abort = new AbortController();
    const options: Options = {
      model: "claude-opus-5", cwd: process.cwd(), maxTurns: 1, permissionMode: "dontAsk", ...LEAN,
      settings: { fastMode: true }, abortController: abort,
    };
    let state: FastModeStatus["state"] = "off";
    let reason: string | null = "unknown";
    try {
      for await (const msg of this.queryFn({ prompt: userMessage("ok"), options })) {
        const m = msg as { type: string; subtype?: string; fast_mode_state?: FastModeStatus["state"]; fast_mode_disabled_reason?: string };
        if (m.type === "system" && m.subtype === "init") {
          state = m.fast_mode_state ?? "off";
          reason = m.fast_mode_disabled_reason ?? null;
          abort.abort();
          break;
        }
      }
    } catch {
      // aborted on purpose once the init message arrived
    }
    this.fastStatus = { state, reason: state === "on" ? null : reason, message: fastModeMessage(state, reason), checked_at: nowIso() };
    return this.fastStatus;
  }

  private claudeList: ClaudeModelsResult | null = null;
  private claudeListing: Promise<ClaudeModelsResult> | null = null;

  /**
   * The Claude models your login can use, as Claude Code lists them in its model picker. Read in the
   * session's startup handshake with no prompt ever sent, so it costs nothing. A list is kept 30
   * minutes (it changes when Claude ships a model or your plan changes); a failure only 30 seconds.
   */
  async claudeModels(force = false): Promise<ClaudeModelsResult> {
    const c = this.claudeList;
    const fresh = c && Date.now() - Date.parse(c.checked_at) < (c.source === "live" ? 30 * 60_000 : 30_000);
    if (c && fresh && !force) return c;
    this.claudeListing ??= this.listClaudeModels().finally(() => (this.claudeListing = null));
    return (this.claudeList = await this.claudeListing);
  }

  private async listClaudeModels(): Promise<ClaudeModelsResult> {
    const abort = new AbortController();
    // A prompt that never sends anything: the session starts, answers the question, and is closed.
    const silent = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise((r) => abort.signal.addEventListener("abort", r, { once: true }));
    })();
    const q = this.queryFn({ prompt: silent, options: { cwd: process.cwd(), ...LEAN, abortController: abort } }) as AsyncIterable<SDKMessage> & {
      supportedModels?: () => Promise<SdkModelInfo[]>;
      close?: () => void;
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      if (typeof q.supportedModels !== "function") throw new Error("this Claude Code version cannot list its models");
      const infos = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("Claude Code did not answer within 20 seconds")), 20_000))),
      ]);
      const models = fromSdk(infos);
      if (!models.length) throw new Error("Claude Code listed no models");
      return { source: "live", models, checked_at: nowIso() };
    } catch (err) {
      return { source: "unavailable", models: [], checked_at: nowIso(), error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      abort.abort();
      try {
        q.close?.();
      } catch {
        // already closed
      }
    }
  }

  private toolsStatus: (SessionTools & { key: string }) | null = null;

  /**
   * The plugins, MCP servers, skills and commands a run gets, with the board's rule for each server.
   * Built from the same options a run uses and aborted at the init message, so it costs nothing —
   * but it does start every MCP server once, so it is cached.
   */
  async sessionTools(force = false): Promise<SessionTools> {
    const settings = this.repo.getSettings();
    // Changing one of these settings changes the answer, so it also invalidates the cache.
    const key = `${settings.loadUserPlugins}|${settings.browserChecks}|${settings.chromeInSupervised}`;
    const cached = this.toolsStatus;
    if (cached && !force && cached.key === key && Date.now() - Date.parse(cached.checked_at) < 10 * 60_000) return cached;
    const abort = new AbortController();
    const dir = join(tmpdir(), "claude-kanban-browser", "probe");
    const options: Options = {
      model: settings.triageModel, cwd: process.cwd(), maxTurns: 1, permissionMode: "dontAsk", abortController: abort,
      settingSources: settings.loadUserPlugins ? ["user", "project"] : ["project"],
      mcpServers: settings.browserChecks ? { [BROWSER_SERVER]: browserServer(dir, pickBrowser(realProbe)?.browser) } : {},
      extraArgs: settings.chromeInSupervised ? { chrome: null } : { "no-chrome": null },
      disallowedTools: [PLAYWRIGHT_PLUGIN_TOOLS],
    };
    const out: SessionTools = { plugins: [], servers: [], skills: 0, commands: 0, userPlugins: settings.loadUserPlugins, checked_at: nowIso(), error: null };
    try {
      for await (const msg of this.queryFn({ prompt: userMessage("ok"), options })) {
        const m = msg as {
          type: string; subtype?: string; tools?: string[]; skills?: unknown[]; slash_commands?: unknown[];
          mcp_servers?: { name: string; status: string }[]; plugins?: { name: string; version?: string; source?: string }[];
        };
        if (m.type !== "system" || m.subtype !== "init") continue;
        const tools = m.tools ?? [];
        out.plugins = (m.plugins ?? []).map((p) => ({ name: p.name, version: p.version ?? null, source: p.source ?? null }));
        // The board's own server is created per task, so it is not in this session; it is always there.
        out.servers = [
          { name: "board", status: "connected", tools: -1, rule: serverRule("mcp__board__") },
          ...(m.mcp_servers ?? []).map((s) => {
            const prefix = `mcp__${s.name.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
            return { name: s.name, status: s.status, tools: tools.filter((t) => t.startsWith(prefix)).length, rule: serverRule(prefix) };
          }),
        ];
        out.skills = (m.skills ?? []).length;
        out.commands = (m.slash_commands ?? []).length;
        abort.abort();
        break;
      }
    } catch (err) {
      if (!abort.signal.aborted) out.error = err instanceof Error ? err.message : String(err);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // held by the browser that is shutting down
    }
    this.toolsStatus = { ...out, key };
    return out;
  }

  /**
   * The numbers behind Claude Code's own `/usage` screen, read from your claude.ai account — so they
   * include everything on the subscription (Claude Code, claude.ai, other machines), not just the
   * board's runs. No message is ever sent, so it costs nothing (measured: ~1 s, $0).
   *
   * Numbers that only arrived with the board's own runs went stale the moment you used Claude
   * anywhere else: the meter showed 40% an hour after the real figure had reached 88%.
   * The SDK marks this call experimental; when it is missing or fails, this returns null and the
   * caller falls back to the paid probe below.
   */
  async readUsage(): Promise<UsageLimit[] | null> {
    type UsageWindow = { utilization: number | null; resets_at: string | null; locked_reason?: string | null } | null | undefined;
    type Usage = {
      rate_limits_available: boolean;
      rate_limits: (Record<string, UsageWindow> & { model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[] }) | null;
    };
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const abort = new AbortController();
    const q = this.queryFn({
      // A session with no message: it starts, answers the usage request, and is closed unused.
      prompt: (async function* () {
        await held;
      })(),
      options: { model: this.repo.getSettings().triageModel, cwd: process.cwd(), settingSources: [], permissionMode: "dontAsk", abortController: abort },
    }) as AsyncIterable<SDKMessage> & { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<Usage> };
    const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    try {
      if (typeof read !== "function") return null;
      const u = await Promise.race([
        read.call(q, { skipBehaviors: true }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), 20_000).unref()),
      ]);
      if (!u?.rate_limits_available || !u.rate_limits) return null;
      const put = (type: string, w: UsageWindow) => {
        if (!w || (w.utilization === null && !w.resets_at)) return;
        const pct = w.utilization ?? 0;
        this.repo.upsertUsageLimit({
          type,
          status: w.locked_reason || pct >= 100 ? "rejected" : "allowed",
          utilization: w.utilization === null ? null : pct / 100,
          resets_at: w.resets_at ? Math.round(Date.parse(w.resets_at) / 1000) : null,
        });
      };
      for (const type of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) put(type, u.rate_limits[type]);
      for (const m of u.rate_limits.model_scoped ?? []) put(`seven_day_model:${m.display_name}`, m);
      const limits = this.repo.usageLimits();
      this.bus.publish({ type: "limits.updated", limits });
      return limits;
    } catch {
      return null;
    } finally {
      release();
      abort.abort();
    }
  }

  private usageTimer: NodeJS.Timeout | null = null;

  /** Keeps the meter current: now, then every few minutes. Free — see readUsage. Server only, not tests. */
  pollUsage(everyMs = 5 * 60_000): void {
    if (this.usageTimer) return;
    const tick = () => void this.readUsage().catch(() => null);
    tick();
    this.usageTimer = setInterval(tick, everyMs);
    this.usageTimer.unref();
  }

  /** Fresh numbers on demand: the free read, or — only if that is unavailable — one tiny paid call. */
  async refreshLimits(): Promise<UsageLimit[]> {
    return (await this.readUsage()) ?? this.probeLimits();
  }

  /**
   * Asks the CLI for the current windows with the smallest possible call (measured at ~$0.018 on
   * Haiku). Now only the fallback for when readUsage is unavailable.
   */
  async probeLimits(): Promise<UsageLimit[]> {
    const model = this.repo.getSettings().triageModel;
    const options: Options = {
      model, effort: "low", cwd: process.cwd(), maxTurns: 1, maxBudgetUsd: 0.05,
      permissionMode: "dontAsk", ...LEAN,
      systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true },
    };
    for await (const msg of this.queryFn({ prompt: userMessage("Reply with: ok"), options })) {
      if (msg.type === "rate_limit_event") this.recordRateLimit(msg as unknown as { rate_limit_info?: RateLimitInfo });
    }
    return this.repo.usageLimits();
  }

  // ---------------------------------------------------------------- usage limits

  /**
   * Was this failure the subscription running out, rather than the work going wrong? Either the CLI
   * said so in a rate-limit event during the run (status "rejected"), or the error says it.
   */
  private hitLimit(error: string | null): boolean {
    if (this.repo.usageLimits().some((l) => l.status === "rejected")) return true;
    return /usage limit|rate[ _-]?limit|limit (reached|exceeded)|out of (usage|credits)|quota|resets? (at|in)|429/i.test(error ?? "");
  }

  /** When the blocking window opens again: the latest reset among rejected windows, plus a margin. */
  private resumeTime(): Date {
    const MARGIN_MS = 90_000; // resets are not instant to the second; do not retry into the same wall
    const now = Date.now();
    const blocking = this.repo.usageLimits().filter((l) => l.status === "rejected" && l.resets_at);
    const known = (blocking.length ? blocking : this.repo.usageLimits().filter((l) => l.resets_at && l.resets_at * 1000 > now))
      .map((l) => l.resets_at! * 1000);
    // With no reset time at all, try again in half an hour rather than guessing wrong in either direction.
    const at = known.length ? Math.max(...known) + MARGIN_MS : now + 30 * 60_000;
    return new Date(Math.max(at, now + 60_000));
  }

  /**
   * Pause a task stopped by a usage limit instead of failing it, and arrange for it to resume by
   * itself. Returns false when this was not a limit, or auto-resume is off — the caller then fails
   * the task as it always has.
   */
  private pauseForLimit(taskId: string, error: string | null): boolean {
    if (!this.repo.getSettings().autoResume || !this.hitLimit(error)) return false;
    const at = this.resumeTime();
    this.setTask(taskId, {
      status: "paused",
      pause_reason: "limit",
      resume_at: at.toISOString(),
      error: null,
      note: `Paused by your Claude usage limit. Resumes by itself at ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, in the same session, from the stage it was on.`,
    });
    this.armResume();
    return true;
  }

  /** The per-task ceiling for this task: the global figure plus whatever Continue has granted it. */
  private taskCeiling(task: Task): number {
    return this.repo.getSettings().maxCostPerTaskUsd + (task.budget_extra_usd ?? 0);
  }

  /**
   * Money ran out: pause for a decision rather than fail (D185). Unlike a usage limit there is no
   * resume time — the person picks Continue (one more stage ceiling) or Stop. The session is kept,
   * so nothing done so far is redone.
   */
  private pauseForCost(taskId: string, spent: number, ceiling: number, detail: string): void {
    const grant = this.repo.getSettings().maxCostPerStageUsd;
    this.setTask(taskId, {
      status: "paused",
      pause_reason: "cost",
      resume_at: null,
      error: null,
      note: `Stopped at $${spent.toFixed(2)}: ${detail} (ceiling $${ceiling.toFixed(2)}). Continue lets it spend up to $${grant.toFixed(2)} more, in the same session; Stop keeps what it did so far.`,
    });
  }

  /** Continue a task paused at its cost ceiling: grant one more stage ceiling and resume where it stopped. */
  continueTask(taskId: string): Task {
    const { task } = this.load(taskId);
    if (task.status !== "paused" || task.pause_reason !== "cost") throw new ConflictError("Only a task paused at its cost ceiling can be continued.");
    const grant = this.repo.getSettings().maxCostPerStageUsd;
    this.setTask(taskId, { status: "backlog", pause_reason: null, note: null, budget_extra_usd: (task.budget_extra_usd ?? 0) + grant });
    return this.retryTask(taskId);
  }

  /**
   * Give up on a paused task (a cost ceiling, or a provider or Claude that ran out): it fails with the
   * reason, so Retry and Back to backlog work as usual, and nothing it did is lost.
   */
  stopPaused(taskId: string): Task {
    const { task } = this.load(taskId);
    if (task.status !== "paused") throw new ConflictError("Only a paused task can be stopped this way.");
    return this.setTask(taskId, { status: "failed", pause_reason: null, resume_at: null, error: task.note ?? "Stopped while paused.", note: null });
  }

  // ---------------------------------------------------------------- a provider that ran out (D194)

  private providerById(id: string | null | undefined): Provider | undefined {
    return id && id !== ANTHROPIC_PROVIDER_ID ? this.repo.getSettings().providers.find((p) => p.id === id) : undefined;
  }

  private labelOf(ref: { provider?: string | null; model: string }): string {
    const p = this.providerById(ref.provider);
    return ref.provider && ref.provider !== ANTHROPIC_PROVIDER_ID ? `${ref.model} on ${p?.label ?? ref.provider}` : `Claude ${ref.model}`;
  }

  /** The provider's out state if it still applies; one whose reset time has passed is cleared here. */
  private activeOut(providerId: string, now = Date.now()): ProviderOut | null {
    const out = this.repo.providerOuts().find((o) => o.provider_id === providerId);
    if (!out) return null;
    if (out.resets_at && Date.parse(out.resets_at) <= now) {
      this.repo.clearProviderOut(providerId);
      this.bus.publish({ type: "providers.out", out: this.repo.providerOuts() });
      return null;
    }
    return out;
  }

  /** Is Claude's own window shut right now? */
  private claudeOut(now = Date.now()): boolean {
    return this.limitedUntil(now) !== null || this.repo.usageLimits().some((l) => l.status === "rejected" && l.resets_at !== null && l.resets_at * 1000 > now);
  }

  /** Can this stage carry on at `to`: it exists, is switched on, may run this kind of stage, and is not out itself. */
  private fallbackUsable(to: TierRef, stage: Stage, mode: Task["mode"]): boolean {
    const onClaude = !to.provider || to.provider === ANTHROPIC_PROVIDER_ID;
    if (onClaude ? this.claudeOut() : this.activeOut(to.provider)) return false;
    try {
      return this.providers.allowedOn(this.providers.resolve(to.provider), stage.stage, mode) === null;
    } catch {
      return false;
    }
  }

  /** Where a stage on this provider carries on when it runs out, if Settings say so. */
  private fallbackFor(providerId: string | null | undefined): TierRef | null {
    return !providerId || providerId === ANTHROPIC_PROVIDER_ID ? this.repo.getSettings().claudeFallback : this.providerById(providerId)?.fallback ?? null;
  }

  /** What a model taking a stage over needs: where the work stands, and what the last one said. */
  private handoverText(task: Task, runId: string | undefined, from: string, why: string): string {
    const said = runId ? this.repo.lastAssistantText(runId, 1800) : "";
    const where = usesWorktree(task)
      ? "Its changes so far are in this worktree, committed as “[failed]” (see `git log -1 --stat` and `git status`)."
      : "Its changes so far are already in the folder (see `git status` and `git diff`).";
    return (
      `This stage was started on ${from}, which stopped partway: ${why}. ${where} ` +
      "Keep what is right, finish the stage rather than starting over, and check its claims against the code." +
      (said ? `\n\nWhat it said last:\n${said}` : "")
    );
  }

  /** Move stage i to another provider and model. The caller runs it again. */
  private moveStage(task: Task, i: number, to: TierRef, why: string, runId?: string): Task {
    const from = task.pipeline[i];
    const onClaude = !to.provider || to.provider === ANTHROPIC_PROVIDER_ID;
    const pipeline = task.pipeline.map((s, j) => {
      if (j !== i) return s;
      const { provider: _p, ...rest } = s;
      return onClaude ? { ...rest, model: to.model } : { ...rest, provider: to.provider, model: to.model };
    });
    const fromLabel = this.labelOf(from);
    this.handovers.set(task.id, this.handoverText(task, runId, fromLabel, why));
    const note = `[board] ${fromLabel} ran out (${why}). Stage #${i + 1} carries on as ${this.labelOf({ provider: to.provider, model: to.model })}.`;
    if (runId) {
      const event = this.repo.insertEvent(runId, "board:switch", { type: "provider_switch", text: note });
      this.bus.publish({ type: "event", runId, taskId: task.id, event });
    } else {
      this.pendingNotes.set(task.id, [...(this.pendingNotes.get(task.id) ?? []), note.replace(/^\[board\] /, "")]);
    }
    this.log(runId ?? task.id, `\n${note}\n`);
    return this.setTask(task.id, { pipeline });
  }

  /**
   * Record that a provider ran out. With no reset time to go on, it is tried again after half an
   * hour, then an hour, two, four — so a plan that is out for days is not knocked on all night.
   */
  private recordOut(providerId: string, kind: OutKind, reason: string, resetsAt: number | null): ProviderOut {
    const streak = this.outStreak.get(providerId) ?? 0;
    let at = resetsAt;
    if (!at && kind !== "credit") {
      at = Date.now() + retryDelayMs(kind, streak);
      this.outStreak.set(providerId, streak + 1);
    }
    const out = this.repo.setProviderOut({ provider_id: providerId, kind, reason, resets_at: at ? new Date(at).toISOString() : null });
    this.bus.publish({ type: "providers.out", out: this.repo.providerOuts() });
    this.armResume();
    return out;
  }

  /** A stage on this provider worked: whatever was recorded against it is over. */
  private providerBack(providerId: string): void {
    this.outStreak.delete(providerId);
    if (this.repo.clearProviderOut(providerId)) this.bus.publish({ type: "providers.out", out: this.repo.providerOuts() });
  }

  /** A provider that says a window is used up, asked directly: when it resets. */
  private async resetFromQuota(provider: Provider, secret: string | null): Promise<number | null> {
    try {
      const q = await this.quota.read(provider, secret, true);
      const full = (q?.windows ?? []).filter((w) => !w.soft && (w.used ?? 0) >= 0.999 && w.resets_at).map((w) => Date.parse(w.resets_at!));
      const later = full.filter((ms) => ms > Date.now());
      return later.length ? Math.max(...later) : null;
    } catch {
      return null;
    }
  }

  /** Pause for a provider that ran out: by itself until it is back, or until you decide. */
  private pauseForProvider(taskId: string, label: string, out: ProviderOut): void {
    const at = out.resets_at ? new Date(Date.parse(out.resets_at) + 90_000) : null;
    const what = out.kind === "credit" ? "is out of credit" : out.kind === "busy" ? "is too busy right now" : "reached its usage limit";
    const fb = "or switch this stage to another provider now (the next model picks up where it stopped)";
    const reason = out.reason.replace(/[.\s]+$/, "");
    this.setTask(taskId, {
      status: "paused",
      pause_reason: "provider",
      resume_at: at ? at.toISOString() : null,
      error: null,
      note: at
        ? `${label} ${what}: ${reason}. It carries on by itself at ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, in the same session, from the stage it was on — ${fb}.`
        : `${label} ${what}: ${reason}. Top it up and press Try again, ${fb}.`,
    });
    this.armResume();
  }

  /**
   * Before a stage starts: if its provider (or Claude) is known to be out, carry on where Settings
   * say, or pause without calling it. Credit that ran out is tried anyway: it may have been topped up.
   */
  private preflightProvider(task: Task, i: number): "go" | "switched" | "paused" {
    const stage = task.pipeline[i];
    const pid = stage.provider && stage.provider !== ANTHROPIC_PROVIDER_ID ? stage.provider : ANTHROPIC_PROVIDER_ID;
    const fb = this.fallbackFor(pid);
    if (pid === ANTHROPIC_PROVIDER_ID) {
      if (fb && this.claudeOut() && this.fallbackUsable(fb, stage, task.mode)) {
        this.moveStage(task, i, fb, "Claude's usage limit is reached");
        return "switched";
      }
      return "go";
    }
    const out = this.activeOut(pid);
    if (!out) return "go";
    if (fb && this.fallbackUsable(fb, stage, task.mode)) {
      this.moveStage(task, i, fb, out.reason);
      return "switched";
    }
    if (out.kind !== "credit" && out.resets_at && this.repo.getSettings().autoResume) {
      this.pauseForProvider(task.id, this.providerById(pid)?.label ?? pid, out);
      return "paused";
    }
    return "go";
  }

  /** A Claude stage stopped by the usage limit: carry on at the fallback if there is one, else pause as ever. */
  private afterClaudeLimit(taskId: string, i: number, error: string | null, runId: string, mayMove: boolean): "switched" | "paused" | "failed" {
    if (!this.hitLimit(error)) return "failed";
    const task = this.repo.getTask(taskId)!;
    const fb = this.repo.getSettings().claudeFallback;
    if (mayMove && fb && this.fallbackUsable(fb, task.pipeline[i], task.mode)) {
      this.moveStage(task, i, fb, "Claude's usage limit is reached", runId);
      return "switched";
    }
    return this.pauseForLimit(taskId, error) ? "paused" : "failed";
  }

  /**
   * A delegated stage failed. If the provider ran out (not the work going wrong): record it, then
   * carry on at its fallback, or wait for it to come back, or pause for you when nothing comes back
   * by itself (credit). Anything else is an ordinary failure.
   */
  private async afterProviderOut(taskId: string, i: number, providerId: string, error: string | null, runId: string, mayMove: boolean): Promise<"switched" | "paused" | "failed"> {
    const provider = this.providerById(providerId);
    const hit = classifyProviderError(error, Date.now(), naiveOffsetFor(provider?.baseUrl));
    if (!hit) return "failed";
    let resetsAt = hit.resetsAt;
    if (!resetsAt && hit.kind === "window" && provider) resetsAt = await this.resetFromQuota(provider, this.secrets.get(provider.authRef));
    const out = this.recordOut(providerId, hit.kind, hit.reason, resetsAt);
    const task = this.repo.getTask(taskId);
    if (!task) return "failed";
    const fb = provider?.fallback;
    if (mayMove && fb && this.fallbackUsable(fb, task.pipeline[i], task.mode)) {
      this.moveStage(task, i, fb, hit.reason, runId);
      return "switched";
    }
    // Auto-resume off: a window fails as it always did. Credit still pauses — failing would not help.
    if (!this.repo.getSettings().autoResume && out.kind !== "credit") return "failed";
    this.pauseForProvider(taskId, provider?.label ?? providerId, out);
    return "paused";
  }

  /**
   * You chose where a paused stage carries on (from the task's pause card). It runs again there,
   * with a note of what the previous model did; `remember` makes it the fallback from now on.
   */
  switchStage(taskId: string, to: TierRef, remember = false): Task {
    const { task } = this.load(taskId);
    if (task.status !== "paused" || task.pause_reason === "cost") {
      throw new ConflictError("Only a task paused because Claude or a provider ran out can be switched here. To change a stage otherwise, edit the pipeline.");
    }
    const i = this.defaultStart(task).fromStage;
    const stage = task.pipeline[i];
    if (!stage) throw new ConflictError("No stage left to run.");
    const res = this.providers.resolve(to.provider);
    const why = this.providers.allowedOn(res, stage.stage, task.mode);
    if (why) throw new PolicyError(why);
    const fromId = stage.provider && stage.provider !== ANTHROPIC_PROVIDER_ID ? stage.provider : ANTHROPIC_PROVIDER_ID;
    const toId = !to.provider || to.provider === ANTHROPIC_PROVIDER_ID ? ANTHROPIC_PROVIDER_ID : to.provider;
    if (fromId === toId && stage.model === to.model) throw new ConflictError("It already runs there. Press Try again to try it now.");
    if (remember && fromId !== toId) {
      const settings = fromId === ANTHROPIC_PROVIDER_ID
        ? this.repo.updateSettings({ claudeFallback: { provider: toId, model: to.model } })
        : this.repo.updateSettings({ providers: this.repo.getSettings().providers.map((p) => (p.id === fromId ? { ...p, fallback: { provider: toId, model: to.model } } : p)) });
      this.bus.publish({ type: "settings.updated", settings });
    }
    const prev = this.latestByStage(taskId).get(i);
    const moved = this.moveStage(task, i, { provider: toId, model: to.model }, task.pause_reason === "provider" ? "it ran out of usage" : "Claude's usage limit is reached", prev?.id);
    this.setTask(taskId, { status: "backlog", pause_reason: null, resume_at: null, note: null, error: null });
    return this.queueTask(moved.id, { fromStage: i });
  }

  /** Every enabled provider's usage: what it says is left, what this board sent there, and whether it is out (D195). */
  async providerUsage(force = false): Promise<ProviderUsage[]> {
    const now = Date.now();
    const h5 = this.repo.providerTotals(new Date(now - 5 * 3_600_000).toISOString());
    const d7 = this.repo.providerTotals(new Date(now - 7 * 86_400_000).toISOString());
    const zero: UsageTotals = { runs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    const shown = this.repo.getSettings().providers.filter((p) => p.enabled || d7.has(p.id));
    return Promise.all(
      shown.map(async (p): Promise<ProviderUsage> => {
        let live: LiveQuota | null = null;
        let error: string | null = null;
        try {
          live = await this.quota.read(p, this.secrets.get(p.authRef), force);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (live) this.noteQuota(p.id, live);
        return {
          provider_id: p.id,
          label: p.label,
          local: isLocal(p),
          source: live ? "live" : "board",
          windows: live?.windows ?? [],
          balance: live?.balance ?? null,
          plan: live?.plan ?? null,
          error,
          board: { h5: h5.get(p.id) ?? zero, d7: d7.get(p.id) ?? zero },
          out: this.activeOut(p.id, now),
          checked_at: new Date(now).toISOString(),
        };
      }),
    );
  }

  /** The provider's own figures settle it: a full window holds its work now; one with room again clears it. */
  private noteQuota(providerId: string, q: LiveQuota): void {
    const hard = q.windows.filter((w) => !w.soft && w.used !== null);
    const full = hard.filter((w) => (w.used ?? 0) >= 0.999 && w.resets_at && Date.parse(w.resets_at) > Date.now());
    const current = this.repo.providerOuts().find((o) => o.provider_id === providerId);
    if (full.length) {
      const until = Math.max(...full.map((w) => Date.parse(w.resets_at!)));
      // Already known (with the provider's own words): only a different reset time is news.
      const known = current && (current.kind === "credit" || (current.resets_at && Math.abs(Date.parse(current.resets_at) - until) < 5 * 60_000));
      if (!known) this.recordOut(providerId, "window", `${full.map((w) => w.label).join(" and ")} used up`, until);
    } else if (hard.length && current?.kind === "window") {
      this.providerBack(providerId);
    }
    if (q.balance && q.balance.amount <= 0 && !current) this.recordOut(providerId, "credit", `no ${q.balance.label} left`, null);
  }

  /**
   * When the Claude window that stopped work opens again, or null when nothing is waiting on it.
   * Read from the paused tasks themselves: `pauseForLimit` already worked the time out, and the
   * state clears itself when `resumeDue` un-pauses them — no extra table, nothing to keep in sync.
   * Tasks waiting on another provider are not Claude's business and do not count.
   */
  limitedUntil(now = Date.now()): number | null {
    let at: number | null = null;
    for (const t of this.repo.tasksInStatus(["paused"])) {
      if (!t.resume_at || t.pause_reason === "provider") continue;
      const ms = Date.parse(t.resume_at);
      if (ms > now && (at === null || ms > at)) at = ms;
    }
    return at;
  }

  /**
   * Would the stage this task is about to start spend Claude's subscription? Only the next stage is
   * asked: a task whose first stage is delegated should get on with it and pause later at a Claude
   * stage if it must — making real progress beats waiting for a window it may never need.
   */
  private nextStage(task: Task): Stage | undefined {
    return task.pipeline[this.startOpts.get(task.id)?.fromStage ?? this.defaultStart(task).fromStage];
  }

  private nextStageNeedsClaude(task: Task): boolean {
    const stage = this.nextStage(task);
    if (!stage) return true;
    const onClaude = (id: string | null | undefined) => !id || id === ANTHROPIC_PROVIDER_ID;
    if (onClaude(stage.provider)) return true;
    // A delegated plan stage still needs the window when its critic argues on Claude.
    const critic = this.providers.debateFor(stage, this.repo.getSettings());
    return critic ? onClaude(critic.provider) : false;
  }

  /**
   * The queue's veto. While a limit window is open, Claude work waits for it; work delegated to
   * another provider carries on, which is the whole point of having delegated it. The same goes the
   * other way: work for a provider that is out until a known time waits for it. Either way, a
   * fallback in Settings means there is somewhere to go, so it starts and moves over (D194).
   */
  private mayStartNow(taskId: string): boolean {
    const task = this.repo.getTask(taskId);
    if (!task) return true;
    if (this.limitedUntil() !== null && this.nextStageNeedsClaude(task) && !this.repo.getSettings().claudeFallback) return false;
    const stage = this.nextStage(task);
    if (stage?.provider && stage.provider !== ANTHROPIC_PROVIDER_ID) {
      const out = this.activeOut(stage.provider);
      if (out && out.kind !== "credit" && out.resets_at && !this.fallbackFor(stage.provider)) return false;
    }
    return true;
  }

  /** One timer for all paused tasks and out providers, set to the earliest time. Survives restarts via recover(). */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  armResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    const times = [
      ...this.repo.tasksInStatus(["paused"]).filter((t) => t.resume_at).map((t) => Date.parse(t.resume_at!)),
      // Queued work held for a provider is nudged when it comes back, even with no task paused on it.
      ...this.repo.providerOuts().filter((o) => o.resets_at).map((o) => Date.parse(o.resets_at!)),
    ];
    if (!times.length) return;
    const next = Math.min(...times);
    // setTimeout caps at ~24.8 days; a weekly window fits, but clamp so an odd value cannot overflow.
    const wait = Math.min(Math.max(0, next - Date.now()), 2 ** 31 - 1);
    this.resumeTimer = setTimeout(() => this.resumeDue(), wait);
    this.resumeTimer.unref?.();
  }

  /** Re-queue every paused task whose time has come, resuming its session from where it stopped. */
  resumeDue(now = Date.now()): string[] {
    // Providers whose time has come are back (activeOut clears them as it reads).
    for (const o of this.repo.providerOuts()) this.activeOut(o.provider_id, now);
    const resumed: string[] = [];
    let claudeWindow = false;
    for (const t of this.repo.tasksInStatus(["paused"])) {
      if (!t.resume_at || Date.parse(t.resume_at) > now) continue;
      if (t.pause_reason !== "provider") claudeWindow = true;
      this.setTask(t.id, { status: "backlog", resume_at: null, pause_reason: null, note: null });
      try {
        this.retryTask(t.id);
        resumed.push(t.id);
      } catch (err) {
        this.setTask(t.id, { status: "failed", error: `Could not resume automatically: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    // The window that blocked them is open again — clear the stale "rejected" so it is not re-read.
    if (claudeWindow) this.repo.clearRejectedLimits();
    this.armResume();
    // Tasks the limit gate held are still waiting and nothing else will nudge them: pump directly,
    // since every retryTask above may have thrown and enqueued nothing.
    this.queue.pump();
    return resumed;
  }

  /** Resume a paused task now, without waiting for its window. */
  resumeNow(taskId: string): void {
    const { task } = this.load(taskId);
    if (task.status !== "paused") throw new ConflictError("Only a paused task can be resumed.");
    if (task.pause_reason === "cost") throw new ConflictError("This task is waiting on Continue, not on a usage window.");
    // "Try again" after topping up: forget what was recorded against its provider, or the stage would
    // pause again before it asks.
    if (task.pause_reason === "provider") {
      const stage = task.pipeline[this.defaultStart(task).fromStage];
      if (stage?.provider) this.providerBack(stage.provider);
    }
    this.repo.updateTask(taskId, { resume_at: new Date(0).toISOString() });
    this.resumeDue();
  }

  // ---------------------------------------------------------------- approvals

  private askApproval(run: Run, taskId: string, toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const approval = this.repo.createApproval({ run_id: run.id, task_id: taskId, tool_name: toolName, input, title: o.title ?? o.displayName ?? null });
    this.setRun(run.id, { status: "approval" });
    this.setTask(taskId, { status: "approval" });
    this.bus.publish({ type: "approval.requested", approval });

    const question = toolName === QUESTION_TOOL;
    const waitMin = question ? this.repo.getSettings().questionWaitMin : 0;
    return new Promise<PermissionResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = ({ decision, note, answers }: { decision: ApprovalDecision; note: string | null; answers?: Record<string, string> }) => {
        if (!this.resolvers.has(approval.id)) return;
        this.resolvers.delete(approval.id);
        if (timer) clearTimeout(timer);
        const decided = this.repo.decideApproval(approval.id, decision, note, answers ?? null);
        this.bus.publish({ type: "approval.decided", approval: decided });
        const stillPending = this.repo.pendingApprovals(taskId).length > 0;
        const active = this.active.get(taskId);
        if (active && active.runId === run.id && !stillPending) {
          this.setRun(run.id, { status: "running" });
          this.setTask(taskId, { status: active.stageStatus });
        }
        if (question) return resolve(questionResult(input, decision, note, answers, waitMin));
        resolve(
          decision === "allow"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: note ? `The user denied this action: ${note}` : "The user denied this action." },
        );
      };
      this.resolvers.set(approval.id, done);
      if (waitMin > 0) {
        timer = setTimeout(() => done({ decision: "expired", note: `no answer in ${waitMin} min — Claude decided` }), waitMin * 60_000);
        timer.unref?.();
      }
      o.signal?.addEventListener("abort", () => done({ decision: "expired", note: "aborted" }), { once: true });
    });
  }

  /** Answer a question card: question text → the option label(s) you chose, or what you typed. */
  answerQuestion(id: string, answers: Record<string, string>): Approval {
    const approval = this.repo.getApproval(id);
    if (!approval) throw new NotFoundError(`No question ${id}`);
    if (approval.tool_name !== QUESTION_TOOL) throw new ConflictError("That card is an approval, not a question.");
    return this.decideApproval(id, "answered", null, answers);
  }

  decideApproval(id: string, decision: "allow" | "deny" | "answered", note: string | null = null, answers?: Record<string, string>): Approval {
    const approval = this.repo.getApproval(id);
    if (!approval) throw new NotFoundError(`No approval ${id}`);
    if (approval.decision) throw new ConflictError(`Approval already ${approval.decision}.`);
    if (approval.tool_name === QUESTION_TOOL && decision === "allow") throw new ConflictError("A question needs an answer, not Allow.");
    const resolve = this.resolvers.get(id);
    if (!resolve) {
      const expired = this.repo.decideApproval(id, "expired", "no live run waiting for this approval");
      this.bus.publish({ type: "approval.decided", approval: expired });
      throw new ConflictError("No live run is waiting for this approval (it expired).");
    }
    resolve({ decision, note, answers });
    return this.repo.getApproval(id)!;
  }

  // ---------------------------------------------------------------- user actions

  stopTask(taskId: string): Task {
    this.load(taskId);
    if (this.queue.cancel(taskId)) {
      this.startOpts.delete(taskId);
      return this.setTask(taskId, { status: "backlog" });
    }
    const ctl = this.pipelines.get(taskId);
    const active = this.active.get(taskId);
    if (!ctl && !active) {
      // A debated plan waiting for a decision: nothing is running, but Stop should still be an exit.
      if (this.repo.getTask(taskId)?.plan_gate) return this.setTask(taskId, { plan_gate: null, status: "failed", error: "stopped by user", note: null });
      throw new ConflictError(this.holds.has(taskId) ? "Task is mid-action (approve/discard/chat); try again in a moment." : "Task is not queued or running.");
    }
    if (ctl) ctl.stopped = true;
    active?.abort.abort();
    return this.repo.getTask(taskId)!;
  }

  /** True when every pipeline stage's latest run succeeded. */
  private pipelineComplete(task: Task): boolean {
    const latest = this.latestByStage(task.id);
    return task.pipeline.every((_, i) => latest.get(i)?.status === "success");
  }

  /** Follow-up chat: resume the latest run's session with the user's text. */
  chat(taskId: string, text: string): Run {
    const { task, project } = this.load(taskId);
    const live = this.active.get(taskId);
    if (live) {
      // The stage is running: keep the message and let the hooks hand it over at the next step (D184).
      if (!live.steerable) throw new ConflictError("This stage runs on another provider, which cannot take a message mid-run. Wait for it to finish, or Stop it.");
      this.repo.insertMessage({ task_id: taskId, from_task_id: null, from_run_id: null, body: text });
      const run = this.repo.getRun(live.runId)!;
      const event = this.repo.insertEvent(run.id, "user:chat", { type: "user_chat", text, live: true });
      this.bus.publish({ type: "event", runId: run.id, taskId, event });
      return run;
    }
    if (this.isBusy(taskId)) throw new ConflictError("Task is busy; wait for the current run to finish.");
    const last = this.repo.latestRun(taskId);
    if (!last?.session_id) throw new ConflictError("No session to continue yet — queue the task first.");
    if (!this.providers.resolve(last.provider).adapter.canResume) {
      throw new ConflictError(`This stage ran on ${this.providers.resolve(last.provider).label}, which cannot continue a session. Retry the stage or open a follow-up instead.`);
    }
    let cwd = project.path;
    if (usesWorktree(task)) {
      if (!task.worktree_path || !existsSync(task.worktree_path)) throw new ConflictError("The task worktree is gone; nothing to continue.");
      cwd = task.worktree_path;
    }
    // Keep the stage's own record intact: a failed chat must not mark a finished stage as failed.
    const before = { status: last.status, error: last.error, ended_at: last.ended_at, result_md: last.result_md };
    const run = this.setRun(last.id, { status: "running", error: null, ended_at: null });
    const event = this.repo.insertEvent(run.id, "user:chat", { type: "user_chat", text });
    this.bus.publish({ type: "event", runId: run.id, taskId, event });
    this.setTask(taskId, { status: "running", error: null });

    const ctl: PipelineCtl = { stopped: false };
    this.pipelines.set(taskId, ctl); // chat counts as a (one-step) pipeline so Stop works
    void (async () => {
      try {
        const outcome = await this.runQuery({ task, project, run, cwd, ctl, prompt: text, resume: last.session_id!, stageStatus: "running", accumulate: true, verifyCommand: null });
        if (usesWorktree(task)) await this.commitWorktree(task, `kanban(chat): ${task.title}`);
        if (!outcome.ok) {
          this.setRun(run.id, before); // the chat turn failed; the stage result it belonged to stands
          if (outcome.providerId === ANTHROPIC_PROVIDER_ID && this.pauseForLimit(taskId, outcome.error)) return;
          if (outcome.providerId !== ANTHROPIC_PROVIDER_ID && !ctl.stopped && (await this.afterProviderOut(taskId, run.stage_index, outcome.providerId, outcome.error, run.id, false)) === "paused") return;
          this.setTask(taskId, { status: "failed", error: outcome.error });
          return;
        }
        if (outcome.providerId !== ANTHROPIC_PROVIDER_ID) this.providerBack(outcome.providerId);
        const fresh = this.repo.getTask(taskId)!;
        if (this.pipelineComplete(fresh)) this.setTask(taskId, { status: "review" });
        else {
          const next = this.defaultStart(fresh).fromStage + 1;
          this.setTask(taskId, { status: "failed", error: `Chat done, but the pipeline is incomplete — Retry continues from stage #${next}.` });
        }
      } finally {
        this.pipelines.delete(taskId);
      }
    })();
    return run;
  }

  async approveTask(taskId: string): Promise<Task> {
    return this.hold(taskId, async () => {
      const { task, project } = this.load(taskId);
      if (task.status !== "review") throw new ConflictError(`Only tasks in review can be approved (status is "${task.status}").`);
      // Approved work is worth remembering: one line, so later tasks in this project inherit it.
      const summary = task.summary?.trim() || this.repo.latestRun(task.id)?.result_md?.split(/\r?\n/).find((l) => l.trim())?.trim();
      if (summary) this.repo.addNote({ project_id: project.id, task_id: task.id, text: `${task.title}: ${summary}`, source: "board" });

      // Merge whenever a branch exists — even if the mode was switched after the worktree was made.
      let done: Task;
      if (task.branch) {
        if (task.worktree_path && existsSync(task.worktree_path)) await this.git.commitAll(task.worktree_path, `kanban: ${task.title}`);
        await this.landBranch(project, task);
        await this.git.removeWorktree(project.path, task.id, { deleteBranch: "safe" });
        this.ports.delete(taskId);
        done = this.setTask(taskId, { status: "done", branch: null, worktree_path: null, note: null });
      } else {
        done = this.setTask(taskId, { status: "done", note: null });
      }
      setImmediate(() => this.promoteReady(project.id)); // anything waiting on this task can start now
      // An approved /init or bootstrap can give the project its verify command. Off the approval
      // path on purpose: it may call a model, and approval must never fail or wait because of it.
      if (task.onboarding) {
        setImmediate(() => {
          applyOnboardingResult({ repo: this.repo, bus: this.bus, queryFn: this.queryFn }, taskId).catch((e) => {
            console.warn(`[onboarding] ${taskId}: ${e instanceof Error ? e.message : String(e)}`);
          });
        });
      }
      return done;
    });
  }

  /**
   * Pull the base branch into a task's worktree on demand, so a long-running task can catch up with
   * what has landed since it started instead of discovering it at approval time.
   */
  async updateTaskFromBase(taskId: string): Promise<{ pulled: number; conflicts: string[]; base: string }> {
    return this.hold(taskId, async () => {
      const { task, project } = this.load(taskId);
      if (!task.worktree_path || !existsSync(task.worktree_path)) throw new ConflictError("This task has no worktree to update.");
      if (this.isBusy(taskId)) throw new ConflictError("Wait for the task to finish before updating its workspace.");
      const base = project.merge.baseBranch?.trim() || (await this.git.currentBranch(project.path));
      await this.git.commitAll(task.worktree_path, `kanban: work in progress on ${task.title}`);
      const res = await this.git.updateFromBase(task.worktree_path, base, project.merge.strategy === "rebase" ? "rebase" : "merge");
      if (!res.ok) throw new ConflictError(`"${base}" conflicts with this task in: ${res.conflicts.join(", ")}. The worktree is unchanged.`);
      if (res.pulled) this.setTask(taskId, { note: `Updated from "${base}" (${res.pulled} commit${res.pulled === 1 ? "" : "s"}).` });
      return { pulled: res.pulled, conflicts: [], base };
    });
  }

  rejectTask(taskId: string, note: string | null): Task {
    const { task } = this.load(taskId);
    if (this.isBusy(taskId)) throw new ConflictError("Task is still running.");
    if (!["review", "failed"].includes(task.status) && !task.plan_gate) throw new ConflictError(`Cannot reject a task in status "${task.status}".`);
    return this.setTask(taskId, { status: "backlog", note, plan_gate: null });
  }

  async discardTask(taskId: string): Promise<Task> {
    return this.hold(taskId, async () => {
      const { task, project } = this.load(taskId);
      if (task.branch || task.worktree_path) {
        await this.git.removeWorktree(project.path, task.id, { deleteBranch: "force" });
      }
      this.ports.delete(taskId);
      return this.setTask(taskId, { status: "backlog", branch: null, worktree_path: null, base_sha: null, note: DISCARDED_NOTE, plan_gate: null });
    });
  }

  async diff(taskId: string) {
    const { task, project } = this.load(taskId);
    if (!task.branch || !task.base_sha) return [];
    return this.git.diffTask(project.path, task.base_sha, task.branch);
  }

  /**
   * Intake. `classify` fills in type/priority/labels only; `refine` also rewrites the spec and
   * proposes subtasks. Read-only by construction (no tools, no repo access) — see triage.ts.
   */
  async triage(taskId: string, mode: "classify" | "refine", opts: { apply?: boolean } = {}): Promise<TriageResult | null> {
    const { task, project } = this.load(taskId);
    const settings = this.repo.getSettings();
    // Closed vocabulary: the project's configured labels plus whatever is already in use.
    const knownLabels = [...new Set([...project.env.labels, ...this.repo.listTasks({ project_id: project.id }).flatMap((t) => t.labels)])].slice(0, 30);
    const result = await triageTask(
      {
        title: task.title,
        spec_md: task.spec_md,
        projectName: project.name,
        memory: this.repo.notes(project.id, NOTES_IN_PROMPT).map((n) => n.text),
        knownLabels,
        mode,
        cwd: project.path,
        model: settings.triageModel,
      },
      this.queryFn as never,
    );
    if (!result) return null;
    if (mode === "classify" && (opts.apply ?? true)) {
      const fresh = this.repo.getTask(taskId);
      if (fresh && !fresh.triaged_at) {
        // Confident classification is applied; priority is always only a suggestion, and a shaky
        // guess is recorded rather than acted on — a wrong label is worse than no label.
        const confident = result.confidence >= CONFIDENCE_TO_APPLY;
        const labels = result.labels.filter((l) => knownLabels.includes(l));
        // The sized pipeline is only ever a suggestion: a wrong guess here spends real money, so
        // accepting it is a decision the human makes. Rejecting keeps the project default.
        const sized = settings.autoSizing ? sizedPipeline(result.sizing, settings.tiers) : null;
        this.setTask(taskId, {
          ...(confident ? { type: result.type, labels } : {}),
          triaged_at: nowIso(),
          suggestion: {
            priority: result.priority,
            type: result.type,
            labels,
            confidence: result.confidence,
            ...(sized ? { pipeline: sized, sizing_reason: result.sizing?.reason || "" } : {}),
          },
        });
      }
    }
    return result;
  }

  /**
   * Applies a suggestion the human accepted. Split out from triage on purpose: nothing the model
   * proposed about how a task runs takes effect until someone presses Accept.
   */
  acceptSuggestion(taskId: string, what: { fields?: boolean; pipeline?: boolean }): Task {
    const { task } = this.load(taskId);
    const s = task.suggestion;
    if (!s) throw new ConflictError("There is nothing suggested for this task.");
    if (what.pipeline && this.isBusy(taskId)) throw new ConflictError("Cannot change the pipeline while the task is queued or running.");
    return this.setTask(taskId, {
      ...(what.fields ? { type: s.type ?? task.type, priority: s.priority ?? task.priority, labels: [...new Set([...task.labels, ...(s.labels ?? [])])] } : {}),
      ...(what.pipeline && s.pipeline?.length ? { pipeline: s.pipeline } : {}),
      suggestion: null,
    });
  }

  /** Look at an attached image once with the cheap vision model, so the stages never have to. */
  async describeAttachment(attachmentId: string): Promise<string | null> {
    const at = this.repo.getAttachment(attachmentId);
    if (!at || at.description) return at?.description ?? null;
    const settings = this.repo.getSettings();
    const r = await this.describeWithFallback(at.path, settings.visionProvider, settings.visionModel);
    const updated = this.repo.describeAttachment(at.id, r.described?.text ?? null, r.described ? r.by : null);
    if (updated && r.described) this.bus.publish({ type: "attachment.added", attachment: updated });
    return r.described?.text ?? null;
  }

  /**
   * The chosen vision provider first; if it is missing, switched off, or cannot see (not every model
   * can), Claude's default vision model does it instead, and the attachment says so.
   */
  private async describeWithFallback(path: string, providerId: string, model: string): Promise<{ described: { text: string } | null; by: string }> {
    const label = (id: string, m: string) => `${id === ANTHROPIC_PROVIDER_ID ? "claude" : id} · ${m}`;
    const onClaudeDefault = (providerId || ANTHROPIC_PROVIDER_ID) === ANTHROPIC_PROVIDER_ID;
    let described: { text: string } | null = null;
    try {
      const res = this.providers.resolve(providerId);
      described = await describeImageVia(res, model, path, { queryFn: this.queryFn as never, timeoutMs: VISION_TIMEOUT_MS });
    } catch {
      described = null;
    }
    if (described || onClaudeDefault) return { described, by: label(providerId || ANTHROPIC_PROVIDER_ID, model) };
    const fallback = await describeImage({ path, model: DEFAULT_VISION_MODEL }, this.queryFn as never);
    return { described: fallback, by: `${label(ANTHROPIC_PROVIDER_ID, DEFAULT_VISION_MODEL)} (fallback: ${label(providerId, model)} could not describe it)` };
  }

  /** Settings → Intake models → Try it: one sample image through exactly this provider and model, no fallback. */
  async testVision(providerId: string, model: string, samplePath: string): Promise<{ ok: boolean; text: string | null; latencyMs: number; error: string | null }> {
    const t0 = Date.now();
    try {
      const res = this.providers.resolve(providerId);
      const d = await describeImageVia(res, model, samplePath, { queryFn: this.queryFn as never, timeoutMs: VISION_TIMEOUT_MS });
      return d
        ? { ok: true, text: d.text, latencyMs: Date.now() - t0, error: null }
        : { ok: false, text: null, latencyMs: Date.now() - t0, error: "It answered, but not with a description — this model may not be able to see images. Images would go to Claude's default instead." };
    } catch (err) {
      return { ok: false, text: null, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Saves an (optionally edited) refine proposal: the task itself, then its subtasks and their dependencies. */
  applyTriage(
    taskId: string,
    proposal: { title: string; spec_md: string; type: Task["type"]; priority: Task["priority"]; labels: string[]; auto_queue_children?: boolean; subtasks: TriageSubtask[] },
  ): { task: Task; subtasks: Task[] } {
    const { task, project } = this.load(taskId);
    if (this.isBusy(taskId)) throw new ConflictError("Task is running; stop it before rewriting it.");
    const updated = this.setTask(taskId, {
      title: proposal.title,
      spec_md: proposal.spec_md,
      type: proposal.type,
      priority: proposal.priority,
      labels: proposal.labels.map((l) => l.toLowerCase().trim()).filter(Boolean).slice(0, 8),
      triaged_at: nowIso(),
      suggestion: null,
      auto_queue_children: proposal.auto_queue_children ?? task.auto_queue_children,
    });

    const ids: string[] = [];
    // Re-apply the file-overlap rule: the user may have edited the list before accepting it.
    const planned = serialiseFileConflicts(proposal.subtasks.map((s) => ({ ...s, files: s.files ?? [] })));
    const subtasks = planned.map((s, index) => {
      const deps = s.depends_on.filter((n) => n >= 1 && n <= index).map((n) => ids[n - 1]).filter(Boolean);
      const child = this.repo.createTask({
        project_id: task.project_id,
        parent_id: task.id,
        milestone_id: task.milestone_id,
        title: s.title,
        spec_md: s.files?.length ? `${s.spec_md}\n\n_Files this subtask owns: ${s.files.join(", ")}_` : s.spec_md,
        type: s.type,
        priority: proposal.priority,
        labels: proposal.labels,
        depends_on: deps,
        mode: allowedMode(project, task.mode),
        pipeline: task.pipeline,
        skills: task.skills,
        live: task.live,
        plan_approval: task.plan_approval,
        own_branch: task.own_branch,
        status: "backlog",
      });
      ids.push(child.id);
      this.bus.publish({ type: "task.updated", task: child });
      return child;
    });
    if (subtasks.length) setImmediate(() => this.promoteReady(project.id));
    return { task: updated, subtasks };
  }

  /**
   * A new task that continues an old one. Sessions are not reopened days later — the worktree is
   * gone, the repo has moved on, and the SDK docs advise passing results into a fresh session
   * instead. So the outcome of the old task is written into the new task's spec as context.
   */
  async followUp(taskId: string, opts: { title?: string; note?: string; type?: Task["type"] } = {}): Promise<Task> {
    const { task, project } = this.load(taskId);
    const runs = this.repo.stageRuns(taskId);
    const last = [...runs].reverse().find((r) => r.result_md?.trim());
    let changed: string[] = [];
    try {
      if (task.base_sha && task.branch) changed = (await this.git.diffTask(project.path, task.base_sha, task.branch)).map((f) => `${f.status} ${f.file}`);
    } catch {
      // the branch is usually merged and gone by now — the summary below is enough
    }

    const context = [
      `## Context: follows up on "${task.title}" (\`${task.id}\`)`,
      `That task finished as **${task.status}**${task.updated_at ? ` on ${task.updated_at.slice(0, 10)}` : ""}.`,
      task.summary ? `\nIts last summary: ${task.summary}` : "",
      last?.result_md ? `\n<details><summary>What that task reported</summary>\n\n${last.result_md.slice(0, 2000)}\n\n</details>` : "",
      changed.length ? `\nFiles it changed:\n${changed.slice(0, 25).map((c) => `- ${c}`).join("\n")}` : "",
      "\nStart from the current state of the repository, not from that task's session: the code may have moved on since.",
      opts.note ? `\n## What is wrong now\n${opts.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const created = this.repo.createTask({
      project_id: task.project_id,
      milestone_id: task.milestone_id,
      title: opts.title?.trim() || `Follow-up: ${task.title}`,
      spec_md: context,
      type: opts.type ?? "bug",
      priority: task.priority,
      labels: task.labels,
      related_to: [task.id, ...task.related_to].slice(0, 10),
      mode: task.mode,
      pipeline: task.pipeline,
      skills: task.skills,
      live: task.live,
      plan_approval: task.plan_approval,
      own_branch: task.own_branch,
      status: "backlog",
    });
    this.setTask(task.id, { related_to: [...new Set([...task.related_to, created.id])].slice(0, 10) });
    this.bus.publish({ type: "task.updated", task: created });
    return created;
  }

  /**
   * Queues every backlog subtask whose dependencies are met, for parents set to auto-run.
   * Called after subtasks appear and after any task finishes, so a dependency graph drains itself:
   * independent subtasks run in parallel (bounded by the project's concurrency), dependent ones wait.
   */
  promoteReady(projectId: string): Task[] {
    const started: Task[] = [];
    for (const task of this.repo.listTasks({ project_id: projectId })) {
      if (task.status !== "backlog" || !task.parent_id || this.isBusy(task.id)) continue;
      const parent = this.repo.getTask(task.parent_id);
      if (!parent?.auto_queue_children) continue;
      if (this.blockers(task).length) continue;
      try {
        started.push(this.queueTask(task.id));
      } catch {
        // policy or state said no — leave it in backlog for the user
      }
    }
    return started;
  }

  /** Boot recovery (DECISIONS D11). */
  recover(): void {
    // Paused tasks keep their resume time across a restart; anything already due resumes now.
    setImmediate(() => this.resumeDue());
    for (const run of this.repo.runsInStatus(["running", "approval"])) {
      this.repo.updateRun(run.id, { status: "failed", error: "interrupted", ended_at: nowIso() });
      const t = this.repo.getTask(run.task_id);
      if (t && !["done", "backlog"].includes(t.status)) {
        this.repo.updateTask(t.id, { status: "failed", error: "interrupted (server restarted) — Retry resumes the session" });
      }
    }
    this.repo.expirePendingApprovals();
    for (const t of this.repo.tasksInStatus(["planning", "running", "approval"])) {
      if (t.plan_gate) continue; // nothing was running: the gate is durable and waits for the human
      this.repo.updateTask(t.id, { status: "failed", error: "interrupted (server restarted)" });
    }
    for (const t of this.repo.tasksInStatus(["queued"])) {
      this.startOpts.set(t.id, this.defaultStart(t));
      this.queue.enqueue({ taskId: t.id, projectId: t.project_id });
    }
  }
}
