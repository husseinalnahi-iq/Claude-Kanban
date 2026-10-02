import type { Repo } from "./repo.ts";

export interface SearchHit {
  kind: "task" | "run" | "transcript" | "memory" | "message";
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  runId?: string;
  /** Where the match was found, for the result line. */
  where: string;
  snippet: string;
  ts: string;
}

/** A short window around the first match, so a result line shows why it matched. */
function snippet(text: string, needle: string, width = 160): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text.slice(0, width).trim();
  const start = Math.max(0, i - Math.floor(width / 3));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + width).trim().replace(/\s+/g, " ")}${start + width < text.length ? "…" : ""}`;
}

/** How many of the most recent runs have their transcripts searched. Results, errors, specs and messages are searched in full. */
const TRANSCRIPT_RUNS = 200;

/** A LIKE pattern for "contains this text": `\` is the escape character, so it is escaped along with `%` and `_`. */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
const ESC = "ESCAPE '\\'";

const HIT_TASK = "tasks.title AS task_title, tasks.project_id AS project_id, projects.name AS project_name";
const HIT_JOIN = "JOIN tasks ON tasks.id = $.task_id JOIN projects ON projects.id = tasks.project_id";

/**
 * Search across everything the board remembers: task specs, run results and errors, transcripts,
 * messages and project memory. This is how you find "what did we do about X three days ago"
 * without reopening a stale session. Newest first; shared by the search box and runs'
 * `board_search_past_work`.
 */
export function searchBoard(repo: Repo, q: string, opts: { project?: string; limit?: number } = {}): SearchHit[] {
  const { project, limit } = opts;
  const needle = q.trim();
  if (needle.length < 2) return [];
  const lower = needle.toLowerCase();
  const cap = Math.min(80, Math.max(5, limit || 40));
  const like = contains(needle);
  // A transcript is stored as JSON, where a quote or a backslash in the text is written with a
  // backslash in front: look for the text the way it is stored.
  const stored = JSON.stringify(needle).slice(1, -1);
  const projects = new Map(repo.listProjects().map((p) => [p.id, p.name]));
  const tasks = new Map(
    (project ? repo.listTasks({ project_id: project }) : [...projects.keys()].flatMap((id) => repo.listTasks({ project_id: id }))).map((t) => [t.id, t]),
  );
  const hits: SearchHit[] = [];

  for (const t of tasks.values()) {
    const field = [
      ["title", t.title],
      ["spec", t.spec_md],
      ["summary", t.summary ?? ""],
      ["note", t.note ?? ""],
      ["error", t.error ?? ""],
    ].find(([, v]) => v.toLowerCase().includes(lower));
    if (field) {
      hits.push({
        kind: "task", taskId: t.id, taskTitle: t.title, projectId: t.project_id, projectName: projects.get(t.project_id) ?? "",
        where: `task ${field[0]}`, snippet: snippet(field[1], needle), ts: t.updated_at,
      });
    }
  }

  // The project is part of each query, not a filter on its answer: the newest matches anywhere used
  // to be fetched first and the other projects' thrown away, which could leave nothing for this one.
  const scope = project ? "tasks.project_id = ?" : "projects.system = 0";
  const scoped = project ? [project] : [];
  const rows = (sql: string, ...args: (string | number)[]) => repo.stmt(sql).all(...args) as Record<string, string>[];
  const base = (r: Record<string, string>) => ({ taskId: r.task_id, taskTitle: r.task_title, projectId: r.project_id, projectName: r.project_name });

  for (const r of rows(
    `SELECT runs.id, runs.task_id, runs.stage, runs.result_md, runs.error, runs.started_at, ${HIT_TASK}
     FROM runs ${HIT_JOIN.replace("$", "runs")}
     WHERE ${scope} AND (runs.result_md LIKE ? ${ESC} OR runs.error LIKE ? ${ESC})
     ORDER BY runs.started_at DESC LIMIT ?`,
    ...scoped, like, like, cap,
  )) {
    const text = (r.result_md ?? "").toLowerCase().includes(lower) ? r.result_md : r.error;
    hits.push({ kind: "run", ...base(r), runId: r.id, where: `${r.stage} result`, snippet: snippet(text ?? "", needle), ts: r.started_at });
  }

  // Transcripts are by far the biggest table and this search reads them on the server's only thread,
  // so it looks through the latest runs rather than all of them. `+events.id` keeps the database from
  // walking the whole table newest-first to honour the ordering.
  for (const e of rows(
    `SELECT events.run_id, events.ts, events.payload_json, runs.task_id, runs.stage, ${HIT_TASK}
     FROM events JOIN runs ON runs.id = events.run_id ${HIT_JOIN.replace("$", "runs")}
     WHERE events.run_id IN (
             SELECT runs.id FROM runs ${HIT_JOIN.replace("$", "runs")} WHERE ${scope} ORDER BY runs.started_at DESC LIMIT ${TRANSCRIPT_RUNS})
       AND events.type IN ('assistant','user:prompt','user:chat','verify:failed') AND events.payload_json LIKE ? ${ESC}
     ORDER BY +events.id DESC LIMIT ?`,
    ...scoped, contains(stored), cap,
  )) {
    hits.push({
      kind: "transcript",
      ...base(e),
      runId: e.run_id,
      where: `${e.stage} transcript`,
      snippet: snippet(e.payload_json.replace(/\\n/g, " ").replace(/"[a-z_]+":/g, " "), stored),
      ts: e.ts,
    });
  }

  for (const m of rows(
    `SELECT messages.task_id, messages.body, messages.ts, ${HIT_TASK}
     FROM messages ${HIT_JOIN.replace("$", "messages")}
     WHERE ${scope} AND messages.body LIKE ? ${ESC} ORDER BY messages.ts DESC LIMIT ?`,
    ...scoped, like, cap,
  )) {
    hits.push({ kind: "message", ...base(m), where: "message", snippet: snippet(m.body, needle), ts: m.ts });
  }

  for (const p of projects.keys()) {
    if (project && p !== project) continue;
    for (const n of repo.notes(p)) {
      if (!n.text.toLowerCase().includes(lower)) continue;
      const t = n.task_id ? tasks.get(n.task_id) : undefined;
      hits.push({
        kind: "memory",
        taskId: n.task_id ?? "",
        taskTitle: t?.title ?? "(project memory)",
        projectId: p,
        projectName: projects.get(p) ?? "",
        where: "memory",
        snippet: n.text,
        ts: n.ts,
      });
    }
  }

  return hits.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, cap);
}
