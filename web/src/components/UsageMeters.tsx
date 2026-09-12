import { useEffect, useRef, useState } from "react";
import type { Task, UsageLimit } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { ago, clock, until } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";

const LABELS: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};
const SHORT: Record<string, string> = { five_hour: "5h", seven_day: "week", seven_day_opus: "opus", seven_day_sonnet: "sonnet" };
/** Order they are read in: the one that runs out first is the one you care about. */
const ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
/** Per-model weekly windows arrive with the model's own name, e.g. `seven_day_model:Fable`. */
const MODEL_WINDOW = "seven_day_model:";
const label = (type: string) => LABELS[type] ?? (type.startsWith(MODEL_WINDOW) ? `Weekly · ${type.slice(MODEL_WINDOW.length)}` : null);
const rank = (type: string) => (ORDER.includes(type) ? ORDER.indexOf(type) : ORDER.length);

function tone(l: UsageLimit): string {
  if (l.status === "rejected") return "bg-rust";
  const pct = (l.utilization ?? 0) * 100;
  return pct >= 90 ? "bg-rust" : pct >= 70 ? "bg-amber" : "bg-moss";
}

/** Re-render once a minute so countdowns stay true without a request. */
function useMinuteTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
}

/**
 * Your Claude usage windows, in the board — the same five-hour and weekly numbers Claude shows, so
 * there is no need to open another app to find out whether you can start something.
 *
 * The numbers are your whole subscription's, read from your account the way Claude's /usage reads
 * them — so using Claude Code or claude.ai elsewhere shows up here too. The server refreshes them
 * every few minutes for free, and runs report them as they go.
 */
export function UsageMeters() {
  const [limits, setLimits] = useState<UsageLimit[]>([]);
  const [paused, setPaused] = useState<Task[]>([]);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useMinuteTick();

  const loadPaused = () => void api.pausedTasks().then(setPaused, () => {});
  useEffect(() => {
    void api.limits().then(setLimits, () => {});
    loadPaused();
  }, []);
  useWs((m) => {
    if (m.type === "limits.updated") setLimits(m.limits);
    if (m.type === "task.updated" && (m.task.status === "paused" || paused.some((p) => p.id === m.task.id))) loadPaused();
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const shown = limits.filter((l) => label(l.type)).sort((a, b) => rank(a.type) - rank(b.type));
  const blocked = shown.some((l) => l.status === "rejected");
  const newest = shown.reduce<string | null>((m, l) => (!m || l.updated_at > m ? l.updated_at : m), null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setLimits(await api.refreshLimits());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-3 rounded-md border px-2 py-1 transition-colors cursor-pointer ${
          blocked ? "border-rust/50 bg-rust/10" : open ? "border-ink-500" : "border-transparent hover:border-ink-700"
        }`}
        title="Your Claude usage windows"
      >
        {shown.length ? (
          shown.slice(0, 2).map((l) => {
            const pct = l.utilization === null ? null : Math.min(100, Math.round(l.utilization * 100));
            return (
              <span key={l.type} className="flex items-center gap-1.5">
                <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-500">{SHORT[l.type]}</span>
                {pct === null ? (
                  <span className={`h-1.5 w-1.5 rounded-full ${l.status === "rejected" ? "bg-rust" : "bg-moss"}`} />
                ) : (
                  <>
                    <span className="h-1.5 w-12 overflow-hidden rounded-full bg-ink-800">
                      <span className={`block h-full rounded-full ${tone(l)}`} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-400">{pct}%</span>
                  </>
                )}
              </span>
            );
          })
        ) : (
          <span className="font-mono text-[10.5px] text-ink-500">usage</span>
        )}
        {paused.length ? <span className="rounded bg-iris/20 px-1 font-mono text-[10px] text-iris">{paused.length} paused</span> : null}
      </button>

      {open ? (
        <div className="rise absolute right-0 top-[calc(100%+6px)] z-50 w-[340px] rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl shadow-black/60">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-[13px] font-semibold text-ink-100">Claude usage</span>
            <span className="font-mono text-[10.5px] text-ink-500">{newest ? `as of ${ago(newest)}` : "not measured yet"}</span>
          </div>

          {shown.length ? (
            <div className="space-y-3">
              {shown.map((l) => {
                const pct = l.utilization === null ? null : Math.min(100, Math.round(l.utilization * 100));
                const resetsMs = l.resets_at ? l.resets_at * 1000 : null;
                return (
                  <div key={l.type}>
                    <div className="mb-1 flex items-baseline justify-between text-[12px]">
                      <span className="text-ink-200">{label(l.type)}</span>
                      <span className={`font-mono ${l.status === "rejected" ? "text-rust" : "text-ink-300"}`}>
                        {l.status === "rejected" ? "limit reached" : pct === null ? "ok" : `${pct}% used`}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-ink-800">
                      <div className={`h-full rounded-full transition-all ${tone(l)}`} style={{ width: `${l.status === "rejected" ? 100 : (pct ?? 0)}%` }} />
                    </div>
                    {resetsMs ? (
                      <div className="mt-1 font-mono text-[10.5px] text-ink-500">
                        resets {until(resetsMs)} · {clock(resetsMs)}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[12px] text-ink-400">
              Nothing measured yet. Check now — it is free.
            </p>
          )}

          {paused.length ? (
            <div className="mt-4 border-t border-ink-800 pt-3">
              <div className="mb-1.5 text-[11px] uppercase tracking-wider text-iris">Waiting for the window</div>
              <div className="space-y-1">
                {paused.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setOpen(false);
                      navigate({ projectId: t.project_id, taskId: t.id });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-ink-850 cursor-pointer"
                  >
                    <span className="min-w-0 flex-1 truncate text-ink-200">{t.title}</span>
                    <span className="font-mono text-[10.5px] text-iris">{t.resume_at ? `${until(t.resume_at)} · ${clock(t.resume_at)}` : "soon"}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-500">They continue by themselves, in the same session, from the stage they were on.</p>
            </div>
          ) : null}

          <div className="mt-4 flex items-center gap-2 border-t border-ink-800 pt-3">
            <button
              onClick={() => void check()}
              disabled={checking}
              className="rounded-md border border-ink-600 px-2.5 py-1 text-[12px] text-ink-200 hover:border-ink-400 disabled:opacity-40 cursor-pointer"
              title="Reads the same numbers as Claude's /usage, from your account — no message is sent, so it is free"
            >
              {checking ? "Checking…" : "Check now"}
            </button>
            <span className="text-[10.5px] text-ink-500">free · also updates every 5 minutes by itself</span>
          </div>
          {error ? <div className="mt-2 text-[11.5px] text-rust">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** How full a session's context window is — the same figure Claude Code shows as its context bar. */
export function ContextBar({ used, window: win, compact }: { used: number; window: number; compact?: boolean }) {
  if (!used) return null;
  const pct = win ? Math.min(100, Math.round((used / win) * 100)) : null;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const tone = pct === null ? "bg-ink-500" : pct >= 90 ? "bg-rust" : pct >= 70 ? "bg-amber" : "bg-cyan";
  return (
    <span className="inline-flex items-center gap-1.5" title={`Context: ${used.toLocaleString()} tokens${win ? ` of ${win.toLocaleString()}` : ""}`}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-ink-800">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct ?? 8}%` }} />
      </span>
      <span className="font-mono text-[10.5px] text-ink-400">
        {compact ? `${pct ?? "?"}%` : `${k(used)}${win ? ` / ${k(win)}` : ""}${pct !== null ? ` (${pct}%)` : ""}`}
      </span>
    </span>
  );
}
