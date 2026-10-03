-- Idempotent: every statement is safe to run on every boot.

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  policy_json TEXT NOT NULL,
  env_json    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  due_date   TEXT,
  notes      TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  milestone_id  TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  spec_md       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'backlog',
  type          TEXT NOT NULL DEFAULT 'feature',
  priority      TEXT NOT NULL DEFAULT 'p2',
  labels_json   TEXT NOT NULL DEFAULT '[]',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  related_to_json TEXT NOT NULL DEFAULT '[]',
  auto_queue_children INTEGER NOT NULL DEFAULT 0,
  triaged_at    TEXT,
  suggestion_json TEXT,
  plan_gate_json TEXT,
  blocked_json  TEXT,
  questions_json TEXT NOT NULL DEFAULT '[]',
  checkout_json TEXT,
  plan_approval INTEGER,
  live          INTEGER NOT NULL DEFAULT 0,
  own_branch    INTEGER NOT NULL DEFAULT 0,
  chat_id       TEXT,
  mode        TEXT NOT NULL DEFAULT 'supervised',
  pipeline_json TEXT NOT NULL DEFAULT '[]',
  skills_json   TEXT NOT NULL DEFAULT '[]',
  branch        TEXT,
  worktree_path TEXT,
  base_sha      TEXT,
  summary       TEXT,
  note          TEXT,
  error         TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
-- Paused, queued and running cards are looked up by status; without this each lookup read every spec.
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  stage_index   INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT,
  model         TEXT NOT NULL,
  effort        TEXT NOT NULL,
  status        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  result_md     TEXT,
  error         TEXT,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  limit_before  REAL,
  limit_after   REAL,
  provider      TEXT,
  role          TEXT NOT NULL DEFAULT 'stage',
  cost_source   TEXT NOT NULL DEFAULT 'sdk'
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
-- Sessions and analytics both read newest-first across all runs.
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_task_id TEXT,
  from_run_id  TEXT,
  body         TEXT NOT NULL,
  ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
-- A task's drawer lists what it sent as well as what it received.
CREATE INDEX IF NOT EXISTS messages_from ON messages(from_task_id);

CREATE TABLE IF NOT EXISTS approvals (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  input_json TEXT NOT NULL,
  title      TEXT,
  decision   TEXT,
  decided_at TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id);
-- pendingApprovals() and the task drawer both filter by task.
CREATE INDEX IF NOT EXISTS approvals_task ON approvals(task_id, created_at);
-- The approvals inbox: a handful of undecided cards among thousands of decided ones.
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(created_at) WHERE decision IS NULL;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Durable, per-project board memory: short decisions/conventions learned from finished tasks.
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    TEXT,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'agent',
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_project ON notes(project_id, ts);
-- Which notes each task's prompts carried, and how the task ended: the evidence for "this note helps"
-- or "this note keeps showing up on work that is sent back" (D308). The last verdict on a task wins.
CREATE TABLE IF NOT EXISTS note_uses (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  verdict TEXT,
  PRIMARY KEY (note_id, task_id)
);
CREATE INDEX IF NOT EXISTS note_uses_task ON note_uses(task_id);
-- Full-text index over the notes, so a prompt carries the ones about its task, not just the newest.
-- Kept in step by triggers; rebuilt on every open (db.ts), because it points at implicit rowids.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content='notes', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE OF text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Subscription usage windows reported by the CLI (five_hour, seven_day, ...), latest value per type.
CREATE TABLE IF NOT EXISTS usage_limits (
  type        TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  utilization REAL,
  resets_at   INTEGER,
  updated_at  TEXT NOT NULL
);

-- Delegated providers that ran out (a usage window, their credit, or too busy), until they come back.
CREATE TABLE IF NOT EXISTS provider_limits (
  provider_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  resets_at   TEXT,
  updated_at  TEXT NOT NULL
);

-- Images belonging to a task: ones you attached, and ones a session produced (screenshots, generated
-- files). The bytes live under <stateDir>/attachments/<task>/; this table is the index.
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  path        TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_task ON attachments(task_id, created_at);

-- Repeating schedules: a card template turned into a fresh card each time it comes round.
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  spec_md       TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL DEFAULT 'supervised',
  type          TEXT NOT NULL DEFAULT 'feature',
  priority      TEXT NOT NULL DEFAULT 'p2',
  pipeline_json TEXT NOT NULL DEFAULT '[]',
  skills_json   TEXT NOT NULL DEFAULT '[]',
  days_json     TEXT NOT NULL DEFAULT '[]',
  time          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_run_at   TEXT,
  last_run_at   TEXT,
  last_task_id  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_project ON schedules(project_id);

-- Small jobs that are not runs but are spend: sorting a new task (triage) and describing an attached
-- image (vision). Kept so the Dashboard's total is the real total (D276).
CREATE TABLE IF NOT EXISTS intake_costs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT,
  kind       TEXT NOT NULL,
  model      TEXT NOT NULL,
  cost_usd   REAL NOT NULL DEFAULT 0,
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_costs_project ON intake_costs(project_id);

-- Side chat: conversations about a project, one Claude session each. Reads code, makes cards; never edits.
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  session_id  TEXT,
  model       TEXT NOT NULL,
  effort      TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'anthropic',
  cost_usd    REAL NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_project ON chats(project_id, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role      TEXT NOT NULL,
  text      TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  ts        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, id);

-- Folders a project's chats can be filed in (the Studio's left pane). A chat's folder_id names one; deleting
-- a folder only empties it, the chats stay.
CREATE TABLE IF NOT EXISTS chat_folders (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_folders_project ON chat_folders(project_id, position);

-- Files attached to a chat (D334): stored under the state dir like a task's attachments. message_id is
-- null until the message they ride with is sent.
CREATE TABLE IF NOT EXISTS chat_files (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id  INTEGER,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_files_chat ON chat_files(chat_id, id);

-- A task's spec versions: your own text and each AI rewrite of it, so any of them can come back.
CREATE TABLE IF NOT EXISTS spec_versions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  spec_md     TEXT NOT NULL,
  model       TEXT,
  effort      TEXT,
  source_id   TEXT,
  instruction TEXT,
  summary     TEXT,
  cost_usd    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spec_versions_task ON spec_versions(task_id, created_at);
