import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { DEFAULT_BLOCKED_COMMANDS, DEFAULT_VISION_MODEL, SEED_DEBATE, SEED_TIERS, newId, nowIso } from "./db.ts";
import type {
  ImageProvider,
  Approval, ApprovalDecision, EventRow, Message, Milestone, Mode, Policy, Project, Run, RunListItem, RunStatus,
  Attachment, Note, MergePolicy, Priority, ProjectEnv, Settings, Stage, StageName, Task, TaskCard, TaskStatus, TaskType, UsageLimit,
  Provider, RunRole, CostSource, TierRef, Schedule, Chat, ChatFile, ChatFolder, ChatMessage, Effort, SpecVersion, ProviderOut, UsageTotals,
} from "./types.ts";
import { ANTHROPIC_PROVIDER_ID, DEFAULT_MERGE, EMPTY_ENV, HELPER_MODELS, RUN_STYLES, type HelperModel, type RunStyle } from "./types.ts";
import { DEFAULT_CHECKLIST } from "./engine/onboarding.ts";
import { isImageProvider } from "./engine/images.ts";

type Row = Record<string, SQLInputValue>;

function toNote(r: Row): Note {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    task_id: (r.task_id as string) ?? null,
    text: r.text as string,
    source: r.source as Note["source"],
    kind: ((r.kind as string) === "outcome" ? "outcome" : "lesson"),
    ts: r.ts as string,
    flag: r.flagged_at ? { reason: (r.flag_reason as string) ?? "", at: r.flagged_at as string, task_id: (r.flag_task_id as string) ?? null } : null,
    approved: Number(r.approved ?? 0),
    sentBack: Number(r.sent_back ?? 0),
  };
}

/** A note with how the tasks that carried it ended. */
const NOTE_SELECT = `SELECT notes.*,
  (SELECT COUNT(*) FROM note_uses u WHERE u.note_id = notes.id AND u.verdict = 'approved') AS approved,
  (SELECT COUNT(*) FROM note_uses u WHERE u.note_id = notes.id AND u.verdict = 'rejected') AS sent_back
  FROM notes`;

/** Memory guardrails: one line each, a bounded number per project, per kind. */
export const NOTE_MAX_CHARS = 280;
export const NOTE_KEEP_PER_PROJECT = 60;
/** How many memory lines a stage prompt carries; the rest are fetched on demand via board_memory. */
export const NOTES_IN_PROMPT = 12;
/** Of those, how many are simply the newest lessons, whatever the task: what was just decided often matters. */
export const NOTES_ALWAYS_RECENT = 3;
/** And at most how many are outcomes of earlier tasks — only ones that match this task get in at all. */
export const NOTE_OUTCOMES_IN_PROMPT = 4;

/** Words too common to say what a task is about; matching on them would rank every note alike. */
const NOTE_STOPWORDS = new Set(
  ("the and for are but not you all any can had has have her his how its our out who why was were will with " +
    "this that these those from into onto then than them they their there what when where which while would " +
    "should could does did done doing been being about also just only very more most some such each other " +
    "make made use used using add added task tasks please need needs want like").split(" "),
);

/**
 * The words of a task worth searching memory for, as an FTS5 query (any of them). Each word is quoted,
 * so nothing a user typed is read as FTS syntax; null when nothing is left to search for.
 */
export function noteQuery(text: string): string | null {
  const words = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((w) => !NOTE_STOPWORDS.has(w)))];
  return words.length ? words.slice(0, 64).map((w) => `"${w}"`).join(" OR ") : null;
}

/** Biggest a single stored event may be. Past this the transcript is a liability, not a record. */
export const MAX_EVENT_CHARS = 24_000;

/**
 * Strips what must not be kept in the transcript: base64 image data (the bytes are already saved as
 * an attachment, and storing them here inflates the database by ~33% of every screenshot) and any
 * tool output so large it would dominate the table. The shape is preserved so the UI still renders.
 */
export function slimEvent(payload: unknown): unknown {
  return slimmed(payload).value;
}

/** The slimmed event together with its JSON: measuring it means writing it out, so that text is kept for storing rather than made twice. */
function slimmed(payload: unknown): { value: unknown; text: string } {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    const o = v as Record<string, unknown>;
    if (o.type === "image" && o.source && typeof o.source === "object") {
      const src = o.source as Record<string, unknown>;
      const bytes = typeof src.data === "string" ? Math.round((src.data.length * 3) / 4) : 0;
      return { type: "image", source: { type: src.type, media_type: src.media_type, omitted_bytes: bytes } };
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = walk(val);
    return out;
  };
  const slim = walk(payload);
  const text = JSON.stringify(slim) ?? "null";
  if (text.length <= MAX_EVENT_CHARS) return { value: slim, text };
  const value = { truncated: true, chars: text.length, preview: text.slice(0, MAX_EVENT_CHARS) };
  return { value, text: JSON.stringify(value) };
}

const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  path: r.path as string,
  policy: json<Policy>(r.policy_json, { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 }),
  env: { ...EMPTY_ENV, ...json<Partial<ProjectEnv>>(r.env_json, {}) },
  merge: { ...DEFAULT_MERGE, ...json<Partial<MergePolicy>>(r.merge_json, {}) },
  created_at: r.created_at as string,
  system: r.system === 1,
});

const toTask = (r: Row): Task => ({
  id: r.id as string,
  project_id: r.project_id as string,
  parent_id: (r.parent_id as string) ?? null,
  milestone_id: (r.milestone_id as string) ?? null,
  title: r.title as string,
  spec_md: r.spec_md as string,
  status: r.status as TaskStatus,
  type: (r.type as TaskType) ?? "feature",
  priority: (r.priority as Priority) ?? "p2",
  labels: json<string[]>(r.labels_json, []),
  depends_on: json<string[]>(r.depends_on_json, []),
  related_to: json<string[]>(r.related_to_json, []),
  auto_queue_children: Number(r.auto_queue_children ?? 0) === 1,
  plan_approval: r.plan_approval === null || r.plan_approval === undefined ? null : Number(r.plan_approval) === 1,
  live: Number(r.live ?? 0) === 1,
  own_branch: Number(r.own_branch ?? 0) === 1,
  may_ask: Number(r.may_ask ?? 0) === 1,
  setup_pending: Number(r.setup_pending ?? 0) === 1,
  chat_id: (r.chat_id as string) ?? null,
  triaged_at: (r.triaged_at as string) ?? null,
  archived_at: (r.archived_at as string) ?? null,
  done_at: (r.done_at as string) ?? null,
  merged_at: (r.merged_at as string) ?? null,
  resume_at: (r.resume_at as string) ?? null,
  pause_reason: (r.pause_reason as Task["pause_reason"]) ?? null,
  budget_extra_usd: Number(r.budget_extra_usd ?? 0),
  start_at: (r.start_at as string) ?? null,
  suggestion: json<Task["suggestion"]>(r.suggestion_json, null),
  onboarding: (r.onboarding as Task["onboarding"]) ?? null,
  plan_gate: json<Task["plan_gate"]>(r.plan_gate_json, null),
  blocked: json<Task["blocked"]>(r.blocked_json, null),
  questions: json<Task["questions"]>(r.questions_json, []),
  checklist: json<Task["checklist"]>(r.checklist_json, []),
  checkout: json<Task["checkout"]>(r.checkout_json, null),
  resolution: json<Task["resolution"]>(r.resolution_json, null),
  conflict_risk: json<Task["conflict_risk"]>(r.conflict_risk_json, null),
  mode: r.mode as Mode,
  pipeline: json<Stage[]>(r.pipeline_json, []),
  skills: json<string[]>(r.skills_json, []),
  branch: (r.branch as string) ?? null,
  worktree_path: (r.worktree_path as string) ?? null,
  base_sha: (r.base_sha as string) ?? null,
  summary: (r.summary as string) ?? null,
  note: (r.note as string) ?? null,
  error: (r.error as string) ?? null,
  position: Number(r.position),
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

const toSchedule = (r: Row): Schedule => ({
  id: r.id as string,
  project_id: r.project_id as string,
  title: r.title as string,
  spec_md: r.spec_md as string,
  mode: r.mode as Mode,
  may_ask: Number(r.may_ask ?? 0) === 1,
  type: (r.type as TaskType) ?? "feature",
  priority: (r.priority as Priority) ?? "p2",
  pipeline: json<Stage[]>(r.pipeline_json, []),
  skills: json<string[]>(r.skills_json, []),
  days: json<number[]>(r.days_json, []),
  time: r.time as string,
  enabled: Number(r.enabled) === 1,
  next_run_at: (r.next_run_at as string) ?? null,
  last_run_at: (r.last_run_at as string) ?? null,
  last_task_id: (r.last_task_id as string) ?? null,
  created_at: r.created_at as string,
});

const toChat = (r: Row): Chat => ({
  id: r.id as string,
  project_id: r.project_id as string,
  title: r.title as string,
  session_id: (r.session_id as string) ?? null,
  model: r.model as string,
  effort: r.effort as Effort,
  provider: (r.provider as string) || ANTHROPIC_PROVIDER_ID,
  cost_usd: Number(r.cost_usd ?? 0),
  folder_id: (r.folder_id as string) ?? null,
  warm_at: (r.warm_at as string) ?? null,
  keep_alive: r.keep_alive === undefined || r.keep_alive === null ? true : Number(r.keep_alive) === 1,
  use_tools: Number(r.use_tools ?? 0) === 1,
  context_tokens: Number(r.context_tokens ?? 0),
  context_window: Number(r.context_window ?? 0),
  mode: r.mode === "autonomous" || r.mode === "ask" ? r.mode : "supervised",
  archived_at: (r.archived_at as string) ?? null,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

const toChatFile = (r: Row): ChatFile => ({
  id: r.id as string,
  chat_id: r.chat_id as string,
  message_id: r.message_id === null || r.message_id === undefined ? null : Number(r.message_id),
  name: r.name as string,
  media_type: r.media_type as string,
  bytes: Number(r.bytes),
  path: r.path as string,
  created_at: r.created_at as string,
});

const toChatFolder = (r: Row): ChatFolder => ({
  id: r.id as string,
  project_id: r.project_id as string,
  name: r.name as string,
  color: (r.color as ChatFolder["color"]) ?? null,
  position: Number(r.position ?? 0),
  created_at: r.created_at as string,
});

const toSpecVersion = (r: Row): SpecVersion => ({
  id: r.id as string,
  task_id: r.task_id as string,
  kind: r.kind as SpecVersion["kind"],
  spec_md: r.spec_md as string,
  model: (r.model as string | null) ?? null,
  effort: (r.effort as Effort | null) ?? null,
  source_id: (r.source_id as string | null) ?? null,
  instruction: (r.instruction as string | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  cost_usd: Number(r.cost_usd) || 0,
  created_at: r.created_at as string,
});

const toChatMessage = (r: Row): ChatMessage => ({
  id: Number(r.id),
  chat_id: r.chat_id as string,
  role: r.role as ChatMessage["role"],
  text: r.text as string,
  meta: json<ChatMessage["meta"]>(r.meta_json, {}),
  ts: r.ts as string,
});

const toAttachment = (r: Row): Attachment => ({
  id: r.id as string,
  task_id: r.task_id as string,
  run_id: (r.run_id as string) ?? null,
  source: r.source as Attachment["source"],
  name: r.name as string,
  media_type: r.media_type as string,
  bytes: Number(r.bytes),
  path: r.path as string,
  note: (r.note as string) ?? null,
  description: (r.description as string) ?? null,
  described_by: (r.described_by as string) ?? null,
  created_at: r.created_at as string,
});

const toRun = (r: Row): Run => ({
  id: r.id as string,
  task_id: r.task_id as string,
  stage: r.stage as StageName,
  stage_index: Number(r.stage_index),
  session_id: (r.session_id as string) ?? null,
  model: r.model as string,
  effort: r.effort as Run["effort"],
  provider: (r.provider as string) ?? null,
  role: (r.role as RunRole) ?? "stage",
  cost_source: (r.cost_source as CostSource) ?? "sdk",
  status: r.status as Run["status"],
  started_at: r.started_at as string,
  ended_at: (r.ended_at as string) ?? null,
  cost_usd: Number(r.cost_usd),
  input_tokens: Number(r.input_tokens),
  output_tokens: Number(r.output_tokens),
  result_md: (r.result_md as string) ?? null,
  error: (r.error as string) ?? null,
  context_tokens: Number(r.context_tokens ?? 0),
  context_window: Number(r.context_window ?? 0),
  cache_read_tokens: Number(r.cache_read_tokens ?? 0),
  cache_write_tokens: Number(r.cache_write_tokens ?? 0),
  other_models_usd: Number(r.other_models_usd ?? 0),
  limit_before: r.limit_before === null || r.limit_before === undefined ? null : Number(r.limit_before),
  limit_after: r.limit_after === null || r.limit_after === undefined ? null : Number(r.limit_after),
});

const toApproval = (r: Row): Approval => ({
  id: r.id as string,
  run_id: r.run_id as string,
  task_id: r.task_id as string,
  tool_name: r.tool_name as string,
  input: json<unknown>(r.input_json, null),
  title: (r.title as string) ?? null,
  decision: (r.decision as ApprovalDecision) ?? null,
  decided_at: (r.decided_at as string) ?? null,
  note: (r.note as string) ?? null,
  answers: json<Record<string, string> | null>(r.answer_json, null),
  created_at: r.created_at as string,
});
const withTask = (r: Row): Approval => ({
  ...toApproval(r),
  ...(r.task_title != null ? { task_title: r.task_title as string } : {}),
  ...(r.project_id != null ? { project_id: r.project_id as string } : {}),
});

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  task_id: r.task_id as string,
  from_task_id: (r.from_task_id as string) ?? null,
  from_run_id: (r.from_run_id as string) ?? null,
  body: r.body as string,
  ts: r.ts as string,
});

const toMilestone = (r: Row): Milestone => ({
  id: r.id as string,
  project_id: r.project_id as string,
  title: r.title as string,
  position: Number(r.position),
  due_date: (r.due_date as string) ?? null,
  notes: (r.notes as string) ?? null,
});

/** Builds "a=?, b=?" + values for a partial update, mapping field names to columns. */
function setClause(patch: Record<string, unknown>, columns: Record<string, (v: unknown) => SQLInputValue>) {
  const sets: string[] = [];
  const vals: SQLInputValue[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !(k in columns)) continue;
    const col =
      k === "pipeline" ? "pipeline_json"
      : k === "skills" ? "skills_json"
      : k === "policy" ? "policy_json"
      : k === "env" ? "env_json"
      : k === "merge" ? "merge_json"
      : k === "labels" ? "labels_json"
      : k === "depends_on" ? "depends_on_json"
      : k === "related_to" ? "related_to_json"
      : k === "suggestion" ? "suggestion_json"
      : k === "plan_gate" ? "plan_gate_json"
      : k === "blocked" ? "blocked_json"
      : k === "questions" ? "questions_json"
      : k === "checklist" ? "checklist_json"
      : k === "checkout" ? "checkout_json"
      : k === "resolution" ? "resolution_json"
      : k === "conflict_risk" ? "conflict_risk_json"
      : k === "days" ? "days_json"
      : k;
    sets.push(`${col} = ?`);
    vals.push(columns[k](v));
  }
  return { sets, vals };
}

/** Anything not a known helper model reads as "no helper" — the way it always worked — never as an unknown model id. */
const readHelperModel = (v: string | undefined): HelperModel => (HELPER_MODELS.includes(v as HelperModel) ? (v as HelperModel) : "stage");

const str = (v: unknown) => (v === null ? null : String(v));
const num = (v: unknown) => Number(v);
const bool = (v: unknown) => (v ? 1 : 0);
const js = (v: unknown) => JSON.stringify(v);

const TASK_FACTS = "tasks.id, tasks.status, tasks.type, tasks.priority, tasks.depends_on_json, tasks.created_at, tasks.updated_at, tasks.done_at";

/** The little the dashboard needs to know about a task. */
export interface TaskFacts {
  id: string;
  status: TaskStatus;
  type: TaskType;
  priority: Priority;
  depends_on: string[];
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

const TASK_COLUMNS: Record<string, (v: unknown) => SQLInputValue> = {
  parent_id: str, milestone_id: str, title: str, spec_md: str, status: str, mode: str, pipeline: js, skills: js,
  branch: str, worktree_path: str, base_sha: str, summary: str, note: str, error: str, position: num,
  type: str, priority: str, labels: js, depends_on: js, related_to: js, triaged_at: str, archived_at: str, resume_at: str, pause_reason: str, budget_extra_usd: num, start_at: str, suggestion: js, plan_gate: js, blocked: js, questions: js, checklist: js, checkout: js, resolution: js, conflict_risk: js, onboarding: str,
  auto_queue_children: (v) => (v ? 1 : 0),
  plan_approval: (v) => (v === null || v === undefined ? null : v ? 1 : 0),
  live: (v) => (v ? 1 : 0),
  own_branch: (v) => (v ? 1 : 0),
  may_ask: (v) => (v ? 1 : 0),
  setup_pending: (v) => (v ? 1 : 0),
  chat_id: str,
  merged_at: str,
};

export type NewTask = {
  project_id: string;
  title: string;
  spec_md?: string;
  parent_id?: string | null;
  milestone_id?: string | null;
  mode?: Mode;
  pipeline?: Stage[];
  skills?: string[];
  status?: TaskStatus;
  type?: TaskType;
  priority?: Priority;
  labels?: string[];
  depends_on?: string[];
  related_to?: string[];
  auto_queue_children?: boolean;
  onboarding?: Task["onboarding"];
  plan_approval?: boolean | null;
  live?: boolean;
  own_branch?: boolean;
  may_ask?: boolean;
  setup_pending?: boolean;
  chat_id?: string | null;
};

/** Tiers used to be bare model ids; older rows are read as Claude models and rewritten on the next save. */
function normaliseTiers(raw: Record<string, unknown>): Settings["tiers"] {
  const one = (v: unknown, fallback: TierRef): TierRef => {
    if (typeof v === "string" && v.trim()) return { provider: "anthropic", model: v };
    const o = v as Partial<TierRef> | null;
    return o && typeof o.model === "string" && o.model
      ? { provider: typeof o.provider === "string" && o.provider ? o.provider : "anthropic", model: o.model }
      : fallback;
  };
  return { cheap: one(raw.cheap, SEED_TIERS.cheap), balanced: one(raw.balanced, SEED_TIERS.balanced), strong: one(raw.strong, SEED_TIERS.strong) };
}

function tierOrNull(v: unknown): TierRef | null {
  const o = v as Partial<TierRef> | null;
  return o && typeof o.provider === "string" && o.provider && typeof o.model === "string" && o.model ? { provider: o.provider, model: o.model } : null;
}

function normaliseProvider(p: Provider): Provider {
  return {
    ...p, enabled: p.enabled !== false, mayEditFiles: p.mayEditFiles === true, models: Array.isArray(p.models) ? p.models : [], authRef: p.authRef ?? "",
    fallback: tierOrNull(p.fallback),
  };
}

/** Distinct statements kept ready. Partial updates build SQL from whichever fields changed, so the set is open-ended. */
const MAX_STATEMENTS = 400;

export class Repo {
  private readonly statements = new Map<string, StatementSync>();
  private settingsRows: { version: number; rows: Map<string, string> } | null = null;
  private cardColumns: string | null = null;

  constructor(readonly db: DatabaseSync) {
    // Settings are read on every tool call and every queue decision, and almost never change. A counter
    // bumped by triggers says when they did — including writes made straight on `db`, which tests do —
    // so a read costs one number instead of the whole table. Temporary: it lives and dies with this connection.
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS settings_version(n INTEGER NOT NULL);
      INSERT INTO settings_version(n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM settings_version);
      CREATE TEMP TRIGGER IF NOT EXISTS settings_inserted AFTER INSERT ON settings BEGIN UPDATE settings_version SET n = n + 1; END;
      CREATE TEMP TRIGGER IF NOT EXISTS settings_updated AFTER UPDATE ON settings BEGIN UPDATE settings_version SET n = n + 1; END;
      CREATE TEMP TRIGGER IF NOT EXISTS settings_deleted AFTER DELETE ON settings BEGIN UPDATE settings_version SET n = n + 1; END;
    `);
  }

  /**
   * A statement compiled once and reused. Every streamed message is an insert and a couple of reads;
   * compiling the same SQL again each time was most of what those cost.
   */
  stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      if (this.statements.size >= MAX_STATEMENTS) this.statements.clear();
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  // ---------- settings ----------
  /** The settings table as it is now; re-read only when something wrote to it. */
  private settingsMap(): Map<string, string> {
    const version = Number((this.stmt("SELECT n FROM temp.settings_version").get() as { n: number }).n);
    if (this.settingsRows?.version !== version) {
      const rows = this.stmt("SELECT key, value FROM settings").all() as { key: string; value: string }[];
      this.settingsRows = { version, rows: new Map(rows.map((r) => [r.key, r.value])) };
    }
    return this.settingsRows.rows;
  }

  /** A fresh object each time: callers are free to change what they are given. */
  getSettings(): Settings {
    const m = this.settingsMap();
    return {
      models: json(m.get("models"), []),
      defaultPipeline: json(m.get("defaultPipeline"), []),
      globalCap: Number(m.get("globalCap") ?? 8),
      serial: String(m.get("serial") ?? "false") === "true",
      maxForcedParallel: Number(m.get("maxForcedParallel") ?? 3),
      defaultMaxConcurrent: Number(m.get("defaultMaxConcurrent") ?? 3),
      stateDir: m.get("stateDir") ?? "",
      disabledSkills: json(m.get("disabledSkills"), []),
      maxTurnsPerStage: Number(m.get("maxTurnsPerStage") ?? 60),
      maxCostPerStageUsd: Number(m.get("maxCostPerStageUsd") ?? 5),
      maxSubagentDepth: Number(m.get("maxSubagentDepth") ?? 2),
      maxConcurrentSubagents: Number(m.get("maxConcurrentSubagents") ?? 5),
      cacheableSystemPrompt: (m.get("cacheableSystemPrompt") ?? "true") !== "false",
      autoTriage: (m.get("autoTriage") ?? "true") !== "false",
      triageModel: m.get("triageModel") ?? "claude-haiku-4-5-20251001",
      visionModel: m.get("visionModel") ?? DEFAULT_VISION_MODEL,
      visionProvider: m.get("visionProvider") ?? ANTHROPIC_PROVIDER_ID,
      imageProvider: isImageProvider(m.get("imageProvider")) ? (m.get("imageProvider") as ImageProvider) : "codex",
      cloudflareAccountId: m.get("cloudflareAccountId") ?? "",
      imageModel: m.get("imageModel") ?? "",
      codexPictures: { works: null, version: null, detail: "", checked_at: null, ...json<Partial<Settings["codexPictures"]>>(m.get("codexPictures"), {}) },
      hiddenModels: { chat: [], stages: [], helpers: [], pictures: [], ...json<Partial<Settings["hiddenModels"]>>(m.get("hiddenModels"), {}) },
      tiers: normaliseTiers(json<Record<string, unknown>>(m.get("tiers"), {})),
      providers: json<Provider[]>(m.get("providers"), []).map(normaliseProvider),
      debate: { ...SEED_DEBATE, ...json<Partial<Settings["debate"]>>(m.get("debate"), {}) },
      delegateTimeoutMin: Number(m.get("delegateTimeoutMin") ?? 30),
      autoSizing: (m.get("autoSizing") ?? "true") !== "false",
      autoResume: (m.get("autoResume") ?? "true") !== "false",
      claudeFallback: tierOrNull(json<unknown>(m.get("claudeFallback"), null)),
      keepAwake: (m.get("keepAwake") ?? "true") !== "false",
      questionWaitMin: Number(m.get("questionWaitMin") ?? 0),
      askModeWaitMin: Number(m.get("askModeWaitMin") ?? 0),
      chatModel: m.get("chatModel") || "claude-sonnet-5-5",
      chatEffort: (m.get("chatEffort") as Effort) || "medium",
      chatProvider: m.get("chatProvider") || ANTHROPIC_PROVIDER_ID,
      chatKeepAlive: (m.get("chatKeepAlive") ?? "true") !== "false",
      chatKeepAliveMessage: m.get("chatKeepAliveMessage") || "Hi, just keeping this chat warm. Reply in one line.",
      chatKeepAliveMaxHours: Number(m.get("chatKeepAliveMaxHours") ?? 8) || 8,
      nextStepsSuggestions: (m.get("nextStepsSuggestions") ?? "true") !== "false",
      specModel: m.get("specModel") || "claude-opus-5-5",
      specEffort: (m.get("specEffort") as Effort) || "high",
      loadUserPlugins: (m.get("loadUserPlugins") ?? "true") !== "false",
      claudeAutoMemory: m.get("claudeAutoMemory") === "true",
      browserChecks: (m.get("browserChecks") ?? "true") !== "false",
      chromeInSupervised: m.get("chromeInSupervised") === "true",
      autoAllowReadOnly: (m.get("autoAllowReadOnly") ?? "true") !== "false",
      markitdownInTasks: (m.get("markitdownInTasks") ?? "true") !== "false",
      planApproval: m.get("planApproval") === "true",
      defaultRunStyle: (RUN_STYLES as string[]).includes(m.get("defaultRunStyle") ?? "") ? (m.get("defaultRunStyle") as RunStyle) : "ask",
      confirmSetup: (m.get("confirmSetup") ?? "true") !== "false",
      autoContinueTurns: Number(m.get("autoContinueTurns") ?? 2),
      liveReviewModel: m.get("liveReviewModel") || "claude-opus-5-5",
      followLatestModels: (m.get("followLatestModels") ?? "true") !== "false",
      browserCheckModel: readHelperModel(m.get("browserCheckModel")),
      autoUpdateEngine: (m.get("autoUpdateEngine") ?? "true") !== "false",
      lastModelMove: json<Settings["lastModelMove"]>(m.get("lastModelMove"), null),
      liveView: (m.get("liveView") ?? "true") !== "false",
      maxCostPerTaskUsd: Number(m.get("maxCostPerTaskUsd") ?? 15),
      maxRepeatedToolCalls: Number(m.get("maxRepeatedToolCalls") ?? 8),
      eventRetentionDays: Number(m.get("eventRetentionDays") ?? 30),
      blockedCommands: json(m.get("blockedCommands"), DEFAULT_BLOCKED_COMMANDS),
      defaultMerge: { ...DEFAULT_MERGE, ...json<Partial<MergePolicy>>(m.get("defaultMerge"), {}) },
      onboardingChecklist: m.get("onboardingChecklist") || DEFAULT_CHECKLIST,
    };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const up = this.stmt("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k === "stateDir") continue;
      up.run(k, typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
    }
    return this.getSettings();
  }

  /**
   * Where this board keeps its files, set by the server at start. The stored value used to be written
   * once and kept: a state folder that was moved went on sending attachments to where it used to be.
   */
  setStateDir(dir: string): void {
    this.stmt("INSERT INTO settings(key, value) VALUES ('stateDir', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(dir);
  }

  // ---------- projects ----------
  /** Your projects. The board's own (Setup) only when asked for. */
  listProjects(opts: { includeSystem?: boolean } = {}): Project[] {
    const where = opts.includeSystem ? "" : "WHERE system = 0 ";
    return (this.stmt(`SELECT * FROM projects ${where}ORDER BY created_at`).all() as Row[]).map(toProject);
  }

  findSetupProject(): Project | undefined {
    const r = this.stmt("SELECT * FROM projects WHERE system = 1 LIMIT 1").get() as Row | undefined;
    return r && toProject(r);
  }

  /** The hidden project "Fix with Claude" runs in: supervised only, one at a time, in the board's own folder. */
  setupProject(dir: string): Project {
    const found = this.findSetupProject();
    if (found) return found;
    mkdirSync(dir, { recursive: true });
    const p = this.createProject({ name: "Setup", path: dir, policy: { worktrees: "forbidden", autonomous: "forbidden", maxConcurrent: 1 } });
    this.stmt("UPDATE projects SET system = 1 WHERE id = ?").run(p.id);
    return this.getProject(p.id)!;
  }

  getProject(id: string): Project | undefined {
    const r = this.stmt("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r && toProject(r);
  }

  createProject(p: { name: string; path: string; policy: Policy; env?: ProjectEnv; merge?: MergePolicy }): Project {
    const id = newId("p");
    this.stmt("INSERT INTO projects(id, name, path, policy_json, env_json, merge_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id, p.name, p.path, JSON.stringify(p.policy), JSON.stringify(p.env ?? EMPTY_ENV), JSON.stringify(p.merge ?? DEFAULT_MERGE), nowIso(),
    );
    return this.getProject(id)!;
  }

  updateProject(id: string, patch: { name?: string; path?: string; policy?: Policy; env?: ProjectEnv; merge?: MergePolicy }): Project {
    const { sets, vals } = setClause(patch, { name: str, path: str, policy: js, env: js, merge: js });
    if (sets.length) this.stmt(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getProject(id)!;
  }

  deleteProject(id: string): void {
    this.stmt("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---------- tasks ----------
  listTasks(filter: { project_id?: string; parent_id?: string } = {}): Task[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filter.project_id) (where.push("project_id = ?"), vals.push(filter.project_id));
    if (filter.parent_id) (where.push("parent_id = ?"), vals.push(filter.parent_id));
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY position, created_at`;
    return (this.stmt(sql).all(...vals) as Row[]).map(toTask);
  }

  getTask(id: string): Task | undefined {
    const r = this.stmt("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r && toTask(r);
  }

  createTask(t: NewTask): Task {
    const id = newId("t");
    const now = nowIso();
    const pos = (this.stmt("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id = ?").get(t.project_id) as { p: number }).p;
    this.stmt(
      `INSERT INTO tasks(id, project_id, parent_id, milestone_id, title, spec_md, status, mode, pipeline_json, skills_json,
                         type, priority, labels_json, depends_on_json, related_to_json, auto_queue_children, onboarding, position, created_at, updated_at,
                         plan_approval, live, own_branch, may_ask, done_at, chat_id, setup_pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, t.project_id, t.parent_id ?? null, t.milestone_id ?? null, t.title, t.spec_md ?? "", t.status ?? "backlog",
      t.mode ?? "supervised", JSON.stringify(t.pipeline ?? []), JSON.stringify(t.skills ?? []),
      t.type ?? "feature", t.priority ?? "p2", JSON.stringify(t.labels ?? []), JSON.stringify(t.depends_on ?? []),
      JSON.stringify(t.related_to ?? []), t.auto_queue_children ? 1 : 0, t.onboarding ?? null, pos, now, now,
      t.plan_approval === undefined || t.plan_approval === null ? null : t.plan_approval ? 1 : 0, t.live ? 1 : 0, t.own_branch ? 1 : 0, t.may_ask ? 1 : 0,
      t.status === "done" ? now : null, t.chat_id ?? null, t.setup_pending ? 1 : 0,
    );
    return this.getTask(id)!;
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "project_id" | "created_at" | "updated_at" | "done_at">>): Task {
    const { sets, vals } = setClause(patch as Record<string, unknown>, TASK_COLUMNS);
    if (sets.length) {
      const now = nowIso();
      if (patch.status !== undefined) {
        // When the task was finished, kept apart from updated_at: archiving or relabelling a finished
        // task must not move the day the dashboard counts it on. `status` here is still the old value,
        // so a task that is already done keeps its date; leaving done clears it.
        sets.push("done_at = CASE WHEN ? = 'done' THEN CASE WHEN status = 'done' AND done_at IS NOT NULL THEN done_at ELSE ? END ELSE NULL END");
        vals.push(patch.status, now);
        // A task taken back out of done is no longer merged work, whatever lands next time.
        if (patch.status !== "done" && patch.merged_at === undefined) sets.push("merged_at = NULL");
      }
      this.stmt(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
    }
    return this.getTask(id)!;
  }

  deleteTask(id: string): void {
    this.stmt("DELETE FROM tasks WHERE id = ?").run(id);
  }

  children(id: string): Task[] {
    return this.listTasks({ parent_id: id });
  }

  siblings(task: Task): Task[] {
    if (!task.parent_id) return [];
    return this.children(task.parent_id).filter((t) => t.id !== task.id);
  }

  /** Tasks of a project decorated with per-stage run state and summed cost (one query for all runs). */
  taskCards(projectId: string): TaskCard[] {
    const runs = this.stmt(
      `SELECT runs.task_id, runs.stage_index, runs.status, runs.cost_usd, runs.role FROM runs JOIN tasks ON tasks.id = runs.task_id
       WHERE tasks.project_id = ? ORDER BY runs.started_at, runs.rowid`,
    ).all(projectId) as { task_id: string; stage_index: number; status: RunStatus; cost_usd: number; role: string }[];
    const byTask = new Map<string, { states: Map<number, RunStatus>; cost: number }>();
    for (const r of runs) {
      const e = byTask.get(r.task_id) ?? { states: new Map(), cost: 0 };
      // A critic run costs money but is not a stage: it must not recolour the stage dot (D132).
      if (r.role === "stage") e.states.set(Number(r.stage_index), r.status);
      e.cost += Number(r.cost_usd);
      byTask.set(r.task_id, e);
    }
    // The board never renders the spec; reading it and sending it meant megabytes of markdown per
    // refresh on a busy project. The drawer fetches the full task when you open one.
    const tasks = (this.stmt(`SELECT ${this.columnsWithoutSpec()}, '' AS spec_md FROM tasks WHERE project_id = ? ORDER BY position, created_at`).all(projectId) as Row[]).map(toTask);
    return tasks.map((t) => {
      const e = byTask.get(t.id);
      return { ...t, cost_usd: e?.cost ?? 0, stage_states: t.pipeline.map((_, i) => e?.states.get(i) ?? "idle") };
    });
  }

  /** Every task column but the spec, asked of the table itself so a column added later is never forgotten here. */
  private columnsWithoutSpec(): string {
    this.cardColumns ??= (this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[])
      .map((c) => c.name)
      .filter((n) => n !== "spec_md")
      .join(", ");
    return this.cardColumns;
  }

  /**
   * What the dashboard counts, for one project or for all of yours: a few short columns of every task,
   * read once. Loading whole tasks for this meant reading every spec to count statuses.
   */
  taskFacts(projectId?: string): TaskFacts[] {
    const rows = (projectId
      ? this.stmt(`SELECT ${TASK_FACTS} FROM tasks WHERE tasks.project_id = ?`).all(projectId)
      : this.stmt(`SELECT ${TASK_FACTS} FROM tasks JOIN projects ON projects.id = tasks.project_id WHERE projects.system = 0`).all()) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      status: r.status as TaskStatus,
      type: (r.type as TaskType) ?? "feature",
      priority: (r.priority as Priority) ?? "p2",
      depends_on: json<string[]>(r.depends_on_json, []),
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
      done_at: (r.done_at as string) ?? null,
    }));
  }

  /** Every task's id and nothing else: enough to ask the engine which of them it is working on. */
  taskIds(): string[] {
    return (this.stmt("SELECT id FROM tasks").all() as { id: string }[]).map((r) => r.id);
  }

  /** Cards waiting for a scheduled start, across every project. */
  scheduledTasks(): Task[] {
    return (this.stmt("SELECT * FROM tasks WHERE start_at IS NOT NULL ORDER BY start_at").all() as Row[]).map(toTask);
  }

  // ---------- schedules ----------
  listSchedules(projectId?: string): Schedule[] {
    const rows = projectId
      ? this.stmt("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at").all(projectId)
      : this.stmt("SELECT * FROM schedules ORDER BY created_at").all();
    return (rows as Row[]).map(toSchedule);
  }

  getSchedule(id: string): Schedule | undefined {
    const r = this.stmt("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return r && toSchedule(r);
  }

  createSchedule(s: Omit<Schedule, "id" | "created_at" | "last_run_at" | "last_task_id">): Schedule {
    const id = newId("sc");
    this.stmt(
      `INSERT INTO schedules(id, project_id, title, spec_md, mode, may_ask, type, priority, pipeline_json, skills_json, days_json, time, enabled, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, s.project_id, s.title, s.spec_md, s.mode, s.may_ask ? 1 : 0, s.type, s.priority, JSON.stringify(s.pipeline), JSON.stringify(s.skills),
      JSON.stringify(s.days), s.time, s.enabled ? 1 : 0, s.next_run_at, nowIso(),
    );
    return this.getSchedule(id)!;
  }

  updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "project_id" | "created_at">>): Schedule {
    const { sets, vals } = setClause(patch as Record<string, unknown>, {
      title: str, spec_md: str, mode: str, may_ask: (v) => (v ? 1 : 0), type: str, priority: str, pipeline: js, skills: js, days: js, time: str,
      enabled: (v) => (v ? 1 : 0), next_run_at: str, last_run_at: str, last_task_id: str,
    });
    if (sets.length) this.stmt(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getSchedule(id)!;
  }

  deleteSchedule(id: string): void {
    this.stmt("DELETE FROM schedules WHERE id = ?").run(id);
  }

  // ---------- side chat ----------
  listChats(projectId: string): Chat[] {
    return (this.stmt("SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Row[]).map(toChat);
  }

  /** Every chat and the project it belongs to: enough to ask which of them is mid-reply. */
  chatIds(): { id: string; project_id: string }[] {
    return this.stmt("SELECT id, project_id FROM chats").all() as { id: string; project_id: string }[];
  }

  getChat(id: string): Chat | undefined {
    const r = this.stmt("SELECT * FROM chats WHERE id = ?").get(id) as Row | undefined;
    return r && toChat(r);
  }

  createChat(c: { project_id: string; title: string; model: string; effort: Effort; provider?: string; mode?: RunStyle }): Chat {
    const id = newId("c");
    const now = nowIso();
    // A new chat's switch starts on the board's default run style (D365); an old chat keeps the one it has.
    this.stmt("INSERT INTO chats(id, project_id, title, model, effort, provider, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, c.project_id, c.title, c.model, c.effort, c.provider || ANTHROPIC_PROVIDER_ID, c.mode ?? this.getSettings().defaultRunStyle, now, now);
    return this.getChat(id)!;
  }

  updateChat(id: string, patch: Partial<Pick<Chat, "title" | "session_id" | "model" | "effort" | "provider" | "cost_usd" | "folder_id" | "warm_at" | "keep_alive" | "use_tools" | "context_tokens" | "context_window" | "mode" | "archived_at">>): Chat {
    const { sets, vals } = setClause(patch as Record<string, unknown>, {
      title: str, session_id: str, model: str, effort: str, provider: str, cost_usd: num, folder_id: str, warm_at: str, keep_alive: bool, use_tools: bool,
      context_tokens: num, context_window: num, mode: str, archived_at: str,
    });
    // Filing a chat, its switches, or its cache window or context moving are not activity: it keeps its place in a list sorted by when it was last used.
    const quiet = new Set(["folder_id", "warm_at", "keep_alive", "use_tools", "context_tokens", "context_window", "mode"]);
    const filingOnly = Object.keys(patch).every((k) => quiet.has(k) || (patch as Record<string, unknown>)[k] === undefined);
    if (sets.length && filingOnly) this.stmt(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    else if (sets.length) this.stmt(`UPDATE chats SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
    return this.getChat(id)!;
  }

  /** Chats whose cache window is open (a reply within the hour) and that are not archived: the ones worth watching. */
  warmChats(): Chat[] {
    return (this.stmt("SELECT * FROM chats WHERE warm_at IS NOT NULL AND archived_at IS NULL").all() as Row[]).map(toChat);
  }

  // ---------- chat files (D334) ----------
  addChatFile(f: Omit<ChatFile, "id" | "created_at">): ChatFile {
    const id = newId("cfl");
    this.stmt("INSERT INTO chat_files(id, chat_id, message_id, name, media_type, bytes, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, f.chat_id, f.message_id, f.name, f.media_type, f.bytes, f.path, nowIso());
    return this.getChatFile(id)!;
  }

  getChatFile(id: string): ChatFile | undefined {
    const r = this.stmt("SELECT * FROM chat_files WHERE id = ?").get(id) as Row | undefined;
    return r && toChatFile(r);
  }

  listChatFiles(chatId: string): ChatFile[] {
    return (this.stmt("SELECT * FROM chat_files WHERE chat_id = ? ORDER BY id").all(chatId) as Row[]).map(toChatFile);
  }

  /** Files attached but not yet sent: they ride with the next message. */
  pendingChatFiles(chatId: string): ChatFile[] {
    return (this.stmt("SELECT * FROM chat_files WHERE chat_id = ? AND message_id IS NULL ORDER BY id").all(chatId) as Row[]).map(toChatFile);
  }

  attachChatFiles(ids: string[], messageId: number): void {
    for (const id of ids) this.stmt("UPDATE chat_files SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  deleteChatFile(id: string): void {
    this.stmt("DELETE FROM chat_files WHERE id = ?").run(id);
  }

  listChatFolders(projectId: string): ChatFolder[] {
    return (this.stmt("SELECT * FROM chat_folders WHERE project_id = ? ORDER BY position, created_at").all(projectId) as Row[]).map(toChatFolder);
  }

  getChatFolder(id: string): ChatFolder | undefined {
    const r = this.stmt("SELECT * FROM chat_folders WHERE id = ?").get(id) as Row | undefined;
    return r && toChatFolder(r);
  }

  createChatFolder(projectId: string, name: string, color: ChatFolder["color"] = null): ChatFolder {
    const id = newId("cf");
    const last = this.stmt("SELECT COALESCE(MAX(position), -1) AS p FROM chat_folders WHERE project_id = ?").get(projectId) as { p: number };
    this.stmt("INSERT INTO chat_folders(id, project_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, projectId, name, color, Number(last.p) + 1, nowIso());
    return this.getChatFolder(id)!;
  }

  updateChatFolder(id: string, patch: { name?: string; color?: ChatFolder["color"]; position?: number }): ChatFolder {
    const { sets, vals } = setClause(patch as Record<string, unknown>, { name: str, color: str, position: num });
    if (sets.length) this.stmt(`UPDATE chat_folders SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getChatFolder(id)!;
  }

  /** Removes the folder only: its chats are left unfiled, never deleted. */
  deleteChatFolder(id: string): void {
    this.stmt("UPDATE chats SET folder_id = NULL WHERE folder_id = ?").run(id);
    this.stmt("DELETE FROM chat_folders WHERE id = ?").run(id);
  }

  deleteChat(id: string): void {
    this.stmt("DELETE FROM chats WHERE id = ?").run(id);
  }

  chatMessages(chatId: string, limit = 500): ChatMessage[] {
    const rows = this.stmt("SELECT * FROM (SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(chatId, limit) as Row[];
    return rows.map(toChatMessage);
  }

  /** The board's updates in a chat after a message: what its cards did while you were away. */
  chatUpdatesSince(chatId: string, afterId: number): ChatMessage[] {
    return (this.stmt("SELECT * FROM chat_messages WHERE chat_id = ? AND id > ? AND role = 'update' ORDER BY id").all(chatId, afterId) as Row[]).map(toChatMessage);
  }

  /** Your own newest message in a chat: the board's keep-alives are left out, so they cannot count as activity. */
  lastOwnChatMessage(chatId: string): ChatMessage | undefined {
    const r = this.stmt("SELECT * FROM chat_messages WHERE chat_id = ? AND role = 'user' AND json_extract(meta_json, '$.keepalive') IS NULL ORDER BY id DESC LIMIT 1").get(chatId) as Row | undefined;
    return r && toChatMessage(r);
  }

  /** The newest message in a chat of a role, or undefined. */
  lastChatMessage(chatId: string, role: ChatMessage["role"]): ChatMessage | undefined {
    const r = this.stmt("SELECT * FROM chat_messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1").get(chatId, role) as Row | undefined;
    return r && toChatMessage(r);
  }

  /** Every update a chat has had about one card, oldest first: what was already said, so a restart does not say it again. */
  chatUpdatesFor(chatId: string, taskId: string): ChatMessage[] {
    return (this.stmt("SELECT * FROM chat_messages WHERE chat_id = ? AND role = 'update' AND json_extract(meta_json, '$.update.id') = ? ORDER BY id")
      .all(chatId, taskId) as Row[]).map(toChatMessage);
  }

  addChatMessage(m: { chat_id: string; role: ChatMessage["role"]; text: string; meta?: ChatMessage["meta"] }): ChatMessage {
    const res = this.stmt("INSERT INTO chat_messages(chat_id, role, text, meta_json, ts) VALUES (?, ?, ?, ?, ?)")
      .run(m.chat_id, m.role, m.text, JSON.stringify(m.meta ?? {}), nowIso());
    return toChatMessage(this.stmt("SELECT * FROM chat_messages WHERE id = ?").get(Number(res.lastInsertRowid)) as Row);
  }

  /** What every side chat has cost, for the dashboard. */
  addIntakeCost(c: { task_id: string; kind: "triage" | "vision"; model: string; cost_usd: number }): void {
    if (!(c.cost_usd > 0)) return;
    const project = this.getTask(c.task_id)?.project_id ?? null;
    this.stmt("INSERT INTO intake_costs(task_id, project_id, kind, model, cost_usd, ts) VALUES (?, ?, ?, ?, ?, ?)").run(c.task_id, project, c.kind, c.model, c.cost_usd, nowIso());
  }

  /** Triage and image descriptions, per kind. */
  intakeCost(projectId?: string): { kind: string; cost: number }[] {
    const rows = (projectId
      ? this.stmt("SELECT kind, COALESCE(SUM(cost_usd), 0) AS c FROM intake_costs WHERE project_id = ? GROUP BY kind").all(projectId)
      : this.stmt("SELECT kind, COALESCE(SUM(cost_usd), 0) AS c FROM intake_costs GROUP BY kind").all()) as { kind: string; c: number }[];
    return rows.map((r) => ({ kind: r.kind, cost: Number(r.c) || 0 }));
  }

  /** Where run money went: tokens by kind, and the share spent by helpers and other small models. */
  spendSplit(projectId?: string): { output: number; fresh: number; cacheRead: number; cacheWrite: number; otherModelsUsd: number; criticUsd: number } {
    const where = projectId ? "WHERE tasks.project_id = ?" : "";
    const r = this.stmt(
      `SELECT COALESCE(SUM(runs.output_tokens), 0) AS o, COALESCE(SUM(runs.input_tokens), 0) AS i, COALESCE(SUM(runs.cache_read_tokens), 0) AS cr,
              COALESCE(SUM(runs.cache_write_tokens), 0) AS cw, COALESCE(SUM(runs.other_models_usd), 0) AS om,
              COALESCE(SUM(CASE WHEN runs.role = 'critic' THEN runs.cost_usd ELSE 0 END), 0) AS critic
       FROM runs JOIN tasks ON tasks.id = runs.task_id ${where}`,
    ).get(...(projectId ? [projectId] : [])) as Record<string, number>;
    const cacheRead = Number(r.cr) || 0;
    const cacheWrite = Number(r.cw) || 0;
    // input_tokens has always counted all three kinds of input together; fresh is what is left.
    return { output: Number(r.o) || 0, fresh: Math.max(0, (Number(r.i) || 0) - cacheRead - cacheWrite), cacheRead, cacheWrite, otherModelsUsd: Number(r.om) || 0, criticUsd: Number(r.critic) || 0 };
  }

  chatCost(projectId?: string): number {
    const r = (projectId
      ? this.stmt("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM chats WHERE project_id = ?").get(projectId)
      : this.stmt("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM chats").get()) as { c: number };
    return Number(r.c) || 0;
  }

  // ---------- spec versions ----------
  specVersions(taskId: string): SpecVersion[] {
    // rowid breaks ties between versions saved in the same millisecond.
    return (this.stmt("SELECT * FROM spec_versions WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Row[]).map(toSpecVersion);
  }

  getSpecVersion(id: string): SpecVersion | undefined {
    const r = this.stmt("SELECT * FROM spec_versions WHERE id = ?").get(id) as Row | undefined;
    return r && toSpecVersion(r);
  }

  addSpecVersion(v: Omit<SpecVersion, "id" | "created_at">): SpecVersion {
    const id = newId("sv");
    this.stmt("INSERT INTO spec_versions(id, task_id, kind, spec_md, model, effort, source_id, instruction, summary, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, v.task_id, v.kind, v.spec_md, v.model, v.effort, v.source_id, v.instruction, v.summary, v.cost_usd, nowIso());
    return this.getSpecVersion(id)!;
  }

  /** What every ✦ Rewrite has cost, for the dashboard. */
  specCost(projectId?: string): number {
    const r = (projectId
      ? this.stmt("SELECT COALESCE(SUM(v.cost_usd), 0) AS c FROM spec_versions v JOIN tasks t ON t.id = v.task_id WHERE t.project_id = ?").get(projectId)
      : this.stmt("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM spec_versions").get()) as { c: number };
    return Number(r.c) || 0;
  }

  // ---------- attachments ----------
  listAttachments(taskId: string): Attachment[] {
    return (this.stmt("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(toAttachment);
  }

  getAttachment(id: string): Attachment | undefined {
    const r = this.stmt("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return r && toAttachment(r);
  }

  addAttachment(a: Omit<Attachment, "id" | "created_at">): Attachment {
    const id = newId("at");
    this.stmt("INSERT INTO attachments(id, task_id, run_id, source, name, media_type, bytes, path, note, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.task_id, a.run_id, a.source, a.name, a.media_type, a.bytes, a.path, a.note, a.description ?? null, nowIso());
    return this.getAttachment(id)!;
  }

  /** Written once by the cheap vision model, so every later stage reads words instead of pixels. */
  describeAttachment(id: string, description: string | null, by: string | null = null): Attachment | undefined {
    this.stmt("UPDATE attachments SET description = ?, described_by = ? WHERE id = ?").run(description, by, id);
    return this.getAttachment(id);
  }

  deleteAttachment(id: string): void {
    this.stmt("DELETE FROM attachments WHERE id = ?").run(id);
  }

  /** How many images a run has already saved, so one chatty session cannot fill the disk. */
  countAttachments(taskId: string, runId: string): number {
    const r = this.stmt("SELECT COUNT(*) AS n FROM attachments WHERE task_id = ? AND run_id = ?").get(taskId, runId) as { n: number };
    return Number(r.n);
  }

  tasksInStatus(statuses: TaskStatus[]): Task[] {
    const q = statuses.map(() => "?").join(", ");
    return (this.stmt(`SELECT * FROM tasks WHERE status IN (${q}) ORDER BY updated_at`).all(...statuses) as Row[]).map(toTask);
  }

  // ---------- runs ----------
  createRun(r: { task_id: string; stage: StageName; stage_index: number; model: string; effort: string; provider?: string | null; role?: RunRole }): Run {
    const id = newId("r");
    this.stmt("INSERT INTO runs(id, task_id, stage, stage_index, model, effort, provider, role, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
      .run(id, r.task_id, r.stage, r.stage_index, r.model, r.effort, r.provider ?? null, r.role ?? "stage", nowIso());
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    const r = this.stmt("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return r && toRun(r);
  }

  updateRun(id: string, patch: Partial<Omit<Run, "id" | "task_id">>): Run {
    const { sets, vals } = setClause(patch as Record<string, unknown>, {
      session_id: str, status: str, ended_at: str, cost_usd: num, input_tokens: num, output_tokens: num, result_md: str,
      error: str, model: str, effort: str, context_tokens: num, context_window: num, limit_before: num, limit_after: num,
      provider: str, role: str, cost_source: str, cache_read_tokens: num, cache_write_tokens: num, other_models_usd: num,
    });
    if (sets.length) this.stmt(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getRun(id)!;
  }

  runsForTask(taskId: string): Run[] {
    return (this.stmt("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Row[]).map(toRun);
  }

  /** Only the runs that are stages of the pipeline; a critic run never counts (D132). */
  stageRuns(taskId: string): Run[] {
    return (this.stmt("SELECT * FROM runs WHERE task_id = ? AND role = 'stage' ORDER BY started_at, rowid").all(taskId) as Row[]).map(toRun);
  }

  /** Newest stage run: the session chat, approve and follow-up continue from. */
  latestRun(taskId: string): Run | undefined {
    const r = this.stmt("SELECT * FROM runs WHERE task_id = ? AND role = 'stage' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId) as Row | undefined;
    return r && toRun(r);
  }

  listRuns(limit = 300): RunListItem[] {
    const rows = this.stmt(
      `SELECT runs.*, tasks.title AS task_title, tasks.project_id AS project_id, projects.name AS project_name
       FROM runs JOIN tasks ON tasks.id = runs.task_id JOIN projects ON projects.id = tasks.project_id
       ORDER BY runs.started_at DESC LIMIT ?`,
    ).all(limit) as Row[];
    return rows.map((r) => ({ ...toRun(r), task_title: r.task_title as string, project_id: r.project_id as string, project_name: r.project_name as string }));
  }

  /**
   * Run aggregates computed in SQL, for a project or across all of them. Doing this in JS meant
   * loading every run into memory and silently dropping everything past the first 2000 — the
   * dashboard would quietly show partial numbers with no way to tell.
   */
  /**
   * What one stage typically costs here: median minutes and dollars of the last 50 finished runs of
   * each kind (debate critics excluded). Median, because one long approval wait skews a mean (D205).
   */
  stageStats(projectId?: string): { stage: string; runs: number; medianMinutes: number; medianCost: number }[] {
    const where = projectId ? "AND tasks.project_id = ?" : "";
    const rows = this.stmt(
      `SELECT runs.stage AS stage, runs.cost_usd AS cost, runs.started_at AS started, runs.ended_at AS ended
       FROM runs JOIN tasks ON tasks.id = runs.task_id
       WHERE runs.status = 'success' AND runs.role = 'stage' AND runs.ended_at IS NOT NULL ${where}
       ORDER BY runs.started_at DESC LIMIT 600`,
    ).all(...(projectId ? [projectId] : [])) as { stage: string; cost: number; started: string; ended: string }[];
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };
    const byStage = new Map<string, { minutes: number[]; cost: number[] }>();
    for (const r of rows) {
      const b = byStage.get(r.stage) ?? { minutes: [], cost: [] };
      if (b.minutes.length >= 50) continue;
      b.minutes.push(Math.max(0, (Date.parse(r.ended) - Date.parse(r.started)) / 60_000));
      b.cost.push(Number(r.cost) || 0);
      byStage.set(r.stage, b);
    }
    return [...byStage.entries()].map(([stage, b]) => ({
      stage,
      runs: b.minutes.length,
      medianMinutes: Number(median(b.minutes).toFixed(1)),
      medianCost: Number(median(b.cost).toFixed(2)),
    }));
  }

  runAggregates(projectId?: string): {
    daily: { date: string; cost: number; runs: number }[];
    byModel: { key: string; cost: number; runs: number }[];
    failuresByStage: { key: string; count: number }[];
    totals: { runs: number; success: number; failed: number; cost: number };
  } {
    const where = projectId ? "WHERE tasks.project_id = ?" : "";
    const args = projectId ? [projectId] : [];
    const from = `FROM runs JOIN tasks ON tasks.id = runs.task_id ${where}`;
    const rows = <T>(sql: string) => this.stmt(sql).all(...args) as T[];
    const daily = rows<{ date: string; cost: number; runs: number }>(
      `SELECT substr(runs.started_at, 1, 10) AS date, SUM(runs.cost_usd) AS cost, COUNT(*) AS runs ${from} GROUP BY date`,
    ).map((r) => ({ date: r.date, cost: Number(r.cost) || 0, runs: Number(r.runs) }));
    const byModel = rows<{ key: string; cost: number; runs: number }>(
      `SELECT CASE WHEN runs.provider IS NULL THEN runs.model ELSE runs.model || ' · ' || runs.provider END AS key, SUM(runs.cost_usd) AS cost, COUNT(*) AS runs ${from} GROUP BY key ORDER BY cost DESC`,
    ).map((r) => ({ key: r.key, cost: Number(Number(r.cost).toFixed(4)) || 0, runs: Number(r.runs) }));
    const failuresByStage = rows<{ key: string; count: number }>(
      `SELECT runs.stage AS key, COUNT(*) AS count ${from}${where ? " AND" : " WHERE"} runs.status = 'failed' GROUP BY runs.stage ORDER BY count DESC`,
    ).map((r) => ({ key: r.key, count: Number(r.count) }));
    const t = this.stmt(
      `SELECT COUNT(*) AS runs, SUM(runs.status = 'success') AS success, SUM(runs.status = 'failed') AS failed, COALESCE(SUM(runs.cost_usd), 0) AS cost ${from}`,
    ).get(...args) as { runs: number; success: number; failed: number; cost: number };
    return {
      daily,
      byModel,
      failuresByStage,
      totals: { runs: Number(t.runs), success: Number(t.success) || 0, failed: Number(t.failed) || 0, cost: Number(t.cost) || 0 },
    };
  }

  /** What a task has spent so far, across every stage and retry. */
  taskCost(taskId: string): number {
    const r = this.stmt("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE task_id = ?").get(taskId) as { c: number };
    return Number(r.c) || 0;
  }

  /** First run start → done, for the cycle-time median, in one query instead of one per task. */
  cycleTimes(projectId?: string): { taskId: string; startedAt: string; doneAt: string; failed: number }[] {
    const where = projectId ? "AND tasks.project_id = ?" : "";
    const args = projectId ? [projectId] : [];
    return (
      this.stmt(
        `SELECT tasks.id AS taskId, MIN(runs.started_at) AS startedAt, COALESCE(tasks.done_at, tasks.updated_at) AS doneAt,
                SUM(runs.status = 'failed') AS failed
         FROM tasks JOIN runs ON runs.task_id = tasks.id
         WHERE tasks.status = 'done' ${where}
         GROUP BY tasks.id`,
      ).all(...args) as { taskId: string; startedAt: string; doneAt: string; failed: number }[]
    ).map((r) => ({ ...r, failed: Number(r.failed) || 0 }));
  }

  runsInStatus(statuses: Run["status"][]): Run[] {
    const q = statuses.map(() => "?").join(", ");
    return (this.stmt(`SELECT * FROM runs WHERE status IN (${q})`).all(...statuses) as Row[]).map(toRun);
  }

  // ---------- events ----------
  insertEvent(runId: string, type: string, payload: unknown): EventRow {
    const ts = nowIso();
    const slim = slimmed(payload);
    const res = this.stmt("INSERT INTO events(run_id, ts, type, payload_json) VALUES (?, ?, ?, ?)").run(runId, ts, type, slim.text);
    return { id: Number(res.lastInsertRowid), run_id: runId, ts, type, payload: slim.value };
  }

  /**
   * Drops transcripts for runs older than `days`, oldest first. The runs, their costs and their
   * results stay — only the message-by-message detail goes, which is what actually grows.
   */
  pruneEvents(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const res = this.stmt("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?)")
      .run(cutoff);
    return Number(res.changes);
  }

  /** Rough size of the transcript table, for the Settings page. */
  eventStats(): { rows: number; bytes: number } {
    const r = this.stmt("SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM events").get() as { rows: number; bytes: number };
    return { rows: Number(r.rows), bytes: Number(r.bytes) };
  }

  eventsAfter(runId: string, after = 0, limit = 2000): EventRow[] {
    const rows = this.stmt("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?").all(runId, after, limit) as Row[];
    return rows.map((r) => ({ id: Number(r.id), run_id: r.run_id as string, ts: r.ts as string, type: r.type as string, payload: json(r.payload_json, null) }));
  }

  /** The newest rows of a run's transcript, oldest first — for a summary of what it is doing now. */
  recentEvents(runId: string, limit = 100): EventRow[] {
    const rows = this.stmt("SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id").all(runId, limit) as Row[];
    return rows.map((r) => ({ id: Number(r.id), run_id: r.run_id as string, ts: r.ts as string, type: r.type as string, payload: json(r.payload_json, null) }));
  }

  // ---------- messages ----------
  insertMessage(m: { task_id: string; from_task_id: string | null; from_run_id: string | null; body: string }): Message {
    const id = newId("m");
    this.stmt("INSERT INTO messages(id, task_id, from_task_id, from_run_id, body, ts) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, m.task_id, m.from_task_id, m.from_run_id, m.body, nowIso(),
    );
    return toMessage(this.stmt("SELECT * FROM messages WHERE id = ?").get(id) as Row);
  }

  /** Messages to or from a task, oldest first. */
  messagesForTask(taskId: string, limit = 200): Message[] {
    const rows = this.stmt("SELECT * FROM (SELECT rowid AS rid, * FROM messages WHERE task_id = ? OR from_task_id = ? ORDER BY rid DESC LIMIT ?) ORDER BY rid")
      .all(taskId, taskId, limit) as Row[];
    return rows.map(toMessage);
  }

  /** The rowid of the newest message to this task, or 0. A run notes it at start to know what is "new". */
  lastMessageRow(taskId: string): number {
    const r = this.stmt("SELECT COALESCE(MAX(rowid), 0) AS m FROM messages WHERE task_id = ?").get(taskId) as { m: number };
    return Number(r.m);
  }

  /** Messages to a task that arrived after `row`, oldest first, each with its rowid so the caller can advance. */
  messagesAfter(taskId: string, row: number): (Message & { rid: number })[] {
    const rows = this.stmt("SELECT rowid AS rid, * FROM messages WHERE task_id = ? AND rowid > ? ORDER BY rowid").all(taskId, row) as Row[];
    return rows.map((r) => ({ ...toMessage(r), rid: Number(r.rid) }));
  }

  inboundMessages(taskId: string, limit = 20): Message[] {
    const rows = this.stmt("SELECT * FROM (SELECT rowid AS rid, * FROM messages WHERE task_id = ? ORDER BY rid DESC LIMIT ?) ORDER BY rid")
      .all(taskId, limit) as Row[];
    return rows.map(toMessage);
  }

  // ---------- approvals ----------
  createApproval(a: { run_id: string; task_id: string; tool_name: string; input: unknown; title?: string | null }): Approval {
    const id = newId("a");
    this.stmt("INSERT INTO approvals(id, run_id, task_id, tool_name, input_json, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.run_id, a.task_id, a.tool_name, JSON.stringify(a.input ?? null), a.title ?? null, nowIso());
    return this.getApprovalWithTask(id)!;
  }

  getApproval(id: string): Approval | undefined {
    const r = this.stmt("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return r && toApproval(r);
  }

  /**
   * An approval with its task's title and project, as the events carry it: a pop-up built from the
   * bare row could only say "A task wants to…", and the inbox could not say which project.
   */
  getApprovalWithTask(id: string): Approval | undefined {
    const r = this.stmt(
      `SELECT approvals.*, tasks.title AS task_title, tasks.project_id AS project_id
       FROM approvals LEFT JOIN tasks ON tasks.id = approvals.task_id WHERE approvals.id = ?`,
    ).get(id) as Row | undefined;
    return r && withTask(r);
  }

  decideApproval(id: string, decision: ApprovalDecision, note: string | null, answers: Record<string, string> | null = null): Approval {
    this.stmt("UPDATE approvals SET decision = ?, decided_at = ?, note = ?, answer_json = ? WHERE id = ? AND decision IS NULL")
      .run(decision, nowIso(), note, answers ? JSON.stringify(answers) : null, id);
    return this.getApprovalWithTask(id)!;
  }

  approvalsForTask(taskId: string): Approval[] {
    return (this.stmt("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(toApproval);
  }

  /** Pending approvals everywhere, with the task title and project attached. */
  pendingApprovalsAll(): Approval[] {
    const rows = this.stmt(
      `SELECT approvals.*, tasks.title AS task_title, tasks.project_id AS project_id
       FROM approvals JOIN tasks ON tasks.id = approvals.task_id
       WHERE approvals.decision IS NULL ORDER BY approvals.created_at`,
    ).all() as Row[];
    return rows.map(withTask);
  }

  pendingApprovals(taskId?: string): Approval[] {
    const rows = taskId
      ? this.stmt("SELECT * FROM approvals WHERE decision IS NULL AND task_id = ? ORDER BY created_at").all(taskId)
      : this.stmt("SELECT * FROM approvals WHERE decision IS NULL ORDER BY created_at").all();
    return (rows as Row[]).map(toApproval);
  }

  /** Closes every waiting card and returns them, so each can be announced as decided. */
  expirePendingApprovals(note: string | null = null): Approval[] {
    const ids = (this.stmt("SELECT id FROM approvals WHERE decision IS NULL").all() as Row[]).map((r) => r.id as string);
    this.stmt("UPDATE approvals SET decision = 'expired', decided_at = ?, note = ? WHERE decision IS NULL").run(nowIso(), note);
    return ids.map((id) => this.getApprovalWithTask(id)!);
  }

  // ---------- project memory ----------
  /**
   * Records one memory line. Capped, de-duplicated and pruned on write: agent memory that grows
   * without bound is the documented failure mode ("catastrophic remembering"), and stale
   * contradictory notes poison later runs.
   */
  addNote(n: { project_id: string; task_id?: string | null; text: string; source?: Note["source"]; kind?: Note["kind"] }): Note | null {
    const text = n.text.trim().replace(/\s+/g, " ").slice(0, NOTE_MAX_CHARS);
    if (text.length < 8) return null;
    const kind = n.kind ?? "lesson";
    const dupe = this.stmt("SELECT id FROM notes WHERE project_id = ? AND lower(text) = lower(?)").get(n.project_id, text) as Row | undefined;
    if (dupe) {
      // Written again as something to follow, an outcome becomes a lesson; never the other way round.
      this.stmt(`UPDATE notes SET ts = ?${kind === "lesson" ? ", kind = 'lesson'" : ""} WHERE id = ?`).run(nowIso(), dupe.id as string);
      return this.note(dupe.id as string);
    }
    const id = newId("n");
    this.stmt("INSERT INTO notes(id, project_id, task_id, text, source, kind, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id, n.project_id, n.task_id ?? null, text, n.source ?? "agent", kind, nowIso(),
    );
    // Each kind has its own cap, so a run of approvals can never push the project's lessons out.
    this.stmt(
      `DELETE FROM notes WHERE project_id = ? AND kind = ? AND id NOT IN
         (SELECT id FROM notes WHERE project_id = ? AND kind = ? ORDER BY ts DESC LIMIT ?)`,
    ).run(n.project_id, kind, n.project_id, kind, NOTE_KEEP_PER_PROJECT);
    return this.note(id);
  }

  private note(id: string): Note {
    return toNote(this.stmt(`${NOTE_SELECT} WHERE notes.id = ?`).get(id) as Row);
  }

  /** Newest first: lessons and outcomes together, each kind at most NOTE_KEEP_PER_PROJECT. */
  notes(projectId: string, limit = 2 * NOTE_KEEP_PER_PROJECT): Note[] {
    return (this.stmt(`${NOTE_SELECT} WHERE notes.project_id = ? ORDER BY notes.ts DESC LIMIT ?`).all(projectId, limit) as Row[]).map(toNote);
  }

  /**
   * The notes a prompt for this task carries. Lessons: the newest few, then the ones whose words best
   * match the task (BM25), then newer ones while there is room. Outcomes — what approved tasks did —
   * only when they match, and at most a few: newest-only let one decision from thirty tasks ago fall
   * out of every prompt while the summaries of unrelated approvals filled it (D305, D307).
   */
  notesFor(projectId: string, about: string, limit = NOTES_IN_PROMPT): Note[] {
    // A note a run called wrong waits for you; carrying it on would mislead every task until then.
    const all = this.notes(projectId).filter((n) => !n.flag);
    const lessons = all.filter((n) => n.kind === "lesson");
    const picked = new Map(lessons.slice(0, Math.min(NOTES_ALWAYS_RECENT, limit)).map((n) => [n.id, n]));
    let outcomes = 0;
    const match = noteQuery(about);
    if (match) {
      const ranked = this.stmt(
        `SELECT notes.id FROM notes_fts JOIN notes ON notes.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? AND notes.project_id = ? ORDER BY bm25(notes_fts) LIMIT ?`,
      ).all(match, projectId, limit + NOTE_OUTCOMES_IN_PROMPT + NOTES_ALWAYS_RECENT) as Row[];
      const byId = new Map(all.map((n) => [n.id, n]));
      for (const r of ranked) {
        if (picked.size >= limit) break;
        const n = byId.get(r.id as string);
        if (!n || picked.has(n.id)) continue;
        if (n.kind === "outcome" && outcomes++ >= NOTE_OUTCOMES_IN_PROMPT) continue;
        picked.set(n.id, n);
      }
    }
    for (const n of lessons) {
      if (picked.size >= limit) break;
      picked.set(n.id, n);
    }
    return [...picked.values()];
  }

  /** Remembers which notes a task's prompt carried; a later stage carrying them again changes nothing. */
  recordNoteUses(taskId: string, noteIds: string[]): void {
    const add = this.stmt("INSERT OR IGNORE INTO note_uses(note_id, task_id) VALUES (?, ?)");
    for (const id of noteIds) add.run(id, taskId);
  }

  /** How the task ended, for every note it carried. A task sent back and later approved counts as approved. */
  settleNoteUses(taskId: string, verdict: "approved" | "rejected"): void {
    this.stmt("UPDATE note_uses SET verdict = ? WHERE task_id = ?").run(verdict, taskId);
  }

  /**
   * A run's report that a note is wrong or stale, found by its text as the prompt showed it (or its start,
   * at least 12 characters). Null when no note of this project reads like that.
   */
  flagNote(projectId: string, text: string, reason: string, taskId: string | null): Note | null {
    const t = text.trim().replace(/\s+/g, " ").replace(/^- /, "");
    if (t.length < 12) return null;
    const row = this.stmt(
      `SELECT id FROM notes WHERE project_id = ? AND (lower(text) = lower(?) OR lower(substr(text, 1, ?)) = lower(?))
       ORDER BY lower(text) = lower(?) DESC, ts DESC LIMIT 1`,
    ).get(projectId, t, t.length, t, t) as Row | undefined;
    if (!row) return null;
    this.stmt("UPDATE notes SET flag_reason = ?, flagged_at = ?, flag_task_id = ? WHERE id = ?")
      .run(reason.trim().slice(0, NOTE_MAX_CHARS), nowIso(), taskId, row.id as string);
    return this.note(row.id as string);
  }

  /** You looked at a flagged note and it stands: it goes back into prompts. */
  keepNote(id: string): Note | null {
    if (!this.stmt("SELECT id FROM notes WHERE id = ?").get(id)) return null;
    this.stmt("UPDATE notes SET flag_reason = NULL, flagged_at = NULL, flag_task_id = NULL WHERE id = ?").run(id);
    return this.note(id);
  }

  deleteNote(id: string): void {
    this.stmt("DELETE FROM notes WHERE id = ?").run(id);
  }

  // ---------- usage limits ----------
  upsertUsageLimit(l: { type: string; status: string; utilization: number | null; resets_at: number | null }): UsageLimit {
    this.stmt(
      `INSERT INTO usage_limits(type, status, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(type) DO UPDATE SET status = excluded.status, utilization = excluded.utilization,
         resets_at = excluded.resets_at, updated_at = excluded.updated_at`,
    ).run(l.type, l.status, l.utilization, l.resets_at, nowIso());
    return this.usageLimits().find((u) => u.type === l.type)!;
  }

  /** Once a blocked window has reset, its "rejected" is history, not state. */
  clearRejectedLimits(): void {
    this.stmt("UPDATE usage_limits SET status = 'allowed' WHERE status = 'rejected'").run();
  }

  usageLimits(): UsageLimit[] {
    const rows = this.stmt("SELECT * FROM usage_limits ORDER BY type").all() as Row[];
    return rows.map((r) => ({
      type: r.type as string,
      status: r.status as UsageLimit["status"],
      utilization: r.utilization === null ? null : Number(r.utilization),
      resets_at: r.resets_at === null ? null : Number(r.resets_at),
      updated_at: r.updated_at as string,
    }));
  }

  // ---------- delegated providers that ran out ----------
  setProviderOut(o: Omit<ProviderOut, "updated_at">): ProviderOut {
    this.stmt(
      `INSERT INTO provider_limits(provider_id, kind, reason, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET kind = excluded.kind, reason = excluded.reason, resets_at = excluded.resets_at, updated_at = excluded.updated_at`,
    ).run(o.provider_id, o.kind, o.reason, o.resets_at, nowIso());
    return this.providerOuts().find((x) => x.provider_id === o.provider_id)!;
  }

  /** Returns whether there was anything to clear. */
  clearProviderOut(providerId: string): boolean {
    return Number(this.stmt("DELETE FROM provider_limits WHERE provider_id = ?").run(providerId).changes) > 0;
  }

  providerOuts(): ProviderOut[] {
    return (this.stmt("SELECT * FROM provider_limits ORDER BY provider_id").all() as Row[]).map((r) => ({
      provider_id: r.provider_id as string,
      kind: r.kind as ProviderOut["kind"],
      reason: r.reason as string,
      resets_at: (r.resets_at as string) ?? null,
      updated_at: r.updated_at as string,
    }));
  }

  /** What the board's runs sent to each delegated provider since a time: runs, tokens and cost. */
  providerTotals(sinceIso: string): Map<string, UsageTotals> {
    const rows = this.stmt(
      `SELECT provider, COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS outp, COALESCE(SUM(cost_usd), 0) AS cost
       FROM runs WHERE provider IS NOT NULL AND started_at >= ? GROUP BY provider`,
    ).all(sinceIso) as { provider: string; runs: number; inp: number; outp: number; cost: number }[];
    return new Map(rows.map((r) => [r.provider, { runs: Number(r.runs), input_tokens: Number(r.inp), output_tokens: Number(r.outp), cost_usd: Number(r.cost) }]));
  }

  /** The last things a run's model said, newest last: what a model taking over needs to know. */
  lastAssistantText(runId: string, maxChars = 2000): string {
    const rows = this.stmt("SELECT payload_json FROM events WHERE run_id = ? AND type = 'assistant' ORDER BY id DESC LIMIT 12").all(runId) as { payload_json: string }[];
    const parts: string[] = [];
    let size = 0;
    for (const r of rows) {
      let text = "";
      try {
        const content = (JSON.parse(r.payload_json) as { message?: { content?: { type: string; text?: string }[] } }).message?.content ?? [];
        text = content.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text!.trim()).join("\n");
      } catch {
        continue;
      }
      if (!text) continue;
      if (size + text.length > maxChars) break;
      parts.unshift(text);
      size += text.length;
    }
    return parts.join("\n\n");
  }

  // ---------- milestones ----------
  listMilestones(projectId: string): Milestone[] {
    return (this.stmt("SELECT * FROM milestones WHERE project_id = ? ORDER BY position, rowid").all(projectId) as Row[]).map(toMilestone);
  }

  getMilestone(id: string): Milestone | undefined {
    const r = this.stmt("SELECT * FROM milestones WHERE id = ?").get(id) as Row | undefined;
    return r && toMilestone(r);
  }

  createMilestone(m: { project_id: string; title: string; due_date?: string | null; notes?: string | null }): Milestone {
    const id = newId("ms");
    const pos = (this.stmt("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM milestones WHERE project_id = ?").get(m.project_id) as { p: number }).p;
    this.stmt("INSERT INTO milestones(id, project_id, title, position, due_date, notes) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, m.project_id, m.title, pos, m.due_date ?? null, m.notes ?? null,
    );
    return this.getMilestone(id)!;
  }

  updateMilestone(id: string, patch: { title?: string; position?: number; due_date?: string | null; notes?: string | null }): Milestone {
    const { sets, vals } = setClause(patch, { title: str, position: num, due_date: str, notes: str });
    if (sets.length) this.stmt(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getMilestone(id)!;
  }

  deleteMilestone(id: string): void {
    this.stmt("DELETE FROM milestones WHERE id = ?").run(id);
  }
}
