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
export type ApprovalDecision = "allow" | "deny" | "expired";

export const TASK_STATUSES: TaskStatus[] = ["backlog", "queued", "planning", "running", "approval", "paused", "review", "done", "failed"];
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

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
  group: "local" | "cloud" | "loaded" | "downloaded" | "free" | "paid" | "saved";
  inputPer1M?: number;
  outputPer1M?: number;
  contextWindow?: number;
  /** Local providers: false for a model that is not pulled / downloaded yet. */
  installed?: boolean;
  /** Why this model may fail as a stage, e.g. loaded with too little context. */
  warning?: string;
}

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
  cli?: { preset: CliPreset; command?: string; extraArgs?: string[]; envPassthrough?: string[] };
  /** cli only: may it run on code stages and change files? Off by default — see D129. */
  mayEditFiles: boolean;
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
export interface PlanGate {
  stage_index: number;
  critic_run_id: string;
  critic: { provider: string; model: string };
  created_at: string;
  original: string;
  critique: { raw: string; objections: Objection[] };
  revised: string;
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
  /** Set when the board classified this task, so the UI can show it was a guess. */
  triaged_at: string | null;
  /** Hidden from the board when set. Purely visual — the task, its runs and its history stay. */
  archived_at: string | null;
  /** When a task paused by a usage limit will pick up again (ISO time), or null. */
  resume_at: string | null;
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
  } | null;
  /** Set while a debated plan waits for your choice; the pipeline continues once you decide. */
  plan_gate: PlanGate | null;
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
  ts: string;
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
  /** Classify new tasks (type, priority, labels) automatically. */
  autoTriage: boolean;
  /** Cheap model used for intake: classification and spec refinement. */
  triageModel: string;
  /** Cheap model that looks at attached images once and writes down what is in them. */
  visionModel: string;
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
   * Give runs their own browser (Playwright, headless, one per session) and ask the code and review
   * stages to look at anything visible they changed. Local pages only unless you approve otherwise.
   */
  browserChecks: boolean;
  /** Also offer Claude in Chrome — your own signed-in Chrome — to supervised runs. Never autonomous ones. */
  chromeInSupervised: boolean;
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
  | { type: "run.updated"; run: Run }
  | { type: "run.finished"; run: Run }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.decided"; approval: Approval }
  | { type: "message.posted"; message: Message }
  | { type: "attachment.added"; attachment: Attachment }
  | { type: "project.updated"; project: Project }
  | { type: "milestone.updated"; milestone: Milestone }
  | { type: "settings.updated"; settings: Settings }
  | { type: "limits.updated"; limits: UsageLimit[] }
  | { type: "setup.updated"; check: SetupCheckResult }
  | { type: "setup.output"; id: string; chunk: string }
  | { type: "health.updated"; health: { loggedIn: boolean; authMethod: string | null; cliVersion: string | null; sdkVersion: string; error: string | null; checkedAt: string } };
