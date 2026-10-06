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
/** The first line of an answer stage's prompt: what makes a `custom` stage an answer (D284). */
export const ANSWER_HEAD = "Answer the request below: find what it asks for and report it.";
type StageKind = { stage: StageName; prompt?: string };
export const isAnswerStage = (s: StageKind): boolean => s.stage === "custom" && Boolean(s.prompt?.startsWith(ANSWER_HEAD));
export const isAnswerPipeline = (p: StageKind[]): boolean => p.length > 0 && p.every(isAnswerStage);
/**
 * A lookup under autonomous: it runs in the project's own folder with nobody asked, because a sandboxed
 * copy could not reach the live system it reads from (D352). Only where the project's access says so.
 */
export const isHandsOff = (t: { mode: Mode; pipeline: StageKind[] }): boolean => t.mode === "autonomous" && isAnswerPipeline(t.pipeline);
/**
 * Whether a task works in its own git worktree: an autonomous task that changes something, and a
 * supervised one with own_branch (D234). A lookup changes nothing, so it never needs one. An autonomous
 * task stamped `in_folder` works in the project folder instead (Settings → autonomousWorktree off, or a
 * folder without git, D398, D399).
 */
export const usesWorktree = (t: { mode: Mode; own_branch?: boolean; in_folder?: boolean; pipeline?: StageKind[] }): boolean =>
  (t.mode === "autonomous" && !isAnswerPipeline(t.pipeline ?? []) && !t.in_folder) || Boolean(t.own_branch);
/** An autonomous task that changes something but works in the project folder, not a worktree (D398). */
export const worksInFolder = (t: { mode: Mode; own_branch?: boolean; in_folder?: boolean; pipeline?: StageKind[] }): boolean =>
  t.mode === "autonomous" && !isAnswerPipeline(t.pipeline ?? []) && Boolean(t.in_folder) && !t.own_branch;
/**
 * A task that changes files in the project folder itself, where another such task would be changing
 * them too: supervised without its own branch, and autonomous in the folder (D400). Lookups change nothing.
 */
export const sharesProjectFolder = (t: { mode: Mode; own_branch?: boolean; in_folder?: boolean; pipeline?: StageKind[] }): boolean =>
  !isAnswerPipeline(t.pipeline ?? []) && ((t.mode === "supervised" && !t.own_branch) || worksInFolder(t));
/**
 * Where an autonomous task that has not run yet will work: in the folder when the setting says so or
 * the project has no git (D398, D399). The same rule the runner stamps on the task when it is queued.
 */
export const plannedInFolder = (t: { mode: Mode; own_branch?: boolean; in_folder?: boolean; worktree_path?: string | null; pipeline?: StageKind[] }, autonomousWorktree: boolean, isGit: boolean): boolean =>
  t.mode === "autonomous" && !isAnswerPipeline(t.pipeline ?? []) && !t.own_branch && !t.worktree_path && (Boolean(t.in_folder) || !autonomousWorktree || !isGit);

/**
 * How a task runs, as the forms and cards name it: the two modes, plus "ask" — "Autonomous + asks me",
 * an autonomous task with `may_ask` on (D361). Stored as mode + may_ask, never as a third Mode.
 */
export type RunStyle = Mode | "ask";
export const RUN_STYLES: RunStyle[] = ["supervised", "autonomous", "ask"];
export const runStyleOf = (t: { mode: Mode; may_ask?: boolean }): RunStyle => (t.mode === "autonomous" && t.may_ask ? "ask" : t.mode);
export const runStyleFields = (s: RunStyle): { mode: Mode; may_ask: boolean } => (s === "ask" ? { mode: "autonomous", may_ask: true } : { mode: s, may_ask: false });
export const RUN_STYLE_LABEL: Record<RunStyle, string> = { supervised: "Supervised", autonomous: "Autonomous", ask: "Autonomous + asks me" };

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

/**
 * How long a plan debate goes on. `once`: one critique and one revision, and both models are told
 * there is no second round. `rounds`: up to `rounds` critique–revision rounds, the models told which
 * round is the last. `until_agree`: rounds until the critic has no objections left, under a fixed
 * ceiling so a stubborn pair cannot spend without end (D339).
 */
export type DebateMode = "once" | "rounds" | "until_agree";
export const DEBATE_MODES: DebateMode[] = ["once", "rounds", "until_agree"];
/** No debate runs past this many rounds, whatever the mode: an unbounded argument just spends money. */
export const DEBATE_ROUND_CEILING = 10;

export interface DebateSettings {
  enabled: boolean;
  critic: { provider: string; model: string; effort: Effort };
  mode: DebateMode;
  /** The number of rounds in `rounds` mode (2–10). Ignored by the other modes. */
  rounds: number;
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
  /** How many critique–revision rounds ran before the gate (absent = one). */
  rounds?: number;
  /** True when the debate ended because the critic had no objections left to the revised plan. */
  agreed?: boolean;
}

/**
 * A stage that could not do the task from where it ran — the sandbox refused what it needed, or it
 * needs a decision or information from you. The pipeline stops there instead of carrying a "success"
 * nobody earned into review (docs/DECISIONS.md D184). The one exception is `advisory` (D382).
 */
export interface Blocked {
  /**
   * Set when an autonomous run said part of the task needs a supervised run and carried on with the
   * rest: shown on the card as a suggestion, it does not stop the pipeline (D382). Absent = it stopped.
   */
  advisory?: boolean;
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
  /**
   * What access the run was missing, named so the card can ask for exactly that — a sign-in to a site,
   * a key file, a host — and run the stage again once it is there (D410). Required with needs "supervised"
   * from an autonomous run; a run that cannot name it is not missing access.
   */
  needs_access?: NeedsAccess;
  created_at: string;
}

export interface NeedsAccess {
  kind: "sign_in" | "key_file" | "host" | "other";
  /** The site to sign in to, the key file's name, the host, or a few words. */
  target: string;
}

/** The card's line while the board makes a task's own copy of the project (D192, D395, D416). */
export const PREPARING_COPY = "Making its own copy of the project — a minute or two on a big one";

/** The block that stopped the task, if one did: a suggestion the run carried on past is not one (D382). */
export const stoppedBy = (t: { blocked: Blocked | null }): Blocked | null => (t.blocked && !t.blocked.advisory ? t.blocked : null);

/** The card's "Your turn" words for a run that lacked access: what to give it, in one phrase (D410). */
export function accessAsk(b: Pick<Blocked, "needs_access" | "reason"> | null | undefined): string | null {
  const a = b?.needs_access;
  if (!a) return null;
  switch (a.kind) {
    case "sign_in":
      return `Sign in to ${a.target}`;
    case "key_file":
      return `Add the key file ${a.target}`;
    case "host":
      return `Allow it to reach ${a.target}`;
    default:
      return `Give it ${a.target}`;
  }
}

/** Whether a sign-in to `host` is the access this block waited for (the site, or one of its subdomains). */
export function unlockedBySignIn(b: Pick<Blocked, "needs_access"> | null | undefined, host: string): boolean {
  const a = b?.needs_access;
  if (!a || a.kind !== "sign_in") return false;
  const want = a.target.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
  const got = host.toLowerCase();
  return want === got || want.endsWith(`.${got}`) || got.endsWith(`.${want}`);
}

/**
 * Where a supervised rerun starts after a suggestion (D382). The stage that made it finished, so a plan
 * is not made again: the access is needed by the stage that changes things — the first code or custom
 * stage from there on, or else the last one before it (a review that saw live steps left undone).
 */
export function supervisedFrom(pipeline: { stage: StageName }[], from: number): number {
  const writes = (i: number) => pipeline[i]?.stage === "code" || pipeline[i]?.stage === "custom";
  for (let i = from; i < pipeline.length; i++) if (writes(i)) return i;
  for (let i = Math.min(from, pipeline.length - 1); i >= 0; i--) if (writes(i)) return i;
  return Math.max(0, Math.min(from, pipeline.length - 1));
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
  /** The option the run recommends, exactly as in `options` (D386). Older questions have none. */
  recommended?: string | null;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

const optionKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const optionLetter = (s: string) => /^\(?([a-z0-9])[).:]\s/i.exec(s.trim())?.[1]?.toLowerCase() ?? null;

/**
 * The option a card question recommends: the one the run named, or else the one its default is — a
 * default that starts with the option, or with the same "B)" letter. Null when none matches (D386).
 */
export function recommendedOption(q: Pick<TaskQuestion, "options" | "default" | "recommended">): string | null {
  const named = q.recommended ? q.options.find((o) => optionKey(o) === optionKey(q.recommended!)) : undefined;
  if (named) return named;
  if (!q.default) return null;
  const d = optionKey(q.default);
  const letter = optionLetter(q.default);
  return q.options.find((o) => d.startsWith(optionKey(o)) || optionKey(o).startsWith(d) || (letter !== null && optionLetter(o) === letter)) ?? null;
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
  /** What an autonomous lookup may reach (D352). Absent on older projects: read it with `accessOf`. */
  access?: AutonomousAccess;
  /** Commands that run without a card in this project: what "Always allow" on a card adds (D353). */
  trusted?: string[];
}

/**
 * `sandboxed`: autonomous stays in its own copy, and a lookup that needs a live system runs supervised.
 * `full`: an autonomous lookup runs in the project's own folder and nothing is asked.
 */
export type AutonomousAccess = "sandboxed" | "full";
export const accessOf = (p: Pick<Policy, "access">): AutonomousAccess => p.access ?? "full";

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
  /**
   * Do that as soon as the base moves, for every card waiting in Review, instead of only at Approve (D413):
   * the card is always up to date, and a conflict goes to Claude at once (when `onConflict` is "claude")
   * rather than when someone presses Approve. Off: the card shows how far behind it is and an Update button.
   */
  autoUpdateFromBase: boolean;
  strategy: MergeStrategy;
  /** Re-run the project's verify command after that update, before landing. */
  verifyBeforeMerge: boolean;
  onConflict: ConflictPolicy;
  /**
   * A conflict Claude resolved while you were approving lands by itself once every check passes. Off:
   * it waits in Review for you to approve again. A resolution started with Fix now always waits.
   */
  autoLandResolved: boolean;
  /** Who double-checks a resolution. null: the model that wrote the task (D357). */
  resolveReviewer: { provider: string; model: string; effort: Effort } | null;
  /**
   * Files every task only adds to — a decisions log, a changelog. Merged by keeping both sides' new
   * lines (git's union merge), so two tasks that each added an entry never conflict over it (D404).
   */
  unionFiles: string[];
}

export const DEFAULT_MERGE: MergePolicy = {
  baseBranch: null,
  updateBeforeMerge: true,
  autoUpdateFromBase: true,
  strategy: "merge",
  verifyBeforeMerge: true,
  onConflict: "claude",
  autoLandResolved: true,
  resolveReviewer: null,
  unionFiles: [],
};

/** One check the board ran on a conflict resolution (D355). */
export interface ResolutionCheck {
  id: "history" | "markers" | "files" | "lines" | "verify" | "review";
  ok: boolean;
  /** Plain words, for the card. */
  detail: string;
}

/** Lines one side added that the resolution no longer has. */
export interface LostLines {
  file: string;
  /** "task": this task's own change; "base": what landed on the base meanwhile. */
  side: "task" | "base";
  lines: string[];
}

/**
 * A conflict between a task and its base, and what Claude did about it (D355–D358). Lives on the task
 * so the card can show it; replaced by the next resolution.
 */
export interface Resolution {
  state: "resolving" | "checking" | "reviewing" | "resolved" | "failed";
  base: string;
  /** The base commit being merged — pinned, so the checks judge exactly what was merged. */
  base_sha: string;
  conflicts: string[];
  /** What landed on the base meanwhile, by title. */
  others: string[];
  attempt: number;
  max_attempts: number;
  /** Started by Approve: land once it passes, if the project allows (`autoLandResolved`). */
  land_after: boolean;
  checks: ResolutionCheck[];
  lost: LostLines[];
  /** Files changed that were not in conflict. */
  outside: string[];
  verdict: "kept" | "lost" | null;
  /** The reviewer's own words. */
  review: string | null;
  /** Claude's report of what it kept from each side. */
  report: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * What a task is expected to change, and has changed: the queue runs two tasks side by side only when
 * these don't overlap (D400). `files` are paths relative to the project (a folder ending in `/` or a
 * glob covers what is under it); `systems` name the live systems it writes to; `touched` is what its
 * runs really wrote. Empty `files` and `touched` mean the board cannot tell, which counts as everything.
 */
export interface Footprint {
  files: string[];
  systems: string[];
  touched: string[];
}

/** Why a queued task waits for another one that is running (D400). Cleared when it starts. */
export interface TaskHold {
  with: string;
  title: string;
  files: string[];
  systems: string[];
  /** True when the other task's footprint is unknown, so it may touch anything in the folder. */
  unknown: boolean;
  /** The other task has finished and waits for Approve or Discard: its changes are still loose in the folder. */
  landing?: boolean;
}

/** What the board did by itself about a task's failures (D411). Cleared when the task reaches Review or Done. */
export interface TaskRecovery {
  /** Tries after a connection problem on one stage: the stage and how many so far (3 at most). */
  transient?: { stage: number; n: number };
  /** Recovery attempts the board's triage chose (a retry of a stage), 2 at most per task. */
  attempts?: number;
  /** The last thing recovery did or decided, for the card and the chat's debrief. */
  last?: { at: string; action: "retry_same" | "retry_from" | "needs_user" | "transient"; reason: string; stage?: number };
}

/** Tries a stage gets after a connection problem before the person is asked (D411). */
export const TRANSIENT_RETRIES = 3;
/** Recovery attempts (a retry chosen by the board's own triage) a task gets before the person is asked (D411). */
export const RECOVERY_ATTEMPTS = 2;
/** The wait before each try after a connection problem: half a minute, two minutes, five. */
export const TRANSIENT_DELAYS_MS = [30_000, 120_000, 300_000];

/** This task's branch would conflict with its base if landed now (D359). */
export interface ConflictRisk {
  base: string;
  files: string[];
  checked_at: string;
}

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
  /** A supervised task that still works in its own worktree and branch, landing only on Approve (D234). Autonomous does unless `in_folder`. */
  own_branch: boolean;
  /** An autonomous task that works in the project folder, stamped when it is queued and kept after (D398). */
  in_folder: boolean;
  /** What it is expected to change and has changed, for running tasks side by side (D400). */
  footprint: Footprint;
  /** Set while it waits in the queue for an overlapping task (D400). */
  hold: TaskHold | null;
  /** What the board did on its own about this task's failures: tries after a connection problem, recovery attempts (D411). */
  recovery: TaskRecovery | null;
  /**
   * "Autonomous + asks me": an autonomous task that may stop on a question card and wait for your
   * answer, instead of only leaving a note with its default (D361). Ignored when the task is supervised.
   */
  may_ask: boolean;
  /**
   * Made by the side chat with a plan stage: it waits on its setup card (mode, models, effort) until
   * someone presses Start there, and the queue refuses it until then (D365).
   */
  setup_pending: boolean;
  /** The side chat that made this card: its result, failure, plan or question is posted back there (D285). */
  chat_id: string | null;
  /** Set when the board classified this task, so the UI can show it was a guess. */
  triaged_at: string | null;
  /** Hidden from the board when set. Purely visual — the task, its runs and its history stay. */
  archived_at: string | null;
  /** When the task became done, or null while it is not. Unlike updated_at, archiving or editing it later does not move this. */
  done_at: string | null;
  /** When Approve merged its branch into the base: what tells a merged task from one that was only finished. */
  merged_at: string | null;
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
  /** Which round of work the card is on: 1 for its first, N+1 for each follow-up its coder continued (D375). */
  round: number;
  /** What the card had spent when this round started: the cost ceiling counts each round on its own. */
  round_cost_base: number;
  /** Where this round's to-do items start in `checklist`: earlier rounds' are done and only clutter it. */
  checklist_from: number;
  /** Every file the card's landed rounds changed, so a later round and the chat know where it has worked. */
  files: string[];
  /** The base's commit right after the card last landed: what "changed since your last round" is measured from. */
  landed_sha: string | null;
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
  /** The latest conflict Claude was given to resolve, and how it went. */
  resolution: Resolution | null;
  /** Set while the task's branch would conflict with its base. */
  conflict_risk: ConflictRisk | null;
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
  /** The cards it makes are "Autonomous + asks me" (D361). */
  may_ask: boolean;
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
  /** The folder it is filed in on the AI Manager's chat list, or null for none. A deleted folder leaves its chats here. */
  folder_id: string | null;
  /**
   * When Claude last answered in this chat: the start of its cache window. Claude keeps a conversation
   * cached for an hour on a subscription (D331); a message after that is re-read at full price. null
   * once the hour has passed, or before the first reply.
   */
  warm_at: string | null;
  /** Send the keep-alive message before this chat's cache window ends (Settings → Side chat says whether any chat does). */
  keep_alive: boolean;
  /**
   * Give this chat your own skills, MCP servers and connectors, the way a task gets them (D335). Off by
   * default: their tool lists ride on every message, so a plain question costs more with them.
   */
  use_tools: boolean;
  /**
   * How full the chat's context is, from Claude's last answer: tokens held, and the model's window
   * (0 when the model did not say). Both 0 before the first reply and after a fresh session (D360).
   */
  context_tokens: number;
  context_window: number;
  /** How the cards this chat makes will run unless the message says otherwise (D344). An answer card is always supervised. */
  mode: RunStyle;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** True while a reply is being written (not stored). */
  busy?: boolean;
}

/** A file you attached to a chat (D334): an image, a PDF, a spreadsheet, a document. Claude is given its path. */
export interface ChatFile {
  id: string;
  chat_id: string;
  /** The message it went with, or null while it waits for your next one. */
  message_id: number | null;
  name: string;
  media_type: string;
  bytes: number;
  /** Absolute path on disk, under the board's state dir. */
  path: string;
  created_at: string;
}

/** The colours a chat folder can wear: the board's own signal colours, so a folder reads as part of the board. */
export const FOLDER_COLORS = ["amber", "cyan", "moss", "iris", "rose", "rust", "lime", "slate"] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

/** A folder on the AI Manager's chat list: a name you gave a group of chats, in a colour. Nothing runs on it. */
export interface ChatFolder {
  id: string;
  project_id: string;
  name: string;
  /** null: no colour chosen — drawn neutral. */
  color: FolderColor | null;
  position: number;
  created_at: string;
}

/** What a card the chat made did by itself, posted into that chat by the board — no model call (D285). */
export interface ChatUpdate {
  id: string;
  title: string;
  /** "asks": a question card the run waits on (AskUserQuestion); "question": a note it carried on past (board_ask). */
  kind: "finished" | "failed" | "plan" | "question" | "asks";
  status: TaskStatus;
  /** The answer or outcome, why it failed, the plan's first lines, or the question. */
  text: string;
  question_id?: string;
  /** For "asks": the question card, answered in the chat or anywhere else (D361). */
  approval_id?: string;
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
  meta: {
    cards?: { id: string; title: string; action: "created" | "updated" | "queued" | "scheduled" | "messaged" | "answered" | "stopped" | "retried" | "continued" | "forked" | "approved" }[];
    cost_usd?: number;
    update?: ChatUpdate;
    /** A user message the board sent by itself to keep the conversation cached (D332), shown as a quiet line. */
    keepalive?: boolean;
    /** A user message the board sent when you pressed ✦ What next? (D338), shown as a quiet line. */
    suggest?: boolean;
    /** An assistant turn the manager posted on its own when a card finished or failed (D410). */
    debrief?: boolean;
    /** The files that went with a user message (D334). */
    files?: Pick<ChatFile, "id" | "name" | "media_type" | "bytes">[];
  };
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
  /**
   * What the run spent before its first edit, in weighted tokens (`engine/explore.ts`): what a fresh card
   * would spend finding the same files again. Set once, when a code or custom stage first finishes (D374).
   */
  explore_weight: number | null;
  /** The card's round this run belonged to (D375). */
  round: number;
}

/** A follow-up round on a card: what was asked, and how it went. Round 1 is the card itself and has no row. */
export interface TaskRound {
  id: string;
  task_id: string;
  round: number;
  request: string;
  /** A review stage runs after the coder this round. */
  review: boolean;
  /** How many to-do items the card had when the round started: the round's own list starts there. */
  checklist_from: number;
  /** The round could not continue its session and started fresh with a handoff. */
  fell_back: boolean;
  started_at: string;
  landed_at: string | null;
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
  /**
   * An autonomous task marked live does its live steps itself: its worktree gets the project's gitignored
   * credential files and its prompts stop leaving those steps for a supervised run. On by default (D385, D410).
   */
  autonomousLive: boolean;
  /**
   * When a task fails for a reason that is not a stop, a block or a usage limit, the board tries to recover
   * it by itself: a connection problem retries the stage in its own session; anything else gets one cheap
   * read-only look by the triage model, which may retry a stage; after two attempts the person is asked (D411).
   */
  autoRecover: boolean;
  /**
   * What an autonomous run may reach (D418). "full" (default): whatever Claude Code itself can — read
   * anywhere, any command, any connector, any site in the board's browser — walled only from your main
   * checkout (and other tasks' copies) while it works in its own copy, and from git that moves the
   * board's branches. "sandbox": the old D187 walls: only its own folder and the folders the board names.
   */
  autonomousReach: "full" | "sandbox";
  /**
   * A stage that reaches its turn limit while still making changes carries on in its session as long as it
   * does; a task that reaches a cost ceiling while progressing is granted another stage ceiling by the board
   * itself, up to twice the task ceiling, and only then asks (D412). Off: the limits stop and ask as before.
   */
  autoContinueWhileProgressing: boolean;
  /**
   * When a card a chat made finishes or fails, the AI Manager posts a short debrief in that chat on its
   * own — what was done, what is left, whether a follow-up is worth making — so the manager tells you
   * rather than waiting for you to ask (D410). One cheap call per finish. Off: only the board's own
   * one-line news is posted.
   */
  debriefOnFinish: boolean;
  /**
   * Autonomous tasks work in their own copy of the project (a git worktree). Off: they work in the
   * project folder itself, and the queue keeps tasks that would change the same files apart (D398, D400).
   * On by default. A project without git always works in its folder (D399).
   */
  autonomousWorktree: boolean;
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
  /** The same for an "Autonomous + asks me" task's question card: 0 waits however long it takes (D361). */
  askModeWaitMin: number;
  /** The side chat's model and effort: a balance of quality and price for questions about code. */
  chatModel: string;
  chatEffort: Effort;
  /** Where the default chat model runs: "anthropic" (Claude) or a Claude-compatible provider's id (D301). */
  chatProvider: string;
  /**
   * Keep chats cached: five minutes before a chat's hour-long cache window ends, the board sends it a
   * short message so the next real one is not re-read at full price (D332). Each chat has its own
   * switch too; this one turns the whole thing on or off.
   */
  chatKeepAlive: boolean;
  /** The message the board sends. Short: its reply is one line, and both are cached. */
  chatKeepAliveMessage: string;
  /** Stop keeping a chat warm this many hours after your last own message in it: an hourly message for ever would be a bill. */
  chatKeepAliveMaxHours: number;
  /**
   * Every chat gets your connectors and skills: Slack, Gmail, Drive, your MCP servers, your skills (D381).
   * Off, a chat has only the project and the board, and makes a card for a lookup in your systems.
   */
  chatTools: boolean;
  /** Offer the ✦ What next? button in every chat: five suggested next steps, on request, at the chat's model (D338). */
  nextStepsSuggestions: boolean;
  /**
   * Where the chat sends a follow-up about a card's own work (D377): "memory" to the card whose coder
   * remembers it when that costs less (a round, a message, a fork), "ask" proposes that and waits for a yes,
   * "new" always a new card (told what the earlier one did).
   */
  followUpRouting: "memory" | "ask" | "new";
  /** The Spec section's ✦ Rewrite: Opus by default — it reads the code first, and a good spec saves a whole run. */
  specModel: string;
  specEffort: Effort;
  /**
   * Give runs their own browser (Playwright, headless, one per session) and ask the code and review
   * stages to look at anything visible they changed. Local pages only unless you approve otherwise.
   */
  browserChecks: boolean;
  /** Also offer Claude in Chrome — your own signed-in Chrome — to supervised runs (see taskBrowser for every run). */
  chromeInSupervised: boolean;
  /**
   * The browser runs use for sites that need a sign-in (D389). "board": the board's own browser, started
   * from a saved profile you sign in to once; autonomous runs may also open the sites in browserSites.
   * "chrome": every run, autonomous included, also gets Claude in Chrome — your own signed-in Chrome.
   */
  taskBrowser: "board" | "chrome";
  /** Sites signed in to in the board's browser profile, by host; autonomous runs may open them (D389). */
  browserSites: string[];
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
  /** How a new card runs unless someone picks otherwise: the form, the chat and the setup card start here (D365). */
  defaultRunStyle: RunStyle;
  /**
   * A task with a plan stage waits on its setup card (mode, models, effort) until someone presses
   * Start, wherever it was created; subtasks, schedules and re-runs are not asked again (D365).
   */
  confirmSetup: boolean;
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

/** A card in the Skills tab's Recommended list (D317–D321): the catalog entry plus this computer's state. */
export interface SuggestedSkill {
  id: string;
  name: string;
  /** One plain sentence on what it does for you. */
  what: string;
  /** A tool (MarkItDown) is installed and checked by its Setup check, named in `check`. */
  kind: "skill" | "plugin" | "tool";
  /** Where to read it on GitHub. */
  link: string;
  /** The Setup check behind it: "Install with Claude" for all, and a tool's whole state. */
  check: string;
  /** Where it comes from, for the card: "obra/superpowers". */
  from: string;
  starter: boolean;
  /** The kind of project it is good for; null when it suits any. */
  fits: "web" | "react" | null;
  needsPython: boolean;
  tooltip: {
    unattended: "yes" | "note" | "person";
    watch: string;
    /** How to turn it off, only where the usual switch does not cover it. */
    off: string | null;
  };
  /**
   * installed-elsewhere: on this computer but not put there by the board's Install, so it never removes it.
   * unknown: a tool, whose state is its Setup check's.
   */
  status: "not-installed" | "installed" | "installed-elsewhere" | "unknown";
  /** A plugin with no skills has no switch in the Skills list, so its card carries one. null: no card switch. */
  enabled: boolean | null;
  /** What it needs that this computer lacks, e.g. "LibreOffice". */
  missing: string[];
  running: "install" | "remove" | null;
  /** The end of the output of the last install or remove that failed. */
  error: string | null;
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
  /** A project's chat folders, whole: they change rarely and the list is short. */
  | { type: "chat.folders"; project_id: string; folders: ChatFolder[] }
  /** A chat's cache window ends in `minutes`: sent once per window, when it reaches the warning line (D331). */
  | { type: "chat.expiring"; chat: Chat; minutes: number }
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
  | { type: "skills.suggested"; skill: SuggestedSkill }
  | { type: "skills.output"; id: string; chunk: string }
  | { type: "codex.updated"; status: { found: boolean; command: string; version: string | null; signedIn: "chatgpt" | "api-key" | null; line: string; linked: boolean } }
  | { type: "health.updated"; health: { loggedIn: boolean; authMethod: string | null; cliVersion: string | null; sdkVersion: string; error: string | null; checkedAt: string } };
