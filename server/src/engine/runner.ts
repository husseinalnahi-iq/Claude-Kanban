import {
  query, type CanUseTool, type HookCallbackMatcher, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import * as gitOps from "../git/worktree.ts";
import { FolderLeftError, isGitFolder } from "../git/worktree.ts";
import { DEFAULT_VISION_MODEL, nowIso } from "../db.ts";
import type { NewTask, Repo } from "../repo.ts";
import type { Bus } from "../bus.ts";
import type {
  Approval, ApprovalDecision, Blocked, ConflictRisk, DiffFile, Mode, TaskHold, Project, Resolution, ResolutionCheck, Provider, ProviderOut, ProviderUsage, Run, SessionTools, Settings, Stage, StageName, Task, TaskStatus, TierRef, UsageLimit, UsageTotals,
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
import { buildRoundFallbackPrompt, buildRoundPrompt, buildStagePrompt, type PromptCtx } from "./prompts.ts";
import { PATH_KEYS, autonomousGate, blockedCommand, escalationHint, handsOffGate, isReadOnlyMcp, isReadOnlyShell, isSafeMcp, isTrusted, killsByName, markitdownRead, READ_ONLY_TOOLS, readViolation, serverRule, trustRules } from "./gate.ts";
import { credentialRisk } from "./credentials.ts";
import { clash, mayConflict, planFootprint, type FootprintOf } from "./footprint.ts";
import { dropKept, keepOriginal, keptCopy, keptFiles, relInside, restoreKept } from "./folderCopies.ts";
import { allowedMode, createBoardServer } from "./boardMcp.ts";
import { RESOLVE_ATTEMPTS, buildResolvePrompt, buildReviewPrompt, parseReviewVerdict, problemsFrom, type OtherSide } from "./conflictResolve.ts";
import { CONFIDENCE_TO_APPLY, serialiseFileConflicts, triageTask, type Sizing, type TriageResult, type TriageSubtask } from "./triage.ts";
import { describeImage, describeImageVia } from "./vision.ts";
import { LEAN } from "./lean.ts";
import { applyOnboardingResult } from "./onboarding.ts";
import { buildCriticPrompt, buildRevisionPrompt, debateRoundLimit, extractRevisedPlan, extractRevisionAnswers, parseCritique } from "./debate.ts";
import { BOARD_PROFILE, BROWSER_SERVER, PLAYWRIGHT_PLUGIN_TOOLS, browserCaption, browserDecision, browserServer, copyProfile } from "./browser.ts";
import { BrowserWatch } from "./browserWatch.ts";
import { CLOUDFLARE_TOKEN_REF, IMAGE_PREFIX, IMAGE_SERVER, POLLINATIONS_KEY_REF, claudeCodeCommand, createImageServer, generateImage, imageMakerLine, imageReadiness, type FetchFn, type ImageConfig, type ImageStatus } from "./images.ts";
import { scanSkills } from "../skills.ts";
import { LIVE_KEY_PATTERNS, freePort, readWorktreeInclude, runProjectCommand, seedWorktree, stopListeners } from "../git/bootstrap.ts";
import { NOTES_IN_PROMPT } from "../repo.ts";
import { SecretStore } from "../secrets.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { estimateCost, sumUsage } from "./providers/cost.ts";
import { ModelCatalog, isLocal } from "./providers/catalog.ts";
import { codexAuth, codexModels, codexStatus, codexUpgrades } from "./providers/codexLocal.ts";
import { codexImagePart } from "./codexImages.ts";
import { setCliSecrets } from "./providers/cli/index.ts";
import { classifyProviderError, naiveOffsetFor, retryDelayMs, type OutKind } from "./providers/limits.ts";
import { QuotaReader, type LiveQuota } from "./providers/usage.ts";
import type { Resolved, StageInvocation } from "./providers/types.ts";
import { saveAttachment } from "../routes/attachments.ts";
import { pickBrowser, realProbe } from "../setup/probe.ts";
import { ANTHROPIC_PROVIDER_ID, ARTIFACT_EXTS, DEBATE_ROUND_CEILING, EFFORTS, MARKITDOWN_TOOL, accessOf, isHandsOff, recommendedOption, sharesProjectFolder, supervisedFrom, usesWorktree, worksInFolder, MAX_ATTACHMENT_BYTES, attachmentKind, supportsFastMode, type ClaudeModelsResult, type FastModeStatus } from "../types.ts";
import { claudeUpgrades, fromSdk, type SdkModelInfo } from "./claudeModels.ts";
import { BROWSER_AGENT, helperAgents, usesHelper } from "./helpers.ts";
import { applyChecklistTool } from "./checklist.ts";
import { outcomeLine, resultText } from "./record.ts";
import { isAnswerPipeline } from "./answer.ts";
import { splitAtFirstEdit } from "./explore.ts";
import { memoryFacts, type MemoryInput } from "./memory.ts";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

/** The request violates a project policy (HTTP 409). */
export class PolicyError extends Error {}
/** The request conflicts with the task's current state (HTTP 409). */
export class ConflictError extends Error {}
/** The card waits on its setup card: mode and models are confirmed by a person before it runs (D365). */
export class SetupNeededError extends ConflictError {}
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
  /** How the image tool reaches its provider. Defaults to the real network (tests inject one). */
  imageFetch?: FetchFn;
}

interface StartOpts {
  fromStage: number;
  resume?: string;
  /**
   * A follow-up round (D375): the first stage continues the card's work session with `prompt`, or starts
   * fresh with `fallback` when that session cannot be reopened; after it only a review runs, if asked.
   */
  round?: { n: number; prompt: string; fallback: string; review: boolean; fork?: boolean };
}

/** Claude Code's answer when a session it was asked to continue is gone (deleted, or never on this machine). */
const LOST_SESSION = /no conversation found|session.*not found/i;

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

/** What one session is started with: a pipeline stage, a debate turn, or a chat turn. */
interface StageArgs {
  task: Task;
  project: Project;
  run: Run;
  cwd: string;
  prompt: string;
  ctl: PipelineCtl;
  resume?: string;
  /** Continue a copy of `resume` as a new session, leaving the original as it was (a fork, D376). */
  forkSession?: boolean;
  stageStatus: TaskStatus;
  disallowedTools?: string[];
  accumulate?: boolean;
  /** Record the prompt as a `user:prompt` event. Defaults to "unless accumulating" (chat writes its own). */
  promptEvent?: boolean;
  /** When set, the model can't end its turn while this command fails. */
  verifyCommand?: string | null;
}

interface StageOutcome {
  ok: boolean;
  error: string | null;
  providerId: string;
  budgetStop: boolean;
  turnLimit: boolean;
  /** The verify command passed when the session last tried to end, and nothing ran after it. */
  verifiedAtStop: boolean;
}

/** The session a failure came from — when it started, and on which model — to tell whether a usage window stopped it. */
interface LimitContext {
  since: number;
  model: string;
}

/** What artifact capture remembers across one run's messages. */
interface CaptureState {
  /** Room left under MAX_ARTIFACTS_PER_RUN. */
  left: number;
  /** tool_use id → the tool, and for a write of an output file, where it goes. */
  tools: Map<string, { name: string; file?: string }>;
}

const STAGE_STATUS: Record<StageName, TaskStatus> = { plan: "planning", code: "running", review: "review", custom: "running" };
const PLAN_DISALLOWED = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

/** Resolutions one approval may start before the conflict comes back to you (D356). */
const MAX_RESOLVE_ROUNDS = 3;

/** Where a task's branch stood before Claude touched a conflict: the way back if it does not pass. */
const preResolveRef = (taskId: string) => `refs/kanban/pre-resolve/${taskId}`;

/** What a stage that ran out of turns is told when it carries on in the same session (D232). */
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
/**
 * Sandbox refusals one autonomous stage may collect before the board stops it as blocked. The run
 * that prompted this made four attempts round the sandbox; a stage that meets the wall once or twice
 * and adapts is normal, five is hunting for a way out (D186).
 */
export const AUTO_BLOCK_AFTER = 5;
/** One image, one description: a CLI that has not answered in three minutes is not going to. */
const VISION_TIMEOUT_MS = 3 * 60_000;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Never keep a copy of something that is not the run's own output. */
const IGNORED_DIRS = /(^|[\\/])(node_modules|\.git|\.kanban|dist|build|\.next|coverage|vendor)([\\/]|$)/i;

/** Where a write tool is about to put an output file — a report, a chart — or undefined for source, vendored files and other tools. */
function artifactPath(block: Record<string, unknown>, cwd: string): string | undefined {
  if (typeof block.name !== "string" || !WRITE_TOOLS.has(block.name)) return undefined;
  const file = (block.input as { file_path?: unknown } | undefined)?.file_path;
  if (typeof file !== "string" || !ARTIFACT_EXTS.includes(extname(file).toLowerCase())) return undefined;
  const abs = isAbsolute(file) ? file : join(cwd, file);
  return IGNORED_DIRS.test(abs) ? undefined : abs;
}

/**
 * A state folder of the task's own, handed to its sessions and to the setup and verify commands as
 * KANBAN_STATE_DIR. A task that works on this very board and starts it inside its worktree would
 * otherwise open the live board's database — the default folder, or the one this process inherited.
 */
export function taskStateDir(taskId: string): string {
  return join(tmpdir(), "claude-kanban-task-state", taskId);
}

/**
 * Says a worktree's setup has not finished. Beside the worktree rather than in it: inside, the
 * board's own commit after a stage would pick it up.
 */
function setupMarker(worktreePath: string): string {
  return `${worktreePath}.setup-pending`;
}

/** How often a run's growing context is written and broadcast while it streams. */
const CONTEXT_UPDATE_MS = 1000;

/**
 * What Claude Code saves for one working folder's sessions: a long tool result it spills to a file and a
 * background command's output, both of which it tells the run to read. The folder name is the working
 * folder with every other character a dash, so the folders are this task's alone (D392).
 */
export function claudeSessionRoots(cwd: string, home = homedir(), temp = tmpdir()): string[] {
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return [join(home, ".claude", "projects", folder), join(temp, "claude", folder)];
}

/**
 * Work a runner starts and nobody waits for: a pipeline's tidy-up after its card reaches Review, a
 * conflict resolution, the conflict check after Review, and the tidy-up after a restart. Kept here, for every runner, so a caller can wait for it to finish. Tests that
 * deleted a repo the moment a task reached Review were refused by Windows while that git work still ran
 * in it, and under a full test run it ran for seconds.
 */
/** Each piece of work, with the project folder it works in. */
const background = new Map<Promise<unknown>, string | null>();
function inBackground(where: string | null | undefined, work: () => Promise<unknown>): void {
  setImmediate(() => void tracked(where, work().catch(() => undefined)));
}

/** Work already running that a caller may want to wait for, returned as it is. */
function tracked<T>(where: string | null | undefined, p: Promise<T>): Promise<T> {
  const held: Promise<unknown> = p.then(() => undefined, () => undefined).finally(() => background.delete(held));
  background.set(held, where ?? null);
  return p;
}

const under = (where: string | null, folder: string) => {
  const norm = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, "");
  return where !== null && (norm(where) === norm(folder) || norm(where).startsWith(norm(folder) + sep));
};

/**
 * Resolves once the background work started so far, and any it started in turn, has finished — or after
 * `timeoutMs`, since a pipeline waiting on an approval nobody gives never finishes. True when all done.
 */
export async function settled(folder?: string, timeoutMs = 5000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const mine = () => [...background].filter(([, where]) => folder === undefined || under(where, folder)).map(([p]) => p);
  // Work is registered on the next turn of the event loop; let it register before looking.
  await new Promise((r) => setImmediate(r));
  while (mine().length) {
    const left = until - Date.now();
    if (left <= 0) return false;
    await Promise.race([Promise.allSettled(mine()), new Promise((r) => setTimeout(r, left).unref())]);
    await new Promise((r) => setImmediate(r));
  }
  return true;
}

/** On the card while a worktree is made; cleared once it is ready (D395). */
const PREPARING_SUMMARY = "Preparing its worktree — a fresh checkout of the repository, up to a minute on a big one";

/** A stage cut off by this many board crashes within the window is left for you, not started again (D384). */
const CRASH_RESUME_LIMIT = 3;
const CRASH_WINDOW_MS = 30 * 60_000;

/**
 * Does this usage window hold back a stage on `model`? The five-hour and weekly windows cover the
 * whole account; `seven_day_opus` or `seven_day_model:Opus 5` only that family. A window the board
 * cannot place is treated as account-wide, which is what it was before windows were told apart.
 */
export function limitCovers(type: string, model: string): boolean {
  const scope = /^seven_day_(?:model:)?(.+)$/i.exec(type)?.[1].toLowerCase();
  const family = scope && ["opus", "sonnet", "haiku", "fable"].find((f) => scope.includes(f));
  return !family || model.toLowerCase().includes(family);
}

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

export type Verdict = "APPROVE" | "CHANGES_NEEDED" | "BLOCKED";

/** Files a person sees when they change: pages, styles, components. */
const VISIBLE_FILE = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$/i;

/**
 * A review that passed a visible change without saying whether it looked at it. The review prompt
 * asks for a `Browser: checked …` / `Browser: not needed …` line; a Sonnet review once approved a
 * game it never opened, on the coding stage's word alone (D275).
 */
export function reviewSkippedBrowser(result: string | null | undefined, changed: string[]): boolean {
  if (!changed.some((f) => VISIBLE_FILE.test(f))) return false;
  return !/^\s*\**browser\**\s*:\s*\**\s*(checked|not needed)/im.test(result ?? "");
}

/**
 * Reads the `VERDICT: …` line a review stage is asked to end with. When a report carries more than
 * one (a quoted example, then the real one), the last one is the verdict.
 */
export function verdictOf(result: string | null | undefined): Verdict | null {
  const all = [...(result ?? "").matchAll(/^\s*\**VERDICT\**\s*:\s*\**\s*(APPROVE|CHANGES_NEEDED|BLOCKED)/gim)];
  return (all.at(-1)?.[1]?.toUpperCase() as Verdict | undefined) ?? null;
}

/** The text after a verdict line, or the report's first lines: what the card says about a verdict. */
function verdictReason(result: string | null | undefined): string {
  const m = /^\s*\**VERDICT\**\s*:\s*\**\s*(?:APPROVE|CHANGES_NEEDED|BLOCKED)\**\s*[—:-]?\s*(.*)$/im.exec(result ?? "");
  return (m?.[1]?.trim() || firstLines(result, 3)).slice(0, 600);
}

/** Size and modification time: enough to tell whether a file changed during a run, without reading it. */
function fileStamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "gone";
  }
}

/**
 * A suggestion minus the parts just decided, or null when nothing is left. Accepting or dismissing
 * one part must not silently throw the others away (D191).
 */
function withoutParts(s: NonNullable<Task["suggestion"]>, what: SuggestionParts): Task["suggestion"] {
  const { type, priority, labels, confidence, pipeline, sizing_reason, mode, mode_reason, live, live_reason } = s;
  const rest: NonNullable<Task["suggestion"]> = {
    ...(what.fields ? {} : { type, priority, labels, confidence }),
    ...(what.pipeline ? {} : { pipeline, sizing_reason }),
    ...(what.mode ? {} : { mode, mode_reason }),
    ...(what.live ? {} : { live, live_reason }),
  };
  for (const k of Object.keys(rest) as (keyof typeof rest)[]) if (rest[k] === undefined) delete rest[k];
  return Object.keys(rest).length ? rest : null;
}

/** The parts of a triage suggestion that are accepted or dismissed separately. */
type SuggestionParts = { fields?: boolean; pipeline?: boolean; mode?: boolean; live?: boolean };

function firstLines(text: string | null | undefined, n: number): string {
  return (text ?? "").split(/\r?\n/).filter(Boolean).slice(0, n).join(" ").slice(0, 400);
}

function eventType(msg: SDKMessage): string {
  const m = msg as { type: string; subtype?: string };
  return m.subtype ? `${m.type}:${m.subtype}` : m.type;
}

/** Two stages are the same step when every setting on them matches, whatever order the keys came in. */
export function sameStage(a: Stage | undefined, b: Stage | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: Stage) => JSON.stringify(Object.keys(s).sort().reduce<Record<string, unknown>>((o, k) => ((o[k] = (s as never)[k]), o), {}));
  return norm(a) === norm(b);
}

/**
 * Supervised runs: force every non-read-only tool through the approval card, even when a settings
 * file pre-allows it (a PreToolUse "ask" overrides allow rules). See docs/DECISIONS.md D20.
 */
export function forceAsk(readsFree: boolean, cwd: string): HookCallbackMatcher[] {
  // A read-only command skips the forced "ask" too, or a settings file's own "ask" would still put it
  // on a card; canUseTool then applies the same rule and records it (D202, D240).
  const freeShellRead = (name: string, input: unknown) =>
    readsFree && (name === "Bash" || name === "PowerShell") && isReadOnlyShell(String((input as { command?: unknown })?.command ?? ""), cwd);
  return [
    {
      hooks: [
        async (input) => {
          const { tool_name: name = "", tool_input: toolInput } = input as { tool_name?: string; tool_input?: unknown };
          if (READ_ONLY_TOOLS.has(name) || isSafeMcp(name) || freeShellRead(name, toolInput) || (readsFree && isReadOnlyMcp(name))) return {};
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
  private imageFetch?: FetchFn;
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
  /** Conflict resolutions started by one approval, so a base that keeps moving cannot loop it (D356). */
  private resolveRounds = new Map<string, number>();
  private startOpts = new Map<string, StartOpts>();
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
  /** taskId → what blocked the last attempt, handed to the next run's prompt (D185). */
  private priorBlocks = new Map<string, Blocked>();
  /** taskId → why a human sent it back, carried past the queue (which clears the card's note). */
  private sentBack = new Map<string, string>();
  /** taskId → the checkout's uncommitted files when a supervised run started, with size+mtime (D204). */
  private checkoutStamps = new Map<string, { cwd: string; own: Set<string>; stamps: Map<string, string> }>();

  constructor(deps: RunnerDeps) {
    this.repo = deps.repo;
    this.bus = deps.bus;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    this.browserWatch = new BrowserWatch(deps.bus);
    this.git = deps.git ?? gitOps;
    this.logDir = deps.logDir;
    this.secrets = deps.secrets ?? new SecretStore(":memory:");
    this.imageFetch = deps.imageFetch;
    this.providers = new ProviderRegistry(deps.repo, this.secrets);
    // Codex's models are read from its own folder: what the signed-in plan (or the API) offers (D294).
    this.catalog = deps.catalog ?? new ModelCatalog(undefined, undefined, (p) =>
      p.kind === "cli" && p.cli?.preset === "codex" ? codexModels(codexAuth(p, (n) => Boolean(this.secrets.get(n)))) : null);
    this.quota = deps.quota ?? new QuotaReader();
    setCliSecrets(this.secrets);
    this.queue = new RunQueue({
      // Serial mode overrides the number without overwriting it, so turning it off restores it.
      globalCap: () => (this.queueSettings().serial ? 1 : this.queueSettings().globalCap),
      projectCap: (pid) => this.repo.getProject(pid)?.policy.maxConcurrent || this.queueSettings().defaultMaxConcurrent,
      forcedCap: () => this.queueSettings().maxForcedParallel,
      canStart: (item) => this.mayStartNow(item.taskId, Boolean(item.force)),
      onPump: (phase) => (this.pumpView = phase === "begin" ? { settings: this.repo.getSettings() } : null),
      // Tracked: a pipeline still tidies up (commit, port, live view) after its card reaches Review.
      start: (item) => tracked(this.repo.getProject(item.projectId)?.path, this.runPipeline(item.taskId)),
      onError: (item, err) => this.failTask(item.taskId, err instanceof Error ? err.message : String(err)),
    });
    // A queued task that waits on others is held by the queue's veto; something has to look again when
    // one of them is done or deleted, or the waiting task's own links change (D289).
    this.bus.subscribe((m) => {
      if ((m.type === "task.updated" && (m.task.status === "done" || m.task.status === "queued" || m.task.status === "backlog")) || m.type === "task.deleted") this.nudgeQueue();
    });
  }

  private nudging = false;

  /** One pump after the current event settles, however many updates asked for it. */
  private nudgeQueue(): void {
    if (this.nudging) return;
    this.nudging = true;
    setImmediate(() => {
      this.nudging = false;
      this.queue.pump();
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * What the queue asks about every waiting item, read once per pump: with fifty tasks waiting, the
   * settings and the usage gate were otherwise read fifty times each. Null outside a pump.
   */
  private pumpView: { settings: Settings; limitedUntil?: number | null } | null = null;

  private queueSettings(): Settings {
    return this.pumpView?.settings ?? this.repo.getSettings();
  }

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
    // A branch that has just reached Review is final until approved: say now if it would conflict (D359).
    if (patch.status === "review" && task.branch) inBackground(this.repo.getProject(task.project_id)?.path, () => this.refreshConflictRisk(task.project_id, task.id));
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
    this.priorBlocks.delete(taskId);
    this.sentBack.delete(taskId);
    this.checkoutStamps.delete(taskId);
    this.handovers.delete(taskId);
    this.dropTaskState(taskId);
  }

  /** The task's scratch state folder is only of use while its work is; a locked file is left to the OS. */
  private dropTaskState(taskId: string): void {
    try {
      rmSync(taskStateDir(taskId), { recursive: true, force: true });
    } catch {
      // still open in something the task started; it is in the temp folder either way
    }
  }

  /** Your answer to a `board_ask` question: kept on the card and handed to the next stage as a message (D203). */
  answerQuestion(taskId: string, questionId: string, answer: string): Task {
    const { task } = this.load(taskId);
    const question = task.questions.find((q) => q.id === questionId);
    if (!question) throw new NotFoundError(`No question ${questionId} on this task.`);
    const text = answer.trim();
    if (!text) throw new ConflictError("The answer is empty.");
    const message = this.repo.insertMessage({ task_id: taskId, from_task_id: null, from_run_id: null, body: `Answer to "${question.text}": ${text}` });
    this.bus.publish({ type: "message.posted", message });
    const updated = this.setTask(taskId, { questions: task.questions.map((q) => (q.id === questionId ? { ...q, answer: text, answered_at: nowIso() } : q)) });
    // The plan that asked is waiting for approval and was written on its default: a different answer
    // means a different plan, so it is written again before anyone approves the old one (D387).
    const gate = updated.plan_gate;
    if (gate?.kind === "approval" && question.stage_index === gate.stage_index && text !== recommendedOption(question) && !this.isBusy(taskId)) {
      return this.replanWithAnswer(updated, gate.stage_index);
    }
    return updated;
  }

  private replanWithAnswer(task: Task, stageIndex: number): Task {
    const note = this.repo.insertMessage({
      task_id: task.id, from_task_id: null, from_run_id: null,
      body: "Your plan was written before this answer arrived and assumed your default. Revise the plan to match the answers above, keep what still holds, and record each ruling with the answer as its why.",
    });
    this.bus.publish({ type: "message.posted", message: note });
    const planRun = this.latestByStage(task.id).get(stageIndex);
    const updated = this.setTask(task.id, { plan_gate: null, note: null, status: "queued", error: null, summary: "Re-planning with your answer" });
    this.startOpts.set(task.id, { fromStage: stageIndex, resume: planRun?.session_id ?? undefined });
    this.queue.enqueue({ taskId: task.id, projectId: task.project_id });
    return updated;
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
    if (isHandsOff(task)) {
      // A lookup under autonomous works in the project's own folder with nobody asked, so it needs no
      // worktree; what it needs is the project saying autonomous may reach that far (D352).
      if (project.policy.autonomous === "forbidden" || accessOf(project.policy) !== "full") {
        throw new PolicyError(
          `Project "${project.name}" does not let an autonomous lookup work outside a sandbox. Switch this card to supervised, or set the project's autonomous access to "Full access" in Settings.`,
        );
      }
    } else if (task.mode === "autonomous") {
      if (project.policy.autonomous === "forbidden") {
        throw new PolicyError(
          `Project "${project.name}" forbids autonomous runs (policy.autonomous = "forbidden"). Switch this task to supervised mode — it will run in the main checkout with every write as an approval card.`,
        );
      }
      // A project that forbids worktrees runs autonomous work in its folder instead (D398): queueTask
      // stamps it. One that still has a worktree from before keeps it until it lands.
      if (project.policy.worktrees === "forbidden" && usesWorktree(task) && !task.worktree_path) {
        throw new PolicyError(
          `Project "${project.name}" forbids worktrees (policy.worktrees = "forbidden"). Queue the task again: it will work in the project folder.`,
        );
      }
      // Another agent's CLI asks no one and passes no gate: only a worktree keeps it off your files (D398).
      if (worksInFolder(task)) this.providers.assertFolderPipeline(task.pipeline);
    }
    // A supervised task on its own branch needs a worktree too, and a repository to make one in (D234).
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
    // A round starts on a done card; nothing else queues one (D375).
    if (!["backlog", "failed", "review"].includes(task.status) && !(opts.round && task.status === "done")) {
      throw new ConflictError(`Cannot queue a task in status "${task.status}".`);
    }
    if (task.setup_pending && this.repo.getSettings().confirmSetup) {
      throw new SetupNeededError("Check how it runs first: confirm its mode and models on its setup card, then press Start.");
    }
    // A task whose dependencies are not done yet is queued all the same: the queue holds it until they
    // are, then it starts by itself (D289). Refusing it left a chain to be started by hand, link by link.
    const placed = this.stampWorkspace(task, project);
    this.assertRunnable(placed, project);
    this.startOpts.set(taskId, opts);
    // The block is over once the task is sent again; the next prompt still says what stopped it.
    if (task.blocked) this.priorBlocks.set(taskId, task.blocked);
    // Queuing clears the card's note, so a Reject's reason is carried to the prompt here — before,
    // it was wiped before any run could read it (D196). A bare "work discarded" is not a reason.
    if (task.status === "backlog" && task.note?.trim() && task.note !== "work discarded") this.sentBack.set(taskId, task.note.trim());
    const updated = this.setTask(taskId, { status: "queued", error: null, note: null, blocked: null, hold: null });
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

  /**
   * Where an autonomous task works, decided the first time it is queued and kept after, so changing the
   * setting never moves half-done work: the project folder when Settings → autonomousWorktree is off or the
   * project forbids worktrees (D398). A folder without git is found when the run starts (ensureCwd, D399).
   * A task that has a worktree keeps it.
   */
  private stampWorkspace(task: Task, project: Project): Task {
    if (task.in_folder || task.worktree_path || task.mode !== "autonomous" || task.own_branch || isAnswerPipeline(task.pipeline)) return task;
    if (this.repo.getSettings().autonomousWorktree && project.policy.worktrees !== "forbidden") return task;
    return this.setTask(task.id, { in_folder: true });
  }

  /** Settings → autonomousLive: an autonomous task marked live does its live steps itself (D385). */
  private liveAllowed(task: Task): boolean {
    return task.mode === "autonomous" && task.live && this.repo.getSettings().autonomousLive;
  }

  /** Every stage, not only a new worktree: the setting may have been turned on after the folder was made. */
  private async seedLiveKeys(task: Task, project: Project, cwd: string): Promise<void> {
    // In the project folder the keys are already where the scripts look for them (D398).
    if (!this.liveAllowed(task) || cwd === project.path) return;
    const report = await seedWorktree(project.path, cwd, LIVE_KEY_PATTERNS);
    if (report.copied.length) this.log(task.id, `Copied the project's key files for live work: ${report.copied.slice(0, 20).join(", ")}\n`);
  }

  private async ensureCwd(task: Task, project: Project): Promise<string> {
    if (!usesWorktree(task)) return project.path;
    if (task.worktree_path && existsSync(task.worktree_path)) {
      // Its setup never finished — the command failed, or the board was closed part-way. A retry that
      // skipped it would start the stage in a checkout with nothing installed.
      if (existsSync(setupMarker(task.worktree_path))) await this.prepareWorkspace(task, project, task.worktree_path);
      await this.seedLiveKeys(task, project, task.worktree_path);
      return task.worktree_path;
    }
    if (!(await this.git.isGitRepo(project.path))) {
      // No repository, or no git at all: an autonomous task works in the folder itself (D399). A supervised
      // task on its own branch asked for a branch, so it still needs one.
      if (task.mode === "autonomous" && !task.own_branch) {
        this.setTask(task.id, { in_folder: true });
        return project.path;
      }
      // isGitRepo cannot tell "no git" from "not a repository"; the fix for each is different.
      const installed = (await realProbe.run("git", ["--version"])).code === 0;
      throw new PolicyError(
        installed ? `Working on its own branch needs a git repository; ${project.path} is not one.` : "Working on its own branch needs git, and git is not installed on this computer. Open Setup to install it.",
      );
    }
    // A checkout of a big repository takes a minute — measured 61 s for 40k files, and 47 s outside
    // CloudSync, so it is the size, not the sync. Say so instead of sitting silently in Queued (D192).
    this.setTask(task.id, { summary: PREPARING_SUMMARY });
    const wt = await this.git.addWorktree(project.path, task.id);
    // baseSha is null when an existing branch was re-attached: keep the stored base so the diff stays right.
    this.setTask(task.id, { branch: wt.branch, worktree_path: wt.path, base_sha: wt.baseSha ?? task.base_sha });
    await this.prepareWorkspace(task, project, wt.path);
    await this.seedLiveKeys(task, project, wt.path);
    // Done preparing. A run that never writes its own summary left this on the card through Review (D395).
    if (this.repo.getTask(task.id)?.summary === PREPARING_SUMMARY) this.setTask(task.id, { summary: null });
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
    // Left behind if anything below fails, so the next attempt prepares again (see ensureCwd).
    const marker = setupMarker(cwd);
    const tracked = Boolean(patterns.length || project.env.setupCommand);
    if (tracked) {
      try {
        writeFileSync(marker, "");
      } catch {
        // Without the marker a retry skips setup, as it always did; not a reason to stop the task.
      }
    }
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
      const res = await runProjectCommand(project.env.setupCommand, cwd, {
        env: { KANBAN_PORT: String(port), KANBAN_PROJECT_PATH: project.path, KANBAN_STATE_DIR: taskStateDir(task.id) },
      });
      note(`Setup command \`${project.env.setupCommand}\` ${res.ok ? "succeeded" : `FAILED (exit ${res.code})`}\n${res.output.slice(-2000)}`);
      if (!res.ok) throw new PolicyError(`The project's setup command failed in the new worktree:\n${res.output.slice(-1500)}`);
    }
    if (tracked) {
      try {
        rmSync(marker, { force: true });
      } catch {
        // Left in place, the next start prepares once more: slower, never wrong.
      }
    }
  }

  /** What the board keeps for a task's workspace outside the workspace itself, once that is gone. */
  private forgetWorkspace(task: Task): void {
    this.ports.delete(task.id);
    this.dropTaskState(task.id);
    if (!task.worktree_path) return;
    try {
      rmSync(setupMarker(task.worktree_path), { force: true });
    } catch {
      // an empty file beside a folder that no longer exists
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
      if (this.reraisePlanGate(task, opts.fromStage)) return;
      const cwd = await this.ensureCwd(task, project);
      // ensureCwd may have placed it in the project folder (D399): read that back before anything asks.
      task = this.repo.getTask(taskId) ?? task;
      if (sharesProjectFolder(task)) await this.snapshotCheckout(taskId, cwd);
      // Reserved before the first prompt is written, so the prompt can name it.
      await this.portFor(taskId);
      let switches = 0;
      // Stage index → automatic continues used after hitting the turn cap (D232).
      const continued = new Map<number, number>();
      let continuing = false;

      for (let i = opts.fromStage; i < task.pipeline.length; i++) {
        if (ctl.stopped) {
          this.setTask(taskId, { status: "failed", error: "stopped by user" });
          return;
        }
        task = this.repo.getTask(taskId)!;
        // The steps ahead may have been edited while the last one ran (D364), shortening the list.
        if (i >= task.pipeline.length) break;
        // A round is its coder's work, then a review only when one was asked for: no plan, no other steps.
        if (opts.round && i > opts.fromStage && !(opts.round.review && task.pipeline[i]!.stage === "review")) continue;
        // A per-stage cap alone lets a 3-stage task cost 3x it, and a parent with six subtasks far
        // more. Check the task's whole spend before starting another stage.
        const capped = this.taskCeiling(task);
        const spent = this.repo.taskCost(taskId);
        if (spent >= capped) {
          this.pauseForCost(taskId, spent, capped, "this task reached its ceiling");
          return;
        }
        // Its provider is known to be out: carry on where Settings say, or wait without calling it (D225).
        const pre = this.preflightProvider(task, i);
        if (pre === "paused") return;
        if (pre === "switched") {
          task = this.repo.getTask(taskId)!;
          if (i === opts.fromStage) opts.resume = undefined;
        }
        const stage = this.stageAt(task, i);
        const resume = i === opts.fromStage ? opts.resume : undefined;
        // "Carry on where you stopped" only means something inside the session that stopped. Moved to
        // another model there is no such session, so the stage gets its whole prompt, with the handover.
        if (!resume) continuing = false;
        const gated = stage.stage === "code" || stage.stage === "custom";
        // Written before the run row exists: if this throws, no run is left behind marked "running".
        const prompt = continuing ? CONTINUE_PROMPT
          : opts.round && i === opts.fromStage ? (resume ? opts.round.prompt : opts.round.fallback)
          : await this.stagePromptFor(task, i, project, cwd);
        continuing = false;
        const run = this.repo.createRun({
          task_id: taskId, stage: stage.stage, stage_index: i, model: stage.model, effort: stage.effort,
          provider: stage.provider && stage.provider !== ANTHROPIC_PROVIDER_ID ? stage.provider : null,
        });
        this.bus.publish({ type: "run.updated", run });
        this.setTask(taskId, { status: STAGE_STATUS[stage.stage], error: null });

        // What stopped the last attempt is for the stage that picks up from it, not for every one after.
        this.priorBlocks.delete(taskId);
        this.handovers.delete(taskId);
        const res = this.providers.resolve(stage.provider);
        const readOnly = stage.stage === "plan" || stage.stage === "review" || !res.provider?.mayEditFiles;
        // A supervised checkout may hold your own uncommitted work: what counts is what the run changed.
        const before = res.adapter.kind === "cli" && readOnly ? await this.workspaceState(cwd) : null;
        const outcome = await this.runQuery({
          task, project, run, cwd, ctl,
          prompt,
          resume,
          forkSession: Boolean(opts.round?.fork && i === opts.fromStage && resume),
          stageStatus: STAGE_STATUS[stage.stage],
          disallowedTools: stage.stage === "plan" ? PLAN_DISALLOWED : undefined,
          verifyCommand: gated ? project.env.verifyCommand : null,
        });
        // A read-only CLI provider that edited files broke its contract: fail before committing, so
        // the changes are neither kept as this stage's output nor merged (docs/DECISIONS.md D137).
        const touched = outcome.ok && before ? await this.workspaceChanges(cwd, before) : [];
        if (touched.length) {
          this.setTask(taskId, {
            status: "failed",
            error: `${res.label} was run read-only on the ${stage.stage} stage but changed ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ` and ${touched.length - 5} more` : ""}. Nothing was committed. Inspect ${cwd}, then retry.`,
          });
          return;
        }
        // A text-only or CLI review cannot call the board tool; its verdict line says the same thing.
        const verdict = verdictOf(this.repo.getRun(run.id)?.result_md);
        const standing = this.repo.getTask(taskId)?.blocked;
        if (outcome.ok && verdict === "BLOCKED" && (!standing || standing.advisory)) {
          // After a "needs a supervised run" suggestion, a review that still blocks is asking for that run.
          this.setTask(taskId, {
            blocked: { stage_index: i, reason: verdictReason(this.repo.getRun(run.id)?.result_md), needs: standing?.advisory ? "supervised" : "input", ask: null, source: "agent", mode: task.mode, created_at: nowIso() },
          });
        }
        const blocked = this.repo.getTask(taskId)?.blocked;
        // A suggestion is not a stop: the stage counts as done and the next one runs (D382).
        const isBlocked = blocked?.stage_index === i && !blocked.advisory && !ctl.stopped;
        if (usesWorktree(task)) {
          await this.commitWorktree(task, `kanban(${stage.stage})${isBlocked ? " [blocked]" : outcome.ok ? "" : " [failed]"}: ${task.title}`);
        }
        // Before any outcome is published: whoever acts on "review" must find the list already there.
        await this.recordTouched(taskId);
        // "Blocked" is not a pass: the stage keeps its report, but it is not counted as done, so the
        // next stage never runs on it and Retry starts here again (D184).
        if (isBlocked) {
          this.setRun(run.id, { status: "failed", error: `blocked: ${blocked.reason}` });
          this.setTask(taskId, { status: "failed", error: `Blocked at stage #${i + 1} (${stage.stage}): ${blocked.reason}` });
          return;
        }
        if (!outcome.ok) {
          // A round whose session is gone starts once more, fresh, with the card's handoff (D375).
          if (opts.round && i === opts.fromStage && resume && !ctl.stopped && LOST_SESSION.test(outcome.error ?? "")) {
            this.repo.updateRound(taskId, opts.round.n, { fell_back: true });
            this.log(run.id, `\n[board] The session to continue could not be reopened; this ${opts.round.fork ? "card" : `round (${opts.round.n})`} starts fresh with what the earlier card did.\n`);
            opts.resume = undefined;
            i--;
            continue;
          }
          // Out of turns is not a fault either: the session is intact, so carry on in it (D232).
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
          // Money, not a fault: wait for Continue or Stop rather than fail (D216).
          if (outcome.budgetStop) {
            this.pauseForCost(taskId, this.repo.taskCost(taskId), this.taskCeiling(task), outcome.error ?? "the stage reached its ceiling");
            return;
          }
          // Ran out rather than went wrong: carry on elsewhere (the stage runs again, in this loop), or
          // wait for it to come back, or ask. Claude's windows and a provider's are handled alike (D225).
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
          const verdict = await this.verifyWorkspace(project, task, cwd, run.id, outcome.verifiedAtStop);
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
          // What the plan says it will change replaces the guess made when the card was created (D400).
          const said = planFootprint(this.repo.getRun(run.id)?.result_md ?? "");
          const now = this.repo.getTask(taskId);
          if (now && (said.files.length || said.systems.length)) {
            this.setTask(taskId, {
              footprint: { ...now.footprint, files: said.files.length ? said.files : now.footprint.files, systems: [...new Set([...now.footprint.systems, ...said.systems])] },
            });
          }
          const critic = this.providers.debateFor(stage, this.repo.getSettings());
          if (critic && (await this.debate({ task, project, planRun: run, stageIndex: i, cwd, ctl, critic }))) return;
          if (ctl.stopped) {
            this.setTask(taskId, { status: "failed", error: "stopped by user" });
            return;
          }
          // Plan approval (D231): nothing is written until the human has read the plan.
          const plan = this.repo.getRun(run.id)?.result_md ?? "";
          if (i + 1 < task.pipeline.length && plan.trim() && this.needsPlanApproval(this.repo.getTask(taskId)!)) {
            this.raisePlanGate(taskId, i, plan);
            return;
          }
        }
        if (stage.stage === "review" && verdict !== "CHANGES_NEEDED" && this.repo.getSettings().browserChecks) {
          const changed = await this.diff(taskId).then((d) => d.map((f) => f.file), () => []);
          if (reviewSkippedBrowser(this.repo.getRun(run.id)?.result_md, changed)) {
            this.setTask(taskId, { note: "The review did not say whether it looked at this change in a browser. Open it yourself before you approve." });
          }
        }
        // A review stage that asked for changes must not look like a pass.
        if (stage.stage === "review" && verdict === "CHANGES_NEEDED") {
          this.setTask(taskId, {
            status: "failed",
            error: `Review asked for changes — Retry from stage #${i} (code) after reading the review. ${verdictReason(this.repo.getRun(run.id)?.result_md)}`,
          });
          return;
        }
      }
      // An answer card changed nothing, so there is nothing to approve or land: its answer is the result (D284).
      const finished = isAnswerPipeline(this.repo.getTask(taskId)?.pipeline ?? []) ? "done" : "review";
      this.setTask(taskId, ctl.stopped ? { status: "failed", error: "stopped by user" } : { status: finished, ...(finished === "done" ? { note: null } : {}) });
    } finally {
      this.pipelines.delete(taskId);
      this.priorBlocks.delete(taskId);
      this.checkoutStamps.delete(taskId);
      // Kept while the task still has stages to go (a debate gate, a limit pause): cleared once it lands in review.
      if (["review", "done"].includes(this.repo.getTask(taskId)?.status ?? "")) this.sentBack.delete(taskId);
    }
  }

  /** The workspace's uncommitted files, each with its size and time: what a read-only stage must leave as it found. */
  private async workspaceState(cwd: string): Promise<Map<string, string> | null> {
    try {
      return new Map((await this.git.statusFiles(cwd)).map((f) => [f, fileStamp(join(cwd, f))]));
    } catch {
      return null; // not a repository: nothing to compare against
    }
  }

  /**
   * What a run added, changed or put back since `before` (D295). "Is it dirty now?" failed every
   * read-only Codex stage in a supervised checkout that already held an uncommitted file of the user's.
   */
  private async workspaceChanges(cwd: string, before: Map<string, string>): Promise<string[]> {
    const after = await this.workspaceState(cwd);
    if (!after) return [];
    return [...new Set([...after.keys(), ...before.keys()])].filter((f) => before.get(f) !== after.get(f));
  }

  /**
   * The stage as it actually runs. A live task's review runs on Settings → liveReviewModel through
   * your Claude login, at high effort or more, whatever its pipeline says (D233): in a real run a
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

  /** Whether the task waits for the human after its plan: its own choice, else Settings; always when live (D231, D233). */
  private needsPlanApproval(task: Task): boolean {
    if (task.live) return true;
    return task.plan_approval ?? this.repo.getSettings().planApproval;
  }

  private raisePlanGate(taskId: string, stageIndex: number, plan: string): void {
    this.setTask(taskId, {
      status: "approval",
      note: "Read the plan, then approve it, edit it, or send the task back.",
      plan_gate: { kind: "approval", stage_index: stageIndex, created_at: nowIso(), original: plan },
    });
  }

  /**
   * A run that starts just past the plan must not slip by the plan's approval. The gate used to be
   * raised only in the moment after the plan stage ran, so Stop at the gate and then Retry went
   * straight to code — on a live task too. Returns true when the task was put back at the gate.
   */
  private reraisePlanGate(task: Task, fromStage: number): boolean {
    const planIndex = fromStage - 1;
    if (planIndex < 0 || task.pipeline[planIndex]?.stage !== "plan" || !this.needsPlanApproval(task)) return false;
    const planRun = this.latestByStage(task.id).get(planIndex);
    const plan = planRun?.status === "success" ? planRun.result_md ?? "" : "";
    if (!planRun || !plan.trim()) return false;
    const events = this.repo.eventsAfter(planRun.id, 0, 20_000);
    // The decision is an event on the plan's own run. No transcript at all means it was pruned with
    // age: a plan that old has been acted on, and asking again would only be noise.
    if (!events.length || events.some((e) => e.type === "plan:approved" || e.type === "debate:decision")) return false;
    this.raisePlanGate(task.id, planIndex, plan);
    return true;
  }

  /** The stage prompt, with what a tool-less model needs inlined (the diff, the file list). */
  private async stagePromptFor(task: Task, stageIndex: number, project: Project, cwd: string): Promise<string> {
    const stage = this.stageAt(task, stageIndex);
    const res = this.providers.resolve(stage.provider);
    const capabilities = res.adapter.hasTools ? (res.adapter.kind === "cli" ? "cli" : "sdk") : "text";
    const ctx = { ...this.promptCtx(task, stageIndex, project), capabilities } as ReturnType<TaskRunner["promptCtx"]> & { capabilities: "sdk" | "cli" | "text"; inlineDiff?: unknown; fileList?: unknown };
    // No picture maker ready: the prompt says nothing about pictures, so the model works as it would anyway.
    if (ctx.imageTool) ctx.imageTool = await this.picturesReady();
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
   * A critic run lists objections, the planner revises in its own session, and the task waits in
   * Approval for the human to pick. Settings → debate decides how many such rounds run (D339): one,
   * a fixed number, or until the critic has no objections left — under a ceiling either way.
   * Returns true when the pipeline must stop here (gated). A broken or silent critic never blocks
   * work: the plan stands and the pipeline continues.
   */
  private async debate(a: { task: Task; project: Project; planRun: Run; stageIndex: number; cwd: string; ctl: PipelineCtl; critic: { provider: string; model: string; effort: Run["effort"] } }): Promise<boolean> {
    const { task, project, stageIndex, cwd, ctl, critic } = a;
    const planRun = this.repo.getRun(a.planRun.id)!;
    const original = planRun.result_md ?? "";
    const publish = (type: string, payload: Record<string, unknown>) => {
      const event = this.repo.insertEvent(planRun.id, type, payload);
      this.bus.publish({ type: "event", runId: planRun.id, taskId: task.id, event });
    };
    const skip = (reason: string) => {
      publish("debate:skipped", { type: "debate_skipped", reason });
      return false;
    };
    if (!original.trim()) return skip("the plan stage produced no text to critique");
    if (ctl.stopped) return false;

    const settings = this.repo.getSettings().debate;
    const limit = debateRoundLimit(settings);
    const earlier = this.promptCtx(task, stageIndex, project).earlierResults;
    const planner = this.providers.resolve(planRun.provider);
    // The planner answers in its own session when it has one; otherwise the plan travels with the critique.
    const resumable = planner.adapter.canResume && !!planRun.session_id;

    let plan = original;
    let critique: ReturnType<typeof parseCritique> | undefined;
    let criticRunId: string | undefined;
    let previousAnswers = "";
    let rounds = 0;
    let agreed = false;
    for (let n = 1; n <= (limit ?? DEBATE_ROUND_CEILING); n++) {
      const round = { n, of: limit, last: n === (limit ?? DEBATE_ROUND_CEILING) };
      const criticRun = this.repo.createRun({
        task_id: task.id, stage: "plan", stage_index: stageIndex, model: critic.model, effort: critic.effort, role: "critic",
        provider: critic.provider && critic.provider !== ANTHROPIC_PROVIDER_ID ? critic.provider : null,
      });
      this.bus.publish({ type: "run.updated", run: criticRun });
      const criticOutcome = await this.runQuery({
        task, project, run: criticRun, cwd, ctl, stageStatus: "planning", disallowedTools: PLAN_DISALLOWED, verifyCommand: null,
        prompt: buildCriticPrompt({ title: task.title, spec_md: task.spec_md, plan, earlier, round, previousAnswers }),
      });
      if (ctl.stopped) return false;
      if (!criticOutcome.ok) {
        // A critic that breaks on a later round does not undo the rounds before it: the gate shows what was argued so far.
        if (!rounds) return skip(`the critic failed: ${criticOutcome.error ?? "no result"}`);
        publish("debate:round", { type: "debate_round", round: n, of: limit ?? null, objections: 0, note: `the critic failed: ${criticOutcome.error ?? "no result"}` });
        break;
      }
      const parsed = parseCritique(this.repo.getRun(criticRun.id)?.result_md ?? "");
      if (!parsed.objections.length) {
        if (!rounds) return skip("the critic had no objections");
        agreed = true;
        publish("debate:round", { type: "debate_round", round: n, of: limit ?? null, objections: 0, agreed: true });
        break;
      }
      critique = parsed;
      criticRunId = criticRun.id;
      publish("debate:round", { type: "debate_round", round: n, of: limit ?? null, objections: parsed.objections.length });

      const revision = await this.runQuery({
        task, project, run: planRun, cwd, ctl, stageStatus: "planning", disallowedTools: PLAN_DISALLOWED, verifyCommand: null,
        accumulate: true, promptEvent: true,
        resume: resumable ? planRun.session_id ?? undefined : undefined,
        prompt: buildRevisionPrompt(parsed.raw, resumable ? undefined : plan, round),
      });
      if (ctl.stopped) return false;
      rounds = n;
      if (!revision.ok) {
        // A failed revision must not leave the stage marked failed: the plan so far still stands.
        this.setRun(planRun.id, { status: "success", error: null, result_md: plan });
        break;
      }
      const answer = this.repo.getRun(planRun.id)?.result_md;
      const revised = extractRevisedPlan(answer);
      if (!revised.trim()) break;
      plan = revised;
      previousAnswers = extractRevisionAnswers(answer);
    }
    if (usesWorktree(task)) await this.commitWorktree(task, `kanban(debate): ${task.title}`);

    this.setTask(task.id, {
      status: "approval",
      note: agreed
        ? `The plan was debated until the critic agreed (${rounds} ${rounds === 1 ? "round" : "rounds"}) — pick the plan to build from.`
        : limit === undefined
          ? `The debate stopped after ${rounds} rounds without agreement — pick the plan to build from.`
          : "The plan was debated — pick the plan to build from.",
      plan_gate: {
        stage_index: stageIndex, critic_run_id: criticRunId, critic: { provider: critic.provider, model: critic.model },
        created_at: nowIso(), original, critique, revised: plan === original ? "" : plan, rounds, agreed,
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
    // Helpers are named Claude models: on another provider's stage the stage does the work itself.
    const claudeStage = !stage.provider || stage.provider === ANTHROPIC_PROVIDER_ID;
    // The model the stage really runs on (a live task's review is moved to the live review model).
    const effective = this.stageAt(task, stageIndex);
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
      handsOff: isHandsOff(task),
      mayAsk: task.mode === "autonomous" && task.may_ask,
      task: { id: task.id, title: task.title, spec_md: task.spec_md },
      branch: task.branch,
      baseSha: task.base_sha,
      parent: parent ? { id: parent.id, title: parent.title, spec_md: parent.spec_md } : null,
      siblings: this.repo.siblings(task).map((s) => ({ id: s.id, title: s.title, status: s.status, summary: s.summary })),
      previousResult: stageIndex > 0 ? prevRun?.result_md ?? null : null,
      previousStage: stageIndex > 0 ? task.pipeline[stageIndex - 1]?.stage ?? null : null,
      live: task.live,
      liveAllowed: this.liveAllowed(task),
      inFolder: worksInFolder(task),
      // Narrowed to "a picture maker is ready" in stagePromptFor, which can ask Codex (D303).
      imageTool: settings.imageProvider !== "off" && stage.stage !== "plan" && stage.stage !== "review",
      imageMaker: imageMakerLine(settings),
      previousFrom: prevRun?.provider ? { provider: prevRun.provider, model: prevRun.model } : null,
      earlierResults,
      skills: task.skills,
      messages,
      rejectNote: this.sentBack.get(task.id) ?? null,
      priorBlock: this.priorBlocks.get(task.id) ?? null,
      foreignChanges: sharesProjectFolder(task) ? task.checkout?.dirtyAtStart ?? [] : [],
      verificationFailure: this.verifyFailures.get(task.id) ?? null,
      handover: this.handovers.get(task.id) ?? null,
      verifyCommand: project.env.verifyCommand,
      browser: settings.browserChecks
        ? {
            port: this.ports.get(task.id) ?? null,
            chrome: settings.taskBrowser === "chrome" || (settings.chromeInSupervised && task.mode !== "autonomous"),
            sites: settings.taskBrowser === "board" ? settings.browserSites : [],
            helper: claudeStage && usesHelper(settings.browserCheckModel, effective.model),
          }
        : null,
      ...this.memoryFor(project.id, task),
      // Images the user attached, by absolute path: Claude reads them with the Read tool, which
      // renders images. Ones a previous run produced are left out — it already saw those.
      images: this.repo
        .listAttachments(task.id)
        .filter((a) => a.source === "user")
        .slice(0, 8)
        .map((a) => ({ name: a.name, path: a.path, note: a.note, description: a.description, kind: attachmentKind(a.media_type) })),
      // What the tasks this one waited for reported: a chain hands its results down (D290).
      dependencies: task.depends_on
        .map((id) => this.repo.getTask(id))
        .filter((t): t is Task => Boolean(t))
        .slice(0, 6)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, outcome: resultText(this.repo.runsForTask(t.id), t.summary, 1500) })),
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

  /**
   * A supervised run shares your checkout with whatever else is changing it — another session, you.
   * Note what was already uncommitted, so the run is told to leave it alone and the card can say which
   * files are this task's (D204). Files an earlier attempt of this same task changed are its own.
   */
  private async snapshotCheckout(taskId: string, cwd: string): Promise<void> {
    try {
      // A look on disk first: most folders that are not a repository never need a git process at all.
      if (!existsSync(join(cwd, ".git")) || !(await this.git.isGitRepo(cwd))) return;
      const own = new Set(this.repo.getTask(taskId)?.checkout?.touched ?? []);
      const files = await this.git.statusFiles(cwd);
      this.checkoutStamps.set(taskId, { cwd, own, stamps: new Map(files.slice(0, 500).map((f) => [f, fileStamp(join(cwd, f))])) });
      this.setTask(taskId, { checkout: { at: nowIso(), dirtyAtStart: files.filter((f) => !own.has(f)).slice(0, 200), touched: null } });
    } catch (err) {
      // A checkout the board cannot read is no reason to stop the task.
      this.log(taskId, `[board] could not read the checkout's status: ${String(err)}\n`);
    }
  }

  /**
   * Files added or changed since the snapshot: this task's, or changed by someone else while it ran.
   * Called after every stage, each time measured from the start of the run.
   */
  private async recordTouched(taskId: string): Promise<void> {
    const before = this.checkoutStamps.get(taskId);
    const task = this.repo.getTask(taskId);
    if (!before || !task?.checkout) return;
    try {
      const now = await this.git.statusFiles(before.cwd);
      const touched = now.filter((f) => before.own.has(f) || !before.stamps.has(f) || before.stamps.get(f) !== fileStamp(join(before.cwd, f)));
      // What it changed with commands too, so the queue keeps the next task off these files (D400).
      const all = [...new Set([...task.footprint.touched, ...touched])].slice(0, 500);
      this.setTask(taskId, { checkout: { ...task.checkout, touched: touched.slice(0, 200) }, footprint: { ...task.footprint, touched: all } });
    } catch (err) {
      this.log(taskId, `[board] could not read the checkout's status: ${String(err)}\n`);
    }
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

  /** Where the board keeps the files a task in the project folder changed, as they were before (D398). */
  private copiesDir(taskId: string): string {
    return join(this.repo.getSettings().stateDir, "folder-copies", taskId);
  }

  /** A file a running task is about to write: kept as it was when the task works in the folder, and added to what it touched (D398, D400). */
  private noteWrite(task: Task, root: string, file: string): void {
    const rel = relInside(root, file);
    if (!rel) return;
    if (worksInFolder(task)) {
      try {
        keepOriginal(this.copiesDir(task.id), root, rel);
      } catch (err) {
        this.log(task.id, `[board] could not keep a copy of ${rel} before it changed: ${String(err)}\n`);
      }
    }
    const fresh = this.repo.getTask(task.id);
    if (!fresh || fresh.footprint.touched.includes(rel)) return;
    this.setTask(task.id, { footprint: { ...fresh.footprint, touched: [...fresh.footprint.touched, rel].slice(0, 500) } });
  }

  /** Another task running in the same folder that has already changed this file, if any (D400). */
  private writtenByOther(task: Task, rel: string): Task | null {
    for (const id of this.active.keys()) {
      if (id === task.id) continue;
      const other = this.repo.getTask(id);
      if (!other || other.project_id !== task.project_id || !sharesProjectFolder(other)) continue;
      if (other.footprint.touched.includes(rel) || (other.checkout?.touched ?? []).includes(rel)) return other;
    }
    // And one that finished without landing yet: its Approve would commit this file with our change in it.
    return this.unlandedInFolder(task).find((t) => t.footprint.touched.includes(rel)) ?? null;
  }

  /** This task's own changes in the project folder: what it wrote, never what was changed before it started (D398). */
  private folderFiles(task: Task): string[] {
    const before = new Set(task.checkout?.dirtyAtStart ?? []);
    const kept = Object.keys(keptFiles(this.copiesDir(task.id)));
    return [...new Set([...kept, ...task.footprint.touched, ...(task.checkout?.touched ?? [])])].filter((f) => kept.includes(f) || !before.has(f));
  }

  /** The Changes tab of a task in the project folder: each file against the copy kept before its first write (D398). */
  private async folderDiff(task: Task, project: Project): Promise<DiffFile[]> {
    const dir = this.copiesDir(task.id);
    const kept = keptFiles(dir);
    const out: DiffFile[] = [];
    for (const [rel, how] of Object.entries(kept)) {
      const abs = join(project.path, ...rel.split("/"));
      const exists = existsSync(abs);
      if (how === "big") {
        out.push({ file: rel, status: "M", patch: "" });
        continue;
      }
      const before = how === "copied" ? keptCopy(dir, rel) : null;
      if (!before && !exists) continue; // made and deleted again
      let patch = "";
      try {
        patch = await this.git.patchBetween(project.path, before, exists ? abs : null, rel);
      } catch {
        // No git on this computer: the file is still listed, without its lines.
      }
      if (before && exists && !patch.trim()) continue; // written back as it was
      out.push({ file: rel, status: !before ? "A" : exists ? "M" : "D", patch });
    }
    // Files a command changed (a formatter, a generator): only a repository can say how.
    const rest = (task.checkout?.touched ?? []).filter((f) => !kept[f] && !(task.checkout?.dirtyAtStart ?? []).includes(f));
    if (rest.length && (await this.git.isGitRepo(project.path))) {
      const changed = new Map((await this.git.diffWorkingTree(project.path).catch(() => [] as DiffFile[])).map((d) => [d.file, d]));
      for (const f of rest) out.push(changed.get(f) ?? { file: f, status: "A", patch: "" });
    }
    return out;
  }

  // ---------------------------------------------------------------- one query() call

  /**
   * One session, start to finish. Whatever goes wrong — before the session exists as much as inside
   * it — the run row is closed and the task is free again. A throw while setting a stage up used to
   * leave the run "running" for good and the task busy until the board was restarted.
   */
  private async runQuery(a: StageArgs): Promise<StageOutcome> {
    try {
      return await this.streamStage(a);
    } catch (err) {
      const { task, run } = a;
      if (this.active.get(task.id)?.runId === run.id) this.active.delete(task.id);
      this.browserWatch.end(task.id, run.id);
      for (const ap of this.repo.pendingApprovals(task.id)) this.resolvers.get(ap.id)?.({ decision: "expired", note: "run ended" });
      try {
        rmSync(join(tmpdir(), "claude-kanban-browser", run.id), { recursive: true, force: true });
      } catch {
        // in the temp folder either way
      }
      const error = a.ctl.stopped ? "stopped by user" : err instanceof Error ? err.message : String(err);
      this.log(run.id, `\n[board] the stage could not run: ${error}\n`);
      if (this.repo.getRun(run.id)) {
        const finished = this.repo.updateRun(run.id, { status: "failed", ended_at: nowIso(), error });
        this.bus.publish({ type: "run.finished", run: finished });
      }
      return { ok: false, error, providerId: run.provider ?? ANTHROPIC_PROVIDER_ID, budgetStop: false, turnLimit: false, verifiedAtStop: false };
    }
  }

  private async streamStage(a: StageArgs): Promise<StageOutcome> {
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
    // A lookup under autonomous: the project's own folder, its own gate, and nothing on a card (D352).
    const handsOff = isHandsOff(task);
    // An autonomous task in the project folder itself (D398): the gate guards the folder, not a copy of it.
    const inFolder = worksInFolder(task);
    // The board's own browser, one per session; see browser.ts for why not the Playwright plugin's.
    const browserDir = join(tmpdir(), "claude-kanban-browser", run.id);
    // Outside its worktree an autonomous run may read only these: this task's attachments, its own
    // screenshots, and the skills Claude loads (D187).
    const readRoots = [
      join(settings.stateDir, "attachments", task.id), browserDir, join(homedir(), ".claude", "skills"), join(homedir(), ".claude", "plugins"),
      ...claudeSessionRoots(a.cwd),
    ];
    // An autonomous run that keeps hitting the sandbox is stopped and marked blocked, not left to
    // hunt for a way round it (D186).
    let refusals = 0;
    let blockedByBoard: string | null = null;
    // The Stop hook's verify passed and no tool has run since: the board need not run it again (D108).
    let verifiedAtStop = false;
    // Where the board browser may go without asking in an autonomous run, and whether Chrome is the owner's choice (D389).
    const browserReach = { sites: settings.taskBrowser === "board" ? settings.browserSites : [], chrome: settings.taskBrowser === "chrome" };
    const refuse = (message: string): { behavior: "deny"; message: string } => {
      refusals++;
      this.log(run.id, `\n[board] sandbox refusal ${refusals}: ${message}\n`);
      if (refusals >= AUTO_BLOCK_AFTER && !blockedByBoard) {
        blockedByBoard = `The sandbox refused ${refusals} attempts to reach outside this task's folder. Last one: ${message}`;
        this.setTask(task.id, {
          blocked: { stage_index: run.stage_index, reason: blockedByBoard, needs: "supervised", ask: null, source: "board", mode: task.mode, created_at: nowIso() },
          summary: "Blocked: kept trying to reach outside its folder",
        });
        abort.abort();
      }
      return { behavior: "deny", message: message + escalationHint(refusals) };
    };
    // The live view: the browser also opens a debugging port the board watches (browserWatch.ts).
    // A plan only reads, and a critic only argues with it: neither is told to look at anything, so
    // neither carries the browser or the image tool (D271).
    const critic = run.role === "critic";
    const visual = !critic && run.stage !== "plan";
    // Only with a picture maker that is ready: a tool that can only fail would just cost a turn (D303).
    const pictures = visual && run.stage !== "review" && settings.imageProvider !== "off" && (await this.picturesReady());
    const watchPort = visual && settings.browserChecks && settings.liveView ? await freePort().catch(() => undefined) : undefined;
    if (watchPort) this.browserWatch.begin(task.id, run.id, watchPort);
    // Why a command is refused outright — the blocked list, or a kill by name — or null when it is not.
    const refusedOutright = (command: string): string | null => {
      if (!command) return null;
      const rule = blockedCommand(command, settings.blockedCommands);
      const killer = rule ? null : killsByName(command);
      const note = rule
        ? `Refused: "${rule}" is on the board's blocked-command list (Settings → Runs & limits). Nothing was run.`
        : killer
          ? `Refused: ${killer} kills every process with that name — including the board running this task and anything else on this computer. ` +
            "Stop only the process you started: stop its background shell, or kill its PID (`kill <pid>`, `taskkill /PID <pid> /T /F`). Nothing was run."
          : null;
      if (note) this.log(run.id, `\n[board] ${note}\n  ${command}\n`);
      return note;
    };
    // The keys a live task was given stay out of the transcript, which the board keeps (D385). In the
    // project folder the keys are always there, live task or not (D398).
    const liveKeys = this.liveAllowed(task) || inFolder;
    const printsKeys = (toolName: string, input: Record<string, unknown>): string | null => {
      const risk = liveKeys ? credentialRisk(toolName, input) : null;
      return risk?.level === "prints"
        ? `Refused: that would put what is in ${risk.files.slice(0, 3).join(", ")} (passwords or keys) into the transcript, which the board keeps. Let a script load the file instead of showing it.`
        : null;
    };
    const handsOffDecision = (toolName: string, input: Record<string, unknown>) => {
      const decision = handsOffGate(toolName, input);
      if (decision.behavior === "deny") this.log(run.id, `\n[board] ${decision.message}\n`);
      return decision;
    };
    // Board tools are always allowed; handled here rather than via allowedTools so nothing shadows this callback.
    const canUseTool: CanUseTool = async (toolName, input, o) => {
      if (toolName.startsWith("mcp__board__")) return { behavior: "allow", updatedInput: input };
      // A question for you: in a supervised run it waits on a card like an approval (and, if Settings
      // say so, Claude decides for itself after a while). Before the gate, which would refuse it.
      // An autonomous run has nobody watching, so it asks with board_ask and carries on (D239) —
      // unless it is "Autonomous + asks me", whose whole point is that someone will answer (D361).
      if (toolName === QUESTION_TOOL) {
        if (!autonomous) return this.askApproval(run, task.id, toolName, input, o);
        if (task.may_ask) return this.askApproval(run, task.id, toolName, input, o, { askMode: true });
        return { behavior: "deny", message: "Nobody is watching this autonomous run, so a question would stall it. Put it on the card with board_ask (with the default you carry on with) and carry on." };
      }
      // The blocklist comes first, in both modes: these are the commands where an approval card
      // would just be a chance to click the wrong button.
      const command = String((input as { command?: unknown }).command ?? "");
      const outright = refusedOutright(command);
      if (outright) return { behavior: "deny", message: outright };
      // An image from the board's own tool lands inside the task's folder (the tool refuses any other
      // path): a card in a supervised run, like any new file; free in an autonomous one (D262).
      if (toolName.startsWith(IMAGE_PREFIX)) return autonomous ? { behavior: "allow", updatedInput: input } : this.askApproval(run, task.id, toolName, input, o);
      if (handsOff) return handsOffDecision(toolName, input);
      // MarkItDown reads a document: free where a Read would be, otherwise refused or a card (D316).
      if (toolName === MARKITDOWN_TOOL && settings.markitdownInTasks) {
        const read = markitdownRead(input, a.cwd, readRoots);
        if (autonomous) return read.ok ? { behavior: "allow", updatedInput: input } : refuse(read.message);
        if (read.ok && !(read.path && credentialRisk("Read", { file_path: read.path }))) {
          const event = this.repo.insertEvent(run.id, "board:auto-allowed", { type: "auto_allowed", tool: toolName, command: String(input.uri ?? "") });
          this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event });
          return { behavior: "allow", updatedInput: input };
        }
        return this.askApproval(run, task.id, toolName, input, o);
      }
      // Browser tools have their own rules: looking at a local page is not a write (docs/DECISIONS.md D128).
      const browser = browserDecision(toolName, input, autonomous, a.cwd, browserDir, browserReach);
      if (browser?.behavior === "allow") return { behavior: "allow", updatedInput: browser.input };
      if (browser?.behavior === "deny") return autonomous ? refuse(browser.message) : browser;
      if (browser?.behavior === "ask") return this.askApproval(run, task.id, toolName, browser.input, o);
      if (!autonomous) {
        // A command that can only read is not a write: no card, but a line in the transcript (D202).
        // Likewise a read of the skills Claude loads, this task's attachments or its screenshots — the
        // same folders an autonomous run may read. Anything else outside the project still asks.
        const readsKnownFolder = READ_ONLY_TOOLS.has(toolName) && !readViolation(toolName, input, a.cwd, readRoots) && !credentialRisk(toolName, input);
        // A connector tool whose name only reads (get_values, list_events) is the same kind of call (D363).
        if (settings.autoAllowReadOnly && (readsKnownFolder || isReadOnlyMcp(toolName) || ((toolName === "Bash" || toolName === "PowerShell") && isReadOnlyShell(command, a.cwd)))) {
          const what = command || String((input as { file_path?: unknown; path?: unknown }).file_path ?? (input as { path?: unknown }).path ?? toolName);
          const event = this.repo.insertEvent(run.id, "board:auto-allowed", { type: "auto_allowed", tool: toolName, command: what });
          this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event });
          return { behavior: "allow", updatedInput: input };
        }
        // What "Always allow" on an earlier card covers, read fresh: a card in this very run may have added it (D353).
        if (isTrusted(toolName, input, a.cwd, this.repo.getProject(task.project_id)?.policy.trusted ?? [])) {
          const event = this.repo.insertEvent(run.id, "board:auto-allowed", { type: "auto_allowed", tool: toolName, command: command || toolName, trusted: true });
          this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event });
          return { behavior: "allow", updatedInput: input };
        }
        return this.askApproval(run, task.id, toolName, input, o);
      }
      const keys = printsKeys(toolName, input);
      if (keys) return { behavior: "deny", message: keys };
      const decision = autonomousGate(toolName, input, a.cwd, readRoots, { markitdown: settings.markitdownInTasks, folder: inFolder });
      // A question nobody can answer is not the sandbox saying no: it gets its own message, uncounted.
      if (decision.behavior === "deny" && toolName !== "AskUserQuestion") return refuse(decision.message);
      return decision;
    };
    // An autonomous run's whole gate, as a hook too. canUseTool is only asked about a call nothing has
    // allowed yet: a read, an edit under acceptEdits, or anything a settings file pre-allows — the
    // project's own `.claude/settings.json` saying `Bash(git:*)` — goes ahead without it, and with
    // that went the sandbox and the blocked list. Hooks run for every tool call, whatever decided the
    // permission (D187, and D20 for the same trap in supervised runs).
    const autonomousGuard: HookCallbackMatcher[] = [
      {
        hooks: [
          async (hookInput) => {
            const h = hookInput as { tool_name?: string; tool_input?: Record<string, unknown> };
            const name = h.tool_name ?? "";
            const input = h.tool_input ?? {};
            const deny = (message: string) => ({
              hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: message },
            });
            // The board's own tools are always allowed, and a question is answered in canUseTool's own words.
            // The board's own picture tool too: it saves inside the task's folder, and an autonomous run makes
            // pictures freely (D262) — without this the gate below refused it as an outside tool (D297).
            if (name.startsWith("mcp__board__") || name === QUESTION_TOOL || name.startsWith(IMAGE_PREFIX)) return {};
            const outright = refusedOutright(String(input.command ?? ""));
            if (outright) return deny(outright);
            if (handsOff) {
              const decision = handsOffDecision(name, input);
              return decision.behavior === "deny" ? deny(decision.message) : {};
            }
            const keys = printsKeys(name, input);
            if (keys) return deny(keys);
            const browser = browserDecision(name, input, true, a.cwd, browserDir, browserReach);
            if (browser?.behavior === "allow") return {};
            if (browser?.behavior === "deny") return deny(refuse(browser.message).message);
            const decision = autonomousGate(name, input, a.cwd, readRoots, { markitdown: settings.markitdownInTasks, folder: inFolder });
            if (decision.behavior === "deny") return deny(refuse(decision.message).message);
            const written = PATH_KEYS[name] ? input[PATH_KEYS[name]] : undefined;
            if (typeof written === "string") {
              const rel = relInside(a.cwd, written);
              // Two tasks in one folder: the second to reach a file waits its turn on it (D400). Not a
              // sandbox refusal, so it never counts toward the stop after five.
              const other = rel && inFolder ? this.writtenByOther(task, rel) : null;
              if (other) {
                this.log(run.id, `
[board] ${rel} is being changed by "${other.title}"; this write waits.
`);
                const when = this.pipelines.has(other.id) ? "is changing" : "changed, and is waiting to be approved,";
                return deny(`"${other.title}" ${when} ${rel} in the same folder. Do the parts of your task that don't need this file first; if nothing else is left, finish and say in your summary that ${rel} still needs this change.`);
              }
              this.noteWrite(task, a.cwd, written);
            }
            return {};
          },
        ],
      },
    ];
    // Settings → Browser for tasks → Your Chrome gives every run your signed-in Chrome, autonomous ones too (D389).
    const chrome = settings.taskBrowser === "chrome" || (settings.chromeInSupervised && !autonomous);
    const steer = this.steerHooks(task.id, run.id);

    // Claude's fast mode, per stage. Only Opus 5 / 4.8 support it; on anything else the flag is not
    // sent at all, so a stage moved to a cheaper model does not start failing.
    const fast = Boolean(task.pipeline[run.stage_index]?.fast) && supportsFastMode(run.model);
    // The board browser starts from its own copy of the profile you signed in to, when there is one (D389).
    const signedIn = visual && settings.browserChecks && settings.taskBrowser === "board" && copyProfile(join(settings.stateDir, BOARD_PROFILE), join(browserDir, "profile"));
    const browserConfig = visual && settings.browserChecks ? browserServer(browserDir, pickBrowser(realProbe)?.browser, watchPort, signedIn ? join(browserDir, "profile") : undefined) : null;
    // Helpers are Claude models picked by name; another provider's endpoint would not know them.
    const helpers = foreign ? {} : helperAgents({ browser: browserConfig, browserModel: settings.browserCheckModel, stageModel: run.model });
    const browserByHelper = BROWSER_AGENT in helpers;
    // Measured before deciding (D272): leaving connectors and plugin servers out of autonomous stages
    // saved under 1% of a stage's start, because Claude Code only loads a tool when it is searched
    // for. A critique still gets nothing but the project: it reads a plan, it does not do the work.
    const lean = critic;
    const baseOptions: Options = {
      model: run.model,
      effort: run.effort,
      cwd: a.cwd,
      ...(fast ? { settings: { fastMode: true } } : {}),
      // "project" always loads (CLAUDE.md and project skills are part of the repo). "user" pulls in
      // your global plugins and hooks — measured at ~5,400 extra input tokens on every single stage.
      // A critique reads the plan and the code; your plugins and skills are for doing the work.
      settingSources: settings.loadUserPlugins && !critic ? ["user", "project"] : ["project"],
      skills: critic ? [] : this.enabledSkills(a.project, task),
      ...(lean ? { strictMcpConfig: true } : {}),
      ...(Object.keys(helpers).length ? { agents: helpers } : {}),

      // A lookup edits nothing, so there are no edits to accept: every call goes to its gate.
      permissionMode: autonomous && !handsOff ? "acceptEdits" : "default",
      canUseTool,
      hooks: {
        PreToolUse: autonomous ? autonomousGuard : forceAsk(settings.autoAllowReadOnly, a.cwd),
        // A message typed while the stage runs is handed over at the next tool call (D215).
        PostToolUse: steer.PostToolUse,
        // A waiting message holds the turn open first; then the deterministic gate: a code stage
        // can't end while the project's own check fails.
        Stop: [...steer.Stop, ...(a.verifyCommand ? this.verifyStopHook(a.verifyCommand, a.cwd, run.id, task.id, (ok) => (verifiedAtStop = ok)) : [])],
      },
      env: {
        ...process.env,
        KANBAN_PORT: String(await this.portFor(task.id)),
        KANBAN_TASK_ID: task.id,
        // Never the board's own: see taskStateDir.
        KANBAN_STATE_DIR: taskStateDir(task.id),
        // Opus 5 delegates to subagents readily; bound the blast radius of an unattended run.
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(settings.maxSubagentDepth),
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(settings.maxConcurrentSubagents),
        // Newer models ship with their to-do tools switched off; the card's checklist is read from them.
        CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
        // The sandbox reads every command as starting in the task's folder. Claude Code's shell keeps the
        // folder a `cd` moved it to, so `../x` after `cd scripts` was refused as leaving it (D390).
        ...(autonomous ? { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1" } : {}),
        // Claude Code's own memory is per repository and shared with your own sessions; left on, a run
        // reads notes the board cannot show you (D306). When it is allowed, your own choice still stands.
        ...(settings.claudeAutoMemory ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
        ...(lean ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {}),
      },
      // Keeps the system prompt static so it can be cached across sessions; the stripped
      // dynamic parts (cwd, git status) are re-injected as the first user message.
      systemPrompt: settings.cacheableSystemPrompt ? { type: "preset", preset: "claude_code", excludeDynamicSections: true } : undefined,
      mcpServers: {
        board: createBoardServer(this.repo, this.bus, { taskId: task.id, runId: run.id }, (parent) => this.promoteReady(parent.project_id)),
        ...(browserConfig && !browserByHelper ? { [BROWSER_SERVER]: browserConfig } : {}),
        // Pictures are made while building; a plan, a review or a critique has no use for them.
        ...(pictures
          ? { [IMAGE_SERVER]: createImageServer({ cwd: a.cwd, config: () => this.imageConfig(), fetchFn: this.imageFetch, onImage: (i) => this.keepImage(task.id, run.id, i) }) }
          : {}),
      },
      // Claude in Chrome is switched on per run, and explicitly off otherwise: an unattended run must
      // never drive the browser you are signed in with.
      extraArgs: chrome ? { chrome: null } : { "no-chrome": null },
      disallowedTools: [...ALWAYS_DISALLOWED, PLAYWRIGHT_PLUGIN_TOOLS, ...(a.disallowedTools ?? [])],
      // Only a real Claude Code session can be continued; HTTP and CLI runs start over (D127).
      resume: res.adapter.canResume ? a.resume : undefined,
      ...(a.forkSession && a.resume && res.adapter.canResume ? { forkSession: true } : {}),
      abortController: abort,
      // Ceilings so an unattended run can't loop forever or burn the budget (docs/DECISIONS.md D25).
      maxTurns: critic ? Math.min(20, settings.maxTurnsPerStage) : settings.maxTurnsPerStage,
      maxBudgetUsd: critic ? Math.min(1, settings.maxCostPerStageUsd) : settings.maxCostPerStageUsd,
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

    // The run as it stands now, read once: the loop below keeps its own copy of what it changes, so a
    // streamed message costs one insert rather than an insert and three or four reads.
    const row = this.repo.getRun(run.id) ?? run;
    // The subscription window is what actually runs out, so note where it stood before this stage.
    const before = foreign ? null : this.fiveHourUtilization();
    let limitBefore = row.limit_before;
    if (before !== null && limitBefore === null) {
      limitBefore = before;
      this.setRun(run.id, { limit_before: before });
    }
    let sessionId = row.session_id;
    let contextTokens = row.context_tokens ?? 0;
    let contextWrittenAt = 0;
    const capture: CaptureState = { left: MAX_ARTIFACTS_PER_RUN - this.repo.countAttachments(task.id, run.id), tools: new Map() };
    // The SDK cannot price a foreign model id (it guesses a Claude price), so its budget ceiling is
    // switched off for those; the board meters a foreign stage itself from the usage each turn reports (D124).
    // The same sums stand in for the run's cost and tokens when it ends with no result to read them from.
    let metered = 0;
    let meteredSource: Run["cost_source"] | null = null;
    let meteredIn = 0;
    let meteredOut = 0;
    // One reply arrives as several messages, one per block, each repeating the reply's whole usage.
    const countedReplies = new Set<string>();

    // Claude's own to-do list for this stage, shown on the card. A continued session keeps its list
    // (its task numbers carry on); a fresh one starts with none.
    const listed = this.repo.getTask(task.id)?.checklist ?? [];
    let checklist = a.resume ? listed : [];
    if (!a.resume && listed.length) this.setTask(task.id, { checklist });

    // A stage that calls the same tool with the same arguments over and over is stuck, not working.
    const repeats = { key: "", count: 0 };
    let loopStopped = false;

    let result: { ok: boolean; text: string | null; error: string | null; cost: number; inTok: number; outTok: number; cacheRead: number; cacheWrite: number; otherUsd: number } | null = null;
    let thrown: string | null = null;
    let budgetStop = false;
    let turnLimit = false;
    try {
      for await (const msg of stream) {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && sessionId !== sid) {
          sessionId = sid;
          this.setRun(run.id, { session_id: sid });
        }
        const event = this.repo.insertEvent(run.id, eventType(msg), msg);
        this.bus.publish({ type: "event", runId: run.id, taskId: task.id, event });

        // How full the session's context is right now (what Claude Code shows as the context bar).
        if (msg.type === "assistant") {
          for (const block of (msg.message?.content ?? []) as { type: string; name?: string; input?: Record<string, unknown> }[]) {
            // Anything it does after the check passed may have undone it.
            if (block.type === "tool_use") verifiedAtStop = false;
            // A subagent keeps a list of its own; only the stage's list belongs on the card.
            if (block.type === "tool_use" && block.name && !(msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
              const next = applyChecklistTool(checklist, block.name, block.input);
              if (next) {
                checklist = next;
                this.setTask(task.id, { checklist });
              }
            }
            const caption = block.type === "tool_use" && block.name ? browserCaption(block.name, block.input ?? {}) : null;
            if (caption) this.browserWatch.action(task.id, caption, typeof block.input?.url === "string" ? block.input.url : undefined);
          }
          const u = msg.message?.usage;
          if (u) {
            const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            const held = inTok + (u.output_tokens ?? 0);
            if (held > contextTokens) {
              contextTokens = held;
              // It grows with nearly every message, and each write is broadcast to every open board:
              // about once a second is as often as anyone can read it. The last value goes out with the run.
              if (Date.now() - contextWrittenAt >= CONTEXT_UPDATE_MS) {
                contextWrittenAt = Date.now();
                this.setRun(run.id, { context_tokens: held });
              }
            }
            const replyId = (msg.message as { id?: unknown }).id;
            const counted = typeof replyId === "string" && countedReplies.has(replyId);
            if (typeof replyId === "string") countedReplies.add(replyId);
            if (!counted) {
              meteredIn += inTok;
              meteredOut += u.output_tokens ?? 0;
            }
            if (!counted && foreign && res.provider) {
              const priced = estimateCost(res.provider, run.model, {
                inputTokens: u.input_tokens ?? 0, cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
              }, this.catalog.priceOf(res.provider, run.model));
              metered += priced.usd;
              meteredSource = priced.source;
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
        if (!loopStopped && this.countRepeats(msg, repeats, settings.maxRepeatedToolCalls)) {
          loopStopped = true;
          this.log(run.id, `
[board] stopped: the same tool call was repeated ${repeats.count} times.
`);
          thrown = `Stopped after the same tool call was repeated ${repeats.count} times — the session was looping, not progressing.`;
          abort.abort();
          // Stop consuming immediately: a session that ignores the abort would otherwise keep going.
          break;
        }
        this.captureImages(msg, task.id, run.id, a.cwd, capture);
        // Usage windows are Claude's subscription; a foreign endpoint's numbers mean nothing here.
        if (msg.type === "rate_limit_event" && !foreign) {
          this.recordRateLimit(msg as unknown as { rate_limit_info?: RateLimitInfo });
          const after = this.fiveHourUtilization();
          if (after !== null) {
            this.setRun(run.id, { limit_after: after, ...(limitBefore === null ? { limit_before: after } : {}) });
            limitBefore ??= after;
          }
        }
        if (msg.type === "result") {
          const r = msg as Extract<SDKMessage, { type: "result" }>;
          let inTok = 0;
          let outTok = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          // Anything not billed to the stage's own model: its helpers, and Claude Code's small calls.
          let otherUsd = 0;
          for (const [model, u] of Object.entries(r.modelUsage ?? {})) {
            inTok += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
            outTok += u.outputTokens ?? 0;
            cacheRead += u.cacheReadInputTokens ?? 0;
            cacheWrite += u.cacheCreationInputTokens ?? 0;
            if (model.replace(/\[1m\]$/i, "") !== run.model) otherUsd += u.costUSD ?? 0;
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
            cacheRead,
            cacheWrite,
            otherUsd: foreign ? 0 : otherUsd,
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

    const error = a.ctl.stopped
      ? "stopped by user"
      : blockedByBoard
        ? `blocked: ${blockedByBoard}`
        : result && !result.ok ? result.error : result ? null : thrown ?? "run ended without a result";
    const prev = this.repo.getRun(run.id)!;
    const add = a.accumulate ? prev : { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, other_models_usd: 0 };
    // A run stopped part-way — by the board's own meter, a Stop, the loop guard — ends with no result
    // to read its cost from. Recording $0 hid exactly the spend the task ceiling exists to catch, so
    // what was metered on the way stands in. (Claude's own runs have no price table here: tokens only.)
    const unpriced = !result && foreign && meteredSource;
    const finished = this.repo.updateRun(run.id, {
      status: error ? "failed" : "success",
      ended_at: nowIso(),
      cost_usd: add.cost_usd + (result?.cost ?? (foreign ? metered : 0)),
      input_tokens: add.input_tokens + (result?.inTok ?? meteredIn),
      output_tokens: add.output_tokens + (result?.outTok ?? meteredOut),
      cache_read_tokens: add.cache_read_tokens + (result?.cacheRead ?? 0),
      cache_write_tokens: add.cache_write_tokens + (result?.cacheWrite ?? 0),
      other_models_usd: add.other_models_usd + (result?.otherUsd ?? 0),
      result_md: result?.text ?? prev.result_md,
      context_tokens: contextTokens,
      ...(unpriced ? { cost_source: unpriced } : {}),
      ...(prev.explore_weight === null && prev.role === "stage" && prev.stage !== "plan" && prev.stage !== "review" && !error
        ? { explore_weight: Math.round(splitAtFirstEdit(this.repo.assistantMessages(run.id)).beforeEdit) }
        : {}),
      error,
    });
    this.bus.publish({ type: "run.finished", run: finished });
    return {
      ok: !error, error, providerId: res.id, budgetStop: budgetStop && !a.ctl.stopped, turnLimit: turnLimit && !a.ctl.stopped,
      verifiedAtStop: verifiedAtStop && !error,
    };
  }

  /**
   * Live steering (D215): a message posted while a stage runs is handed to Claude at its next tool
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
  private verifyStopHook(command: string, cwd: string, runId: string, taskId: string, onResult: (ok: boolean) => void): HookCallbackMatcher[] {
    return [
      {
        hooks: [
          async () => {
            const res = await runProjectCommand(command, cwd, { env: this.commandEnv(taskId), timeoutMs: 10 * 60_000 });
            onResult(res.ok);
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
  private async landBranch(project: Project, task: Task): Promise<"landed" | "resolving"> {
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
          if (policy.onConflict === "claude" && this.mayResolveAgain(task)) {
            this.beginResolution(task, base, true);
            return "resolving";
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
      this.resolveRounds.delete(task.id);
      return "landed";
    } finally {
      release();
    }
  }

  /**
   * A base that keeps moving while Claude resolves could send Approve round and round: each landing
   * finds a fresh conflict. After a few rounds in one approval, the conflict is handed back to you.
   */
  private mayResolveAgain(task: Task): boolean {
    const rounds = (this.resolveRounds.get(task.id) ?? 0) + 1;
    if (rounds > MAX_RESOLVE_ROUNDS) {
      this.resolveRounds.delete(task.id);
      return false;
    }
    this.resolveRounds.set(task.id, rounds);
    return true;
  }

  /**
   * Hand a conflict to the session that wrote the task, in its own worktree (D107, D355). The task is
   * held busy from here, synchronously, so nothing else can start on it; the work itself runs after
   * the caller's hold is released. `landAfter`: Approve started it, so a resolution that passes
   * every check finishes that approval — when the project allows (`autoLandResolved`).
   */
  private beginResolution(task: Task, base: string, landAfter: boolean): Task {
    const ctl: PipelineCtl = { stopped: false };
    this.pipelines.set(task.id, ctl); // counts as a pipeline, so Stop works and nothing else starts
    const resolution: Resolution = {
      state: "resolving", base, base_sha: "", conflicts: [], others: [], attempt: 0, max_attempts: RESOLVE_ATTEMPTS, land_after: landAfter,
      checks: [], lost: [], outside: [], verdict: null, review: null, report: null, error: null, started_at: nowIso(), finished_at: null,
    };
    const t = this.setTask(task.id, { status: "running", resolution, conflict_risk: null, error: null, note: `"${base}" has moved on and conflicts with this task. Claude is resolving it in the task's own worktree — your checkout is untouched.` });
    setImmediate(() => {
      void tracked(this.repo.getProject(task.project_id)?.path, this.runResolution(task.id, ctl)).catch((err) => {
        // Nothing awaits this: a throw here would end the whole board.
        this.failTask(task.id, `The conflict could not be handled: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    return t;
  }

  private async runResolution(taskId: string, ctl: PipelineCtl): Promise<void> {
    const { task, project } = this.load(taskId);
    const wt = task.worktree_path!;
    let r = task.resolution!;
    const save = (patch: Partial<Resolution>) => {
      r = { ...r, ...patch };
      this.setTask(taskId, { resolution: r });
    };
    const message = `Merge ${r.base} into ${task.branch}: ${task.title}`;
    let pre: string | null = null;
    let outcome = "failed" as "resolved" | "failed";
    let why = "";
    try {
      await this.git.commitAll(wt, `kanban: ${task.title}`);
      pre = await this.git.headSha(wt);
      if (!pre) throw new Error("the task's branch has no commit to start from");
      const baseSha = await this.git.revParse(project.path, r.base);
      await this.git.setRef(wt, preResolveRef(taskId), pre);
      const preview = await this.git.previewMerge(wt, pre, baseSha);
      const landed = await this.otherSide(task, r.base);
      save({ base_sha: baseSha, conflicts: preview.conflicts, others: landed.map((o) => o.title) });

      let problems: string[] = [];
      for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS && outcome !== "resolved"; attempt++) {
        if (ctl.stopped) break;
        save({ state: "resolving", attempt, checks: [], lost: [], outside: [], verdict: null, review: null, report: null });
        const conflicts = await this.git.startResolveMerge(wt, baseSha, message);
        if (!conflicts.length) {
          // The base moved again and no longer conflicts: git merged it, and its merge needs no judging.
          save({ checks: [{ id: "history", ok: true, detail: `"${r.base}" no longer conflicts with this task; git merged it cleanly.` }] });
          outcome = "resolved";
          break;
        }
        const turn = await this.sessionTurn(taskId, buildResolvePrompt({ branch: task.branch ?? "", base: r.base, baseSha, conflicts, landed, problems }), ctl);
        if (!turn.ok) {
          why = ctl.stopped ? "Stopped by you." : `Claude could not finish the resolution: ${turn.error ?? "no result"}.`;
          await this.git.rollbackResolution(wt, pre);
          break;
        }
        save({ state: "checking", report: turn.report });
        await this.git.finishResolveMerge(wt, message);
        const judged = await this.judgeResolution(project, task, wt, { pre, baseSha, previewTree: preview.tree, conflicts, landed, report: turn.report }, (state) => save({ state }), ctl);
        save(judged);
        // A Stop during the checks cuts the review short, and an unreviewed resolution is not a pass.
        if (ctl.stopped) {
          await this.git.rollbackResolution(wt, pre);
          break;
        }
        if (judged.checks.every((c) => c.ok)) {
          outcome = "resolved";
          break;
        }
        await this.git.rollbackResolution(wt, pre);
        problems = problemsFrom(judged.checks, judged.review);
        why = `It did not pass the board's checks after ${attempt} ${attempt === 1 ? "try" : "tries"}: ${problems[0] ?? "see the checks"}`;
      }
      if (ctl.stopped && outcome !== "resolved") why = "Stopped by you.";
    } catch (err) {
      why = `The conflict could not be handled: ${err instanceof Error ? err.message : String(err)}`;
      if (pre) await this.git.rollbackResolution(wt, pre).catch(() => undefined);
    } finally {
      await this.git.setRef(wt, preResolveRef(taskId), null).catch(() => undefined);
      this.pipelines.delete(taskId);
    }

    if (outcome !== "resolved") {
      this.resolveRounds.delete(taskId);
      save({ state: "failed", error: why, finished_at: nowIso() });
      this.setTask(taskId, {
        status: "review",
        note: `${why} Nothing was merged and the task's branch is back as it was. Open the worktree at ${wt} to resolve it yourself, or use Follow-up to redo the work on the current code.`,
      });
      return;
    }
    save({ state: "resolved", finished_at: nowIso() });
    const landNow = r.land_after && project.merge.autoLandResolved;
    this.setTask(taskId, {
      status: "review",
      note: landNow
        ? `Claude resolved the conflict with "${r.base}" and every check passed. Landing it now.`
        : `Claude resolved the conflict with "${r.base}" and every check passed. Approve to land it.`,
    });
    if (!landNow) return;
    try {
      await this.approveTask(taskId);
    } catch (err) {
      this.setTask(taskId, { note: `Claude resolved the conflict and every check passed, but landing it failed: ${err instanceof Error ? err.message : String(err)} Approve again once that is sorted.` });
    }
  }

  /**
   * The board's own checks on a committed resolution, then the project's verify command, then a
   * second model. Anything a line-by-line check cannot settle — a line rewritten to combine both
   * sides, a file touched outside the conflict — passes only when the reviewer says nothing was lost.
   */
  private async judgeResolution(
    project: Project, task: Task, wt: string,
    a: { pre: string; baseSha: string; previewTree: string; conflicts: string[]; landed: OtherSide[]; report: string },
    stage: (s: Resolution["state"]) => void, ctl: PipelineCtl,
  ): Promise<Pick<Resolution, "checks" | "lost" | "outside" | "verdict" | "review">> {
    const f = await this.git.checkResolution(wt, a);
    const failed = new Map(f.hard.map((h) => [h.id, h.detail]));
    const checks: ResolutionCheck[] = [
      { id: "history", ok: !failed.has("history"), detail: failed.get("history") ?? "Both histories are in the merge." },
    ];
    if (failed.has("history")) return { checks, lost: [], outside: [], verdict: null, review: null };
    checks.push(
      { id: "markers", ok: !failed.has("markers"), detail: failed.get("markers") ?? "No conflict markers are left." },
      {
        id: "files", ok: !failed.has("files"),
        detail: failed.get("files") ?? (f.outside.length ? `Changed outside the conflict: ${f.outside.join(", ")} — the reviewer judged these.` : "Every file outside the conflict matches git's own merge."),
      },
    );
    const lostCount = f.lost.reduce((n, l) => n + l.lines.length, 0);
    const linesCheck: ResolutionCheck = {
      id: "lines", ok: lostCount === 0,
      detail: lostCount ? `${lostCount} line${lostCount === 1 ? "" : "s"} a side added ${lostCount === 1 ? "is" : "are"} not in the result word for word — the reviewer judged ${lostCount === 1 ? "it" : "them"}.` : "Every line either side added is still there.",
    };
    checks.push(linesCheck);
    const result = (verdict: Resolution["verdict"] = null, review: string | null = null) => ({ checks, lost: f.lost, outside: f.outside, verdict, review });
    if (f.hard.length || ctl.stopped) return result();

    const runId = this.repo.latestRun(task.id)?.id ?? "";
    if (project.merge.verifyBeforeMerge && project.env.verifyCommand?.trim()) {
      const res = await this.verifyWorkspace(project, task, wt, runId);
      if (res && !res.ok) {
        checks.push({ id: "verify", ok: false, detail: `The project's verify command fails on the combined code:\n${res.output.slice(-1500)}` });
        return result();
      }
      checks.push({ id: "verify", ok: true, detail: "The project's verify command passes on the combined code." });
    }
    if (ctl.stopped) return result();

    stage("reviewing");
    const review = await this.reviewResolution(project, task, wt, { ...a, lost: f.lost, outside: f.outside }, ctl);
    const judgement = f.lost.length > 0 || f.outside.length > 0;
    if (review.verdict === "kept") {
      linesCheck.ok = true;
      checks.push({ id: "review", ok: true, detail: `A second look (${review.model}) found nothing from either side lost.` });
    } else if (review.verdict === "lost") {
      checks.push({ id: "review", ok: false, detail: `A second look (${review.model}) found something lost.` });
    } else {
      // No verdict: fine only when nothing needed the reviewer's judgement in the first place.
      checks.push({ id: "review", ok: !judgement, detail: `The second look gave no verdict${review.error ? ` (${review.error})` : ""}${judgement ? ", and some changes needed one." : "; nothing needed its judgement."}` });
    }
    return result(review.verdict, review.text);
  }

  /** A second model reads both sides and the result, and says whether anything was lost (D357). */
  private async reviewResolution(
    project: Project, task: Task, wt: string,
    a: { pre: string; baseSha: string; conflicts: string[]; landed: OtherSide[]; report: string; lost: Resolution["lost"]; outside: string[] },
    ctl: PipelineCtl,
  ): Promise<{ verdict: Resolution["verdict"]; text: string | null; model: string; error: string | null }> {
    const last = this.repo.latestRun(task.id);
    const who = project.merge.resolveReviewer ?? { provider: last?.provider ?? ANTHROPIC_PROVIDER_ID, model: last?.model ?? task.pipeline[0]?.model ?? "", effort: last?.effort ?? "medium" };
    try {
      const mb = await this.git.mergeBase(wt, a.pre, a.baseSha);
      const files = [...new Set([...a.conflicts, ...a.outside])];
      const run = this.repo.createRun({
        task_id: task.id, stage: last?.stage ?? "code", stage_index: last?.stage_index ?? 0, model: who.model, effort: who.effort, role: "critic",
        provider: who.provider && who.provider !== ANTHROPIC_PROVIDER_ID ? who.provider : null,
      });
      this.bus.publish({ type: "run.updated", run });
      const prompt = buildReviewPrompt({
        title: task.title, goal: task.summary || task.spec_md, base: task.resolution?.base ?? "", landed: a.landed, conflicts: a.conflicts,
        taskSide: await this.git.diffFiles(wt, mb, a.pre, files),
        baseSide: await this.git.diffFiles(wt, mb, a.baseSha, files),
        result: await this.git.diffFiles(wt, mb, "HEAD", files),
        lost: a.lost, outside: a.outside, report: a.report,
      });
      const outcome = await this.runQuery({ task, project, run, cwd: wt, ctl, stageStatus: "running", disallowedTools: PLAN_DISALLOWED, verifyCommand: null, prompt });
      const text = this.repo.getRun(run.id)?.result_md ?? null;
      return { verdict: outcome.ok ? parseReviewVerdict(text) : null, text, model: who.model, error: outcome.ok ? null : outcome.error };
    } catch (err) {
      return { verdict: null, text: null, model: who.model, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * One turn in the session that wrote the task, awaited — the resolution's own version of a chat
   * message. The stage's result stays the stage's: the turn's reply is returned, not kept as the result.
   */
  private async sessionTurn(taskId: string, text: string, ctl: PipelineCtl): Promise<{ ok: boolean; error: string | null; report: string }> {
    const { task, project } = this.load(taskId);
    const last = this.repo.workRun(taskId);
    if (!last) return { ok: false, error: "the task has no run to continue", report: "" };
    // A provider that cannot continue a session starts a fresh one in the same worktree: the prompt
    // carries what it needs, and a resolution without the history beats none.
    const resume = last.session_id && this.providers.resolve(last.provider).adapter.canResume ? last.session_id : undefined;
    const before = { status: last.status, error: last.error, ended_at: last.ended_at, result_md: last.result_md };
    const run = this.setRun(last.id, { status: "running", error: null, ended_at: null });
    const event = this.repo.insertEvent(run.id, "user:chat", { type: "user_chat", text, board: true });
    this.bus.publish({ type: "event", runId: run.id, taskId, event });
    const outcome = await this.runQuery({ task, project, run, cwd: task.worktree_path!, ctl, prompt: text, resume, stageStatus: "running", accumulate: true, verifyCommand: null });
    const report = outcome.ok ? (this.repo.getRun(run.id)?.result_md ?? "") : "";
    // Cost stays added to the run; its status and result go back to being the stage's.
    this.setRun(run.id, before);
    return { ok: outcome.ok, error: outcome.error, report };
  }

  /** What landed on the base since this task split from it, with each board task's goal (D354). */
  private async otherSide(task: Task, base: string): Promise<OtherSide[]> {
    try {
      const landed = await this.git.landedSince(task.worktree_path!, base);
      return landed.map((l) => {
        const other = l.taskId ? this.repo.getTask(l.taskId) : undefined;
        return { title: other?.title ?? l.title, goal: other ? other.summary || other.spec_md : null };
      });
    } catch {
      // Context only: a resolver without it is the one this board had before, not a reason to stop.
      return [];
    }
  }

  /** After a restart: roll an interrupted resolution back to the branch's saved starting point. */
  private async abandonResolution(task: Task): Promise<void> {
    if (!task.worktree_path || !existsSync(task.worktree_path)) return;
    const ref = preResolveRef(task.id);
    const pre = await this.git.revParse(task.worktree_path, ref).catch(() => null);
    if (pre) {
      await this.git.rollbackResolution(task.worktree_path, pre);
      await this.git.setRef(task.worktree_path, ref, null);
    }
    this.setTask(task.id, { status: "review", error: null, note: "The board restarted while Claude was resolving a conflict. The task's branch is back as it was; Approve or Fix now to try again." });
  }

  /**
   * Fix now (D359): resolve a conflict the board has foreseen, before anyone approves. It never lands
   * by itself — nobody has approved this task yet.
   */
  async resolveConflict(taskId: string): Promise<Task> {
    return this.hold(taskId, async () => {
      const { task, project } = this.load(taskId);
      if (!task.branch || !task.worktree_path || !existsSync(task.worktree_path)) throw new ConflictError("This task has no worktree, so there is nothing to merge.");
      if (!["review", "failed", "backlog"].includes(task.status)) throw new ConflictError("Wait for the task to finish before resolving its conflict.");
      const base = project.merge.baseBranch?.trim() || (await this.git.currentBranch(project.path));
      await this.git.commitAll(task.worktree_path, `kanban: ${task.title}`);
      const preview = await this.git.previewMerge(task.worktree_path, "HEAD", base);
      if (preview.clean) {
        // Nothing to resolve after all (the base moved again): bring it in now, it is cheap and safe.
        const res = await this.git.updateFromBase(task.worktree_path, base, "merge");
        return this.setTask(taskId, { conflict_risk: null, note: res.pulled ? `No conflict with "${base}" any more — brought its ${res.pulled} new commit${res.pulled === 1 ? "" : "s"} in.` : `No conflict with "${base}".` });
      }
      // The lookup above shows the busy check passed; the pipeline marker set next keeps it busy.
      return this.beginResolution(task, base, false);
    });
  }

  /**
   * Which unfinished tasks in a project would conflict with its base if landed now (D359). Read-only:
   * asked of git's object store, so a task that is running is never disturbed.
   */
  async refreshConflictRisk(projectId: string, onlyTaskId?: string): Promise<void> {
    const project = this.repo.getProject(projectId);
    if (!project || !existsSync(project.path)) return;
    let base: string;
    try {
      base = project.merge.baseBranch?.trim() || (await this.git.currentBranch(project.path));
    } catch {
      return;
    }
    const tasks = this.repo.listTasks({ project_id: projectId }).filter((t) => t.branch && t.worktree_path && t.status !== "done" && (!onlyTaskId || t.id === onlyTaskId));
    for (const t of tasks) {
      if (t.resolution && ["resolving", "checking", "reviewing"].includes(t.resolution.state)) continue;
      try {
        const preview = await this.git.previewMerge(project.path, t.branch!, base);
        const risk: ConflictRisk | null = preview.clean ? null : { base, files: preview.conflicts, checked_at: nowIso() };
        const fresh = this.repo.getTask(t.id);
        if (fresh && JSON.stringify(fresh.conflict_risk?.files ?? null) !== JSON.stringify(risk?.files ?? null)) this.setTask(t.id, { conflict_risk: risk });
      } catch {
        // A branch git cannot read right now is simply not warned about.
      }
    }
  }

  /** What the project's verify command runs with: the task's port, and a state folder that is not the board's. */
  private commandEnv(taskId: string): Record<string, string> {
    return { KANBAN_PORT: String(this.ports.get(taskId) ?? 0), KANBAN_STATE_DIR: taskStateDir(taskId) };
  }

  /** Board-side verification after a stage: the record of record for whether the work is good. */
  private async verifyWorkspace(project: Project, task: Task, cwd: string, runId: string, passedAtStop = false): Promise<{ ok: boolean; output: string } | null> {
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
    // The session's own Stop hook ran this very command as the stage ended, and no tool has run
    // since. That pass never reached the cache above (the tree was not committed yet), so the board
    // used to run the whole suite again seconds later. It counts, and is remembered for landing.
    if (passedAtStop) {
      if (fingerprint) this.verified.set(task.id, fingerprint);
      return { ok: true, output: `$ ${command}\n(passed as the stage ended — not run a second time)` };
    }
    const res = await runProjectCommand(command, cwd, { env: this.commandEnv(task.id), timeoutMs: 10 * 60_000 });
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
  /** Settings → Images as the tool reads them: the provider, its keys from the secret store, and Codex when it makes pictures. */
  async imageConfig(): Promise<ImageConfig> {
    const s = this.repo.getSettings();
    return {
      provider: s.imageProvider,
      pollinationsKey: this.secrets.get(POLLINATIONS_KEY_REF),
      cloudflareAccountId: s.cloudflareAccountId,
      cloudflareToken: this.secrets.get(CLOUDFLARE_TOKEN_REF),
      codex: await codexImagePart(s, this.secrets, (works, detail, version) => this.rememberCodexPictures(works, detail, version)),
    };
  }

  /** Whether the picture maker in Settings → Images can make a picture now (D303). */
  async picturesReady(): Promise<boolean> {
    return imageReadiness(await this.imageConfig()).ready;
  }

  /** What a try taught about Codex making pictures with this version, kept so a computer where it cannot is not asked every time (D297). */
  rememberCodexPictures(works: boolean | null, detail: string, version: string | null): void {
    const settings = this.repo.updateSettings({ codexPictures: { works, version, detail, checked_at: works === null ? null : nowIso() } });
    this.bus.publish({ type: "settings.updated", settings });
  }

  /** What Settings → Images shows: which keys are set (never their values) and whether an image would come. */
  async imageStatus(): Promise<ImageStatus> {
    const cfg = await this.imageConfig();
    const s = this.repo.getSettings();
    const st = await codexStatus();
    return {
      provider: cfg.provider, cloudflareAccountId: cfg.cloudflareAccountId,
      hasPollinationsKey: Boolean(cfg.pollinationsKey), hasCloudflareToken: Boolean(cfg.cloudflareToken),
      ...imageReadiness(cfg), claudeCodeCommand: claudeCodeCommand(),
      codex: { found: st.found, signedIn: st.signedIn, version: st.version, pictures: s.codexPictures, model: cfg.codex?.model ?? s.imageModel },
    };
  }

  /** Settings → Images → Try it: one small image from exactly what is set, handed back inline. */
  async testImage(prompt: string): Promise<{ ok: boolean; dataUrl: string | null; provider: string; latencyMs: number; error: string | null }> {
    const t0 = Date.now();
    const cfg = await this.imageConfig();
    const ready = imageReadiness(cfg);
    if (!ready.ready) return { ok: false, dataUrl: null, provider: cfg.provider, latencyMs: 0, error: ready.detail };
    try {
      const img = await generateImage({ prompt, width: 512, height: 512 }, cfg, { fetchFn: this.imageFetch });
      return { ok: true, dataUrl: `data:image/${img.format};base64,${Buffer.from(img.bytes).toString("base64")}`, provider: img.provider, latencyMs: Date.now() - t0, error: null };
    } catch (e) {
      return { ok: false, dataUrl: null, provider: cfg.provider, latencyMs: Date.now() - t0, error: (e as Error).message };
    }
  }

  /** A generated image is kept on the card too, so you see it without opening the folder. */
  private keepImage(taskId: string, runId: string, info: { path: string; prompt: string; provider: string; bytes: number }): void {
    this.log(runId, `\n[board] generate_image → ${info.path} (${Math.round(info.bytes / 1024)} KB, ${info.provider})\n`);
    try {
      if (info.bytes > MAX_ATTACHMENT_BYTES) return;
      const stage = this.repo.getRun(runId)?.stage ?? "code";
      const at = saveAttachment(this.repo, { task_id: taskId, run_id: runId, source: "run", name: basename(info.path), data: readFileSync(info.path), note: `made with generate_image during the ${stage} stage: ${info.prompt.slice(0, 200)}` });
      this.bus.publish({ type: "attachment.added", attachment: at });
    } catch {
      // The file is in the project either way; the copy on the card is a convenience.
    }
  }

  private captureImages(msg: SDKMessage, taskId: string, runId: string, cwd: string, state: CaptureState): void {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    const stage = () => this.repo.getRun(runId)?.stage ?? "code";
    for (const block of content as Record<string, unknown>[]) {
      try {
        // A tool call is only announced here: nothing has run yet, and a supervised write is still
        // waiting on its card. Note what it is, and look at its file once its result comes back.
        if (block.type === "tool_use") {
          if (typeof block.id === "string" && typeof block.name === "string") state.tools.set(block.id, { name: block.name, file: artifactPath(block, cwd) });
          continue;
        }
        const use = block.type === "tool_result" ? state.tools.get(String(block.tool_use_id)) : undefined;
        if (block.type === "tool_result") state.tools.delete(String(block.tool_use_id));
        // Opening an image with Read is looking at a file that already exists (often one you attached),
        // not producing one: keeping it would file a copy of your own image as a "screenshot".
        if (use?.name === "Read") continue;
        // A screenshot handed back by a tool (browser MCP, image generation, …).
        for (const img of imageBlocks(block)) {
          if (state.left <= 0) break;
          const data = Buffer.from(img.data, "base64");
          if (!data.byteLength || data.byteLength > MAX_ATTACHMENT_BYTES) continue;
          const at = saveAttachment(this.repo, {
            task_id: taskId, run_id: runId, source: "run", name: `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`,
            media_type: img.media_type, data, note: `screenshot from the ${stage()} stage`,
          });
          state.left--;
          this.bus.publish({ type: "attachment.added", attachment: at });
        }
        // A file the session produced: a report, a spreadsheet, a page, a diagram. Source files are
        // deliberately not kept — they are already in the diff; these are the things that are not.
        const abs = use?.file;
        if (!abs || block.is_error === true || state.left <= 0 || !existsSync(abs)) continue;
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
            if (old.run_id === runId) state.left++;
          }
        }
        const at = saveAttachment(this.repo, { task_id: taskId, run_id: runId, source: "run", name: basename(abs), data, note: `written during the ${stage()} stage` });
        state.left--;
        this.bus.publish({ type: "attachment.added", attachment: at });
      } catch {
        // An image is a nice-to-have; never let it break the run.
      }
    }
  }

  /**
   * Counts identical consecutive tool calls. Documented runaway agents spend hours (and real money)
   * retrying one failing call; a bounded repeat count turns that into a clean, explained failure.
   */
  private countRepeats(msg: SDKMessage, state: { key: string; count: number }, limit: number): boolean {
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
      if (state.count >= limit) hit = true;
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
    // Two screens asking at once share one session instead of starting one each.
    return (this.fastChecking ??= this.checkFastMode().finally(() => (this.fastChecking = null)));
  }

  private fastChecking: Promise<FastModeStatus> | null = null;

  private async checkFastMode(): Promise<FastModeStatus> {
    const abort = new AbortController();
    const options: Options = {
      // Any Claude model answers the question; "opus" is whichever Opus is current.
      model: "opus", cwd: process.cwd(), maxTurns: 1, permissionMode: "dontAsk", ...LEAN,
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
    this.claudeListing ??= this.listClaudeModels()
      .then((r) => (this.followLatestModels(r), void this.followCodexModels(), r))
      .finally(() => (this.claudeListing = null));
    return (this.claudeList = await this.claudeListing);
  }

  /**
   * A newer model of a family your settings name (Opus 5 → Opus 5.5) replaces the older one in every
   * pick, as soon as your login lists it. Tasks already on the board keep the models they were given.
   */
  /**
   * The same for Codex (D298): when the account lists a newer model of a family a Codex pick names
   * (GPT-6 Luna → GPT-6.1 Luna), the pick moves and Settings says so. Tasks keep theirs.
   */
  async followCodexModels(): Promise<void> {
    try {
      const settings = this.repo.getSettings();
      if (!settings.followLatestModels || !settings.providers.some((p) => p.kind === "cli" && p.cli?.preset === "codex")) return;
      const rows = await codexModels("login");
      if (!rows?.length) return;
      const { moves, patch } = codexUpgrades(settings, rows);
      if (!moves.length) return;
      this.bus.publish({ type: "settings.updated", settings: this.repo.updateSettings({ ...patch, lastModelMove: { at: nowIso(), moves } }) });
      console.log(`Newer Codex models on your account: ${[...new Set(moves.map((m) => `${m.from} → ${m.to}`))].join(", ")}.`);
    } catch (err) {
      console.error("Could not move settings to newer Codex models:", err);
    }
  }

  private followLatestModels(list: ClaudeModelsResult): void {
    try {
      const settings = this.repo.getSettings();
      if (!settings.followLatestModels || list.source !== "live") return;
      const { moves, patch } = claudeUpgrades(settings, list);
      if (!moves.length) return;
      this.bus.publish({ type: "settings.updated", settings: this.repo.updateSettings({ ...patch, lastModelMove: { at: nowIso(), moves } }) });
      const names = [...new Set(moves.map((m) => `${m.from} → ${m.to}`))].join(", ");
      console.log(`Newer Claude models on your login: ${names} (${moves.length} setting${moves.length === 1 ? "" : "s"} moved).`);
    } catch (err) {
      // The list itself is still good; the settings simply stay as they were.
      console.error("Could not move settings to newer Claude models:", err);
    }
  }

  /** The list as last read, without asking Claude Code: for callers that must not start a session to know it. */
  knownClaudeModels(): ClaudeModelsResult | null {
    return this.claudeList;
  }

  private async listClaudeModels(): Promise<ClaudeModelsResult> {
    const abort = new AbortController();
    // A prompt that never sends anything: the session starts, answers the question, and is closed.
    const silent = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise((r) => abort.signal.addEventListener("abort", r, { once: true }));
    })();
    let q: (AsyncIterable<SDKMessage> & { supportedModels?: () => Promise<SdkModelInfo[]>; close?: () => void }) | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      // Inside the try: this runs unawaited at boot, where a session that cannot even start would
      // otherwise be an unhandled rejection — and that ends the whole board.
      q = this.queryFn({ prompt: silent, options: { cwd: process.cwd(), ...LEAN, abortController: abort } });
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
        q?.close?.();
      } catch {
        // already closed
      }
    }
  }

  private toolsStatus: (SessionTools & { key: string }) | null = null;
  private toolsChecking: { key: string; pending: Promise<SessionTools> } | null = null;

  /**
   * The plugins, MCP servers, skills and commands a run gets, with the board's rule for each server.
   * Built from the same options a run uses and aborted at the init message, so it costs nothing —
   * but it does start every MCP server once, so it is cached.
   */
  async sessionTools(force = false): Promise<SessionTools> {
    const settings = this.repo.getSettings();
    // Changing one of these settings changes the answer, so it also invalidates the cache.
    const key = `${settings.loadUserPlugins}|${settings.browserChecks}|${settings.chromeInSupervised}|${settings.markitdownInTasks}`;
    const cached = this.toolsStatus;
    if (cached && !force && cached.key === key && Date.now() - Date.parse(cached.checked_at) < 10 * 60_000) return cached;
    // The check starts every tool server once; a second caller waits for the one already under way.
    if (this.toolsChecking?.key === key) return this.toolsChecking.pending;
    const pending = this.checkSessionTools(settings, key).finally(() => {
      if (this.toolsChecking?.pending === pending) this.toolsChecking = null;
    });
    this.toolsChecking = { key, pending };
    return pending;
  }

  private async checkSessionTools(settings: Settings, key: string): Promise<SessionTools> {
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
            return { name: s.name, status: s.status, tools: tools.filter((t) => t.startsWith(prefix)).length, rule: serverRule(prefix, { markitdown: settings.markitdownInTasks }) };
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
      // The answer is the usage report that comes with any reply; Claude Code's whole system prompt
      // only made the one-word call cost more. Triage runs the same way with none.
      systemPrompt: "",
      tools: [],
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
  private hitLimit(error: string | null, session: LimitContext): boolean {
    // Only a window that was reported shut while this session ran, and that covers its model. Any
    // "rejected" row used to count: with the weekly Opus window full, a Sonnet stage that failed for
    // an ordinary reason was paused for days as "your usage limit" — and held the whole queue with it (D116).
    const shut = this.repo.usageLimits().some((l) => l.status === "rejected" && limitCovers(l.type, session.model) && Date.parse(l.updated_at) >= session.since);
    if (shut) return true;
    return /usage limit|rate[ _-]?limit|limit (reached|exceeded)|out of (usage|credits)|quota|resets? (at|in)|429/i.test(error ?? "");
  }

  /** When the blocking window opens again: the latest reset among the rejected windows that cover this model, plus a margin. */
  private resumeTime(model: string): Date {
    const MARGIN_MS = 90_000; // resets are not instant to the second; do not retry into the same wall
    const now = Date.now();
    const windows = this.repo.usageLimits().filter((l) => limitCovers(l.type, model));
    const blocking = windows.filter((l) => l.status === "rejected" && l.resets_at);
    const known = (blocking.length ? blocking : windows.filter((l) => l.resets_at && l.resets_at * 1000 > now))
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
  private pauseForLimit(taskId: string, error: string | null, session: LimitContext): boolean {
    if (!this.repo.getSettings().autoResume || !this.hitLimit(error, session)) return false;
    const at = this.resumeTime(session.model);
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
  /** Counted per round: what the card spent before this round started is not this round's bill (D375). */
  private taskCeiling(task: Task): number {
    return this.repo.getSettings().maxCostPerTaskUsd + (task.budget_extra_usd ?? 0) + (task.round_cost_base ?? 0);
  }

  /**
   * Money ran out: pause for a decision rather than fail (D216). Unlike a usage limit there is no
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

  // ---------------------------------------------------------------- a provider that ran out (D225)

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

  /** Is Claude's own window shut right now, for a stage on this model? A window for another model family is not. */
  private claudeOut(model: string, now = Date.now()): boolean {
    return (
      this.limitedUntil(now) !== null ||
      this.repo.usageLimits().some((l) => l.status === "rejected" && l.resets_at !== null && l.resets_at * 1000 > now && limitCovers(l.type, model))
    );
  }

  /** Can this stage carry on at `to`: it exists, is switched on, may run this kind of stage, and is not out itself. */
  private fallbackUsable(to: TierRef, stage: Stage, mode: Task["mode"]): boolean {
    const onClaude = !to.provider || to.provider === ANTHROPIC_PROVIDER_ID;
    if (onClaude ? this.claudeOut(to.model) : this.activeOut(to.provider)) return false;
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
      : isGitFolder(this.repo.getProject(task.project_id)?.path ?? "")
        ? "Its changes so far are already in the folder (see `git status` and `git diff`)."
        : "Its changes so far are already in the folder.";
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
      if (fb && this.claudeOut(stage.model) && this.fallbackUsable(fb, stage, task.mode)) {
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
    const run = this.repo.getRun(runId);
    const task = this.repo.getTask(taskId)!;
    const session: LimitContext = { since: run ? Date.parse(run.started_at) : Date.now(), model: run?.model ?? task.pipeline[i].model };
    if (!this.hitLimit(error, session)) return "failed";
    const fb = this.repo.getSettings().claudeFallback;
    if (mayMove && fb && this.fallbackUsable(fb, task.pipeline[i], task.mode)) {
      this.moveStage(task, i, fb, "Claude's usage limit is reached", runId);
      return "switched";
    }
    return this.pauseForLimit(taskId, error, session) ? "paused" : "failed";
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

  /** Every enabled provider's usage: what it says is left, what this board sent there, and whether it is out (D226). */
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

  private stageNeedsClaude(stage: Stage | undefined, settings: Settings): boolean {
    if (!stage) return true;
    const onClaude = (id: string | null | undefined) => !id || id === ANTHROPIC_PROVIDER_ID;
    if (onClaude(stage.provider)) return true;
    // A delegated plan stage still needs the window when its critic argues on Claude.
    const critic = this.providers.debateFor(stage, settings);
    return critic ? onClaude(critic.provider) : false;
  }

  /**
   * The queue's veto. While a limit window is open, Claude work waits for it; work delegated to
   * another provider carries on, which is the whole point of having delegated it. The same goes the
   * other way: work for a provider that is out until a known time waits for it. Either way, a
   * fallback in Settings means there is somewhere to go, so it starts and moves over (D225).
   */
  private mayStartNow(taskId: string, force = false): boolean {
    const task = this.repo.getTask(taskId);
    if (!task) return true;
    // Waits for what it depends on to be done (merged), not just reviewed: D52, D289.
    if (this.blockers(task).length) return false;
    // Inside a pump the settings and the usage gate are the same for every waiting item: read once.
    const view = this.pumpView;
    const settings = view?.settings ?? this.repo.getSettings();
    const limited = !view ? this.limitedUntil() : view.limitedUntil !== undefined ? view.limitedUntil : (view.limitedUntil = this.limitedUntil());
    const stage = this.nextStage(task);
    if (limited !== null && this.stageNeedsClaude(stage, settings) && !settings.claudeFallback) return false;
    if (stage?.provider && stage.provider !== ANTHROPIC_PROVIDER_ID) {
      const out = this.activeOut(stage.provider);
      if (out && out.kind !== "credit" && out.resets_at && !this.fallbackFor(stage.provider)) return false;
    }
    // Last, so the card's reason is the real one: two tasks that would change the same files in one
    // folder, or write the same live system, take turns (D400). Run now still runs it now.
    const hold = force ? null : this.holdFor(task);
    if (JSON.stringify(hold) !== JSON.stringify(task.hold)) this.setTask(task.id, { hold });
    return !hold;
  }

  /**
   * The working cards of a project that a card with this footprint would wait for (same files in one
   * folder, the same live system) or might conflict with when both land (same files, each in its own
   * copy). What the chat and a run see before they make a card (D400).
   */
  overlapsWith(projectId: string, card: FootprintOf, exceptId?: string): { id: string; title: string; status: TaskStatus; waits: boolean; files: string[]; systems: string[]; unknown: boolean }[] {
    const working: TaskStatus[] = ["queued", "planning", "running", "approval", "paused", "review"];
    const out: ReturnType<TaskRunner["overlapsWith"]> = [];
    // A card not queued yet has no place stamped: judge it where the queue will put it.
    const project = this.repo.getProject(projectId);
    const settings = this.repo.getSettings();
    const unplaced = card.mode === "autonomous" && !card.own_branch && !card.in_folder;
    if (unplaced && project && (!settings.autonomousWorktree || project.policy.worktrees === "forbidden")) card = { ...card, in_folder: true };
    for (const t of this.repo.listTasks({ project_id: projectId })) {
      if (t.id === exceptId || !working.includes(t.status)) continue;
      // Review has finished writing: in a worktree only a merge conflict is left to warn about; in the folder its
      // changes still wait there for Approve or Discard, so the same files still wait for it (D400).
      const loose = t.status === "review" && worksInFolder(t) && t.footprint.touched.length > 0;
      const c = t.status === "review" ? (loose ? clash({ ...card, live: false }, { ...t, live: false }) : null) : clash(card, t);
      const later = mayConflict(card, t);
      if (c) out.push({ id: t.id, title: t.title, status: t.status, waits: true, files: c.files, systems: c.systems, unknown: c.unknown });
      else if (later.length) out.push({ id: t.id, title: t.title, status: t.status, waits: false, files: later, systems: [], unknown: false });
    }
    return out;
  }

  /** The running task this one would get in the way of, and why; null when they may run together (D400). */
  private holdFor(task: Task): TaskHold | null {
    for (const id of this.pipelines.keys()) {
      if (id === task.id) continue;
      const other = this.repo.getTask(id);
      if (!other || other.project_id !== task.project_id) continue;
      const c = clash(task, other);
      if (c) return { with: other.id, title: other.title, files: c.files.slice(0, 20), systems: c.systems, unknown: c.unknown };
    }
    // Finished but not landed: its changes are still loose in the project folder, and its Approve commits
    // and its Discard puts back whole files. Writing the same files now would mix two tasks' work, so the
    // next one waits until it is approved or discarded (D400). Only files: a live write already happened.
    for (const other of this.unlandedInFolder(task)) {
      const c = clash({ ...task, live: false }, { ...other, live: false });
      if (c) return { with: other.id, title: other.title, files: c.files.slice(0, 20), systems: [], unknown: c.unknown, landing: true };
    }
    return null;
  }

  /** Tasks of this project whose changes in the project folder wait for Approve or Discard (D398, D400). */
  private unlandedInFolder(task: Task): Task[] {
    return this.repo
      .listTasks({ project_id: task.project_id })
      .filter((t) => t.id !== task.id && !this.pipelines.has(t.id) && worksInFolder(t) && t.status !== "done" && t.status !== "queued" && t.footprint.touched.length > 0);
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
    const due = new Date(0).toISOString();
    if (task.pause_reason === "provider") {
      const stage = task.pipeline[this.defaultStart(task).fromStage];
      if (stage?.provider) this.providerBack(stage.provider);
    } else {
      // Claude's window is the account's, not this task's. Releasing one task alone left it sitting in
      // Queued: the queue holds Claude work for as long as any other task is still paused by the limit.
      for (const t of this.repo.tasksInStatus(["paused"])) {
        if (t.resume_at && t.pause_reason !== "provider" && t.pause_reason !== "cost") this.repo.updateTask(t.id, { resume_at: due });
      }
    }
    this.repo.updateTask(taskId, { resume_at: due });
    this.resumeDue();
  }

  // ---------------------------------------------------------------- approvals

  private askApproval(run: Run, taskId: string, toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2], how: { askMode?: boolean } = {}): Promise<PermissionResult> {
    const approval = this.repo.createApproval({ run_id: run.id, task_id: taskId, tool_name: toolName, input, title: o.title ?? o.displayName ?? null });
    this.setRun(run.id, { status: "approval" });
    this.setTask(taskId, { status: "approval" });
    this.bus.publish({ type: "approval.requested", approval });

    const question = toolName === QUESTION_TOOL;
    const settings = this.repo.getSettings();
    const waitMin = !question ? 0 : how.askMode ? settings.askModeWaitMin : settings.questionWaitMin;
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

  /** Adds what this card asks for to the project's trusted commands, and says so in the transcript. */
  private trustApproved(approval: Approval): void {
    const { task, project } = this.load(approval.task_id);
    const cwd = usesWorktree(task) && task.worktree_path ? task.worktree_path : project.path;
    const rules = trustRules(approval.tool_name, (approval.input ?? {}) as Record<string, unknown>, cwd);
    if (!rules) {
      throw new ConflictError(
        "The board cannot always allow this one: it changes a file, shows a credentials file, or runs something written on the spot, so there is nothing lasting to remember. Press Allow to let it through this once.",
      );
    }
    const trusted = [...new Set([...(project.policy.trusted ?? []), ...rules])];
    const updated = this.repo.updateProject(project.id, { policy: { ...project.policy, trusted } });
    this.bus.publish({ type: "project.updated", project: updated });
    this.log(approval.run_id, `\n[board] Always allowed in this project from now on: ${rules.join(", ")}. Remove it in Settings → this project.\n`);
  }

  /** Answer a question card: question text → the option label(s) you chose, or what you typed. */
  answerApproval(id: string, answers: Record<string, string>): Approval {
    const approval = this.repo.getApproval(id);
    if (!approval) throw new NotFoundError(`No question ${id}`);
    if (approval.tool_name !== QUESTION_TOOL) throw new ConflictError("That card is an approval, not a question.");
    return this.decideApproval(id, "answered", null, answers);
  }

  /**
   * `always`: also stop asking for this command in this project (D353). Refused, with the card left
   * waiting, when there is nothing lasting to remember — the person then presses plain Allow.
   */
  decideApproval(id: string, decision: "allow" | "deny" | "answered", note: string | null = null, answers?: Record<string, string>, always = false): Approval {
    const approval = this.repo.getApproval(id);
    if (!approval) throw new NotFoundError(`No approval ${id}`);
    if (approval.decision) throw new ConflictError(`Approval already ${approval.decision}.`);
    if (approval.tool_name === QUESTION_TOOL && decision === "allow") throw new ConflictError("A question needs an answer, not Allow.");
    if (always && decision === "allow" && this.resolvers.has(id)) this.trustApproved(approval);
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

  /** What the board knows about a card's memory, for `memoryFacts` (D374). */
  memoryInput(taskId: string): MemoryInput {
    const task = this.repo.getTask(taskId);
    if (!task) throw new NotFoundError(`No task ${taskId}`);
    const run = this.repo.workRun(taskId);
    return {
      status: task.status,
      session: run
        ? {
            id: run.session_id,
            model: run.model,
            endedAt: run.ended_at,
            running: run.status === "running" || this.isBusy(taskId),
            contextTokens: run.context_tokens,
            contextWindow: run.context_window,
            exploreWeight: this.repo.exploreWeight(taskId),
            canResume: this.providers.resolve(run.provider).adapter.canResume,
          }
        : null,
      usdPerWeight: run ? this.repo.usdPerWeight(run.model) : null,
    };
  }

  /** Follow-up chat: continue the session that did the work (the coder, not the reviewer) with the user's text. */
  chat(taskId: string, text: string): Run {
    const { task, project } = this.load(taskId);
    const live = this.active.get(taskId);
    if (live) {
      // The stage is running: keep the message and let the hooks hand it over at the next step (D215).
      if (!live.steerable) throw new ConflictError("This stage runs on another provider, which cannot take a message mid-run. Wait for it to finish, or Stop it.");
      this.repo.insertMessage({ task_id: taskId, from_task_id: null, from_run_id: null, body: text });
      const run = this.repo.getRun(live.runId)!;
      const event = this.repo.insertEvent(run.id, "user:chat", { type: "user_chat", text, live: true });
      this.bus.publish({ type: "event", runId: run.id, taskId, event });
      return run;
    }
    if (this.isBusy(taskId)) throw new ConflictError("Task is busy; wait for the current run to finish.");
    // A task waiting on a decision is not waiting for a message. A chat turn here ran in the plan's
    // session with nothing held back, overwrote the plan with its reply, and left the task "failed" —
    // from where Retry walked past the approval. A paused task lost its automatic resume the same way.
    if (task.plan_gate) throw new ConflictError("This task is waiting for you to choose a plan — decide that first, then message it.");
    if (task.status === "paused") {
      throw new ConflictError(
        task.pause_reason === "cost"
          ? "This task is paused at its cost ceiling — press Continue or Stop first, then message it."
          : "This task is paused until it can run again — press Try now or Stop first, then message it.",
      );
    }
    if (task.status === "approval") throw new ConflictError("This task is waiting for your decision — answer that first, then message it.");
    // The project's access may have been tightened since this lookup last ran (D352).
    if (isHandsOff(task)) this.assertRunnable(task, project);
    const last = this.repo.workRun(taskId);
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
    // The run row is the stage's, started long ago: what counts for the usage limit is this turn.
    const session: LimitContext = { since: Date.now(), model: run.model };
    void (async () => {
      try {
        const outcome = await this.runQuery({ task, project, run, cwd, ctl, prompt: text, resume: last.session_id!, stageStatus: "running", accumulate: true, verifyCommand: null });
        if (usesWorktree(task)) await this.commitWorktree(task, `kanban(chat): ${task.title}`);
        if (!outcome.ok) {
          this.setRun(run.id, before); // the chat turn failed; the stage result it belonged to stands
          // A turn you stopped yourself is stopped, not "paused by your usage limit".
          if (outcome.providerId === ANTHROPIC_PROVIDER_ID && !ctl.stopped && this.pauseForLimit(taskId, outcome.error, session)) return;
          if (outcome.providerId !== ANTHROPIC_PROVIDER_ID && !ctl.stopped && (await this.afterProviderOut(taskId, run.stage_index, outcome.providerId, outcome.error, run.id, false)) === "paused") return;
          this.setTask(taskId, { status: "failed", error: outcome.error });
          return;
        }
        if (outcome.providerId !== ANTHROPIC_PROVIDER_ID) this.providerBack(outcome.providerId);
        const fresh = this.repo.getTask(taskId)!;
        if (this.pipelineComplete(fresh)) this.setTask(taskId, { status: isAnswerPipeline(fresh.pipeline) ? "done" : "review" });
        else {
          const next = this.defaultStart(fresh).fromStage + 1;
          this.setTask(taskId, { status: "failed", error: `Chat done, but the pipeline is incomplete — Retry continues from stage #${next}.` });
        }
      } catch (err) {
        // Nothing awaits this turn, so a throw here would be an unhandled rejection — which ends the
        // whole board, and every task running on it. It fails this task instead.
        if (this.repo.getRun(run.id)) this.setRun(run.id, before);
        this.failTask(taskId, `The message could not be handled: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.pipelines.delete(taskId);
      }
    })();
    return run;
  }

  /** The project memory a stage prompt carries, split into what to follow and what earlier tasks did. */
  private memoryFor(projectId: string, task: Task): Pick<PromptCtx, "memory" | "pastOutcomes"> {
    const notes = this.repo.notesFor(projectId, `${task.title}\n${task.spec_md}`, NOTES_IN_PROMPT);
    this.repo.recordNoteUses(task.id, notes.map((n) => n.id));
    return {
      memory: notes.filter((n) => n.kind === "lesson").map((n) => n.text),
      pastOutcomes: notes.filter((n) => n.kind === "outcome").map((n) => ({ text: n.text, taskId: n.task_id })),
    };
  }

  async approveTask(taskId: string): Promise<Task> {
    return this.hold(taskId, async () => {
      const { task, project } = this.load(taskId);
      if (task.status !== "review") throw new ConflictError(`Only tasks in review can be approved (status is "${task.status}").`);
      // Approved work is worth remembering: one line, so later tasks in this project inherit it.
      // Only once it has landed: an approval that hands a conflict to Claude comes back through here.
      const remember = () => {
        this.repo.settleNoteUses(task.id, "approved");
        const summary = outcomeLine(this.repo.runsForTask(task.id), task.summary);
        if (summary) this.repo.addNote({ project_id: project.id, task_id: task.id, text: `${task.title}: ${summary}`, source: "board", kind: "outcome" });
      };

      // What the card changed, kept past its branch: the next round and the chat need to know where it worked (D375).
      const landedFiles = async (): Promise<string[]> => {
        try {
          if (task.branch && task.base_sha) return (await this.git.diffTask(project.path, task.base_sha, task.branch)).map((f) => f.file);
        } catch {
          // a diff that cannot be read leaves the list as it was
        }
        return task.checkout?.touched ?? [];
      };
      // Bookkeeping only: nothing here may stop or fail an approval.
      const landedSha = async (): Promise<string | null> => {
        try {
          return await this.git.headSha(project.path);
        } catch {
          return null;
        }
      };
      const keepLanding = (files: string[], sha: string | null) => {
        this.setTask(taskId, { files: [...new Set([...task.files, ...files])].slice(0, 500), ...(sha ? { landed_sha: sha } : {}) });
        if (task.round > 1) this.repo.updateRound(taskId, task.round, { landed_at: nowIso() });
      };

      // Merge whenever a branch exists — even if the mode was switched after the worktree was made.
      let done: Task;
      if (task.branch) {
        if (task.worktree_path && existsSync(task.worktree_path)) await this.git.commitAll(task.worktree_path, `kanban: ${task.title}`);
        const files = await landedFiles();
        if ((await this.landBranch(project, task)) === "resolving") return this.repo.getTask(taskId)!;
        keepLanding(files, await landedSha());
        remember();
        // The work is merged: from here the task is done whatever happens to the tidying-up. Marking it
        // only after the worktree and branch were gone left a merged task in Review whenever that
        // failed — always, for a squash, whose branch git never counts as merged — and approving
        // again could not succeed.
        done = this.setTask(taskId, { status: "done", merged_at: nowIso(), branch: null, worktree_path: null, note: null, conflict_risk: null });
        try {
          // A squash leaves the branch "unmerged" as far as git can tell; its content has just landed.
          await this.git.removeWorktree(project.path, task.id, { deleteBranch: project.merge.strategy === "squash" ? "force" : "safe" });
        } catch (err) {
          this.log(this.repo.latestRun(taskId)?.id ?? taskId, `[board] cleanup after merging failed: ${String(err)}\n`);
          done = this.setTask(taskId, {
            note: `Merged. The board could not remove the task's worktree or its branch (${task.branch}) afterwards — nothing is lost. Settings → Worktrees can clear it once nothing is using the folder.`,
          });
        }
        this.forgetWorkspace(task);
      } else if (worksInFolder(task)) {
        // Worked in the project folder (D398): landing is one commit of exactly its own files on your
        // branch, leaving anything you had changed or staged yourself alone. No repository: nothing to commit.
        const files = this.folderFiles(task);
        let sha: string | null = null;
        if (await this.git.isGitRepo(project.path)) {
          try {
            sha = await this.git.commitOnly(project.path, files, task.title);
          } catch (err) {
            throw new ConflictError(`Could not commit this task's files: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        keepLanding(files, sha ?? (await landedSha()));
        remember();
        dropKept(this.copiesDir(taskId));
        done = this.setTask(taskId, { status: "done", merged_at: sha ? nowIso() : null, note: null });
        this.forgetWorkspace(task);
      } else {
        keepLanding(await landedFiles(), null);
        remember();
        done = this.setTask(taskId, { status: "done", note: null });
        this.forgetWorkspace(task);
      }
      setImmediate(() => this.promoteReady(project.id)); // anything waiting on this task can start now
      // The base just moved: say which other cards would now conflict, while it is cheap to act on.
      if (task.branch) inBackground(project.path, () => this.refreshConflictRisk(project.id));
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
      // No busy check here: `hold` made it on the way in, and from inside the hold it is always true.
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
    this.repo.settleNoteUses(taskId, "rejected");
    return this.setTask(taskId, { status: "backlog", note, plan_gate: null, blocked: null });
  }

  async discardTask(taskId: string): Promise<Task> {
    return this.hold(taskId, async () => {
      const { task, project } = this.load(taskId);
      let left: string | null = null;
      if (task.branch || task.worktree_path) left = await this.removeWorkspace(project, task);
      if (worksInFolder(task)) {
        // In the project folder, discarding puts back what the task found (D398).
        const undone = restoreKept(this.copiesDir(taskId), project.path);
        dropKept(this.copiesDir(taskId));
        this.setTask(taskId, { footprint: { ...task.footprint, touched: [] }, checkout: null });
        if (undone.left.length) left = `Could not put back ${undone.left.slice(0, 5).join(", ")}${undone.left.length > 5 ? " and more" : ""}: check them by hand.`;
      }
      this.forgetWorkspace(task);
      // Discarding after a Reject must not erase why it was rejected: the note is the only record of it.
      const note = task.note?.trim() && task.note !== "work discarded" ? `${task.note.trim()} — work discarded` : "work discarded";
      if (left) return this.setTask(taskId, { status: "backlog", branch: null, worktree_path: null, base_sha: null, note: `${note}. ${left}`, plan_gate: null, blocked: null });
      return this.setTask(taskId, { status: "backlog", branch: null, worktree_path: null, base_sha: null, note, plan_gate: null, blocked: null });
    });
  }

  /**
   * Removes a task's worktree and branch. A folder that could not be deleted does not stop the caller:
   * git has let go of it and its keys are gone, so the reason comes back as a line for the card (D396).
   */
  private async removeWorkspace(project: Project, task: Task): Promise<string | null> {
    try {
      await this.git.removeWorktree(project.path, task.id, { deleteBranch: "force" });
      return null;
    } catch (err) {
      if (!(err instanceof FolderLeftError)) throw err;
      this.log(this.repo.latestRun(task.id)?.id ?? task.id, `[board] ${err.message}
`);
      return `Its folder ${err.path} could not be deleted (something is still using it); its key files were removed. Delete it when nothing uses it, or from Settings → Worktrees.`;
    }
  }

  /**
   * "Switch to supervised and retry": for a task an autonomous run could not do from its worktree.
   * The worktree only holds work done without the access the task needed, so it is discarded; the
   * task then re-runs from the stage that was blocked, in the main checkout, every write approved.
   * Earlier stages that finished (the plan) are kept and handed on (D185).
   */
  async escalateToSupervised(taskId: string): Promise<Task> {
    await this.hold(taskId, async () => {
      const { task, project } = this.load(taskId);
      if (!["failed", "review", "backlog"].includes(task.status)) throw new ConflictError(`Cannot switch a task in status "${task.status}".`);
      if (task.mode === "supervised") throw new ConflictError("This task is already supervised.");
      const left = task.branch || task.worktree_path ? await this.removeWorkspace(project, task) : null;
      this.forgetWorkspace(task);
      this.setTask(taskId, { mode: "supervised", branch: null, worktree_path: null, base_sha: null, plan_gate: null, ...(left ? { note: left } : {}) });
    });
    const task = this.repo.getTask(taskId)!;
    const from = task.blocked?.advisory ? supervisedFrom(task.pipeline, task.blocked.stage_index) : task.blocked?.stage_index ?? this.defaultStart(task).fromStage;
    // A fresh session: the old one lived in a worktree that no longer exists.
    return this.queueTask(taskId, { fromStage: Math.min(from, Math.max(0, task.pipeline.length - 1)) });
  }

  async diff(taskId: string): Promise<DiffFile[]> {
    const { task, project } = this.load(taskId);
    if (worksInFolder(task) && !task.branch) return this.folderDiff(task, project);
    if (!task.branch || !task.base_sha) return [];
    return this.git.diffTask(project.path, task.base_sha, task.branch);
  }

  /**
   * Intake. `classify` fills in type/priority/labels only; `refine` also rewrites the spec and
   * proposes subtasks. Read-only by construction (no tools, no repo access) — see triage.ts.
   */
  async triage(taskId: string, mode: "classify" | "refine", opts: { apply?: boolean; decided?: { pipeline?: boolean; live?: boolean } } = {}): Promise<TriageResult | null> {
    const { task, project } = this.load(taskId);
    const settings = this.repo.getSettings();
    // Closed vocabulary: the project's configured labels plus whatever is already in use.
    const knownLabels = [...new Set([...project.env.labels, ...this.repo.listTasks({ project_id: project.id }).flatMap((t) => t.labels)])].slice(0, 30);
    const result = await triageTask(
      {
        title: task.title,
        spec_md: task.spec_md,
        projectName: project.name,
        memory: this.repo.notesFor(project.id, `${task.title}\n${task.spec_md}`, NOTES_IN_PROMPT).map((n) => n.text),
        knownLabels,
        mode,
        cwd: project.path,
        model: settings.triageModel,
      },
      this.queryFn as never,
    );
    if (!result) return null;
    this.repo.addIntakeCost({ task_id: taskId, kind: "triage", model: settings.triageModel, cost_usd: result.cost_usd });
    if (mode === "classify" && (opts.apply ?? true)) {
      const fresh = this.repo.getTask(taskId);
      if (fresh && !fresh.triaged_at) {
        // Confident classification is applied; priority is always only a suggestion, and a shaky
        // guess is recorded rather than acted on — a wrong label is worse than no label.
        const confident = result.confidence >= CONFIDENCE_TO_APPLY;
        const labels = result.labels.filter((l) => knownLabels.includes(l));
        // The sized pipeline is only ever a suggestion: a wrong guess here spends real money, so
        // accepting it is a decision the human makes. Rejecting keeps the project default.
        // Triage runs in the background: by the time it answers the task may already be running, and
        // a pipeline suggestion shown under a finished run is noise (D191).
        // What the side chat already settled with you (D286) is not offered back as a second opinion.
        const sized = settings.autoSizing && fresh.status === "backlog" && !opts.decided?.pipeline ? sizedPipeline(result.sizing, settings.tiers) : null;
        // Live-system work is proposed as a live task — one record of it, with plan approval and a
        // review that checks the live system itself — rather than as a mode switch (D241).
        // Reading a live system is not changing it: a lookup gets neither plan approval nor a live review (D287).
        const toLive = result.live_access?.changes && !fresh.live && fresh.status === "backlog" && !opts.decided?.live;
        // The systems it writes to, named, unless someone named them already (D400).
        const systems = result.live_access?.changes && !fresh.footprint.systems.length ? result.live_access.systems : [];
        this.setTask(taskId, {
          ...(systems.length ? { footprint: { ...fresh.footprint, systems } } : {}),
          ...(confident ? { type: result.type, labels } : {}),
          triaged_at: nowIso(),
          suggestion: {
            priority: result.priority,
            type: result.type,
            labels,
            confidence: result.confidence,
            ...(sized ? { pipeline: sized, sizing_reason: result.sizing?.reason || "" } : {}),
            ...(toLive
              ? {
                  live: true,
                  live_reason:
                    `${result.live_access!.reason || "It changes a live system."} A live task waits for your OK on its plan, and its review reads the live system back.` +
                    (fresh.mode === "autonomous" ? " An autonomous run is sandboxed, so if it needs to reach that system it will stop and ask to run supervised." : ""),
                }
              : {}),
          },
        });
      }
    }
    return result;
  }

  /**
   * Whether a task's mode, branch or pipeline may change now. One rule for the board and the side chat:
   * never under a run, and never away from a branch that holds work nobody has approved or discarded.
   */
  assertReconfigurable(task: Task, patch: { mode?: Mode; pipeline?: Stage[]; own_branch?: boolean }): void {
    const busy = this.isBusy(task.id);
    // Mode and branch pick the folder the run works in, once, when it starts: no switching mid-run.
    if (busy && ((patch.mode && patch.mode !== task.mode) || (patch.own_branch !== undefined && patch.own_branch !== task.own_branch))) {
      throw new ConflictError("Mode can't change while the task runs: it chose where to work when it started. Stop it first, then change the mode.");
    }
    // The steps still ahead can change: the pipeline is read afresh at every stage (D364).
    if (busy && patch.pipeline) {
      const started = this.repo.latestRun(task.id)?.stage_index ?? -1;
      const kept = patch.pipeline.length > started && task.pipeline.slice(0, started + 1).every((s, i) => sameStage(s, patch.pipeline![i]));
      if (!kept) throw new ConflictError("Steps that already started can't be changed; you can change the steps after them.");
    }
    if (patch.own_branch !== undefined && patch.own_branch !== task.own_branch && (task.branch || task.worktree_path)) {
      throw new ConflictError(`This task has work on ${task.branch ?? "its worktree"}; approve or discard it before changing where it works.`);
    }
    if (patch.mode && patch.mode !== task.mode && (task.branch || task.worktree_path)) {
      throw new ConflictError(`This task has work on ${task.branch ?? "its worktree"}; approve or discard it before changing mode.`);
    }
  }

  /**
   * Applies a suggestion the human accepted. Split out from triage on purpose: nothing the model
   * proposed about how a task runs takes effect until someone presses Accept.
   */
  acceptSuggestion(taskId: string, what: SuggestionParts): Task {
    const { task } = this.load(taskId);
    const s = task.suggestion;
    if (!s) throw new ConflictError("There is nothing suggested for this task.");
    if ((what.pipeline || what.mode || what.live) && this.isBusy(taskId)) throw new ConflictError("Cannot change the pipeline, mode or live flag while the task is queued or running.");
    if (what.mode && s.mode && s.mode !== task.mode && (task.branch || task.worktree_path)) {
      throw new ConflictError(`This task has work on ${task.branch ?? "its worktree"}; approve or discard it before changing mode.`);
    }
    return this.setTask(taskId, {
      ...(what.fields ? { type: s.type ?? task.type, priority: s.priority ?? task.priority, labels: [...new Set([...task.labels, ...(s.labels ?? [])])] } : {}),
      ...(what.pipeline && s.pipeline?.length ? { pipeline: s.pipeline } : {}),
      ...(what.mode && s.mode ? { mode: s.mode } : {}),
      ...(what.live && s.live ? { live: true } : {}),
      suggestion: withoutParts(s, what),
    });
  }

  /** "Keep default" for one part of a suggestion; the other parts stay on offer. */
  dismissSuggestion(taskId: string, what: SuggestionParts): Task {
    const { task } = this.load(taskId);
    return this.setTask(taskId, { suggestion: task.suggestion ? withoutParts(task.suggestion, what) : null });
  }

  /** Look at an attached image once with the cheap vision model, so the stages never have to. */
  async describeAttachment(attachmentId: string): Promise<string | null> {
    const at = this.repo.getAttachment(attachmentId);
    if (!at || at.description) return at?.description ?? null;
    const settings = this.repo.getSettings();
    const r = await this.describeWithFallback(at.path, settings.visionProvider, settings.visionModel);
    if (at.task_id) this.repo.addIntakeCost({ task_id: at.task_id, kind: "vision", model: r.by, cost_usd: r.described?.cost_usd ?? 0 });
    const updated = this.repo.describeAttachment(at.id, r.described?.text ?? null, r.described ? r.by : null);
    if (updated && r.described) this.bus.publish({ type: "attachment.added", attachment: updated });
    return r.described?.text ?? null;
  }

  /**
   * The chosen vision provider first; if it is missing, switched off, or cannot see (not every model
   * can), Claude's default vision model does it instead, and the attachment says so.
   */
  private async describeWithFallback(path: string, providerId: string, model: string): Promise<{ described: { text: string; cost_usd?: number } | null; by: string }> {
    const label = (id: string, m: string) => `${id === ANTHROPIC_PROVIDER_ID ? "claude" : id} · ${m}`;
    const onClaudeDefault = (providerId || ANTHROPIC_PROVIDER_ID) === ANTHROPIC_PROVIDER_ID;
    let described: { text: string; cost_usd?: number } | null = null;
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
        may_ask: task.may_ask,
        status: "backlog",
      });
      // Kept as data too, not only in the spec: the queue keeps it off a card changing the same files (D400).
      const placed = s.files?.length || task.footprint.systems.length
        ? this.repo.updateTask(child.id, { footprint: { files: s.files ?? [], systems: task.footprint.systems, touched: [] } })
        : child;
      ids.push(placed.id);
      this.bus.publish({ type: "task.updated", task: placed });
      return placed;
    });
    if (subtasks.length) setImmediate(() => this.promoteReady(project.id));
    return { task: updated, subtasks };
  }

  /** What a card did, written for a new card that follows it (D56), from the files kept when it landed. */
  handoff(taskId: string): string {
    const { task } = this.load(taskId);
    return this.handoffText(task, task.files.map((f) => `M ${f}`));
  }

  /**
   * What a card did, for a session that cannot remember it: its summary, its last report, the files it
   * changed. Shared by Follow-up (D56) and a round or fork whose session is gone (D375). Reads the branch's
   * own diff while there is one.
   */
  private async handoffFor(task: Task, project: Project): Promise<string> {
    let changed: string[] = task.files.map((f) => `M ${f}`);
    try {
      if (task.base_sha && task.branch) changed = (await this.git.diffTask(project.path, task.base_sha, task.branch)).map((f) => `${f.status} ${f.file}`);
    } catch {
      // the branch is usually merged and gone by now — the files kept at landing stand in
    }
    return this.handoffText(task, changed);
  }

  private handoffText(task: Task, changed: string[]): string {
    const last = [...this.repo.stageRuns(task.id)].reverse().find((r) => r.result_md?.trim());
    return [
      `## Context: follows up on "${task.title}" (\`${task.id}\`)`,
      `That task finished as **${task.status}**${task.updated_at ? ` on ${task.updated_at.slice(0, 10)}` : ""}.`,
      task.summary ? `\nIts last summary: ${task.summary}` : "",
      last?.result_md ? `\n<details><summary>What that task reported</summary>\n\n${last.result_md.slice(0, 2000)}\n\n</details>` : "",
      changed.length ? `\nFiles it changed:\n${changed.slice(0, 25).map((c) => `- ${c}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Round N+1 on a done card (D375): its coder continues in its own session, in a working copy recreated at
   * the same path from the current base, told what others changed in its files since. Queued like any run,
   * so the queue's caps, usage-limit pauses and the verify command all apply. Its own approval lands it.
   */
  async startRound(taskId: string, request: string, opts: { review?: boolean; force?: boolean } = {}): Promise<Task> {
    const { task, project } = this.load(taskId);
    const ask = request.trim();
    if (!ask) throw new ConflictError("Say what this round should do.");
    if (task.status === "review" || task.status === "failed") {
      throw new ConflictError("This card's work is not approved yet: send the change to it as a message, and it joins the work waiting for your review.");
    }
    if (task.status !== "done") throw new ConflictError(`A new round starts on a done card; this one is ${task.status}.`);
    if (this.isBusy(taskId)) throw new ConflictError("Task is busy; wait for the current run to finish.");
    const facts = memoryFacts(this.memoryInput(taskId));
    if (facts.memory === "gone") throw new ConflictError(`This card's memory cannot be continued (${facts.why.replace(/^A new card is told what it did: /, "").replace(/\.$/, "")}). Make a new card that follows it instead.`);
    const work = this.repo.workRun(taskId)!;
    const n = task.round + 1;
    const review = (Boolean(opts.review) || task.live) && task.pipeline.some((st) => st.stage === "review");
    const changedByOthers = task.landed_sha ? await this.git.changedSince(project.path, task.landed_sha, task.files) : [];
    const prompt = buildRoundPrompt({ round: n, request: ask, changedByOthers, worktree: usesWorktree(task) });
    const fallback = buildRoundFallbackPrompt({ round: n, request: ask, handoff: await this.handoffFor(task, project) });
    this.repo.addRound({ task_id: taskId, round: n, request: ask, review, checklist_from: task.checklist.length });
    // The ceiling counts this round alone, and Continue's grants belonged to the last one.
    this.setTask(taskId, { round: n, round_cost_base: this.repo.taskCost(taskId), checklist_from: task.checklist.length, budget_extra_usd: 0, summary: `Round ${n}: ${ask}`.slice(0, 280) });
    try {
      return this.queueTask(taskId, { fromStage: work.stage_index, resume: work.session_id ?? undefined, round: { n, prompt, fallback, review } }, opts.force);
    } catch (err) {
      // Not queued (the project's policy, a busy card): the round never began, so the card is as it was.
      this.setTask(taskId, { round: task.round, round_cost_base: task.round_cost_base, checklist_from: task.checklist_from, budget_extra_usd: task.budget_extra_usd, summary: task.summary });
      this.repo.deleteRound(taskId, n);
      throw err;
    }
  }

  /**
   * A new card that starts with a copy of another card's coder memory (D376): for new work in the same
   * files that should run beside it, or while it waits for review. Started at once — a fork is only worth
   * it while the memory is there — in its own folder; the original session stays as it was.
   */
  async forkTask(sourceId: string, o: { title: string; request: string; chatId?: string | null; review?: boolean; force?: boolean }): Promise<Task> {
    const { task: source, project } = this.load(sourceId);
    const ask = o.request.trim();
    if (!ask) throw new ConflictError("Say what the new card should do.");
    const facts = memoryFacts(this.memoryInput(sourceId));
    if (!facts.can.includes("fork")) {
      throw new ConflictError(facts.memory === "gone" ? "That card's memory cannot be continued: make a new card that follows it instead." : `A card can be branched from once it has finished its work (this one is ${source.status}).`);
    }
    const work = this.repo.workRun(sourceId)!;
    const stage = source.pipeline[work.stage_index] ?? { stage: work.stage, model: work.model, effort: work.effort };
    const reviewStage = source.pipeline.find((st) => st.stage === "review");
    const review = Boolean(o.review || source.live) && Boolean(reviewStage);
    const created = this.repo.createTask({
      project_id: source.project_id,
      milestone_id: source.milestone_id,
      title: o.title.trim() || ask.slice(0, 80),
      spec_md: `${ask}\n\n${await this.handoffFor(source, project)}`,
      type: source.type,
      priority: source.priority,
      labels: source.labels,
      related_to: [source.id],
      mode: source.mode,
      may_ask: source.may_ask,
      own_branch: source.own_branch,
      live: source.live,
      // The same model as the memory it continues: the cache is per model (D374).
      pipeline: [{ ...stage, model: work.model }, ...(review && reviewStage ? [reviewStage] : [])],
      chat_id: o.chatId ?? null,
      status: "backlog",
    } as NewTask);
    this.setTask(source.id, { related_to: [...new Set([...source.related_to, created.id])].slice(0, 10) });
    this.bus.publish({ type: "task.updated", task: created });
    const own = usesWorktree(created) ? gitOps.worktreePathFor(project.path, created.id) : project.path;
    const prompt = [
      `## ${created.title}`,
      "",
      ask,
      "",
      `This is a new task, branched from the work you did earlier in this session on "${source.title}". Do only what it asks.`,
      source.status === "done"
        ? `That work has landed. You now work in \`${own}\`, which holds the project as it is today, with that work in it.`
        : `That work is not approved yet, so it is not in your folder. You now work in \`${own}\`, which holds the project as it is today.`,
      own !== (source.worktree_path ?? project.path) ? "Paths you remember from before point at the old folder: use the same file names under your new folder." : "",
      "Read a file again before you edit it, keep a to-do list for this task, and end with a short report of what you changed.",
    ].filter(Boolean).join("\n");
    const fallback = buildRoundFallbackPrompt({ round: 1, request: ask, handoff: await this.handoffFor(source, project) });
    return this.queueTask(created.id, { fromStage: 0, resume: work.session_id ?? undefined, round: { n: 1, prompt, fallback, review, fork: true } }, o.force);
  }

  /**
   * A new task that continues an old one. Sessions are not reopened days later — the worktree is
   * gone, the repo has moved on, and the SDK docs advise passing results into a fresh session
   * instead. So the outcome of the old task is written into the new task's spec as context.
   */
  async followUp(taskId: string, opts: { title?: string; note?: string; type?: Task["type"] } = {}): Promise<Task> {
    const { task, project } = this.load(taskId);
    const context = [
      await this.handoffFor(task, project),
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
      may_ask: task.may_ask,
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

  /**
   * Boot recovery (DECISIONS D11). `afterCrash`: the launcher saw the last board die without being
   * asked to, so the stages it cut off carry on in their own sessions instead of waiting for Retry (D384).
   */
  recover(opts: { afterCrash?: boolean } = {}): void {
    // Pollinations without a key was the shipped picture maker; its free tier now turns requests away,
    // so a board still on it moves to "Codex when linked" — no picture tool until one is ready (D303).
    if (this.repo.getSettings().imageProvider === "pollinations" && !this.secrets.has(POLLINATIONS_KEY_REF)) {
      this.repo.updateSettings({ imageProvider: "codex" });
    }
    // Paused tasks keep their resume time across a restart; anything already due resumes now.
    setImmediate(() => this.resumeDue());
    // The stage each task was in when the board died: only a pipeline stage carries on by itself.
    const cutOff = new Map<string, number>();
    for (const run of this.repo.runsInStatus(["running", "approval"])) {
      this.repo.updateRun(run.id, { status: "failed", error: "interrupted", ended_at: nowIso() });
      const t = this.repo.getTask(run.task_id);
      if (t && !["done", "backlog"].includes(t.status)) {
        this.repo.updateTask(t.id, { status: "failed", error: "interrupted (server restarted) — Retry resumes the session" });
        if (run.role === "stage" && !t.plan_gate) cutOff.set(t.id, run.stage_index);
      }
    }
    // Announced even though nobody is connected yet: every card ends with a decided event, so a
    // listener added before boot (a test, a future plugin) never holds one open for ever.
    for (const approval of this.repo.expirePendingApprovals("the board restarted")) this.bus.publish({ type: "approval.decided", approval });
    for (const t of this.repo.tasksInStatus(["planning", "running", "approval"])) {
      if (t.plan_gate) continue; // nothing was running: the gate is durable and waits for the human
      this.repo.updateTask(t.id, { status: "failed", error: "interrupted (server restarted)" });
    }
    // A conflict resolution cut off by the restart may have left its worktree mid-merge: put the
    // branch back where it was before Claude touched it, exactly as a failed attempt is (D355).
    for (const t of this.repo.listTasks()) {
      if (!t.resolution || !["resolving", "checking", "reviewing"].includes(t.resolution.state)) continue;
      this.repo.updateTask(t.id, { resolution: { ...t.resolution, state: "failed", error: "The board restarted while Claude was resolving this conflict.", finished_at: nowIso() } });
      inBackground(this.repo.getProject(t.project_id)?.path, () => this.abandonResolution(t));
    }
    for (const p of this.repo.listProjects()) inBackground(p.path, () => this.refreshConflictRisk(p.id));
    for (const t of this.repo.tasksInStatus(["queued"])) {
      // Where it was queued from lived in memory. A task with every stage already done can only have
      // been queued to run again — sent back from Review — so it starts over; "the first stage
      // without a success" would have re-run its last stage alone, in the old session.
      this.startOpts.set(t.id, this.pipelineComplete(t) ? { fromStage: 0 } : this.defaultStart(t));
      this.queue.enqueue({ taskId: t.id, projectId: t.project_id });
    }
    if (opts.afterCrash) for (const [taskId, stageIndex] of cutOff) this.carryOnAfterCrash(taskId, stageIndex);
  }

  /**
   * A stage the board's own crash cut off: run it again in its session, which still holds everything
   * it had done. A task cut off again and again stays failed, because the next crash may be its doing
   * and a board that restarts into it would never stay up (D384).
   */
  private carryOnAfterCrash(taskId: string, stageIndex: number): void {
    const since = Date.now() - CRASH_WINDOW_MS;
    const cuts = this.repo.stageRuns(taskId).filter((r) => r.error === "interrupted" && r.ended_at && Date.parse(r.ended_at) >= since).length;
    if (cuts >= CRASH_RESUME_LIMIT) {
      this.setTask(taskId, {
        error: `interrupted: the board stopped ${cuts} times in ${CRASH_WINDOW_MS / 60_000} minutes while this ran, so it was not started again by itself — Retry resumes the session`,
      });
      return;
    }
    // Before the start: the note is read when the stage's first event is written.
    const notes = this.pendingNotes.get(taskId) ?? [];
    this.pendingNotes.set(taskId, [...notes, "The board stopped unexpectedly while this stage ran. It started again by itself, and this stage carries on in the same session."]);
    try {
      this.retryTask(taskId, stageIndex);
    } catch {
      // Its project or settings no longer allow a start: it stays failed, and Retry says why.
      this.pendingNotes.set(taskId, notes);
    }
  }
}
