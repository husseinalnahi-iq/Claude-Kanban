import { useEffect, useMemo, useState } from "react";
import type { TaskCommand } from "../../../server/src/engine/commands.ts";
import { explainCommand, RISK_INFO, type CommandRisk, type Explanation } from "../../../server/src/engine/explain.ts";
import { api } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { clock } from "../lib/format.ts";

/**
 * Each risk level's glyph, colour and motion (D336). The motion says what the command does before
 * the words are read: an eye blinks, a pen writes, the bin shakes, arrows travel. Nothing moves under
 * *reduce motion*.
 */
const LOOK: Record<CommandRisk, { icon: string; tone: string; bg: string; anim: string }> = {
  reads: { icon: "◉", tone: "text-cyan", bg: "bg-cyan/10", anim: "kb-ex-blink" },
  runs: { icon: "▶", tone: "text-amber", bg: "bg-amber/10", anim: "kb-ex-run" },
  writes: { icon: "✎", tone: "text-lime", bg: "bg-lime/10", anim: "kb-ex-write" },
  network: { icon: "⇅", tone: "text-iris", bg: "bg-iris/10", anim: "kb-ex-travel" },
  installs: { icon: "⬇", tone: "text-iris", bg: "bg-iris/10", anim: "kb-ex-drop" },
  deletes: { icon: "⌫", tone: "text-rust", bg: "bg-rust/10", anim: "kb-ex-shake" },
  system: { icon: "⚙", tone: "text-rose", bg: "bg-rose/10", anim: "kb-ex-spin" },
  unknown: { icon: "?", tone: "text-ink-300", bg: "bg-ink-700/60", anim: "kb-ex-blink" },
};

/** The glyph alone, animated: for a row in a list. */
export function RiskIcon({ risk, size = "md", title }: { risk: CommandRisk; size?: "sm" | "md"; title?: string }) {
  const l = LOOK[risk];
  const box = size === "sm" ? "h-5 w-5 text-[11px]" : "h-7 w-7 text-[14px]";
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-md ${box} ${l.bg} ${l.tone}`} title={title ?? RISK_INFO[risk].label} aria-label={RISK_INFO[risk].label}>
      <span className={`inline-block ${l.anim}`}>{l.icon}</span>
    </span>
  );
}

/** Remembered for the page: asking twice about the same command would pay twice. */
const asked = new Map<string, string>();

/**
 * What a command does, in plain words, above the command itself (D336): from a fixed table, free and
 * instant. A command the table does not know says so and offers to ask Claude's cheapest model, once.
 */
export function CommandExplainer({ command, compact = false, open }: { command: string; compact?: boolean; open?: boolean }) {
  const ex = useMemo<Explanation>(() => explainCommand(command), [command]);
  // The part-by-part list is folded until asked for: a forty-line script was a wall under every card. `open` given, the caller folds it.
  const [own, setOwn] = useState(false);
  const listOpen = open ?? own;
  const [ai, setAi] = useState<string | null>(() => asked.get(command) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.explainCommand(command);
      asked.set(command, r.text);
      setAi(r.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const info = RISK_INFO[ex.risk];
  if (compact) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-300" title={`${info.label}: ${info.hint}`}>
        <RiskIcon risk={ex.risk} size="sm" />
        <span className="min-w-0 flex-1 truncate">{ai ?? ex.summary}</span>
      </div>
    );
  }
  return (
    <div className="mb-1.5 flex items-start gap-2 rounded-md border border-ink-800 bg-ink-900/60 px-2.5 py-1.5">
      <RiskIcon risk={ex.risk} title={`${info.label}: ${info.hint}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`font-mono text-[10px] uppercase tracking-wide ${LOOK[ex.risk].tone}`}>{info.label}</span>
          {!ex.complete && !ai ? <span className="font-mono text-[10px] text-ink-500">· not in the board's table</span> : null}
        </div>
        {/* Folded, a long chain's sentence is cut at two lines; the whole of it is behind the pointer and the fold. */}
        <div className={`text-[12.5px] leading-snug text-ink-100 ${listOpen ? "" : "line-clamp-2"}`} title={listOpen ? undefined : ai ?? ex.summary}>{ai ?? ex.summary}</div>
        {ex.parts.length > 1 && !ai && open === undefined ? (
          <button className="mt-0.5 cursor-pointer font-mono text-[10.5px] text-ink-500 hover:text-ink-200" onClick={() => setOwn((v) => !v)} aria-expanded={listOpen}>
            {listOpen ? "▾ hide the" : "▸ show the"} {ex.parts.length} parts
          </button>
        ) : null}
        {ex.parts.length > 1 && !ai && listOpen ? (
          <ul className="mt-1 space-y-0.5">
            {ex.parts.map((p, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-400">
                <RiskIcon risk={p.risk} size="sm" />
                <span className="min-w-0">
                  <span className="font-mono text-ink-500">{p.text.length > 48 ? `${p.text.slice(0, 45)}…` : p.text}</span> <span className="text-ink-300">{p.meaning}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {!ex.complete && !ai ? (
          <button
            className="mt-1 cursor-pointer rounded border border-ink-700 px-1.5 py-px font-mono text-[10.5px] text-ink-300 hover:border-amber/60 hover:text-amber disabled:opacity-50"
            onClick={() => void ask()}
            disabled={busy}
            title="Asks Claude's cheapest model to explain this one command. Costs a fraction of a cent, once."
          >
            {busy ? "asking…" : "Ask Claude what it does"}
          </button>
        ) : null}
        {error ? <div className="mt-1 text-[11.5px] text-rust">{error}</div> : null}
      </div>
    </div>
  );
}

const STATUS: Record<TaskCommand["status"], { dot: string; word: string }> = {
  waiting: { dot: "bg-rose pulse-rose", word: "waiting for you" },
  running: { dot: "bg-amber breathe", word: "running" },
  done: { dot: "bg-moss", word: "done" },
  failed: { dot: "bg-rust", word: "failed" },
  denied: { dot: "bg-ink-500", word: "denied" },
  stopped: { dot: "bg-ink-600", word: "stopped" },
};
const VIA: Record<NonNullable<TaskCommand["via"]>, string> = { approval: "you were asked", auto: "read-only, allowed by the board", autonomous: "the run's own call" };

/** A task's commands, live: refetched when its runs or approvals move. */
export function useTaskCommands(taskId: string | null, enabled = true): TaskCommand[] {
  const [list, setList] = useState<TaskCommand[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!taskId || !enabled) {
      setList([]);
      return;
    }
    let stale = false;
    void api.taskCommands(taskId).then((l) => !stale && setList(l), () => {});
    return () => {
      stale = true;
    };
  }, [taskId, enabled, tick]);
  // A running stage reports many events; one refetch a few seconds after the latest is plenty.
  useEffect(() => {
    if (!taskId || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setTick((n) => n + 1);
      }, 2500);
    };
    const off = subscribe(taskId, bump);
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [taskId, enabled]);
  return list;
}

// One socket listener for every open list, keyed by task.
const watchers = new Map<string, Set<() => void>>();
function subscribe(taskId: string, fn: () => void) {
  const set = watchers.get(taskId) ?? new Set();
  set.add(fn);
  watchers.set(taskId, set);
  return () => {
    set.delete(fn);
    if (!set.size) watchers.delete(taskId);
  };
}
/** Mounted once (App) so every command list hears the task's moves. */
export function useCommandFeed() {
  useWs((m) => {
    const id =
      m.type === "event" ? m.taskId
      : m.type === "run.updated" || m.type === "run.finished" ? m.run.task_id
      : m.type === "approval.requested" || m.type === "approval.decided" ? m.approval.task_id
      : null;
    if (id) for (const fn of watchers.get(id) ?? []) fn();
  });
}

/**
 * Every command a task ran, is running or waits to run, newest first (D337): a glance tells what kind
 * of thing it did, in words, with the command itself under it. Autonomous runs show here too, which
 * is the point: they never show an approval card.
 */
export function CommandList({ taskId, compact = false, enabled = true }: { taskId: string; compact?: boolean; enabled?: boolean }) {
  const list = useTaskCommands(taskId, enabled);
  const shown = [...list].reverse();
  if (!shown.length) return <div className={`text-ink-500 ${compact ? "text-[11.5px]" : "px-5 py-6 text-[13px]"}`}>{compact ? "No commands yet." : "No commands yet. Shell commands the task runs show up here as it works, with what each one does in plain words."}</div>;
  return (
    <ol className={compact ? "space-y-1" : "space-y-1.5 px-5 py-3"}>
      {shown.map((c) => {
        const ex = explainCommand(c.command);
        const st = STATUS[c.status];
        return (
          <li key={c.id} className={`rounded-md border ${c.status === "waiting" ? "border-rose/40 bg-rose/5" : "border-ink-800 bg-ink-900/50"} ${compact ? "px-2 py-1" : "px-2.5 py-1.5"}`}>
            <div className="flex items-center gap-2">
              <RiskIcon risk={ex.risk} size="sm" title={`${RISK_INFO[ex.risk].label}: ${RISK_INFO[ex.risk].hint}`} />
              <span className={`min-w-0 flex-1 truncate ${compact ? "text-[11.5px]" : "text-[12.5px]"} text-ink-100`} title={ex.summary}>{ex.summary}</span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-ink-500" title={c.via ? VIA[c.via] : undefined}>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${st.dot}`} />
                {st.word}
              </span>
            </div>
            <div className={`mt-0.5 flex items-center gap-2 font-mono text-ink-400 ${compact ? "text-[10.5px]" : "text-[11px]"}`}>
              <span className="min-w-0 flex-1 truncate" title={c.command}>$ {c.command}</span>
              {!compact ? <span className="shrink-0 text-ink-600">{c.stage ? `#${(c.stage_index ?? 0) + 1} ${c.stage} · ` : ""}{clock(c.ts)}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
