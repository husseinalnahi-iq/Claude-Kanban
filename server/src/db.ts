import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "./config.ts";
import type { ModelEntry, Settings, Stage } from "./types.ts";

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

/**
 * Refused in both modes, before the model's choice or any settings file is consulted. These are the
 * commands that documented agent incidents actually ran: a dropped production database during a
 * code freeze, a force-push over someone's work, a piped installer from the internet.
 */
export const DEFAULT_BLOCKED_COMMANDS: string[] = [
  "rm -rf /",
  "rm -rf ~",
  "drop database",
  "drop schema",
  "truncate table",
  "git push --force",
  "git push -f",
  "shutdown",
  "mkfs",
  "diskpart",
  "format c:",
  "curl | sh",
  "curl | bash",
  "wget | sh",
  "iwr | iex",
  "invoke-expression",
];

export const SEED_MODELS: ModelEntry[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "hardest tasks (costly)" },
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "execution (default)" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "mechanical / review" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "trivial / read-only" },
];

export const SEED_TIERS: Settings["tiers"] = {
  cheap: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  balanced: { provider: "anthropic", model: "claude-sonnet-5-5" },
  strong: { provider: "anthropic", model: "claude-opus-5-5" },
};

/**
 * Looks at each attached image once. Haiku is Claude's cheapest model that can see, and reads text in
 * screenshots well; describing an image is looking, not reasoning, so it runs at low effort. It is
 * also the fallback when another provider chosen for vision cannot see.
 */
export const DEFAULT_VISION_MODEL = "claude-haiku-4-5-20251001";

export const SEED_DEBATE: Settings["debate"] = {
  enabled: false,
  critic: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
  mode: "once",
  rounds: 3,
};

/**
 * Opus thinks the plan through at high effort; coding at medium thinks less per step, and a plan
 * already says what to do. The Neon Drift run landed working this way for $3.46 (D270).
 */
export const SEED_PIPELINE: Stage[] = [
  { stage: "plan", model: "claude-opus-5-5", effort: "high" },
  { stage: "code", model: "claude-opus-5-5", effort: "medium" },
  { stage: "review", model: "claude-sonnet-5-5", effort: "medium" },
];

/**
 * Defaults the board used to ship. A board whose saved default is still exactly one of these never
 * chose it, so it moves to the current one; a default anyone edited is left alone (D270).
 */
const RETIRED_PIPELINES: Stage[][] = [
  [
    { stage: "plan", model: "claude-fable-5-1", effort: "high" },
    { stage: "code", model: "claude-opus-5", effort: "high" },
    { stage: "review", model: "claude-sonnet-5", effort: "medium" },
  ],
  // The same, after "move to newer models" took Opus 5 and Sonnet 5 to 5.5.
  [
    { stage: "plan", model: "claude-fable-5-1", effort: "high" },
    { stage: "code", model: "claude-opus-5-5", effort: "high" },
    { stage: "review", model: "claude-sonnet-5-5", effort: "medium" },
  ],
];

const samePipeline = (a: unknown, b: Stage[]) =>
  Array.isArray(a) &&
  a.length === b.length &&
  a.every((s: Record<string, unknown>, i) => Object.keys(s).length === 3 && s.stage === b[i].stage && s.model === b[i].model && s.effort === b[i].effort);

/** Columns added after the first schema; ALTER only when missing so boots stay idempotent. */
const LATER_COLUMNS: { table: string; column: string; ddl: string; backfill?: string }[] = [
  { table: "runs", column: "context_tokens", ddl: "context_tokens INTEGER NOT NULL DEFAULT 0" },
  { table: "runs", column: "context_window", ddl: "context_window INTEGER NOT NULL DEFAULT 0" },
  { table: "projects", column: "env_json", ddl: "env_json TEXT NOT NULL DEFAULT '{}'" },
  { table: "tasks", column: "type", ddl: "type TEXT NOT NULL DEFAULT 'feature'" },
  { table: "tasks", column: "priority", ddl: "priority TEXT NOT NULL DEFAULT 'p2'" },
  { table: "tasks", column: "labels_json", ddl: "labels_json TEXT NOT NULL DEFAULT '[]'" },
  { table: "tasks", column: "depends_on_json", ddl: "depends_on_json TEXT NOT NULL DEFAULT '[]'" },
  { table: "tasks", column: "auto_queue_children", ddl: "auto_queue_children INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "triaged_at", ddl: "triaged_at TEXT" },
  { table: "tasks", column: "suggestion_json", ddl: "suggestion_json TEXT" },
  { table: "tasks", column: "related_to_json", ddl: "related_to_json TEXT NOT NULL DEFAULT '[]'" },
  { table: "projects", column: "merge_json", ddl: "merge_json TEXT NOT NULL DEFAULT '{}'" },
  { table: "tasks", column: "archived_at", ddl: "archived_at TEXT" },
  { table: "tasks", column: "resume_at", ddl: "resume_at TEXT" },
  { table: "attachments", column: "description", ddl: "description TEXT" },
  { table: "attachments", column: "described_by", ddl: "described_by TEXT" },
  { table: "runs", column: "limit_before", ddl: "limit_before REAL" },
  { table: "runs", column: "limit_after", ddl: "limit_after REAL" },
  { table: "runs", column: "cache_read_tokens", ddl: "cache_read_tokens INTEGER NOT NULL DEFAULT 0" },
  { table: "runs", column: "cache_write_tokens", ddl: "cache_write_tokens INTEGER NOT NULL DEFAULT 0" },
  { table: "runs", column: "other_models_usd", ddl: "other_models_usd REAL NOT NULL DEFAULT 0" },
  { table: "runs", column: "provider", ddl: "provider TEXT" },
  { table: "runs", column: "role", ddl: "role TEXT NOT NULL DEFAULT 'stage'" },
  { table: "runs", column: "cost_source", ddl: "cost_source TEXT NOT NULL DEFAULT 'sdk'" },
  { table: "tasks", column: "plan_gate_json", ddl: "plan_gate_json TEXT" },
  { table: "tasks", column: "onboarding", ddl: "onboarding TEXT" },
  { table: "projects", column: "system", ddl: "system INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "blocked_json", ddl: "blocked_json TEXT" },
  { table: "tasks", column: "questions_json", ddl: "questions_json TEXT NOT NULL DEFAULT '[]'" },
  { table: "tasks", column: "checkout_json", ddl: "checkout_json TEXT" },
  { table: "tasks", column: "start_at", ddl: "start_at TEXT" },
  { table: "approvals", column: "answer_json", ddl: "answer_json TEXT" },
  { table: "tasks", column: "pause_reason", ddl: "pause_reason TEXT" },
  { table: "tasks", column: "budget_extra_usd", ddl: "budget_extra_usd REAL NOT NULL DEFAULT 0" },
  { table: "tasks", column: "plan_approval", ddl: "plan_approval INTEGER" },
  { table: "tasks", column: "live", ddl: "live INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "own_branch", ddl: "own_branch INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "checklist_json", ddl: "checklist_json TEXT NOT NULL DEFAULT '[]'" },
  { table: "tasks", column: "done_at", ddl: "done_at TEXT" },
  { table: "tasks", column: "chat_id", ddl: "chat_id TEXT" },
  { table: "chats", column: "provider", ddl: "provider TEXT NOT NULL DEFAULT 'anthropic'" },
  { table: "chats", column: "folder_id", ddl: "folder_id TEXT" },
  { table: "chats", column: "warm_at", ddl: "warm_at TEXT" },
  { table: "chats", column: "keep_alive", ddl: "keep_alive INTEGER NOT NULL DEFAULT 1" },
  { table: "chats", column: "use_tools", ddl: "use_tools INTEGER NOT NULL DEFAULT 0" },
  { table: "chat_folders", column: "color", ddl: "color TEXT" },
  { table: "chats", column: "mode", ddl: "mode TEXT NOT NULL DEFAULT 'supervised'" },
  {
    table: "notes", column: "kind", ddl: "kind TEXT NOT NULL DEFAULT 'lesson'",
    // Until kinds, the board wrote two notes of its own: each approved task's outcome, and the verify
    // command it set (D165), which is a fact about the project rather than something a task did.
    backfill: "UPDATE notes SET kind = 'outcome' WHERE source = 'board' AND text NOT LIKE 'Verify command set to %'",
  },
  { table: "notes", column: "flag_reason", ddl: "flag_reason TEXT" },
  { table: "notes", column: "flagged_at", ddl: "flagged_at TEXT" },
  { table: "notes", column: "flag_task_id", ddl: "flag_task_id TEXT" },
];

/**
 * Indexes on columns from LATER_COLUMNS. They cannot live in schema.sql: that file runs before the
 * columns are added, so on a board from before the column existed the index would fail the boot.
 */
const LATER_INDEXES: string[] = [
  // The scheduler looks for cards with a start time every few seconds; nearly every card has none.
  "CREATE INDEX IF NOT EXISTS tasks_start_at ON tasks(start_at) WHERE start_at IS NOT NULL",
];

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Eight random bytes: approvals and messages are made by the thousand, and at four bytes two of them
 * sharing an id — which fails the insert, and with it a tool call or a stage — was only a matter of time.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string, backfill?: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  // Only on the boot that adds the column: later rows get their value when they are written.
  if (backfill) db.exec(backfill);
}

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // NORMAL is the standard durability level under WAL; FULL fsyncs on every streamed event.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  for (const c of LATER_COLUMNS) addColumnIfMissing(db, c.table, c.column, c.ddl, c.backfill);
  for (const ddl of LATER_INDEXES) db.exec(ddl);
  // The memory index is new to older boards, and it follows `notes` by implicit rowid, which a VACUUM
  // may renumber. Rebuilding is a few hundred short rows at most, so it is simply done every time.
  db.exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')");
  // Boards from before done_at only know when a finished task was last touched: the best date there is.
  db.exec("UPDATE tasks SET done_at = updated_at WHERE status = 'done' AND done_at IS NULL");

  // Before seeding anything: a board that already has settings is an upgrade, and must keep behaving
  // as it did. Only a brand-new state directory gets the one-at-a-time default.
  const fresh = (db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n === 0;

  const seed = db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
  seed.run("models", JSON.stringify(SEED_MODELS));
  seed.run("defaultPipeline", JSON.stringify(SEED_PIPELINE));
  seed.run("globalCap", "8");
  seed.run("defaultMaxConcurrent", "3");
  seed.run("serial", fresh ? "true" : "false");
  seed.run("maxForcedParallel", "3");
  seed.run("visionModel", DEFAULT_VISION_MODEL);
  // Codex when it is linked, and no picture tool until then (D303).
  seed.run("imageProvider", "codex");
  seed.run("cloudflareAccountId", "");
  seed.run("tiers", JSON.stringify(SEED_TIERS));
  seed.run("providers", "[]");
  seed.run("debate", JSON.stringify(SEED_DEBATE));
  seed.run("delegateTimeoutMin", "30");
  seed.run("autoSizing", "true");
  seed.run("autoResume", "true");
  seed.run("claudeFallback", "null");
  seed.run("keepAwake", "true");
  seed.run("questionWaitMin", "0");
  seed.run("chatModel", "claude-sonnet-5-5");
  seed.run("chatEffort", "medium");
  seed.run("chatKeepAlive", "true");
  seed.run("chatKeepAliveMessage", "Hi, just keeping this chat warm. Reply in one line.");
  seed.run("chatKeepAliveMaxHours", "8");
  seed.run("nextStepsSuggestions", "true");
  seed.run("specModel", "claude-opus-5-5");
  seed.run("specEffort", "high");
  seed.run("loadUserPlugins", "true");
  seed.run("claudeAutoMemory", "false");
  seed.run("browserChecks", "true");
  seed.run("chromeInSupervised", "false");
  seed.run("autoAllowReadOnly", "true");
  seed.run("markitdownInTasks", "true");
  seed.run("planApproval", "false");
  seed.run("autoContinueTurns", "2");
  seed.run("liveReviewModel", "claude-opus-5-5");
  seed.run("followLatestModels", "true");
  // Measured (D273): a Sonnet helper did not make a whole task cheaper, only more thoroughly checked.
  seed.run("browserCheckModel", "stage");
  seed.run("autoUpdateEngine", "true");
  seed.run("liveView", "true");
  seed.run("maxCostPerTaskUsd", "15");
  seed.run("maxRepeatedToolCalls", "8");
  seed.run("eventRetentionDays", "30");
  seed.run("blockedCommands", JSON.stringify(DEFAULT_BLOCKED_COMMANDS));
  seed.run("disabledSkills", "[]");
  seed.run("maxTurnsPerStage", "60");
  seed.run("maxCostPerStageUsd", "5");
  seed.run("maxSubagentDepth", "2");
  seed.run("maxConcurrentSubagents", "5");
  seed.run("cacheableSystemPrompt", "true");
  seed.run("autoTriage", "true");
  seed.run("triageModel", "claude-haiku-4-5-20251001");
  seed.run("stateDir", STATE_DIR);

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'defaultPipeline'").get() as { value: string } | undefined;
  let saved: unknown = null;
  try {
    saved = JSON.parse(stored?.value ?? "null");
  } catch {
    // unreadable: left for the settings reader's own fallback
  }
  if (RETIRED_PIPELINES.some((old) => samePipeline(saved, old))) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'defaultPipeline'").run(JSON.stringify(SEED_PIPELINE));
  }
  return db;
}
