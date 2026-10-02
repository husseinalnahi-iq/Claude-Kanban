// Row shapes shared by server and web (web imports these with `import type`).

export type StageName = "plan" | "code" | "review" | "custom";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Mode = "autonomous" | "supervised";
/** `paused`: stopped by a subscription usage limit, and resumed automatically when it resets. */
export type TaskStatus = "backlog" | "planning" | "queued" | "running" | "review" | "approval" | "paused" | "done" | "failed";
/** What kind of work this is. Deliberately short: more types means less consistent labelling. */
export type TaskType = "feature" | "bug" | "chore" | "docs" | "refactor";
/** P0 drop everything → P3 someday. Suggested by triage, applied only by you. */
export type Priority = "p0" | "p1" | "p2" | "p3";

export const TASK_TYPES: TaskType[] = ["feature", "bug", "chore", "docs", "refactor"];
export const PRIORITIES: Priority[] = ["p0", "p1", "p2", "p3"];
export type RunStatus = "running" | "approval" | "success" | "failed";
/** "answered": a question Claude asked (AskUserQuestion) that you answered. */
export type ApprovalDecision = "allow" | "deny" | "expired" | "answered";

export const TASK_STATUSES: TaskStatus[] = ["backlog", "queued", "planning", "running", "approval", "paused", "review", "done", "failed"];
/** Whether a task works in its own git worktree: every autonomous task, and a supervised one with own_branch (D234). */
export const usesWorktree = (t: { mode: Mode; own_branch?: boolean }): boolean => t.mode === "autonomous" || Boolean(t.own_branch);

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Where `generate_image` makes pictures: Codex on your ChatGPT plan (D297), free Pollinations.ai, Cloudflare Workers AI with your token, or nowhere (D262). */
export const IMAGE_PROVIDERS = ["codex", "pollinations", "cloudflare", "off"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];
/** The image tool's MCP names, here so the web can label its cards without importing the engine. */
export const IMAGE_SERVER = "images";
export const IMAGE_PREFIX = `mcp__${IMAGE_SERVER}__`;
export const IMAGE_TOOL = `${IMAGE_PREFIX}generate_image`;
/** Microsoft's MarkItDown (PDF, Word, Excel… → Markdown), as the Skills page adds it to your Claude Code. */
export const MARKITDOWN_SERVER = "markitdown";
export const MARKITDOWN_TOOL = `mcp__${MARKITDOWN_SERVER}__convert_to_markdown`;

/** What Settings → Images shows: which keys are set (never their values), whether an image would come, and how to give your own Claude Code the tool. */
export interface ImageStatus {
  provider: ImageProvider;
  cloudflareAccountId: string;
  hasPollinationsKey: boolean;
  hasCloudflareToken: boolean;
  ready: boolean;
  detail: string;
  /** The one line that adds the tool to your own Claude Code (`claude mcp add …`). */
  claudeCodeCommand: string;
  /** Codex as a picture maker: whether it is there, its account, and whether it can make pictures here (D297). */
  codex: { found: boolean; signedIn: "chatgpt" | "api-key" | null; version: string | null; pictures: CodexPictures; model: string };
}

/** Whether Codex can make pictures on this computer, learned the first time it is asked to (D297). */
export interface CodexPictures {
  /** null: not tried with this Codex yet. */
  works: boolean | null;
  /** The Codex version it was tried with: a newer one is tried again. */
  version: string | null;
  detail: string;
  checked_at: string | null;
}

/** The pickers whose model lists Settings → Model lists controls (D300). */
export const MODEL_SURFACES = ["chat", "stages", "helpers", "pictures"] as const;
export type ModelSurface = (typeof MODEL_SURFACES)[number];
/** A model as the lists name it: "anthropic:claude-opus-5-5", "codex:gpt-6-luna", "pictures:pollinations". */
export const modelKey = (provider: string | null | undefined, model: string) => `${provider || "anthropic"}:${model}`;

export interface Stage {
  stage: StageName;
  model: string;
  effort: Effort;
  /**
   * Claude's fast mode for this stage: "a high-speed configuration for Claude Opus, making the model
   * up to 2.5x faster at a higher cost per token." Opus 5 and 4.8 only; off by default, as in Claude.
   */
  fast?: boolean;
  prompt?: string;
  /** Which provider runs this stage. Absent (or "anthropic") = Claude through your Claude Code login. */
  provider?: string;
  /**
   * Plan stages only: have a second model critique the plan before code starts. `true`/absent
   * follows Settings → debate; `false` switches it off for this stage; an object names the critic.
   */
  debate?: boolean | { provider: string; model: string; effort?: Effort };
}

// ---------------------------------------------------------------- providers

/**
 * How the board reaches a model that is not Claude-through-your-login (docs/DECISIONS.md D121):
 *  - anthropic-compatible: the real Claude Code, pointed at another Anthropic-shaped endpoint
 *    (GLM/z.ai, Kimi, MiniMax, OpenRouter, Ollama). Every board tool, hook and gate keeps working.
 *  - openai-compatible: a plain chat-completions call. Text in, text out, no tools — plan/review only.
 *  - cli: another coding agent's CLI run as a subprocess in the task's workspace (Codex, Gemini, …).
 */
export type ProviderKind = "anthropic-compatible" | "openai-compatible" | "cli";
export type CliPreset = "codex" | "gemini" | "kimi" | "opencode" | "custom";
/** The implicit default provider. Never stored in `Settings.providers`. */
export const ANTHROPIC_PROVIDER_ID = "anthropic";

export interface ProviderModel {
  id: string;
  label: string;
  /** USD per million tokens, for the estimate shown on runs. Leave both empty for a subscription. */
  inputPer1M?: number;
  outputPer1M?: number;
  contextWindow?: number;
}

/**
 * One row of a provider's live model list (GET /providers/:id/models). `group` is what the picker
 * files it under: local and cloud are Ollama, loaded and downloaded are LM Studio, free and paid are
 * OpenRouter's own prices, saved is a model from your list the provider did not report (or every
 * model, for a provider with no list).
 */
export interface CatalogModel {
  id: string;
  label: string;
  /** `plan`: included in a subscription you are signed in to (Codex on ChatGPT), no per-token bill. */
  group: "local" | "cloud" | "loaded" | "downloaded" | "free" | "paid" | "plan" | "saved";
  inputPer1M?: number;
  outputPer1M?: number;
  contextWindow?: number;
  /** Local providers: false for a model that is not pulled / downloaded yet. */
  installed?: boolean;
  /** Why this model may fail as a stage, e.g. loaded with too little context. */
  warning?: string;
  /** The effort levels it takes, when the provider says (Codex does, D298). */
  efforts?: Effort[];
}

/** One Claude model your login can use, as Claude Code reports it (GET /claude/models). */
export interface ClaudeModel {
  /** The id stages use, e.g. "claude-sonnet-5". */
  id: string;
  /** "Sonnet 5". */
  label: string;
  /** What it is for, in Claude's words: "Efficient for routine tasks". */
  blurb: string;
  /** Effort levels it takes; empty when it has no effort setting (Haiku). */
  efforts: Effort[];
  /** The short names that point at it too ("sonnet", "opus[1m]"). */
  aliases: string[];
}

/** One pick moved to a newer model of its family. */
export interface ModelMove {
  /** "default pipeline, stage 2 (code)" */
  where: string;
  from: string;
  to: string;
  /** "Opus 5.5" */
  label: string;
}

export interface ClaudeModelsResult {
  /** live: Claude Code answered. unavailable: it could not be asked — see error; ids are not checked. */
  source: "live" | "unavailable";
  models: ClaudeModel[];
  checked_at: string;
  error?: string;
}

/**
 * One version of a task's spec. `yours` is text a person wrote (the original, or an edit made after a
 * rewrite); `ai` is a ✦ Rewrite of the `yours` version named by `source_id`. Nothing is ever overwritten.
 */
export interface SpecVersion {
  id: string;
  task_id: string;
  kind: "yours" | "ai";
  spec_md: string;
  model: string | null;
  effort: Effort | null;
  source_id: string | null;
  /** What you asked the rewrite to focus on, if anything. */
  instruction: string | null;
  /** The rewrite's one line on what it changed. */
  summary: string | null;
  cost_usd: number;
  created_at: string;
}

/** How a Claude model id compares with your login's list. */
export type ClaudeModelStatus = "ok" | "unlisted" | "invalid" | "unchecked";

export interface ModelCatalogResult {
  /** live: asked the provider. saved: your list only (no list to ask, or asking failed — see error). */
  source: "live" | "saved";
  models: CatalogModel[];
  error?: string;
}

export interface Provider {
  /** Short slug, e.g. "zai", "openrouter". */
  id: string;
  label: string;
  kind: ProviderKind;
  enabled: boolean;
  /** http kinds only. */
  baseUrl?: string;
  /** NAME of the secret holding the key (e.g. "ZAI_API_KEY"), never the key itself. */
  authRef: string;
  models: ProviderModel[];
  /**
   * `auth` (Codex): `login` runs on the account the CLI is signed in to — a ChatGPT plan — and never
   * sees an API key; `api-key` passes this provider's key. Unset: the key if one is set, else the login (D293).
   */
  cli?: { preset: CliPreset; command?: string; extraArgs?: string[]; envPassthrough?: string[]; auth?: "login" | "api-key" };
  /** cli only: may it run on code stages and change files? Off by default — see D129. */
  mayEditFiles: boolean;
  /**
   * anthropic-compatible only: how the key is sent. Most endpoints take `Authorization: Bearer`
   * (ANTHROPIC_AUTH_TOKEN); Kimi Code wants it as an API key (ANTHROPIC_API_KEY).
   */
  authStyle?: "bearer" | "api-key";
  /** When this provider runs out mid-task, carry on here instead of waiting (D225). Unset: wait, or ask. */
  fallback?: TierRef | null;
}

/** A provider that ran out: a usage window, its credit, or its patience (D225). */
export interface ProviderOut {
  provider_id: string;
  kind: "window" | "credit" | "busy";
  /** The provider's own words. */
  reason: string;
  /** When it comes back, if known. */
  resets_at: string | null;
  updated_at: string;
}

/** One usage window a provider reports about its own plan. */
export interface QuotaWindow {
  label: string;
  /** 0..1, or null when it only says whether it is out. */
  used: number | null;
  resets_at: string | null;
  /** Running out of this one does not stop runs (z.ai's monthly web-tool calls). */
  soft?: boolean;
}

/** What the board's own runs sent to a provider in a window of time. */
export interface UsageTotals {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/** A provider's usage, for the usage panel and Settings (D226). */
export interface ProviderUsage {
  provider_id: string;
  label: string;
  /** Runs on this computer: nothing to run out of. */
  local: boolean;
  /** "live": the provider said; "board": only what this board counted. */
  source: "live" | "board";
  windows: QuotaWindow[];
  balance: { amount: number; currency: string; label: string } | null;
  plan: string | null;
  /** Why asking the provider failed. */
  error: string | null;
  board: { h5: UsageTotals; d7: UsageTotals };
  out: ProviderOut | null;
  checked_at: string;
}

export type TierRef = { provider: string; model: string };

export interface DebateSettings {
  enabled: boolean;
  critic: { provider: string; model: string; effort: Effort };
}

export interface Objection {
  n: number;
  severity: "high" | "medium" | "low";
  claim: string;
  change: string;
}

/** A plan waiting for you to choose: the original, the critic's objections, and the revised plan. */
/**
 * A plan waiting for the human before any code is written. `debate`: a critic argued with it and a
 * revision exists (D131). `approval`: plan approval is on for this task, so the plan alone waits (D231).
 */
export interface PlanGate {
  kind?: "debate" | "approval";
  stage_index: number;
  created_at: string;
  original: string;
  critic_run_id?: string;
  critic?: { provider: string; model: string };
  critique?: { raw: string; objections: Objection[] };
  revised?: string;
}

/**
 * A stage that could not do the task from where it ran — the sandbox refused what it needed, or it
 * needs a decision or information from you. The pipeline stops there instead of carrying a "success"
 * nobody earned into review (docs/DECISIONS.md D184).
 */
export interface Blocked {
  stage_index: number;
  /** What stopped it, in one or two sentences. */
  reason: string;
  /** "supervised": it needs access only an approved run has (live systems, credentials, the main checkout). */
  needs: "supervised" | "input" | "other";
  /** The question or request for you, if there is one. */
  ask: string | null;
  /** "agent" when the stage reported it; "board" when the board stopped a run that kept hitting the sandbox. */
  source: "agent" | "board";
  /** The mode the blocked run had, so a rerun knows whether anything about its access changed. */
  mode: Mode;
  created_at: string;
}

/**
 * A decision a stage wants from you but does not need to stop for: it carries on with `default` and
 * the question waits on the card. The plan that prompted this asked two questions in its report and
 * the pipeline ran on without anyone seeing them (docs/DECISIONS.md D203).
 */
/** A helper agent's model: a cheaper Claude, or "stage" for the model of the stage that sends it. */
export type HelperModel = "sonnet" | "haiku" | "stage";
export const HELPER_MODELS: HelperModel[] = ["sonnet", "haiku", "stage"];

/** One line of Claude's own to-do list for a stage. */
export interface ChecklistItem {
  id: string;
  text: string;
  /** How it reads while in progress: "Writing the login form". */
  doing?: string;
  status: "pending" | "in_progress" | "completed";
  /** Removed by Claude. Kept, hidden, so the items after it keep the numbers Claude Code gave them. */
  deleted?: true;
}

export interface TaskQuestion {
  id: string;
  stage_index: number;
  text: string;
  options: string[];
  /** What the run is doing meanwhile. */
  default: string | null;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

/**
 * A supervised run works in your main checkout, which other sessions may be changing too. What was
 * already uncommitted when it started, and what this task changed, so the two are never mixed up (D204).
 */
export interface CheckoutState {
  at: string;
  /** Uncommitted files that were there before the run, not this task's. */
  dirtyAtStart: string[];
  /** Files this task added or changed, set when the run ends; null while it runs. */
  touched: string[] | null;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  modelEcho: string | null;
  usageReported: boolean;
  costReported: boolean;
  error: string | null;
}

/** Where a run's cost figure came from — kept on the run because prices can be edited later (D123). */
export type CostSource = "sdk" | "estimated" | "subscription" | "provider";
export type RunRole = "stage" | "critic";

/**
 * Claude's own effort levels and the notes Claude Code shows for them, word for word
 * (code.claude.com/docs/en/model-config). `high` is Claude's default.
 */
export const EFFORT_NOTES: Record<Effort, string> = {
  low: "Fastest and cheapest",
  medium: "Reduces token usage",
  high: "Default on most models",
  xhigh: "Deeper reasoning at higher token spend",
  max: "Demanding tasks needing maximum reasoning",
};
export const DEFAULT_EFFORT: Effort = "high";

/** Fast mode is an Opus-only configuration (code.claude.com/docs/en/fast-mode). */
export const supportsFastMode = (model: string): boolean => /opus-(5|4-8)(?![0-9])/.test(model);

/** What the CLI reports about fast mode for this account, read without making a model call. */
export interface FastModeStatus {
  state: "on" | "off" | "cooldown";
  /** Claude's reason code, e.g. "extra_usage_disabled", or null when nothing blocks it. */
  reason: string | null;
  /** The same thing in plain words. */
  message: string;
  checked_at: string;
}

export interface Policy {
  worktrees: "allowed" | "forbidden";
  autonomous: "allowed" | "forbidden";
  maxConcurrent: number;
  defaultPipeline?: Stage[];
}

/** How a task's workspace is prepared and checked. All optional; empty means "do nothing". */
export interface ProjectEnv {
  /** Extra gitignored files to copy into a new worktree (on top of the repo's .worktreeinclude). */
  worktreeInclude: string[];
  /** Shell command run once in a fresh worktree (dependency install, codegen). */
  setupCommand: string | null;
  /** Command that must pass before a task reaches review (tests / typecheck / build). */
  verifyCommand: string | null;
  /** The only labels triage may use. Closed on purpose: a model that mints labels causes label sprawl. */
  labels: string[];
  /** What the human said when an empty folder was bootstrapped, kept for the record. */
  onboarding: { goal: string; stack: string; verify: string } | null;
}

/** How a finished branch lands. `rebase` replays the task's commits; `squash` lands one commit. */
export type MergeStrategy = "merge" | "rebase" | "squash";
/** What happens when bringing the base into a task branch hits a conflict. */
export type ConflictPolicy = "ask" | "claude";

/**
 * Landing policy. The point of every option here is that conflicts are resolved **in the task's
 * worktree**, never in the checkout you are sitting in: the branch is brought up to date with the
 * base first, so the final merge into the base cannot conflict.
 */
export interface MergePolicy {
  /** Branch finished work lands on. null = whatever the main checkout currently has out. */
  baseBranch: string | null;
  /** Bring the base into the task branch (inside its worktree) before landing it. */
  updateBeforeMerge: boolean;
  strategy: MergeStrategy;
  /** Re-run the project's verify command after that update, before landing. */
  verifyBeforeMerge: boolean;
  onConflict: ConflictPolicy;
}

export const DEFAULT_MERGE: MergePolicy = {
  baseBranch: null,
  updateBeforeMerge: true,
  strategy: "merge",
  verifyBeforeMerge: true,
  onConflict: "ask",
};

export interface Project {
  id: string;
  name: string;
  path: string;
  policy: Policy;
  env: ProjectEnv;
  merge: MergePolicy;
  created_at: string;
  /** The board's own hidden project (Setup). Never listed. */
  system?: boolean;
}

export const EMPTY_ENV: ProjectEnv = { worktreeInclude: [], setupCommand: null, verifyCommand: null, labels: [], onboarding: null };

export interface Task {
  id: string;
  project_id: string;
  parent_id: string | null;
  milestone_id: string | null;
  title: string;
  spec_md: string;
  status: TaskStatus;
  type: TaskType;
  priority: Priority;
  labels: string[];
  /** Task ids that must reach done before this one may start. */
  depends_on: string[];
  /** Earlier tasks this one follows up on: history a new session should know about. */
  related_to: string[];
  /** Queue this task's subtasks automatically as their dependencies clear. */
  auto_queue_children: boolean;
  /** Wait for the human after the plan stage. null follows Settings → planApproval (D231). */
  plan_approval: boolean | null;
  /** Touches a live system (production data, a live business app…): plan approval is forced on and review runs on Settings → liveReviewModel (D233). */
  live: boolean;
  /** A supervised task that still works in its own worktree and branch, landing only on Approve (D234). Autonomous always does. */
  own_branch: boolean;
  /** The side chat that made this card: its result, failure, plan or question is posted back there (D285). */
  chat_id: string | null;
  /** Set when the board classified this task, so the UI can show it was a guess. */
  triaged_at: string | null;
  /** Hidden from the board when set. Purely visual — the task, its runs and its history stay. */
  archived_at: string | null;
  /** When the task became done, or null while it is not. Unlike updated_at, archiving or editing it later does not move this. */
  done_at: string | null;
  /** When a task paused by a usage limit will pick up again (ISO time), or null. */
  resume_at: string | null;
  /**
   * Why the task is paused: Claude's usage limit (resumes by itself), a cost ceiling (waits for
   * Continue), or a delegated provider that ran out (resumes by itself when resume_at is set, else
   * waits for you to switch or top up).
   */
  pause_reason: "limit" | "cost" | "provider" | null;
  /** Extra dollars granted to this task by pressing Continue, on top of the global per-task ceiling. */
  budget_extra_usd: number;
  /**
   * A scheduled start for a Backlog card: an ISO time, or "reset" for when the Claude 5-hour usage
   * window next resets. Cleared once it fires (or the card is started by hand).
   */
  start_at: string | null;
  /** Set on the tasks the board creates to set a project up; approval reads a verify command out of them. */
  onboarding: "init" | "bootstrap" | null;
  /**
   * Triage's unapplied suggestions, or null. Nothing here is ever applied on its own: a wrong guess
   * that changed how a task runs would cost real money, so the human accepts or keeps the default.
   */
  suggestion: {
    priority?: Priority;
    type?: TaskType;
    labels?: string[];
    confidence?: number;
    /** A pipeline sized to this task: fewer/cheaper stages for small work, stronger for hard work. */
    pipeline?: Stage[];
    /** One sentence saying why that pipeline, shown next to the Accept button. */
    sizing_reason?: string;
    /** Supervised, when an autonomous task needs a live system (D191). No longer proposed (D241); kept so older cards still show theirs. */
    mode?: Mode;
    mode_reason?: string;
    /** Mark the task live: triage saw that it changes a live system (D191, D241). */
    live?: boolean;
    live_reason?: string;
  } | null;
  /** Set while a debated plan waits for your choice; the pipeline continues once you decide. */
  plan_gate: PlanGate | null;
  /** Set when a stage stopped because it could not do the work from where it ran; cleared on the next queue. */
  blocked: Blocked | null;
  /** Questions stages asked with `board_ask`, answered or not. */
  questions: TaskQuestion[];
  /** Claude's own to-do list for the stage it is running (or last ran), shown on the card. D252. */
  checklist: ChecklistItem[];
  /** Supervised runs: the checkout's state around the run. */
  checkout: CheckoutState | null;
  mode: Mode;
  pipeline: Stage[];
  skills: string[];
  branch: string | null;
  worktree_path: string | null;
  base_sha: string | null;
  summary: string | null;
  note: string | null;
  error: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

/**
 * A repeating schedule: a card template. Each time it comes round, a fresh card is made from it and
 * queued — the template itself never runs, so earlier results are never overwritten.
 */
export interface Schedule {
  id: string;
  project_id: string;
  title: string;
  spec_md: string;
  mode: Mode;
  type: TaskType;
  priority: Priority;
  pipeline: Stage[];
  skills: string[];
  /** Days of the week it runs on, 0 = Sunday … 6 = Saturday, in the computer's local time. */
  days: number[];
  /** "HH:MM", 24-hour, local time. */
  time: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_task_id: string | null;
  created_at: string;
}

/** A side-chat conversation about one project: one resumable Claude session. */
export interface Chat {
  id: string;
  project_id: string;
  title: string;
  session_id: string | null;
  model: string;
  effort: Effort;
  /** Where the model runs: "anthropic" (Claude) or a Claude-compatible provider's id (D301). */
  provider: string;
  cost_usd: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** True while a reply is being written (not stored). */
  busy?: boolean;
}

/** What a card the chat made did by itself, posted into that chat by the board — no model call (D285). */
export interface ChatUpdate {
  id: string;
  title: string;
  kind: "finished" | "failed" | "plan" | "question";
  status: TaskStatus;
  /** The answer or outcome, why it failed, the plan's first lines, or the question. */
  text: string;
  question_id?: string;
  options?: string[];
  cost_usd?: number;
}

/**
 * One line of a side chat. `tool` rows are the quiet "read server/src/db.ts" lines; `meta.cards` are
 * task cards the chat created, queued, scheduled or talked to, shown as cards you can act on. `update`
 * rows are written by the board, not the model, when one of the chat's cards moves on.
 */
export interface ChatMessage {
  id: number;
  chat_id: string;
  role: "user" | "assistant" | "tool" | "error" | "update";
  text: string;
  meta: { cards?: { id: string; title: string; action: "created" | "updated" | "queued" | "scheduled" | "messaged" | "answered" | "stopped" | "retried" }[]; cost_usd?: number; update?: ChatUpdate };
  ts: string;
}

export interface Run {
  id: string;
  task_id: string;
  stage: StageName;
  stage_index: number;
  session_id: string | null;
  model: string;
  effort: Effort;
  /** null = Claude through your login; otherwise a `Settings.providers[].id`. */
  provider: string | null;
  /** "critic" runs belong to a plan debate: shown in the transcript and costs, ignored by stage bookkeeping (D132). */
  role: RunRole;
  cost_source: CostSource;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  result_md: string | null;
  error: string | null;
  /** Tokens held in the session's context at the last assistant turn, and the model's window size. */
  context_tokens: number;
  context_window: number;
  /** Of the input: what was re-read from the prompt cache, and what was written to it (D276). */
  cache_read_tokens: number;
  cache_write_tokens: number;
  /**
   * Spent on models other than the stage's own within this run: its helpers (browser-check,
   * the browser-check helper and Claude Code's own small calls. Part of cost_usd, not added to it.
   */
  other_models_usd: number;
  /**
   * Five-hour subscription window usage (0–1) as the CLI reported it when this run started and when
   * it ended. The difference is what this run cost you of the thing that actually runs out.
   */
  limit_before: number | null;
  limit_after: number | null;
}

/** One line of durable project memory: a decision or convention worth carrying into later tasks. */
export interface Note {
  id: string;
  project_id: string;
  task_id: string | null;
  text: string;
  source: "agent" | "board" | "user";
  /**
   * A lesson is something to follow (a decision, a convention, a gotcha); an outcome is what an
   * approved task did. Outcomes only reach a prompt when they match its task (D307).
   */
  kind: "lesson" | "outcome";
  ts: string;
  /** A run said this note is wrong or stale. It stays out of prompts until you keep or delete it (D308). */
  flag: { reason: string; at: string; task_id: string | null } | null;
  /** Tasks whose prompts carried this note and that were approved, or sent back, in the end. */
  approved: number;
  sentBack: number;
}

/** A subscription usage window as reported by the CLI (Claude Code shows the same numbers). */
export interface UsageLimit {
  type: string; // five_hour | seven_day | seven_day_opus | ...
  status: "allowed" | "allowed_warning" | "rejected";
  utilization: number | null; // 0..1
  resets_at: number | null; // epoch seconds
  updated_at: string;
}

export type StageState = "idle" | RunStatus;

/** Task plus what the board card needs: latest run state per pipeline stage and total cost. */
export interface TaskCard extends Task {
  stage_states: StageState[];
  cost_usd: number;
}

/** Run joined with its task/project for the Sessions view. */
export interface RunListItem extends Run {
  task_title: string;
  project_id: string;
  project_name: string;
}

export interface EventRow {
  id: number;
  run_id: string;
  ts: string;
  type: string;
  payload: unknown;
}

export interface Message {
  id: string;
  task_id: string;
  from_task_id: string | null;
  from_run_id: string | null;
  body: string;
  ts: string;
}

/**
 * An image belonging to a task: one you attached, or one a session produced — a screenshot it took,
 * or an image file it wrote. Stored under the state dir, never inside the project.
 */
export interface Attachment {
  id: string;
  task_id: string;
  run_id: string | null;
  source: "user" | "run";
  name: string;
  media_type: string;
  bytes: number;
  /** Absolute path on disk. Runs are given this path so they can read the image. */
  path: string;
  /** Where a run-produced image came from, e.g. "screenshot" or the tool that wrote it. */
  note: string | null;
  /**
   * What is in the image, written once by the cheap vision model so the expensive stages never have
   * to open it. null while it is still being described, or if describing failed.
   */
  description: string | null;
  /** Which provider and model wrote the description ("claude · claude-haiku-4-5…"), and whether it was the fallback. */
  described_by?: string | null;
  created_at: string;
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * What a task may hold, by extension. The extension is the authority, not the browser's guess at a
 * media type — browsers disagree about .csv in particular, and a stored type we chose ourselves is
 * the one we have to trust later when serving the bytes back.
 */
export const ATTACHMENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain", ".md": "text/markdown", ".log": "text/plain",
  ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml", ".xml": "text/xml",
  ".html": "text/html", ".htm": "text/html",
};

export type AttachmentKind = "image" | "text" | "document";

/** How the UI shows it and how the board previews it. Driven by the stored media type. */
export function attachmentKind(mediaType: string): AttachmentKind {
  if (mediaType.startsWith("image/") && mediaType !== "image/svg+xml") return "image";
  if (mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "image/svg+xml") return "text";
  return "document";
}

/** Extensions a run's output is worth keeping. Source files are already in the diff; these are not. */
export const ARTIFACT_EXTS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".csv", ".tsv", ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".html", ".htm",
];

export interface Approval {
  id: string;
  run_id: string;
  task_id: string;
  /** Denormalised so the approvals inbox needs no extra request per card. */
  task_title?: string;
  project_id?: string;
  tool_name: string;
  input: unknown;
  title: string | null;
  decision: ApprovalDecision | null;
  decided_at: string | null;
  note: string | null;
  /** Your answers to a question card: question text → chosen label(s), or what you typed. */
  answers: Record<string, string> | null;
  created_at: string;
}

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  position: number;
  due_date: string | null;
  notes: string | null;
}

export interface ModelEntry {
  id: string;
  label: string;
  note?: string;
}

export interface Settings {
  models: ModelEntry[];
  defaultPipeline: Stage[];
  globalCap: number;
  defaultMaxConcurrent: number;
  /**
   * Run one task at a time: it finishes and commits before the next starts. Overrides `globalCap`
   * without overwriting it, so turning this off restores the number you had.
   */
  serial: boolean;
  /** How many tasks "Run now" may start alongside the queue, outside the caps. */
  maxForcedParallel: number;
  stateDir: string;
  /** Skills switched off on the board: hidden from every run (unless a task attaches one explicitly). */
  disabledSkills: string[];
  /** Ceilings per stage so an unattended run can't loop or overspend. */
  maxTurnsPerStage: number;
  maxCostPerStageUsd: number;
  /** Ceiling for a whole task, across every stage and retry. A 3-stage task could otherwise cost 3×. */
  maxCostPerTaskUsd: number;
  /** Stop a stage that calls the same tool with the same arguments this many times in a row. */
  maxRepeatedToolCalls: number;
  /** Days of run transcripts to keep. Runs, costs and results are never pruned — only the detail. */
  eventRetentionDays: number;
  /** Commands refused outright, in both modes, whatever the model or a settings file says. */
  blockedCommands: string[];
  /** Blast-radius limits for subagents a run spawns. */
  maxSubagentDepth: number;
  maxConcurrentSubagents: number;
  /** Strip per-session dynamic sections from the system prompt so it caches across runs. */
  cacheableSystemPrompt: boolean;
  /**
   * Load your ~/.claude plugins, hooks and skills into every run. Measured at ~5,400 input tokens
   * per stage (~12%), paid whether a task uses them or not. Project settings (CLAUDE.md) always load.
   */
  loadUserPlugins: boolean;
  /**
   * Let Claude Code's own auto memory (~/.claude/projects/<repo>/memory, shared with your own sessions)
   * load into runs and be written by them. Off by default: the board's project memory is the one you
   * can see and edit, and a second memory could contradict it (D306).
   */
  claudeAutoMemory: boolean;
  /** Classify new tasks (type, priority, labels) automatically. */
  autoTriage: boolean;
  /** Cheap model used for intake: classification and spec refinement. */
  triageModel: string;
  /** Cheap model that looks at attached images once and writes down what is in them. */
  visionModel: string;
  /** Where the vision model runs: "anthropic" (Claude, the default) or a provider id from Settings → Providers. */
  visionProvider: string;
  /** Who makes pictures for runs (`generate_image`), or "off". D262; Codex D297. */
  imageProvider: ImageProvider;
  /** The Codex model that makes pictures; "" lets the board pick the newest Luna (D297). */
  imageModel: string;
  /** What the board learned about Codex making pictures here. Written by the board, not by Settings. */
  codexPictures: CodexPictures;
  /** Per picker, the models it does not list: "provider:model". A hide-list, so new models show by themselves (D300). */
  hiddenModels: Record<ModelSurface, string[]>;
  /** Cloudflare account id (dashboard → Workers AI). Not a secret; the API token lives in the secret store. */
  cloudflareAccountId: string;
  /**
   * What "cheap / balanced / strong" mean here. Sizing picks a tier, never a model id, so it cannot
   * invent one — and changing model here changes every future sizing at once.
   */
  tiers: { cheap: TierRef; balanced: TierRef; strong: TierRef };
  /** Other places a stage can run: compatible endpoints, plain chat APIs, other agents' CLIs. */
  providers: Provider[];
  /** A second model critiques every plan before code starts, unless a stage says otherwise. */
  debate: DebateSettings;
  /** Wall-clock ceiling for a stage on a provider the board cannot meter mid-run (HTTP, CLI). */
  delegateTimeoutMin: number;
  /** Let the board propose a pipeline sized to each new task (you still accept it). */
  autoSizing: boolean;
  /**
   * When a run is stopped by a subscription usage limit, pause the task and resume it — in the same
   * session, from the stage it was on — once the window resets, instead of marking it failed.
   */
  autoResume: boolean;
  /**
   * When Claude's usage runs out mid-task, carry the stage on here (a provider and model) instead of
   * waiting for the window to reset. null waits (D225).
   */
  claudeFallback: TierRef | null;
  /** Tell the OS not to sleep while anything is queued, running or scheduled. The screen may still turn off. */
  keepAwake: boolean;
  /**
   * When Claude asks you a question mid-task and nobody answers: 0 waits for your answer however long it
   * takes; N > 0 waits N minutes, then Claude picks the most sensible option and says which.
   */
  questionWaitMin: number;
  /** The side chat's model and effort: a balance of quality and price for questions about code. */
  chatModel: string;
  chatEffort: Effort;
  /** Where the default chat model runs: "anthropic" (Claude) or a Claude-compatible provider's id (D301). */
  chatProvider: string;
  /** The Spec section's ✦ Rewrite: Opus by default — it reads the code first, and a good spec saves a whole run. */
  specModel: string;
  specEffort: Effort;
  /**
   * Give runs their own browser (Playwright, headless, one per session) and ask the code and review
   * stages to look at anything visible they changed. Local pages only unless you approve otherwise.
   */
  browserChecks: boolean;
  /** Also offer Claude in Chrome — your own signed-in Chrome — to supervised runs. Never autonomous ones. */
  chromeInSupervised: boolean;
  /**
   * Supervised runs run shell commands that can only read (grep, ls, git log, sed -n …) without an
   * approval card. Anything that could write, run a program or touch credentials still asks (D202).
   */
  autoAllowReadOnly: boolean;
  /**
   * Tasks use MarkItDown (once it is in your Claude Code) like a read: a web page or a file in the
   * folders the task may read, without a card; any other file is refused (autonomous) or asked (D316).
   */
  markitdownInTasks: boolean;
  /** Every task waits for the human after its plan stage (a task can override it). D231. */
  planApproval: boolean;
  /** A stage that hits maxTurnsPerStage continues in the same session this many times before failing. D232. */
  autoContinueTurns: number;
  /** Claude model the review stage of a live task runs on, whatever its pipeline says. D233. */
  liveReviewModel: string;
  /**
   * When your Claude login gets a newer model of a family your settings name (Opus 5 → Opus 5.5), move
   * every such pick to it and say so. Off: Settings only offers the move. D250.
   */
  followLatestModels: boolean;
  /**
   * Who drives the browser for a stage's visual check: the stage itself ("stage", the default) or a
   * cheaper helper. Measured over four whole runs (D273): the helper halves what the stage re-reads
   * but checks far more, so a task costs about the same and takes a little longer — more thorough, not cheaper.
   */
  browserCheckModel: HelperModel;
  /** Get newer versions of Claude's engine when the board starts, so new models show up. D249. */
  autoUpdateEngine: boolean;
  /** The last time picks were moved to newer models, and which — shown in Settings so it is never silent. */
  lastModelMove: { at: string; moves: ModelMove[] } | null;
  /** Stream a live picture of each task's browser into its card (only while someone is watching). */
  liveView: boolean;
  /** Landing policy new projects start with. */
  defaultMerge: MergePolicy;
  /** Markdown checklist the bootstrap task follows for an empty project. Empty means the shipped default. */
  onboardingChecklist: string;
}

/** What a run actually receives, read from a session's init message (never reaches the model). */
export interface SessionTools {
  plugins: { name: string; version: string | null; source: string | null }[];
  servers: {
    name: string;
    status: string;
    /** -1 for the board's own server, which every run has but this check does not start. */
    tools: number;
    /** How the board treats this server's tools, in plain words. */
    rule: string;
  }[];
  skills: number;
  commands: number;
  /** Whether your global plugins were loaded (Settings → Runs & limits). */
  userPlugins: boolean;
  checked_at: string;
  error: string | null;
}

export interface SkillInfo {
  name: string; // qualified: "pdf", "superpowers:brainstorming"
  description: string;
  source: "user" | "project" | "plugin";
  plugin?: string;
  /** Its plugin is enabled in ~/.claude/settings.json (always true for user/project skills). */
  pluginEnabled: boolean;
  /** The board's own on/off switch — what runs actually get. */
  enabled: boolean;
  path: string; // SKILL.md
}

export interface DiffFile {
  file: string;
  status: string;
  patch: string;
}

/** One row on the Setup page (server/src/setup). Detected on request, never stored. */
export interface SetupCheckResult {
  id: string;
  title: string;
  level: "required" | "recommended" | "optional" | "info";
  why: string;
  ok: boolean;
  detail: string;
  /** Works, but not the way you probably mean it: shown amber. */
  warn: boolean;
  /** The one thing to press now, posted to the board's own endpoint ("Use it" → /codex/link). */
  action: { label: string; endpoint: string } | null;
  /** What the page may offer: a built-in command, a supervised Claude session, Claude's own login. */
  fixes: ("run" | "claude" | "login")[];
  /** The one-click button's word ("Install" when null). */
  runLabel: string | null;
  /** Fields the built-in fix needs (git name and email). */
  form: { name: string; label: string; placeholder: string }[] | null;
  /** The usual command(s) on this OS, to copy. */
  manual: string | null;
  link: { label: string; href: string } | null;
  running: boolean;
  /** The open "Fix with Claude" task for this check, if any. */
  taskId: string | null;
}

export type WsMessage =
  | { type: "event"; runId: string; taskId: string; event: EventRow }
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; taskId: string }
  | { type: "schedule.updated"; schedule: Schedule }
  | { type: "chat.updated"; chat: Chat }
  /** A task's browser opened or closed: the board shows a "watch" chip on its card while live. */
  | { type: "browser.live"; taskId: string; live: boolean }
  | { type: "chat.deleted"; id: string; project_id: string }
  | { type: "chat.message"; message: ChatMessage }
  /** Words of a reply as they are written; only sent to clients watching that chat. */
  | { type: "chat.delta"; chatId: string; text: string }
  | { type: "spec.rewrite"; taskId: string; state: "running" | "done" | "failed" | "stopped"; note?: string; error?: string }
  | { type: "schedule.deleted"; id: string; project_id: string }
  | { type: "run.updated"; run: Run }
  | { type: "run.finished"; run: Run }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.decided"; approval: Approval }
  | { type: "message.posted"; message: Message }
  | { type: "attachment.added"; attachment: Attachment }
  | { type: "project.updated"; project: Project }
  /** A project was removed, with its tasks: other open tabs drop it without waiting for a reload. */
  | { type: "project.deleted"; id: string }
  | { type: "milestone.updated"; milestone: Milestone }
  | { type: "settings.updated"; settings: Settings }
  | { type: "limits.updated"; limits: UsageLimit[] }
  /** A delegated provider ran out, or came back. */
  | { type: "providers.out"; out: ProviderOut[] }
  | { type: "setup.updated"; check: SetupCheckResult }
  | { type: "setup.output"; id: string; chunk: string }
  | { type: "codex.updated"; status: { found: boolean; command: string; version: string | null; signedIn: "chatgpt" | "api-key" | null; line: string; linked: boolean } }
  | { type: "health.updated"; health: { loggedIn: boolean; authMethod: string | null; cliVersion: string | null; sdkVersion: string; error: string | null; checkedAt: string } };
