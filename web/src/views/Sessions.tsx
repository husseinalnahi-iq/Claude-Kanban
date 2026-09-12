import { useCallback, useEffect, useState } from "react";
import type { RunListItem } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { ago, cost, elapsed, modelLabel, tokens } from "../lib/format.ts";
import { Empty } from "../components/ui.tsx";
import { ContextBar } from "../components/UsageMeters.tsx";

const TONE = { running: "text-amber", approval: "text-rose", success: "text-moss", failed: "text-rust" } as const;

export function Sessions() {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [, tick] = useState(0);
  const load = useCallback(() => void api.runs().then(setRuns), []);
  useEffect(load, [load]);
  useWs((m) => {
    if (m.type === "run.updated" || m.type === "run.finished") {
      setRuns((prev) => (prev.some((r) => r.id === m.run.id) ? prev.map((r) => (r.id === m.run.id ? { ...r, ...m.run } : r)) : prev));
      if (m.type === "run.updated" && !runs.some((r) => r.id === m.run.id)) load();
    }
  });
  const live = runs.filter((r) => r.status === "running" || r.status === "approval");
  useEffect(() => {
    if (!live.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live.length]);

  const total = runs.reduce((s, r) => s + r.cost_usd, 0);
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-baseline gap-4">
        <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">Sessions</h1>
        <span className="font-mono text-[12px] text-ink-400">
          {live.length} live · {runs.length} total · {cost(total)}
        </span>
      </div>
      {!runs.length ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-left text-[12.5px]">
            <thead className="bg-ink-900 text-[10.5px] uppercase tracking-wider text-ink-500">
              <tr>
                {["State", "Project", "Task", "Stage", "Model", "Effort", "Cost", "Tokens in/out", "Context", "Elapsed", "Started"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => navigate({ view: "board", projectId: r.project_id, taskId: r.task_id })}
                  className="cursor-pointer border-t border-ink-800 hover:bg-ink-850"
                >
                  <td className={`px-3 py-2 font-mono text-[11.5px] ${TONE[r.status]}`}>
                    <span className={r.status === "running" ? "breathe" : ""}>●</span> {r.status}
                  </td>
                  <td className="px-3 py-2 text-ink-300">{r.project_name}</td>
                  <td className="max-w-[280px] truncate px-3 py-2 text-ink-100">{r.task_title}</td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-ink-300">{r.stage}</td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-ink-200">{modelLabel(r)}</td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-ink-400">{r.effort}</td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-ink-200">{cost(r.cost_usd)}</td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-ink-400">{tokens(r.input_tokens)} / {tokens(r.output_tokens)}</td>
                  <td className="px-3 py-2"><ContextBar used={r.context_tokens} window={r.context_window} compact /></td>
                  <td className="px-3 py-2 font-mono text-[11.5px] text-ink-300">{elapsed(r.started_at, r.ended_at)}</td>
                  <td className="px-3 py-2 text-[11.5px] text-ink-500">{ago(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
