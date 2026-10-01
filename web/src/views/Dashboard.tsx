import { useCallback, useEffect, useRef, useState } from "react";
import type { Analytics } from "../../../server/src/routes/analytics.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { useWs, useWsReconnect } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { cost, STATUS_META } from "../lib/format.ts";
import { BarRows, CATEGORICAL, Donut, LineChart, MONEY, Panel, PRIORITY_RAMP, SERIES_A, SERIES_B, Stat, TableToggle } from "../components/charts.tsx";
import { Empty } from "../components/ui.tsx";

const PRIORITY_LABEL: Record<string, string> = { p0: "p0 · now", p1: "p1 · soon", p2: "p2 · normal", p3: "p3 · later" };

export function Dashboard({ project }: { project: ProjectWithGit | null }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(() => {
    void api.analytics(project?.id, days).then(setData, () => setData(null));
  }, [project?.id, days]);
  useEffect(load, [load]);
  useWsReconnect(load);
  // A stage that starts or ends sends several task updates within a moment, and each one used to
  // recount every chart. They are gathered into one reload, half a second after the last of them.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 500);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useWs((m) => {
    // A task update in another project used to refetch this whole dashboard. Run and delete events
    // carry no project, so those still reload — they are rare, one per finished stage.
    if (m.type === "task.updated") {
      if (!project || m.task.project_id === project.id) soon();
      return;
    }
    if (m.type === "run.finished" || m.type === "task.deleted") soon();
  });

  if (!data) return <div className="p-6 text-[13px] text-ink-400">Loading…</div>;
  const t = data.totals;
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  const hours = (v: number | null) => (v === null ? "—" : v < 1 ? `${Math.round(v * 60)}m` : v < 48 ? `${v.toFixed(1)}h` : `${(v / 24).toFixed(1)}d`);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">Dashboard</h1>
        <span className="font-mono text-[12px] text-ink-400">{project ? project.name : "all projects"}</span>
        <div className="ml-auto flex overflow-hidden rounded-md border border-ink-700 font-mono text-[11px]">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`px-2.5 py-1 cursor-pointer ${days === d ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"}`}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <Stat label="Needs you" value={String(t.needsYou)} sub="review, approval or failed" tone={t.needsYou ? "text-rose" : "text-ink-100"} />
        <Stat label="Open" value={String(t.open)} sub={t.blocked ? `${t.blocked} waiting on other tasks` : "none blocked"} />
        <Stat label="Done" value={String(t.done)} sub={`${pct(t.firstPassRate)} finished without a failed run`} />
        <Stat label="Spend (7d)" value={cost(t.cost7d)} sub={`${cost(t.costAll)} all time`} />
        <Stat label="Typical task" value={hours(t.medianCycleHours)} sub="median first run → done" />
        <Stat label="Runs" value={String(t.runs)} sub={`${pct(t.runSuccessRate)} succeeded`} />
      </div>

      {!t.runs && !t.open && !t.done ? (
        <Empty>No tasks yet. Create one on the Board and the charts fill in as work runs.</Empty>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
          <Panel title="Where the work is" hint="tasks by status" right={<TableToggle headers={["Status", "Tasks"]} rows={data.byStatus.map((s) => [s.key, s.count])} />}>
            <BarRows
              data={data.byStatus.map((s) => ({ key: STATUS_META[s.key].label, count: s.count, color: SERIES_A, dot: STATUS_META[s.key].dot }))}
            />
          </Panel>

          <Panel title="What kind of work" hint="by type" right={<TableToggle headers={["Type", "Tasks"]} rows={data.byType.map((s) => [s.key, s.count])} />}>
            <Donut data={data.byType.map((s, i) => ({ key: s.key, count: s.count, color: CATEGORICAL[i] }))} />
          </Panel>

          <Panel title="Priority mix" hint="p0 is 'everything is blocked'" right={<TableToggle headers={["Priority", "Tasks"]} rows={data.byPriority.map((s) => [s.key, s.count])} />}>
            <BarRows data={data.byPriority.map((s, i) => ({ key: PRIORITY_LABEL[s.key] ?? s.key, count: s.count, color: PRIORITY_RAMP[i] }))} />
          </Panel>

          <Panel
            title="Throughput"
            hint="tasks created vs finished"
            right={<TableToggle headers={["Day", "Created", "Done"]} rows={data.daily.map((d) => [d.date, d.created, d.done])} />}
          >
            <LineChart
              points={data.daily.map((d) => ({ date: d.date, values: [d.created, d.done] }))}
              series={[{ label: "created", color: SERIES_A }, { label: "done", color: SERIES_B }]}
            />
          </Panel>

          <Panel title="Spend per day" hint="estimated, from run costs" right={<TableToggle headers={["Day", "Cost", "Runs"]} rows={data.daily.map((d) => [d.date, `$${d.cost.toFixed(3)}`, d.runs])} />}>
            <LineChart
              area
              points={data.daily.map((d) => ({ date: d.date, values: [d.cost] }))}
              series={[{ label: "cost", color: MONEY }]}
              format={(n) => `$${n < 1 ? n.toFixed(2) : n.toFixed(0)}`}
            />
          </Panel>

          <Panel title="Cost by model" hint="which stage models are expensive" right={<TableToggle headers={["Model", "Cost", "Runs"]} rows={data.costByModel.map((m) => [m.key, `$${m.cost.toFixed(3)}`, m.runs])} />}>
            {data.costByModel.length ? (
              <div className="space-y-1.5">
                {data.costByModel.slice(0, 6).map((m) => {
                  const max = Math.max(...data.costByModel.map((x) => x.cost), 0.0001);
                  return (
                    <div key={m.key} className="flex items-center gap-2" title={`${m.key}: ${cost(m.cost)} over ${m.runs} runs`}>
                      <span className="w-36 shrink-0 truncate font-mono text-[11.5px] text-ink-300">{m.key.replace(/^claude-/, "")}</span>
                      <span className="h-3.5 flex-1 overflow-hidden rounded-sm bg-ink-850">
                        <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(2, (m.cost / max) * 100)}%`, background: MONEY }} />
                      </span>
                      <span className="w-14 text-right font-mono text-[11.5px] tabular-nums text-ink-300">{cost(m.cost)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-6 text-center text-[12px] text-ink-500">No runs yet.</div>
            )}
          </Panel>

          {data.spend ? (
            <Panel
              title="Where the money goes"
              hint="by job, and what the runs' tokens were"
              right={<TableToggle headers={["Job", "Cost"]} rows={data.spend.byJob.map((j) => [j.key, `$${j.cost.toFixed(3)}`])} />}
            >
              {data.spend.byJob.length ? (
                <div className="space-y-1.5">
                  {data.spend.byJob.map((j) => {
                    const max = Math.max(...data.spend.byJob.map((x) => x.cost), 0.0001);
                    return (
                      <div key={j.key} className="flex items-center gap-2" title={`${j.key}: ${cost(j.cost)}`}>
                        <span className="w-44 shrink-0 truncate text-[11.5px] text-ink-300">{j.key}</span>
                        <span className="h-3.5 flex-1 overflow-hidden rounded-sm bg-ink-850">
                          <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(2, (j.cost / max) * 100)}%`, background: MONEY }} />
                        </span>
                        <span className="w-14 text-right font-mono text-[11.5px] tabular-nums text-ink-300">{cost(j.cost)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-6 text-center text-[12px] text-ink-500">No spend yet.</div>
              )}
              {(() => {
                const t = data.spend.tokens;
                const all = t.output + t.fresh + t.cacheRead + t.cacheWrite;
                if (!all) return null;
                const pct = (n: number) => `${Math.round((n / all) * 100)}%`;
                // A long session is mostly re-reading what it already has: cheap per token, but the bulk of the count.
                return (
                  <div className="mt-3 border-t border-ink-800 pt-2 text-[11.5px] text-ink-400">
                    Tokens in runs: <span className="text-ink-200">{pct(t.cacheRead)}</span> re-read from cache (cheapest), {pct(t.cacheWrite)} written to
                    cache, {pct(t.fresh)} new input, <span className="text-ink-200">{pct(t.output)}</span> written by the model (dearest per token).
                  </div>
                );
              })()}
            </Panel>
          ) : null}

          {data.failuresByStage.length ? (
            <Panel title="Where runs fail" hint="failed runs by stage">
              <BarRows data={data.failuresByStage.map((f) => ({ key: f.key, count: f.count, color: "var(--color-rust)" }))} />
              <button className="mt-2 cursor-pointer font-mono text-[10.5px] text-ink-500 underline-offset-2 hover:text-ink-200 hover:underline" onClick={() => navigate({ view: "sessions" })}>
                open sessions →
              </button>
            </Panel>
          ) : null}
        </div>
      )}
    </div>
  );
}
