import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { DEFAULT_BLOCKED_COMMANDS, DEFAULT_VISION_MODEL, SEED_DEBATE, SEED_TIERS, newId, nowIso } from "./db.ts";
import type {
  Approval, ApprovalDecision, EventRow, Message, Milestone, Mode, Policy, Project, Run, RunListItem, RunStatus,
  Attachment, Note, MergePolicy, Priority, ProjectEnv, Settings, Stage, StageName, Task, TaskCard, TaskStatus, TaskType, UsageLimit,
  Provider, RunRole, CostSource, TierRef, Schedule,
} from "./types.ts";
import { ANTHROPIC_PROVIDER_ID, DEFAULT_MERGE, EMPTY_ENV } from "./types.ts";
import { DEFAULT_CHECKLIST } from "./engine/onboarding.ts";

type Row = Record<string, SQLInputValue>;

/** Memory guardrails: one line each, a bounded number per project. */
export const NOTE_MAX_CHARS = 280;
export const NOTE_KEEP_PER_PROJECT = 60;
/** How many memory lines a stage prompt carries; the rest are fetched on demand via board_memory. */
export const NOTES_IN_PROMPT = 12;

/** Biggest a single stored event may be. Past this the transcript is a liability, not a record. */
export const MAX_EVENT_CHARS = 24_000;

/**
 * Strips what must not be kept in the transcript: base64 image data (the bytes are already saved as
 * an attachment, and storing them here inflates the database by ~33% of every screenshot) and any
 * tool output so large it would dominate the table. The shape is preserved so the UI still renders.
 */
export function slimEvent(payload: unknown): unknown {
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
  const text = JSON.stringify(slim) ?? "";
  if (text.length <= MAX_EVENT_CHARS) return slim;
  return { truncated: true, chars: text.length, preview: text.slice(0, MAX_EVENT_CHARS) };
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
  triaged_at: (r.triaged_at as string) ?? null,
  archived_at: (r.archived_at as string) ?? null,
  resume_at: (r.resume_at as string) ?? null,
  pause_reason: (r.pause_reason as Task["pause_reason"]) ?? null,
  budget_extra_usd: Number(r.budget_extra_usd ?? 0),
  start_at: (r.start_at as string) ?? null,
  suggestion: json<Task["suggestion"]>(r.suggestion_json, null),
  onboarding: (r.onboarding as Task["onboarding"]) ?? null,
  plan_gate: json<Task["plan_gate"]>(r.plan_gate_json, null),
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
  created_at: r.created_at as string,
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
      : k === "days" ? "days_json"
      : k;
    sets.push(`${col} = ?`);
    vals.push(columns[k](v));
  }
  return { sets, vals };
}

const str = (v: unknown) => (v === null ? null : String(v));
const num = (v: unknown) => Number(v);
const js = (v: unknown) => JSON.stringify(v);

const TASK_COLUMNS: Record<string, (v: unknown) => SQLInputValue> = {
  parent_id: str, milestone_id: str, title: str, spec_md: str, status: str, mode: str, pipeline: js, skills: js,
  branch: str, worktree_path: str, base_sha: str, summary: str, note: str, error: str, position: num,
  type: str, priority: str, labels: js, depends_on: js, related_to: js, triaged_at: str, archived_at: str, resume_at: str, pause_reason: str, budget_extra_usd: num, start_at: str, suggestion: js, plan_gate: js, onboarding: str,
  auto_queue_children: (v) => (v ? 1 : 0),
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

function normaliseProvider(p: Provider): Provider {
  return { ...p, enabled: p.enabled !== false, mayEditFiles: p.mayEditFiles === true, models: Array.isArray(p.models) ? p.models : [], authRef: p.authRef ?? "" };
}

export class Repo {
  constructor(readonly db: DatabaseSync) {}

  // ---------- settings ----------
  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const m = new Map(rows.map((r) => [r.key, r.value]));
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
      tiers: normaliseTiers(json<Record<string, unknown>>(m.get("tiers"), {})),
      providers: json<Provider[]>(m.get("providers"), []).map(normaliseProvider),
      debate: { ...SEED_DEBATE, ...json<Partial<Settings["debate"]>>(m.get("debate"), {}) },
      delegateTimeoutMin: Number(m.get("delegateTimeoutMin") ?? 30),
      autoSizing: (m.get("autoSizing") ?? "true") !== "false",
      autoResume: (m.get("autoResume") ?? "true") !== "false",
      keepAwake: (m.get("keepAwake") ?? "true") !== "false",
      loadUserPlugins: (m.get("loadUserPlugins") ?? "true") !== "false",
      browserChecks: (m.get("browserChecks") ?? "true") !== "false",
      chromeInSupervised: m.get("chromeInSupervised") === "true",
      maxCostPerTaskUsd: Number(m.get("maxCostPerTaskUsd") ?? 15),
      maxRepeatedToolCalls: Number(m.get("maxRepeatedToolCalls") ?? 8),
      eventRetentionDays: Number(m.get("eventRetentionDays") ?? 30),
      blockedCommands: json(m.get("blockedCommands"), DEFAULT_BLOCKED_COMMANDS),
      defaultMerge: { ...DEFAULT_MERGE, ...json<Partial<MergePolicy>>(m.get("defaultMerge"), {}) },
      onboardingChecklist: m.get("onboardingChecklist") || DEFAULT_CHECKLIST,
    };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const up = this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k === "stateDir") continue;
      up.run(k, typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
    }
    return this.getSettings();
  }

  // ---------- projects ----------
  /** Your projects. The board's own (Setup) only when asked for. */
  listProjects(opts: { includeSystem?: boolean } = {}): Project[] {
    const where = opts.includeSystem ? "" : "WHERE system = 0 ";
    return (this.db.prepare(`SELECT * FROM projects ${where}ORDER BY created_at`).all() as Row[]).map(toProject);
  }

  findSetupProject(): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE system = 1 LIMIT 1").get() as Row | undefined;
    return r && toProject(r);
  }

  /** The hidden project "Fix with Claude" runs in: supervised only, one at a time, in the board's own folder. */
  setupProject(dir: string): Project {
    const found = this.findSetupProject();
    if (found) return found;
    mkdirSync(dir, { recursive: true });
    const p = this.createProject({ name: "Setup", path: dir, policy: { worktrees: "forbidden", autonomous: "forbidden", maxConcurrent: 1 } });
    this.db.prepare("UPDATE projects SET system = 1 WHERE id = ?").run(p.id);
    return this.getProject(p.id)!;
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r && toProject(r);
  }

  createProject(p: { name: string; path: string; policy: Policy; env?: ProjectEnv; merge?: MergePolicy }): Project {
    const id = newId("p");
    this.db.prepare("INSERT INTO projects(id, name, path, policy_json, env_json, merge_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id, p.name, p.path, JSON.stringify(p.policy), JSON.stringify(p.env ?? EMPTY_ENV), JSON.stringify(p.merge ?? DEFAULT_MERGE), nowIso(),
    );
    return this.getProject(id)!;
  }

  updateProject(id: string, patch: { name?: string; path?: string; policy?: Policy; env?: ProjectEnv; merge?: MergePolicy }): Project {
    const { sets, vals } = setClause(patch, { name: str, path: str, policy: js, env: js, merge: js });
    if (sets.length) this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getProject(id)!;
  }

  deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---------- tasks ----------
  listTasks(filter: { project_id?: string; parent_id?: string } = {}): Task[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filter.project_id) (where.push("project_id = ?"), vals.push(filter.project_id));
    if (filter.parent_id) (where.push("parent_id = ?"), vals.push(filter.parent_id));
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY position, created_at`;
    return (this.db.prepare(sql).all(...vals) as Row[]).map(toTask);
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r && toTask(r);
  }

  createTask(t: NewTask): Task {
    const id = newId("t");
    const now = nowIso();
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id = ?").get(t.project_id) as { p: number }).p;
    this.db
      .prepare(
        `INSERT INTO tasks(id, project_id, parent_id, milestone_id, title, spec_md, status, mode, pipeline_json, skills_json,
                           type, priority, labels_json, depends_on_json, related_to_json, auto_queue_children, onboarding, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, t.project_id, t.parent_id ?? null, t.milestone_id ?? null, t.title, t.spec_md ?? "", t.status ?? "backlog",
        t.mode ?? "supervised", JSON.stringify(t.pipeline ?? []), JSON.stringify(t.skills ?? []),
        t.type ?? "feature", t.priority ?? "p2", JSON.stringify(t.labels ?? []), JSON.stringify(t.depends_on ?? []),
        JSON.stringify(t.related_to ?? []), t.auto_queue_children ? 1 : 0, t.onboarding ?? null, pos, now, now,
      );
    return this.getTask(id)!;
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "project_id" | "created_at" | "updated_at">>): Task {
    const { sets, vals } = setClause(patch as Record<string, unknown>, TASK_COLUMNS);
    if (sets.length) {
      this.db.prepare(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
    }
    return this.getTask(id)!;
  }

  deleteTask(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
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
    const runs = this.db
      .prepare(
        `SELECT runs.task_id, runs.stage_index, runs.status, runs.cost_usd, runs.role FROM runs JOIN tasks ON tasks.id = runs.task_id
         WHERE tasks.project_id = ? ORDER BY runs.started_at, runs.rowid`,
      )
      .all(projectId) as { task_id: string; stage_index: number; status: RunStatus; cost_usd: number; role: string }[];
    const byTask = new Map<string, { states: Map<number, RunStatus>; cost: number }>();
    for (const r of runs) {
      const e = byTask.get(r.task_id) ?? { states: new Map(), cost: 0 };
      // A critic run costs money but is not a stage: it must not recolour the stage dot (D132).
      if (r.role === "stage") e.states.set(Number(r.stage_index), r.status);
      e.cost += Number(r.cost_usd);
      byTask.set(r.task_id, e);
    }
    return this.listTasks({ project_id: projectId }).map((t) => {
      const e = byTask.get(t.id);
      // The board never renders the spec; sending it meant megabytes of markdown per refresh on a
      // busy project. The drawer fetches the full task when you open one.
      return { ...t, spec_md: "", cost_usd: e?.cost ?? 0, stage_states: t.pipeline.map((_, i) => e?.states.get(i) ?? "idle") };
    });
  }

  /** Cards waiting for a scheduled start, across every project. */
  scheduledTasks(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE start_at IS NOT NULL ORDER BY start_at").all() as Row[]).map(toTask);
  }

  // ---------- schedules ----------
  listSchedules(projectId?: string): Schedule[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at").all(projectId)
      : this.db.prepare("SELECT * FROM schedules ORDER BY created_at").all();
    return (rows as Row[]).map(toSchedule);
  }

  getSchedule(id: string): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return r && toSchedule(r);
  }

  createSchedule(s: Omit<Schedule, "id" | "created_at" | "last_run_at" | "last_task_id">): Schedule {
    const id = newId("sc");
    this.db
      .prepare(
        `INSERT INTO schedules(id, project_id, title, spec_md, mode, type, priority, pipeline_json, skills_json, days_json, time, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, s.project_id, s.title, s.spec_md, s.mode, s.type, s.priority, JSON.stringify(s.pipeline), JSON.stringify(s.skills),
        JSON.stringify(s.days), s.time, s.enabled ? 1 : 0, s.next_run_at, nowIso(),
      );
    return this.getSchedule(id)!;
  }

  updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "project_id" | "created_at">>): Schedule {
    const { sets, vals } = setClause(patch as Record<string, unknown>, {
      title: str, spec_md: str, mode: str, type: str, priority: str, pipeline: js, skills: js, days: js, time: str,
      enabled: (v) => (v ? 1 : 0), next_run_at: str, last_run_at: str, last_task_id: str,
    });
    if (sets.length) this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getSchedule(id)!;
  }

  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  // ---------- attachments ----------
  listAttachments(taskId: string): Attachment[] {
    return (this.db.prepare("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(toAttachment);
  }

  getAttachment(id: string): Attachment | undefined {
    const r = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return r && toAttachment(r);
  }

  addAttachment(a: Omit<Attachment, "id" | "created_at">): Attachment {
    const id = newId("at");
    this.db
      .prepare("INSERT INTO attachments(id, task_id, run_id, source, name, media_type, bytes, path, note, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.task_id, a.run_id, a.source, a.name, a.media_type, a.bytes, a.path, a.note, a.description ?? null, nowIso());
    return this.getAttachment(id)!;
  }

  /** Written once by the cheap vision model, so every later stage reads words instead of pixels. */
  describeAttachment(id: string, description: string | null, by: string | null = null): Attachment | undefined {
    this.db.prepare("UPDATE attachments SET description = ?, described_by = ? WHERE id = ?").run(description, by, id);
    return this.getAttachment(id);
  }

  deleteAttachment(id: string): void {
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  }

  /** How many images a run has already saved, so one chatty session cannot fill the disk. */
  countAttachments(taskId: string, runId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE task_id = ? AND run_id = ?").get(taskId, runId) as { n: number };
    return Number(r.n);
  }

  tasksInStatus(statuses: TaskStatus[]): Task[] {
    const q = statuses.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM tasks WHERE status IN (${q}) ORDER BY updated_at`).all(...statuses) as Row[]).map(toTask);
  }

  // ---------- runs ----------
  createRun(r: { task_id: string; stage: StageName; stage_index: number; model: string; effort: string; provider?: string | null; role?: RunRole }): Run {
    const id = newId("r");
    this.db
      .prepare("INSERT INTO runs(id, task_id, stage, stage_index, model, effort, provider, role, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
      .run(id, r.task_id, r.stage, r.stage_index, r.model, r.effort, r.provider ?? null, r.role ?? "stage", nowIso());
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return r && toRun(r);
  }

  updateRun(id: string, patch: Partial<Omit<Run, "id" | "task_id">>): Run {
    const { sets, vals } = setClause(patch as Record<string, unknown>, {
      session_id: str, status: str, ended_at: str, cost_usd: num, input_tokens: num, output_tokens: num, result_md: str,
      error: str, model: str, effort: str, context_tokens: num, context_window: num, limit_before: num, limit_after: num,
      provider: str, role: str, cost_source: str,
    });
    if (sets.length) this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getRun(id)!;
  }

  runsForTask(taskId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Row[]).map(toRun);
  }

  /** Only the runs that are stages of the pipeline; a critic run never counts (D132). */
  stageRuns(taskId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? AND role = 'stage' ORDER BY started_at, rowid").all(taskId) as Row[]).map(toRun);
  }

  /** Newest stage run: the session chat, approve and follow-up continue from. */
  latestRun(taskId: string): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE task_id = ? AND role = 'stage' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId) as Row | undefined;
    return r && toRun(r);
  }

  listRuns(limit = 300): RunListItem[] {
    const rows = this.db
      .prepare(
        `SELECT runs.*, tasks.title AS task_title, tasks.project_id AS project_id, projects.name AS project_name
         FROM runs JOIN tasks ON tasks.id = runs.task_id JOIN projects ON projects.id = tasks.project_id
         ORDER BY runs.started_at DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({ ...toRun(r), task_title: r.task_title as string, project_id: r.project_id as string, project_name: r.project_name as string }));
  }

  /**
   * Run aggregates computed in SQL, for a project or across all of them. Doing this in JS meant
   * loading every run into memory and silently dropping everything past the first 2000 — the
   * dashboard would quietly show partial numbers with no way to tell.
   */
  runAggregates(projectId?: string): {
    daily: { date: string; cost: number; runs: number }[];
    byModel: { key: string; cost: number; runs: number }[];
    failuresByStage: { key: string; count: number }[];
    totals: { runs: number; success: number; failed: number; cost: number };
  } {
    const where = projectId ? "WHERE tasks.project_id = ?" : "";
    const args = projectId ? [projectId] : [];
    const from = `FROM runs JOIN tasks ON tasks.id = runs.task_id ${where}`;
    const rows = <T>(sql: string) => this.db.prepare(sql).all(...args) as T[];
    const daily = rows<{ date: string; cost: number; runs: number }>(
      `SELECT substr(runs.started_at, 1, 10) AS date, SUM(runs.cost_usd) AS cost, COUNT(*) AS runs ${from} GROUP BY date`,
    ).map((r) => ({ date: r.date, cost: Number(r.cost) || 0, runs: Number(r.runs) }));
    const byModel = rows<{ key: string; cost: number; runs: number }>(
      `SELECT CASE WHEN runs.provider IS NULL THEN runs.model ELSE runs.model || ' · ' || runs.provider END AS key, SUM(runs.cost_usd) AS cost, COUNT(*) AS runs ${from} GROUP BY key ORDER BY cost DESC`,
    ).map((r) => ({ key: r.key, cost: Number(Number(r.cost).toFixed(4)) || 0, runs: Number(r.runs) }));
    const failuresByStage = rows<{ key: string; count: number }>(
      `SELECT runs.stage AS key, COUNT(*) AS count ${from}${where ? " AND" : " WHERE"} runs.status = 'failed' GROUP BY runs.stage ORDER BY count DESC`,
    ).map((r) => ({ key: r.key, count: Number(r.count) }));
    const t = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, SUM(runs.status = 'success') AS success, SUM(runs.status = 'failed') AS failed, COALESCE(SUM(runs.cost_usd), 0) AS cost ${from}`,
      )
      .get(...args) as { runs: number; success: number; failed: number; cost: number };
    return {
      daily,
      byModel,
      failuresByStage,
      totals: { runs: Number(t.runs), success: Number(t.success) || 0, failed: Number(t.failed) || 0, cost: Number(t.cost) || 0 },
    };
  }

  /** What a task has spent so far, across every stage and retry. */
  taskCost(taskId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE task_id = ?").get(taskId) as { c: number };
    return Number(r.c) || 0;
  }

  /** First run start → done, for the cycle-time median, in one query instead of one per task. */
  cycleTimes(projectId?: string): { taskId: string; startedAt: string; updatedAt: string; failed: number }[] {
    const where = projectId ? "AND tasks.project_id = ?" : "";
    const args = projectId ? [projectId] : [];
    return (
      this.db
        .prepare(
          `SELECT tasks.id AS taskId, MIN(runs.started_at) AS startedAt, tasks.updated_at AS updatedAt,
                  SUM(runs.status = 'failed') AS failed
           FROM tasks JOIN runs ON runs.task_id = tasks.id
           WHERE tasks.status = 'done' ${where}
           GROUP BY tasks.id`,
        )
        .all(...args) as { taskId: string; startedAt: string; updatedAt: string; failed: number }[]
    ).map((r) => ({ ...r, failed: Number(r.failed) || 0 }));
  }

  runsInStatus(statuses: Run["status"][]): Run[] {
    const q = statuses.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM runs WHERE status IN (${q})`).all(...statuses) as Row[]).map(toRun);
  }

  // ---------- events ----------
  insertEvent(runId: string, type: string, payload: unknown): EventRow {
    const ts = nowIso();
    const slim = slimEvent(payload);
    const res = this.db.prepare("INSERT INTO events(run_id, ts, type, payload_json) VALUES (?, ?, ?, ?)").run(runId, ts, type, JSON.stringify(slim));
    return { id: Number(res.lastInsertRowid), run_id: runId, ts, type, payload: slim };
  }

  /**
   * Drops transcripts for runs older than `days`, oldest first. The runs, their costs and their
   * results stay — only the message-by-message detail goes, which is what actually grows.
   */
  pruneEvents(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const res = this.db
      .prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?)")
      .run(cutoff);
    return Number(res.changes);
  }

  /** Rough size of the transcript table, for the Settings page. */
  eventStats(): { rows: number; bytes: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM events").get() as { rows: number; bytes: number };
    return { rows: Number(r.rows), bytes: Number(r.bytes) };
  }

  eventsAfter(runId: string, after = 0, limit = 2000): EventRow[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?").all(runId, after, limit) as Row[];
    return rows.map((r) => ({ id: Number(r.id), run_id: r.run_id as string, ts: r.ts as string, type: r.type as string, payload: json(r.payload_json, null) }));
  }

  // ---------- messages ----------
  insertMessage(m: { task_id: string; from_task_id: string | null; from_run_id: string | null; body: string }): Message {
    const id = newId("m");
    this.db.prepare("INSERT INTO messages(id, task_id, from_task_id, from_run_id, body, ts) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, m.task_id, m.from_task_id, m.from_run_id, m.body, nowIso(),
    );
    return toMessage(this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row);
  }

  /** Messages to or from a task, oldest first. */
  messagesForTask(taskId: string, limit = 200): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT rowid AS rid, * FROM messages WHERE task_id = ? OR from_task_id = ? ORDER BY rid DESC LIMIT ?) ORDER BY rid")
      .all(taskId, taskId, limit) as Row[];
    return rows.map(toMessage);
  }

  /** The rowid of the newest message to this task, or 0. A run notes it at start to know what is "new". */
  lastMessageRow(taskId: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM messages WHERE task_id = ?").get(taskId) as { m: number };
    return Number(r.m);
  }

  /** Messages to a task that arrived after `row`, oldest first, each with its rowid so the caller can advance. */
  messagesAfter(taskId: string, row: number): (Message & { rid: number })[] {
    const rows = this.db.prepare("SELECT rowid AS rid, * FROM messages WHERE task_id = ? AND rowid > ? ORDER BY rowid").all(taskId, row) as Row[];
    return rows.map((r) => ({ ...toMessage(r), rid: Number(r.rid) }));
  }

  inboundMessages(taskId: string, limit = 20): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT rowid AS rid, * FROM messages WHERE task_id = ? ORDER BY rid DESC LIMIT ?) ORDER BY rid")
      .all(taskId, limit) as Row[];
    return rows.map(toMessage);
  }

  // ---------- approvals ----------
  createApproval(a: { run_id: string; task_id: string; tool_name: string; input: unknown; title?: string | null }): Approval {
    const id = newId("a");
    this.db
      .prepare("INSERT INTO approvals(id, run_id, task_id, tool_name, input_json, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.run_id, a.task_id, a.tool_name, JSON.stringify(a.input ?? null), a.title ?? null, nowIso());
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return r && toApproval(r);
  }

  decideApproval(id: string, decision: ApprovalDecision, note: string | null): Approval {
    this.db.prepare("UPDATE approvals SET decision = ?, decided_at = ?, note = ? WHERE id = ? AND decision IS NULL").run(decision, nowIso(), note, id);
    return this.getApproval(id)!;
  }

  approvalsForTask(taskId: string): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(toApproval);
  }

  /** Pending approvals everywhere, with the task title and project attached. */
  pendingApprovalsAll(): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT approvals.*, tasks.title AS task_title, tasks.project_id AS project_id
         FROM approvals JOIN tasks ON tasks.id = approvals.task_id
         WHERE approvals.decision IS NULL ORDER BY approvals.created_at`,
      )
      .all() as Row[];
    return rows.map((r) => ({ ...toApproval(r), task_title: r.task_title as string, project_id: r.project_id as string }));
  }

  pendingApprovals(taskId?: string): Approval[] {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM approvals WHERE decision IS NULL AND task_id = ? ORDER BY created_at").all(taskId)
      : this.db.prepare("SELECT * FROM approvals WHERE decision IS NULL ORDER BY created_at").all();
    return (rows as Row[]).map(toApproval);
  }

  expirePendingApprovals(): number {
    return Number(this.db.prepare("UPDATE approvals SET decision = 'expired', decided_at = ? WHERE decision IS NULL").run(nowIso()).changes);
  }

  // ---------- project memory ----------
  /**
   * Records one memory line. Capped, de-duplicated and pruned on write: agent memory that grows
   * without bound is the documented failure mode ("catastrophic remembering"), and stale
   * contradictory notes poison later runs.
   */
  addNote(n: { project_id: string; task_id?: string | null; text: string; source?: Note["source"] }): Note | null {
    const text = n.text.trim().replace(/\s+/g, " ").slice(0, NOTE_MAX_CHARS);
    if (text.length < 8) return null;
    const dupe = this.db.prepare("SELECT id FROM notes WHERE project_id = ? AND lower(text) = lower(?)").get(n.project_id, text) as Row | undefined;
    if (dupe) {
      this.db.prepare("UPDATE notes SET ts = ? WHERE id = ?").run(nowIso(), dupe.id as string);
      return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(dupe.id as string) as unknown as Note;
    }
    const id = newId("n");
    this.db.prepare("INSERT INTO notes(id, project_id, task_id, text, source, ts) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, n.project_id, n.task_id ?? null, text, n.source ?? "agent", nowIso(),
    );
    this.db
      .prepare(`DELETE FROM notes WHERE project_id = ? AND id NOT IN (SELECT id FROM notes WHERE project_id = ? ORDER BY ts DESC LIMIT ?)`)
      .run(n.project_id, n.project_id, NOTE_KEEP_PER_PROJECT);
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as unknown as Note;
  }

  notes(projectId: string, limit = NOTE_KEEP_PER_PROJECT): Note[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM notes WHERE project_id = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts DESC")
      .all(projectId, limit) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      project_id: r.project_id as string,
      task_id: (r.task_id as string) ?? null,
      text: r.text as string,
      source: r.source as Note["source"],
      ts: r.ts as string,
    }));
  }

  deleteNote(id: string): void {
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }

  // ---------- usage limits ----------
  upsertUsageLimit(l: { type: string; status: string; utilization: number | null; resets_at: number | null }): UsageLimit {
    this.db
      .prepare(
        `INSERT INTO usage_limits(type, status, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(type) DO UPDATE SET status = excluded.status, utilization = excluded.utilization,
           resets_at = excluded.resets_at, updated_at = excluded.updated_at`,
      )
      .run(l.type, l.status, l.utilization, l.resets_at, nowIso());
    return this.usageLimits().find((u) => u.type === l.type)!;
  }

  /** Once a blocked window has reset, its "rejected" is history, not state. */
  clearRejectedLimits(): void {
    this.db.prepare("UPDATE usage_limits SET status = 'allowed' WHERE status = 'rejected'").run();
  }

  usageLimits(): UsageLimit[] {
    const rows = this.db.prepare("SELECT * FROM usage_limits ORDER BY type").all() as Row[];
    return rows.map((r) => ({
      type: r.type as string,
      status: r.status as UsageLimit["status"],
      utilization: r.utilization === null ? null : Number(r.utilization),
      resets_at: r.resets_at === null ? null : Number(r.resets_at),
      updated_at: r.updated_at as string,
    }));
  }

  // ---------- milestones ----------
  listMilestones(projectId: string): Milestone[] {
    return (this.db.prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY position, rowid").all(projectId) as Row[]).map(toMilestone);
  }

  getMilestone(id: string): Milestone | undefined {
    const r = this.db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as Row | undefined;
    return r && toMilestone(r);
  }

  createMilestone(m: { project_id: string; title: string; due_date?: string | null; notes?: string | null }): Milestone {
    const id = newId("ms");
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM milestones WHERE project_id = ?").get(m.project_id) as { p: number }).p;
    this.db.prepare("INSERT INTO milestones(id, project_id, title, position, due_date, notes) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, m.project_id, m.title, pos, m.due_date ?? null, m.notes ?? null,
    );
    return this.getMilestone(id)!;
  }

  updateMilestone(id: string, patch: { title?: string; position?: number; due_date?: string | null; notes?: string | null }): Milestone {
    const { sets, vals } = setClause(patch, { title: str, position: num, due_date: str, notes: str });
    if (sets.length) this.db.prepare(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getMilestone(id)!;
  }

  deleteMilestone(id: string): void {
    this.db.prepare("DELETE FROM milestones WHERE id = ?").run(id);
  }
}
