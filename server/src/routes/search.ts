import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";

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

/**
 * Search across everything the board remembers: task specs, run results and errors, transcripts,
 * messages and project memory. This is how you find "what did we do about X three days ago"
 * without reopening a stale session.
 */
export async function searchRoutes(app: FastifyInstance, { repo }: AppDeps) {
  app.get("/search", async (req) => {
    const { q, project, limit } = req.query as { q?: string; project?: string; limit?: string };
    const needle = (q ?? "").trim();
    if (needle.length < 2) return [];
    const cap = Math.min(80, Math.max(5, Number(limit) || 40));
    const like = `%${needle.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const projects = new Map(repo.listProjects().map((p) => [p.id, p.name]));
    const tasks = new Map(
      (project ? repo.listTasks({ project_id: project }) : [...projects.keys()].flatMap((id) => repo.listTasks({ project_id: id }))).map((t) => [t.id, t]),
    );
    const hits: SearchHit[] = [];
    const base = (taskId: string) => {
      const t = tasks.get(taskId)!;
      return { taskId, taskTitle: t.title, projectId: t.project_id, projectName: projects.get(t.project_id) ?? "" };
    };

    for (const t of tasks.values()) {
      const field = [
        ["title", t.title],
        ["spec", t.spec_md],
        ["summary", t.summary ?? ""],
        ["note", t.note ?? ""],
        ["error", t.error ?? ""],
      ].find(([, v]) => v.toLowerCase().includes(needle.toLowerCase()));
      if (field) hits.push({ kind: "task", ...base(t.id), where: `task ${field[0]}`, snippet: snippet(field[1], needle), ts: t.updated_at });
    }

    const rows = (sql: string, ...args: unknown[]) => repo.db.prepare(sql).all(...(args as never[])) as Record<string, string>[];

    for (const r of rows(
      `SELECT runs.id, runs.task_id, runs.stage, runs.result_md, runs.error, runs.started_at FROM runs
       WHERE (runs.result_md LIKE ? ESCAPE '\\' OR runs.error LIKE ? ESCAPE '\\') ORDER BY runs.started_at DESC LIMIT ?`,
      like, like, cap,
    )) {
      if (!tasks.has(r.task_id)) continue;
      const text = (r.result_md ?? "").toLowerCase().includes(needle.toLowerCase()) ? r.result_md : r.error;
      hits.push({ kind: "run", ...base(r.task_id), runId: r.id, where: `${r.stage} result`, snippet: snippet(text ?? "", needle), ts: r.started_at });
    }

    for (const e of rows(
      `SELECT events.run_id, events.ts, events.type, events.payload_json, runs.task_id, runs.stage FROM events
       JOIN runs ON runs.id = events.run_id
       WHERE events.type IN ('assistant','user:prompt','user:chat','verify:failed') AND events.payload_json LIKE ? ESCAPE '\\'
       ORDER BY events.id DESC LIMIT ?`,
      like, cap,
    )) {
      if (!tasks.has(e.task_id)) continue;
      hits.push({
        kind: "transcript",
        ...base(e.task_id),
        runId: e.run_id,
        where: `${e.stage} transcript`,
        snippet: snippet(e.payload_json.replace(/\\n/g, " ").replace(/"[a-z_]+":/g, " "), needle),
        ts: e.ts,
      });
    }

    for (const m of rows(`SELECT * FROM messages WHERE body LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`, like, cap)) {
      if (!tasks.has(m.task_id)) continue;
      hits.push({ kind: "message", ...base(m.task_id), where: "message", snippet: snippet(m.body, needle), ts: m.ts });
    }

    for (const p of projects.keys()) {
      if (project && p !== project) continue;
      for (const n of repo.notes(p)) {
        if (!n.text.toLowerCase().includes(needle.toLowerCase())) continue;
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
  });
}
