import { useEffect, useState } from "react";
import type { TaskCard } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { STATUS_META } from "../lib/format.ts";
import { Select } from "./ui.tsx";

/** The project's cards, kept current, for picking and naming the tasks one waits for. */
function useProjectTasks(projectId: string) {
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  useEffect(() => {
    void api.tasks(projectId).then(setTasks, () => setTasks([]));
  }, [projectId]);
  useWs((m) => {
    if (m.type === "task.updated" && m.task.project_id === projectId) {
      setTasks((prev) => (prev.some((t) => t.id === m.task.id) ? prev.map((t) => (t.id === m.task.id ? { ...t, ...m.task } : t)) : [...prev, { ...m.task, stage_states: [], cost_usd: 0 }]));
    } else if (m.type === "task.deleted") setTasks((prev) => prev.filter((t) => t.id !== m.taskId));
  });
  return tasks;
}

/**
 * Which tasks this one starts after, by name and where each is: a task queued before they are done
 * waits in Queued and starts by itself, with what they reported (D289–D291). Removing one lets it go
 * without it; a loop is refused by the server and its reason shown here.
 */
export function DependsOn({ projectId, selfId, value, onChange, editable = true }: {
  projectId: string;
  /** The task being edited, left out of the choices; absent for a task not made yet. */
  selfId?: string;
  value: string[];
  onChange: (next: string[]) => Promise<unknown> | void;
  editable?: boolean;
}) {
  const tasks = useProjectTasks(projectId);
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const set = async (next: string[]) => {
    setError(null);
    try {
      await onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Open work first: what is still to come is what a new link is usually about.
  const choices = tasks
    .filter((t) => t.id !== selfId && !value.includes(t.id) && !t.archived_at)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.position - b.position);
  return (
    <div className="space-y-1.5">
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const t = byId.get(id);
            const meta = t ? STATUS_META[t.status] : null;
            return (
              <span key={id} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-0.5 text-[12px]">
                {meta ? <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} /> : null}
                <button type="button" className="min-w-0 cursor-pointer truncate text-ink-100 hover:text-amber" onClick={() => navigate({ taskId: id })} title="Open it">
                  {t?.title ?? id}
                </button>
                <span className={`shrink-0 font-mono text-[10px] ${meta?.text ?? "text-ink-500"}`}>{t ? (t.status === "done" ? "done ✓" : meta!.label.toLowerCase()) : "gone"}</span>
                {editable ? (
                  <button type="button" className="shrink-0 cursor-pointer text-ink-500 hover:text-rust" title="Don't wait for this one" aria-label={`Stop waiting for ${t?.title ?? id}`} onClick={() => void set(value.filter((x) => x !== id))}>
                    ×
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
      {editable && choices.length ? (
        <Select
          className="text-[12px]"
          aria-label="Starts after"
          value=""
          onChange={(e) => {
            if (e.target.value) void set([...value, e.target.value]);
          }}
        >
          <option value="">{value.length ? "+ and after…" : "+ starts after…"}</option>
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} · {t.status === "done" ? "done" : STATUS_META[t.status].label.toLowerCase()}
            </option>
          ))}
        </Select>
      ) : null}
      {error ? <div className="text-[11.5px] text-rust">{error}</div> : null}
    </div>
  );
}
