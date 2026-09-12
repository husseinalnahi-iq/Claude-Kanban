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
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "planning / design" },
  { id: "claude-opus-5", label: "Opus 5", note: "execution (default)" },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "mechanical / review" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "trivial / read-only" },
];

export const SEED_TIERS: Settings["tiers"] = {
  cheap: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  balanced: { provider: "anthropic", model: "claude-sonnet-5" },
  strong: { provider: "anthropic", model: "claude-opus-5" },
};

/**
 * Looks at each attached image once. Haiku is Claude's cheapest model that can see, and reads text in
 * screenshots well; describing an image is looking, not reasoning, so it runs at low effort. It is
 * also the fallback when another provider chosen for vision cannot see.
 */
export const DEFAULT_VISION_MODEL = "claude-haiku-4-5-20251001";

export const SEED_DEBATE: Settings["debate"] = {
  enabled: false,
  critic: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
};

export const SEED_PIPELINE: Stage[] = [
  { stage: "plan", model: "claude-fable-5-1", effort: "high" },
  { stage: "code", model: "claude-opus-5", effort: "high" },
  { stage: "review", model: "claude-sonnet-5", effort: "medium" },
];

/** Columns added after the first schema; ALTER only when missing so boots stay idempotent. */
const LATER_COLUMNS: { table: string; column: string; ddl: string }[] = [
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
  { table: "runs", column: "provider", ddl: "provider TEXT" },
  { table: "runs", column: "role", ddl: "role TEXT NOT NULL DEFAULT 'stage'" },
  { table: "runs", column: "cost_source", ddl: "cost_source TEXT NOT NULL DEFAULT 'sdk'" },
  { table: "tasks", column: "plan_gate_json", ddl: "plan_gate_json TEXT" },
  { table: "tasks", column: "onboarding", ddl: "onboarding TEXT" },
  { table: "projects", column: "system", ddl: "system INTEGER NOT NULL DEFAULT 0" },
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // NORMAL is the standard durability level under WAL; FULL fsyncs on every streamed event.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  for (const c of LATER_COLUMNS) addColumnIfMissing(db, c.table, c.column, c.ddl);

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
  seed.run("tiers", JSON.stringify(SEED_TIERS));
  seed.run("providers", "[]");
  seed.run("debate", JSON.stringify(SEED_DEBATE));
  seed.run("delegateTimeoutMin", "30");
  seed.run("autoSizing", "true");
  seed.run("autoResume", "true");
  seed.run("loadUserPlugins", "true");
  seed.run("browserChecks", "true");
  seed.run("chromeInSupervised", "false");
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
  return db;
}
