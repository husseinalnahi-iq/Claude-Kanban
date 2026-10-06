import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { isAnswerPipeline, stoppedBy, type TaskCard, type TaskStatus } from "../../../server/src/types.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { useWs, useWsReconnect } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { useAppData } from "../lib/store.tsx";
import { clock, cost, PRIORITY_META, STATUS_META, TYPE_META, until } from "../lib/format.ts";
import { Button, Chip, MemoryDot, ModeChip, Select, StageDots, inputCls } from "../components/ui.tsx";
import { useProjectMemory } from "../lib/memory.ts";
import type { MemoryFacts } from "../../../server/src/engine/memory.ts";

/** Cards whose memory a follow-up can use: waiting for review, failed, or done. */
const MEMORY_STATUSES = new Set(["review", "failed", "done"]);
import { NewTaskForm } from "../components/forms.tsx";
import { LimitBanner, SerialSwitch } from "../components/QueueControls.tsx";
import { DepGraph } from "../components/DepGraph.tsx";
import { SchedulesPanel, startLabel, useSchedules } from "../components/SchedulesPanel.tsx";
import { isQuestion } from "../lib/questions.ts";
import { liveTasks } from "../components/LiveBrowser.tsx";
import { openTaskOn } from "./TaskDrawer.tsx";
import { COLUMN_SIZES, setViewPrefs, useViewPrefs } from "../lib/view.ts";
import { ChecklistLine } from "../components/Checklist.tsx";
import { phase, stoppedProvider, waitingOn, waitLine, waitsOnYou } from "../lib/phase.ts";
import { holdLine, mayConflict } from "../../../server/src/engine/footprint.ts";


/**
 * The board's columns. Everything between "queued" and "review" is one In progress column, always on
 * screen: a task only passes through planning / running / approval / paused while a run is live, and
 * a column per status appeared and vanished as tasks moved, so an idle board had no in-progress at all.
 * Each card there says which of the four it is.
 */
const IN_PROGRESS: TaskStatus[] = ["approval", "planning", "running", "paused"];
const COLUMNS: { id: string; statuses: TaskStatus[]; label: string; color: string; text: string; dot: string }[] = [
  ...(["backlog", "queued"] as const).map((s) => ({ id: s, statuses: [s], ...STATUS_META[s] })),
  { id: "in-progress", statuses: IN_PROGRESS, label: "In progress", color: "border-amber", text: "text-amber", dot: "bg-amber" },
  ...(["review", "done", "failed"] as const).map((s) => ({ id: s, statuses: [s], ...STATUS_META[s] })),
];

/** Keeps a project's task cards live: initial fetch, then WS upserts; refetch on run end for costs. */
export function useTaskCards(projectId: string | null) {
  const [cards, setCards] = useState<TaskCard[]>([]);
  const reload = useCallback(async () => {
    // A failed reload keeps the cards that are there; the next push or reconnect asks again.
    if (projectId) await api.tasks(projectId).then(setCards, () => {});
  }, [projectId]);
  useEffect(() => {
    setCards([]);
    void reload();
  }, [reload]);
  useWsReconnect(() => void reload());
  useWs((m) => {
    if (m.type === "task.updated" && m.task.project_id === projectId) {
      setCards((prev) => {
        const old = prev.find((c) => c.id === m.task.id);
        const next: TaskCard = {
          ...m.task,
          cost_usd: old?.cost_usd ?? 0,
          stage_states: m.task.pipeline.map((_, i) => old?.stage_states[i] ?? "idle"),
        };
        return old ? prev.map((c) => (c.id === next.id ? next : c)) : [...prev, next];
      });
    } else if (m.type === "task.deleted") {
      setCards((prev) => prev.filter((c) => c.id !== m.taskId));
    } else if (m.type === "run.updated") {
      // A running stage sends this on nearly every message (its context size grew), and for every
      // project. The same list back means no re-render; a new one redrew the whole board each time.
      setCards((prev) => {
        const card = prev.find((c) => c.id === m.run.task_id);
        const now = card?.stage_states[m.run.stage_index];
        if (!card || now === undefined || now === m.run.status) return prev;
        return prev.map((c) => (c === card ? { ...c, stage_states: c.stage_states.map((s, i) => (i === m.run.stage_index ? m.run.status : s)) } : c));
      });
    } else if (m.type === "run.finished") {
      void reload();
    }
  });
  return { cards, reload };
}

const Card = memo(function Card({
  card,
  parentTitle,
  waiting,
  progress,
  serial,
  asking,
  watching,
  memory,
  conflictsWith,
  detail,
}: {
  card: TaskCard;
  /** Another working card in its own worktree that changes the same files: both can run, landing the second may conflict (D400). */
  conflictsWith?: { title: string; files: string[] };
  parentTitle?: string;
  /** What it still waits for: the tasks it depends on that are not done. */
  waiting?: { id: string; title: string; status: TaskStatus }[];
  progress?: { done: number; total: number };
  /** The board runs one task at a time, so queueing means waiting — offer the way past it. */
  serial?: boolean;
  /** Its pending card is a question, not an approval. */
  asking?: boolean;
  /** Its browser is open right now: offer to watch. */
  watching?: boolean;
  /** What its coder still remembers, for a card in review or done (D374). */
  memory?: MemoryFacts;
  /** "compact" (default) shows only what you act on; "full" brings back every tag (D410). */
  detail?: "compact" | "full";
}) {
  const full = detail === "full";
  const draggable = card.status === "backlog" || card.status === "queued";
  const live = ["planning", "running", "approval"].includes(card.status);
  // Shown on the card: alert() is dismissed unseen in embedded browsers (D193).
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (e: React.MouseEvent, fn: () => Promise<unknown>) => {
    e.stopPropagation();
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };
  // Retrying a sandbox block in the same mode would only hit the same wall: that is decided in the task.
  const stopped = stoppedBy(card);
  const needsSwitch = card.status === "failed" && stopped?.needs === "supervised" && card.mode === "autonomous";
  const yours = waitsOnYou(card, asking);
  return (
    <div
      draggable={draggable}
      // Set here, not passed in: a handler made afresh by the board on every render undid the memo above.
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", card.id);
        e.dataTransfer.setData("text/task-status", card.status);
      }}
      onClick={() => navigate({ taskId: card.id })}
      // Reachable without a mouse: Tab to the card, Enter to open it.
      role="link"
      tabIndex={0}
      aria-label={`Open task: ${card.title}${yours ? " — waits on you" : ""}`}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && navigate({ taskId: card.id })}
      className={`rise group relative cursor-pointer rounded-lg border bg-ink-850 px-2.5 py-2 transition-colors hover:border-ink-500 hover:bg-ink-800 focus-visible:border-amber focus-visible:outline-none ${
        yours ? "kb-needs border-rose/60" : live ? "border-amber/40" : "border-ink-700"
      } ${card.archived_at ? "opacity-55 hover:opacity-100" : ""}`}
    >
      {card.archived_at ? <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-600">archived</div> : null}
      {parentTitle ? <div className="mb-1 truncate font-mono text-[10.5px] text-ink-500">↳ {parentTitle}</div> : null}
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {IN_PROGRESS.includes(card.status) ? (() => {
          const p = phase(card, asking);
          return <Chip className={`${p.tone} ${card.status === "paused" ? "" : "font-semibold"}`} title={p.title}>{p.text}</Chip>;
        })() : null}
        {yours?.chip ? (
          <Chip className="border-rose/60 font-semibold text-rose" title={yours.title}>{yours.chip}</Chip>
        ) : null}
        {full ? <Chip className={PRIORITY_META[card.priority].tone} title={PRIORITY_META[card.priority].title}>{card.priority}</Chip> : null}
        {full ? <Chip className={TYPE_META[card.type].tone}>{TYPE_META[card.type].short}</Chip> : null}
        {card.labels.slice(0, full ? 2 : 1).map((l) => (
          <Chip key={l} className="border-ink-700 text-ink-400 normal-case">{l}</Chip>
        ))}
        {waiting?.length ? (
          <Chip className="border-slate/50 text-slate" title={`Waits for ${waiting.map((w) => `“${w.title}” (${w.status})`).join(", ")}`}>
            waits for {waiting.length}
          </Chip>
        ) : null}
        {card.questions?.some((q) => !q.answer) ? (
          <Chip className="border-cyan/60 font-semibold text-cyan" title={card.questions.filter((q) => !q.answer).map((q) => q.text).join("\n")}>
            {card.questions.filter((q) => !q.answer).length} question{card.questions.filter((q) => !q.answer).length === 1 ? "" : "s"} for you
          </Chip>
        ) : null}
        {card.setup_pending && card.status === "backlog" ? (
          <Chip className="border-amber/60 font-semibold text-amber" title="It waits for you to check its mode and models and press Start — open the task">check setup</Chip>
        ) : null}
        {stopped && card.status === "failed" ? (
          <Chip className="border-rose/60 font-semibold text-rose" title={`${stopped.reason} — open the task`}>blocked · needs you</Chip>
        ) : card.blocked?.advisory && card.status === "review" && card.mode === "autonomous" ? (
          <Chip className="border-amber/60 text-amber" title={`${card.blocked.reason} — it carried on without it; open the task to switch`}>live steps left</Chip>
        ) : null}
        {card.resolution && ["resolving", "checking", "reviewing"].includes(card.resolution.state) ? (
          <Chip className="border-amber/60 font-semibold text-amber" title={`Claude is combining this task with what landed on ${card.resolution.base} meanwhile`}>resolving conflict</Chip>
        ) : card.resolution?.state === "failed" && card.status === "review" ? (
          <Chip className="border-rose/60 font-semibold text-rose" title={`${card.resolution.error ?? "The conflict could not be resolved safely"} — open the task`}>conflict · needs you</Chip>
        ) : card.conflict_risk && card.status !== "done" ? (
          <Chip className="border-amber/60 text-amber" title={`Would conflict with ${card.conflict_risk.base} in ${card.conflict_risk.files.join(", ")} — open the task to have Claude fix it now`}>will conflict</Chip>
        ) : conflictsWith && full ? (
          <Chip className="border-slate/50 text-slate" title={`“${conflictsWith.title}” changes the same files (${conflictsWith.files.slice(0, 3).join(", ")}). Both can run in their own copies; the second one approved may need its conflicts resolved.`}>may conflict</Chip>
        ) : null}
        {watching ? (
          <button
            className="rise flex cursor-pointer items-center gap-1 rounded border border-live/50 bg-live/10 px-1 py-0 font-mono text-[9.5px] font-semibold lowercase text-live hover:bg-live/20"
            title="Its browser is open: watch it work"
            onClick={(e) => {
              e.stopPropagation();
              openTaskOn(card.id, "browser");
            }}
          >
            <span className="pulse-live h-1.5 w-1.5 rounded-full bg-live" /> live
          </button>
        ) : null}
        {progress ? (
          <Chip
            className={progress.done === progress.total ? "border-moss/50 text-moss" : "border-ink-600 text-ink-300"}
            title={`${progress.done} of ${progress.total} subtasks done`}
          >
            {progress.done}/{progress.total}
          </Chip>
        ) : null}
        {full && card.suggestion && (card.suggestion.priority !== card.priority || card.suggestion.type !== card.type) ? (
          <Chip
            className="border-cyan/40 text-cyan"
            title={`Claude suggests ${card.suggestion.type} · ${card.suggestion.priority} (${Math.round((card.suggestion.confidence ?? 0) * 100)}% sure) — open the task to accept`}
          >
            {card.suggestion.type !== card.type ? card.suggestion.type : card.suggestion.priority}?
          </Chip>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {full && card.round > 1 ? <Chip className="border-iris/40 text-iris" title={`Round ${card.round}: its coder continued this card ${card.round - 1} time${card.round > 2 ? "s" : ""} with what it remembered`}>R{card.round}</Chip> : null}
          {full && memory && memory.memory !== "gone" ? <MemoryDot facts={memory} /> : null}
          {card.live ? <Chip className="border-rose/50 text-rose" title="Touches a live system: plan approval is on and review runs on the live review model">prod</Chip> : null}
          {full ? <ModeChip mode={card.mode} ownBranch={card.own_branch} lookup={isAnswerPipeline(card.pipeline)} mayAsk={card.may_ask} /> : null}
        </span>
      </div>
      <div className="text-[12px] font-medium leading-snug text-ink-100">{card.title}</div>
      {card.summary ? <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-ink-300">{card.summary}</div> : null}
      {yours ? (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-rose/50 bg-rose/10 px-2 py-1 text-[11.5px] font-semibold text-rose" title={yours.title}>
          <span className="pulse-rose h-1.5 w-1.5 shrink-0 rounded-full bg-rose" /> Your turn: {yours.action}
        </div>
      ) : null}
      {/* Queued before what it needs was done: it starts by itself once that is (D289). */}
      {waiting?.length && (card.status === "queued" || card.status === "backlog") ? (
        <div className={`mt-1.5 line-clamp-2 text-[11.5px] ${waiting.some((w) => w.status === "failed") ? "text-rust" : card.status === "queued" ? "text-slate" : "text-ink-400"}`}>
          ⏳ {waitLine(waiting)}
        </div>
      ) : card.hold && card.status === "queued" ? (
        /* Two tasks that would change the same files or live system take turns (D400). */
        <div className="mt-1.5 line-clamp-2 text-[11.5px] text-slate" title={card.hold.files.length ? card.hold.files.join("\n") : undefined}>
          ⏳ {holdLine(card.hold)}
        </div>
      ) : null}
      {IN_PROGRESS.includes(card.status) || card.status === "failed" ? <ChecklistLine list={card.checklist.slice(card.checklist_from)} live={live} /> : null}
      {stopped && card.status === "failed" ? (
        <div className="mt-1.5 line-clamp-2 text-[11.5px] text-rose">{stopped.reason}</div>
      ) : card.status === "failed" && card.start_at && card.note ? (
        // The board is trying again on its own (a connection problem): a calm line, not a red error (D410).
        <div className="mt-1.5 line-clamp-2 text-[11.5px] text-slate">{card.note}</div>
      ) : card.error && card.status === "failed" ? (
        <div className="mt-1.5 line-clamp-2 font-mono text-[11px] text-rust">{card.error}</div>
      ) : null}
      {/* Recovery triage, or a review loop, left a plain note on a card that is not scheduled: show it. */}
      {card.status === "failed" && !card.start_at && !stopped && card.note && card.note !== "work discarded" ? (
        <div className="mt-1.5 line-clamp-2 text-[11.5px] text-slate">{card.note}</div>
      ) : null}
      {actionError ? <div className="mt-1.5 line-clamp-3 text-[11.5px] text-rust">{actionError}</div> : null}
      {card.note && card.status === "backlog" ? <div className="mt-1.5 line-clamp-2 text-[11.5px] italic text-ink-400">“{card.note}”</div> : null}
      {card.start_at && (card.status === "backlog" || card.status === "failed") ? (
        <div className="rise mt-1.5 flex items-center gap-2 rounded-md border border-cyan/40 bg-cyan/5 px-2 py-1 text-[11.5px] text-cyan">
          <span className="min-w-0 leading-tight" title={`Scheduled: it queues itself ${startLabel(card.start_at)}`}>
            ⏰ {card.start_at === "reset" ? "after limit reset" : startLabel(card.start_at)}
          </span>
          <button
            className="ml-auto shrink-0 cursor-pointer rounded border border-cyan/40 px-1.5 py-px font-mono text-[10.5px] hover:bg-cyan/10"
            title="Start it now instead of waiting"
            onClick={(e) => act(e, async () => { await api.scheduleTask(card.id, null); await api.queue(card.id); })}
          >
            now
          </button>
          <button
            className="shrink-0 cursor-pointer px-0.5 text-cyan/70 hover:text-cyan"
            title="Cancel the scheduled start. The card stays in Backlog."
            onClick={(e) => act(e, () => api.scheduleTask(card.id, null))}
          >
            ×
          </button>
        </div>
      ) : null}
      {card.status === "paused" && card.pause_reason === "cost" ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-rose/40 bg-rose/5 px-2 py-1 text-[11.5px] text-rose">
          <span title={card.note ?? undefined}>reached its cost ceiling</span>
          <button
            className="ml-auto cursor-pointer rounded border border-rose/40 px-1.5 py-px font-mono text-[10.5px] hover:bg-rose/10"
            title="Let it spend one more stage's worth and carry on from where it stopped"
            onClick={(e) => act(e, () => api.continueTask(card.id))}
          >
            continue
          </button>
        </div>
      ) : null}
      {card.status === "paused" && card.pause_reason === "provider" && !card.resume_at ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-rose/40 bg-rose/5 px-2 py-1 text-[11.5px] text-rose">
          <span className="min-w-0 truncate" title={card.note ?? undefined}>{stoppedProvider(card) ?? "the provider"} is out of credit</span>
          <button
            className="ml-auto shrink-0 cursor-pointer rounded border border-rose/40 px-1.5 py-px font-mono text-[10.5px] hover:bg-rose/10"
            title="Open it to carry the stage on with another provider, or try again after topping up"
            onClick={(e) => {
              e.stopPropagation();
              navigate({ taskId: card.id });
            }}
          >
            switch
          </button>
        </div>
      ) : null}
      {card.status === "paused" && card.pause_reason !== "cost" && card.resume_at ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-iris/40 bg-iris/5 px-2 py-1 text-[11.5px] text-iris">
          <span title={card.pause_reason === "provider" ? card.note ?? undefined : "Paused by your Claude usage limit; it continues in the same session, from the stage it was on"}>
            resumes {until(card.resume_at)} · {clock(card.resume_at)}
          </span>
          <button
            className="ml-auto cursor-pointer rounded border border-iris/40 px-1.5 py-px font-mono text-[10.5px] hover:bg-iris/10"
            title="Try now instead of waiting — it will pause again if the limit still applies"
            onClick={(e) => act(e, () => api.resumeTask(card.id))}
          >
            now
          </button>
        </div>
      ) : null}
      <div className="relative mt-2 flex items-center gap-2">
        {/* The stage chips get the row. The hover actions sit over its right end and do not take space
            while hidden: laid out beside the chips, the invisible buttons squeezed them to one letter. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <StageDots card={card} compact={!full} />
        </div>
        {card.cost_usd > 0 ? <span className="shrink-0 font-mono text-[10.5px] text-ink-400">{cost(card.cost_usd)}</span> : null}
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1.5 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 bg-ink-850 group-hover:bg-ink-800">
          {(card.status === "backlog" || card.status === "failed") && !needsSwitch ? (
            <>
              <button
                className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 hover:border-amber hover:text-amber cursor-pointer"
                onClick={(e) => (card.setup_pending && card.status === "backlog" ? (e.stopPropagation(), navigate({ taskId: card.id })) : act(e, () => (card.status === "failed" ? api.retry(card.id) : api.queue(card.id))))}
                title={card.setup_pending && card.status === "backlog" ? "Check its mode and models first, then press Start" : undefined}
              >
                {card.status === "failed" ? "retry" : card.setup_pending ? "check setup" : "queue"}
              </button>
              {serial && !card.setup_pending ? (
                <button
                  className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 hover:border-cyan hover:text-cyan cursor-pointer"
                  title="Start it now, beside whatever is already running, instead of waiting its turn"
                  onClick={(e) => act(e, () => (card.status === "failed" ? api.retry(card.id, undefined, true) : api.queue(card.id, true)))}
                >
                  run now
                </button>
              ) : null}
            </>
          ) : null}
          {card.status === "done" ? (
            <button
              className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 hover:border-amber hover:text-amber cursor-pointer"
              title={card.archived_at ? "Bring it back onto the board" : "Hide it from the board — nothing is deleted"}
              onClick={(e) => act(e, () => (card.archived_at ? api.unarchive(card.id) : api.archive(card.id)))}
            >
              {card.archived_at ? "unarchive" : "archive"}
            </button>
          ) : null}
          {card.status === "queued" || live ? (
            <button
              className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 hover:border-rust hover:text-rust cursor-pointer"
              onClick={(e) => act(e, () => api.stop(card.id))}
            >
              stop
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

export function Board({ project }: { project: ProjectWithGit }) {
  const { cards } = useTaskCards(project.id);
  const { pending, settings } = useAppData();
  const { columns } = useViewPrefs();
  const [creating, setCreating] = useState<false | "now" | "repeat">(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  // Compact by default: a card shows only what you act on. "Full" brings back priority, type, mode,
  // model names and the rest, for when you want them. Remembered on this computer (D410).
  const [detail, setDetail] = useState<"compact" | "full">(() => (localStorage.getItem("kanban.cardDetail") === "full" ? "full" : "compact"));
  const setDetailPref = (d: "compact" | "full") => { setDetail(d); try { localStorage.setItem("kanban.cardDetail", d); } catch { /* private window */ } };
  // Tasks whose browser is open now, for the "live" chip.
  const [live, setLive] = useState<Set<string>>(new Set());
  const loadLive = () => void liveTasks().then((ids) => setLive(new Set(ids)), () => {});
  useEffect(loadLive, [project.id]);
  useWsReconnect(loadLive);
  useWs((m) => {
    if (m.type === "browser.live") setLive((prev) => {
      const next = new Set(prev);
      if (m.live) next.add(m.taskId);
      else next.delete(m.taskId);
      return next;
    });
  });
  const schedules = useSchedules(project.id);
  const scheduledCount = schedules.filter((s) => s.enabled).length + cards.filter((c) => c.start_at).length;
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const [filter, setFilter] = useState({ q: "", type: "", priority: "", label: "" });
  const [view, setView] = useState<"board" | "graph">("board");
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const titles = useMemo(() => new Map(cards.map((c) => [c.id, c.title])), [cards]);
  const done = useMemo(() => new Set(cards.filter((c) => c.status === "done").map((c) => c.id)), [cards]);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  // Working cards in their own worktrees that will change the same files (D400): one line per card, worked out once per update.
  const conflicts = useMemo(() => {
    const working = cards.filter((c) => ["queued", "planning", "running", "approval", "paused", "review"].includes(c.status));
    const out = new Map<string, { title: string; files: string[] }>();
    for (const c of working) {
      for (const o of working) {
        if (o.id === c.id) continue;
        const files = mayConflict(c, o);
        if (files.length) {
          out.set(c.id, { title: o.title, files });
          break;
        }
      }
    }
    return out;
  }, [cards]);
  // What each finished or waiting card remembers (D374): fetched again when one of them changes.
  const memoryKey = cards.filter((c) => MEMORY_STATUSES.has(c.status)).map((c) => `${c.id}:${c.status}:${c.updated_at}`).join("|");
  const memory = useProjectMemory(project.id, memoryKey);
  /** Progress of a parent's children, so a parent card says 2/5 without opening it. */
  const progress = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const c of cards) {
      if (!c.parent_id) continue;
      const e = m.get(c.parent_id) ?? { done: 0, total: 0 };
      e.total += 1;
      if (c.status === "done") e.done += 1;
      m.set(c.parent_id, e);
    }
    return m;
  }, [cards]);
  const labels = useMemo(() => [...new Set(cards.flatMap((c) => c.labels))].sort(), [cards]);
  const archivedCount = useMemo(() => cards.filter((c) => c.archived_at).length, [cards]);
  const visible = useMemo(
    () =>
      cards.filter(
        (c) =>
          (showArchived || !c.archived_at) &&
          (!filter.type || c.type === filter.type) &&
          (!filter.priority || c.priority === filter.priority) &&
          (!filter.label || c.labels.includes(filter.label)) &&
          (!filter.q || `${c.title} ${c.summary ?? ""} ${c.labels.join(" ")}`.toLowerCase().includes(filter.q.toLowerCase())),
      ),
    [cards, filter, showArchived],
  );
  const byColumn = useMemo(() => {
    const m = new Map<string, TaskCard[]>(COLUMNS.map((col) => [col.id, []]));
    const colOf = new Map<TaskStatus, string>(COLUMNS.flatMap((col) => col.statuses.map((s) => [s, col.id] as const)));
    for (const c of visible) m.get(colOf.get(c.status) ?? "")?.push(c);
    // Inside In progress, what needs you comes first and what is paused last; then the most urgent first.
    // A cost pause waits on a person, like an approval, so it ranks with "needs you" rather than last.
    const needsYou = (c: TaskCard) => c.status === "paused" && (c.pause_reason === "cost" || (c.pause_reason === "provider" && !c.resume_at));
    const rank = (c: TaskCard) => (needsYou(c) ? 0 : IN_PROGRESS.includes(c.status) ? IN_PROGRESS.indexOf(c.status) : 0);
    for (const list of m.values()) list.sort((a, b) => rank(a) - rank(b) || a.priority.localeCompare(b.priority) || a.position - b.position);
    return m;
  }, [visible]);
  const projectPending = pending.filter((a) => cards.some((c) => c.id === a.task_id));
  // Everything that waits on you, not only approval pop-ups: a card in review, a question, a cost pause,
  // a failure all count — the one signal the card itself uses (D410). Approvals break the memo tie.
  const needsYou = useMemo(
    () => cards.filter((c) => !c.archived_at && waitsOnYou(c, projectPending.some((a) => a.task_id === c.id && isQuestion(a)))),
    [cards, projectPending],
  );
  /** The graph is about relationships, so by default it leaves out tasks that have none. */
  const linked = useMemo(() => {
    const isDep = new Set(cards.flatMap((c) => c.depends_on));
    const isParent = new Set(cards.map((c) => c.parent_id).filter(Boolean) as string[]);
    return visible.filter((c) => c.depends_on.length || isDep.has(c.id) || c.parent_id || isParent.has(c.id));
  }, [cards, visible]);
  const graphTasks = showUnlinked ? visible : linked;

  const onDrop = async (status: TaskStatus, e: React.DragEvent) => {
    setDropTarget(null);
    const id = e.dataTransfer.getData("text/task-id");
    const from = e.dataTransfer.getData("text/task-status");
    if (!id || from === status) return;
    try {
      // A card waiting on its setup opens on it instead: its mode and models are confirmed first (D365).
      if (from === "backlog" && status === "queued" && cards.find((c) => c.id === id)?.setup_pending) navigate({ taskId: id });
      else if (from === "backlog" && status === "queued") await api.queue(id);
      else if (from === "queued" && status === "backlog") await api.stop(id);
    } catch (err) {
      setDragError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-800 px-6 py-3.5">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight text-ink-100">{project.name}</h1>
          <div className="truncate font-mono text-[11px] text-ink-500">{project.path}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!project.isGit ? <Chip className="border-ink-600 text-ink-400">no git</Chip> : null}
          <Chip className={project.policy.autonomous === "forbidden" ? "border-rust/50 text-rust" : "border-ink-600 text-ink-400"}>
            autonomous {project.policy.autonomous}
          </Chip>
          <Chip className={project.policy.worktrees === "forbidden" ? "border-rust/50 text-rust" : "border-ink-600 text-ink-400"}>
            worktrees {project.policy.worktrees}
          </Chip>
          <Chip className="border-ink-600 text-ink-400">max {project.policy.maxConcurrent}</Chip>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <SerialSwitch />
          <button
            className="font-mono text-[11px] text-ink-500 hover:text-amber cursor-pointer"
            title={detail === "compact" ? "Show every tag on a card: priority, type, mode, models…" : "Show only what you act on"}
            onClick={() => setDetailPref(detail === "compact" ? "full" : "compact")}
          >
            cards: {detail}
          </button>
          {needsYou.length ? (
            <Button variant="outline" className="border-rose/60 text-rose" onClick={() => navigate({ taskId: needsYou[0].id })}>
              <span className="pulse-rose inline-block h-2 w-2 rounded-full bg-rose" />
              {needsYou.length} need{needsYou.length === 1 ? "s" : ""} you
            </Button>
          ) : null}
          <Button onClick={() => setSchedulesOpen(true)} title="Work set to start later, or on repeat, so it runs while you are away">
            ⏰ Schedules
            {scheduledCount ? <span className="rounded-full bg-cyan px-1.5 font-mono text-[10px] text-ink-950">{scheduledCount}</span> : null}
          </Button>
          <Button variant="primary" onClick={() => setCreating("now")}>+ New task</Button>
        </div>
      </header>
      <LimitBanner />
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-6 py-2">
        <input className={`${inputCls} max-w-[220px]`} placeholder="Filter tasks…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <Select className="font-mono text-[11px]" aria-label="Filter by type" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
          <option value="">any type</option>
          {Object.keys(TYPE_META).map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Select className="font-mono text-[11px]" aria-label="Filter by priority" value={filter.priority} onChange={(e) => setFilter({ ...filter, priority: e.target.value })}>
          <option value="">any priority</option>
          {(Object.keys(PRIORITY_META) as (keyof typeof PRIORITY_META)[]).map((p) => <option key={p} value={p}>{PRIORITY_META[p].short}</option>)}
        </Select>
        {labels.length ? (
          <Select className="font-mono text-[11px]" aria-label="Filter by label" value={filter.label} onChange={(e) => setFilter({ ...filter, label: e.target.value })}>
            <option value="">any label</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </Select>
        ) : null}
        {filter.q || filter.type || filter.priority || filter.label ? (
          <button className="cursor-pointer font-mono text-[11px] text-ink-400 hover:text-ink-100" onClick={() => setFilter({ q: "", type: "", priority: "", label: "" })}>
            clear · showing {visible.length}/{cards.length}
          </button>
        ) : null}
        {view === "graph" && linked.length !== visible.length ? (
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-ink-400 hover:text-ink-200">
            <input type="checkbox" checked={showUnlinked} onChange={(e) => setShowUnlinked(e.target.checked)} />
            show {visible.length - linked.length} unlinked
          </label>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {view === "board" ? (
            <div className="flex rounded-md border border-ink-700 font-mono text-[11px]" title="Column width — “fill” shares the window evenly">
              {COLUMN_SIZES.map((c) => (
                <button
                  key={c.label}
                  onClick={() => setViewPrefs({ columns: c.value })}
                  className={`px-1.5 py-1 transition-colors cursor-pointer ${columns === c.value ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex rounded-md border border-ink-700">
          {(["board", "graph"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              title={v === "graph" ? "See which tasks wait for which, and draw new dependencies" : "Columns by status"}
              className={`px-2.5 py-1 font-mono text-[11px] transition-colors cursor-pointer ${view === v ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
            >
              {v}
            </button>
          ))}
          </div>
        </div>
      </div>
      {dragError ? (
        <div className="mx-6 mt-3 flex items-center justify-between rounded-md border border-rust/40 bg-rust/10 px-3 py-2 text-[11.5px] text-rust">
          {dragError}
          <button className="cursor-pointer text-rust/70 hover:text-rust" onClick={() => setDragError(null)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
      {view === "graph" ? (
        graphTasks.length ? (
          <DepGraph tasks={graphTasks} />
        ) : (
          <div className="mx-auto mt-20 max-w-md px-6 text-center text-[11.5px] text-ink-500">
            No linked tasks yet. Open a task and press <span className="font-mono text-cyan">Improve</span> to split it into subtasks with dependencies, or tick “show unlinked” and drag one card onto another.
          </div>
        )
      ) : (
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 py-4">
        {COLUMNS.map((meta) => {
          const status = meta.statuses[0];
          const list = byColumn.get(meta.id) ?? [];
          const accepts = meta.id === "backlog" || meta.id === "queued";
          return (
            <section
              key={meta.id}
              onDragOver={(e) => {
                if (!accepts) return;
                e.preventDefault();
                setDropTarget(status);
              }}
              onDragLeave={() => setDropTarget((d) => (d === status ? null : d))}
              onDrop={(e) => onDrop(status, e)}
              style={columns === "fill" ? undefined : { width: columns }}
              className={`flex flex-col rounded-xl border bg-ink-900/70 transition-colors ${
                columns === "fill" ? "min-w-[188px] flex-1" : "shrink-0"
              } ${dropTarget === status ? "border-amber/60 bg-amber/5" : "border-ink-800"}`}
            >
              <div className={`flex items-center gap-2 border-t-2 ${meta.color} rounded-t-xl px-3 py-2`}>
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                <span className={`text-[11.5px] font-semibold uppercase tracking-[0.08em] ${meta.text}`}>{meta.label}</span>
                <span className="font-mono text-[11px] text-ink-500">{list.length}</span>
                {(() => {
                  const n = list.filter((c) => needsYou.some((y) => y.id === c.id)).length;
                  return n ? <span className="font-mono text-[10.5px] text-rose" title={`${n} here ${n === 1 ? "needs" : "need"} you`}>· {n} need{n === 1 ? "s" : ""} you</span> : null;
                })()}
                {status === "backlog" ? (
                  <button className="ml-auto text-ink-400 hover:text-amber cursor-pointer" onClick={() => setCreating("now")} title="New task">+</button>
                ) : null}
                {status === "done" && list.some((c) => !c.archived_at) ? (
                  <button
                    className="ml-auto font-mono text-[10.5px] text-ink-500 hover:text-amber cursor-pointer"
                    title="Hide every finished task here. Nothing is deleted — they stay in search, the dashboard and their own history."
                    onClick={() => void api.archiveDone(project.id).catch((e) => setDragError(e instanceof Error ? e.message : String(e)))}
                  >
                    tidy
                  </button>
                ) : null}
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-3">
                {list.map((c) => (
                  <Card
                    key={c.id}
                    card={c}
                    waiting={c.depends_on.length ? waitingOn(c, byId) : undefined}
                    progress={progress.get(c.id)}
                    parentTitle={c.parent_id ? titles.get(c.parent_id) : undefined}
                    serial={settings?.serial}
                    asking={projectPending.some((a) => a.task_id === c.id && isQuestion(a))}
                    watching={live.has(c.id)}
                    memory={MEMORY_STATUSES.has(c.status) ? memory[c.id] : undefined}
                    conflictsWith={conflicts.get(c.id)}
                    detail={detail}
                  />
                ))}
                {status === "done" && archivedCount ? (
                  <button
                    className="mt-1 rounded-lg border border-dashed border-ink-800 px-3 py-2 text-center font-mono text-[11px] text-ink-500 hover:border-ink-600 hover:text-ink-300 cursor-pointer"
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    {showArchived ? "hide" : "show"} {archivedCount} archived
                  </button>
                ) : null}
                {!list.length && accepts ? (
                  <div className="rounded-lg border border-dashed border-ink-800 px-3 py-5 text-center text-[11.5px] text-ink-500">
                    {status === "backlog" ? "Drag here to unqueue" : "Drag from Backlog to queue"}
                  </div>
                ) : null}
                {!list.length && meta.id === "in-progress" ? (
                  <div className="rounded-lg border border-dashed border-ink-800 px-3 py-5 text-center text-[11.5px] text-ink-500">
                    Nothing is running. A queued task shows up here while Claude plans, codes and reviews it.
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      )}
      {creating ? <NewTaskForm project={project} initialWhen={creating} onClose={() => setCreating(false)} /> : null}
      {schedulesOpen ? (
        <SchedulesPanel project={project} cards={cards} schedules={schedules} onClose={() => setSchedulesOpen(false)} onNew={() => setCreating("repeat")} />
      ) : null}
    </div>
  );
}
