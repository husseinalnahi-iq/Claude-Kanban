import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { type StageState, type TaskCard, type TaskStatus } from "../../../server/src/types.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { useAppData } from "../lib/store.tsx";
import { clock, cost, PRIORITY_META, shortModel, STATUS_META, TYPE_META, until } from "../lib/format.ts";
import { Button, Chip, ModeChip, inputCls } from "../components/ui.tsx";
import { NewTaskForm } from "../components/forms.tsx";
import { LimitBanner, SerialSwitch } from "../components/QueueControls.tsx";
import { DepGraph } from "../components/DepGraph.tsx";
import { COLUMN_SIZES, setViewPrefs, useViewPrefs } from "../lib/view.ts";

const DOT: Record<StageState, string> = {
  idle: "border border-ink-500 bg-transparent",
  running: "bg-amber breathe",
  approval: "bg-rose pulse-rose",
  success: "bg-moss",
  failed: "bg-rust",
};
const STAGE_LETTER = { plan: "P", code: "C", review: "R", custom: "·" } as const;

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

/** The in-progress badge: which stage is running, or why it is waiting. */
function phase(card: TaskCard): { text: string; tone: string; title: string } {
  if (card.status === "approval") return { text: "needs you", tone: "border-rose/60 text-rose", title: "Waiting for you to allow or deny something — open the task" };
  if (card.status === "paused") return { text: "paused · limit", tone: "border-iris/50 text-iris", title: "Paused by your Claude usage limit; it carries on by itself" };
  if (card.status === "planning") return { text: "planning", tone: "border-cyan/50 text-cyan", title: "The plan stage is running" };
  const i = card.stage_states.indexOf("running");
  const stage = i >= 0 ? card.pipeline[i]?.stage : undefined;
  const word = stage === "code" ? "coding" : stage === "review" ? "reviewing" : stage === "plan" ? "planning" : "running";
  return { text: word, tone: "border-amber/50 text-amber", title: stage ? `The ${stage} stage is running` : "A stage is running" };
}

/** Keeps a project's task cards live: initial fetch, then WS upserts; refetch on run end for costs. */
export function useTaskCards(projectId: string | null) {
  const [cards, setCards] = useState<TaskCard[]>([]);
  const reload = useCallback(async () => {
    if (projectId) setCards(await api.tasks(projectId));
  }, [projectId]);
  useEffect(() => {
    setCards([]);
    void reload();
  }, [reload]);
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
      setCards((prev) =>
        prev.map((c) => (c.id === m.run.task_id ? { ...c, stage_states: c.stage_states.map((s, i) => (i === m.run.stage_index ? m.run.status : s)) } : c)),
      );
    } else if (m.type === "run.finished") {
      void reload();
    }
  });
  return { cards, reload };
}

const Card = memo(function Card({
  card,
  parentTitle,
  blocked,
  progress,
  serial,
  onDragStart,
}: {
  card: TaskCard;
  parentTitle?: string;
  blocked?: boolean;
  progress?: { done: number; total: number };
  /** The board runs one task at a time, so queueing means waiting — offer the way past it. */
  serial?: boolean;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const draggable = card.status === "backlog" || card.status === "queued";
  const live = ["planning", "running", "approval"].includes(card.status);
  const act = async (e: React.MouseEvent, fn: () => Promise<unknown>) => {
    e.stopPropagation();
    try {
      await fn();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={() => navigate({ taskId: card.id })}
      className={`rise group relative cursor-pointer rounded-lg border bg-ink-850 px-3 py-2.5 transition-colors hover:border-ink-500 hover:bg-ink-800 ${
        card.status === "approval" ? "border-rose/60" : live ? "border-amber/40" : "border-ink-700"
      } ${card.archived_at ? "opacity-55 hover:opacity-100" : ""}`}
    >
      {card.archived_at ? <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-600">archived</div> : null}
      {parentTitle ? <div className="mb-1 truncate font-mono text-[10.5px] text-ink-500">↳ {parentTitle}</div> : null}
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {IN_PROGRESS.includes(card.status) ? (() => {
          const p = phase(card);
          return <Chip className={`${p.tone} ${card.status === "paused" ? "" : "font-semibold"}`} title={p.title}>{p.text}</Chip>;
        })() : null}
        <Chip className={PRIORITY_META[card.priority].tone} title={PRIORITY_META[card.priority].title}>{card.priority}</Chip>
        <Chip className={TYPE_META[card.type].tone}>{TYPE_META[card.type].short}</Chip>
        {card.labels.slice(0, 2).map((l) => (
          <Chip key={l} className="border-ink-700 text-ink-400 normal-case">{l}</Chip>
        ))}
        {blocked ? <Chip className="border-slate/50 text-slate" title="Waiting on another task">blocked</Chip> : null}
        {progress ? (
          <Chip
            className={progress.done === progress.total ? "border-moss/50 text-moss" : "border-ink-600 text-ink-300"}
            title={`${progress.done} of ${progress.total} subtasks done`}
          >
            {progress.done}/{progress.total}
          </Chip>
        ) : null}
        {card.suggestion && (card.suggestion.priority !== card.priority || card.suggestion.type !== card.type) ? (
          <Chip
            className="border-cyan/40 text-cyan"
            title={`Claude suggests ${card.suggestion.type} · ${card.suggestion.priority} (${Math.round((card.suggestion.confidence ?? 0) * 100)}% sure) — open the task to accept`}
          >
            {card.suggestion.type !== card.type ? card.suggestion.type : card.suggestion.priority}?
          </Chip>
        ) : null}
        <span className="ml-auto"><ModeChip mode={card.mode} /></span>
      </div>
      <div className="text-[13px] font-medium leading-snug text-ink-100">{card.title}</div>
      {card.summary ? <div className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-ink-300">{card.summary}</div> : null}
      {card.error && card.status === "failed" ? <div className="mt-1.5 line-clamp-2 font-mono text-[11px] text-rust">{card.error}</div> : null}
      {card.note && card.status === "backlog" ? <div className="mt-1.5 line-clamp-2 text-[11.5px] italic text-ink-400">“{card.note}”</div> : null}
      {card.status === "paused" && card.resume_at ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-iris/40 bg-iris/5 px-2 py-1 text-[11.5px] text-iris">
          <span title="Paused by your Claude usage limit; it continues in the same session, from the stage it was on">
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
      <div className="mt-2.5 flex items-center gap-2.5">
        {/* The stage chips give way first: in a narrow column the hover actions must stay on the card. */}
        <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
          {card.pipeline.map((s, i) => (
            <span key={i} className={`flex items-center gap-1 font-mono text-[10px] ${s.provider ? "text-iris" : "text-ink-400"}`} title={`${s.stage} · ${s.model}${s.provider ? ` via ${s.provider}` : ""} · ${s.effort} · ${card.stage_states[i]}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${DOT[card.stage_states[i] ?? "idle"]}`} />
              <span className="text-ink-500">{STAGE_LETTER[s.stage]}</span>
              {shortModel(s.model).split("-")[0]}
              {s.fast ? <span className="text-amber" title="Fast mode">↯</span> : null}
            </span>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {card.cost_usd > 0 ? <span className="font-mono text-[10.5px] text-ink-400">{cost(card.cost_usd)}</span> : null}
          {card.status === "backlog" || card.status === "failed" ? (
            <>
              <button
                className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 opacity-0 transition-opacity hover:border-amber hover:text-amber group-hover:opacity-100 cursor-pointer"
                onClick={(e) => act(e, () => (card.status === "failed" ? api.retry(card.id) : api.queue(card.id)))}
              >
                {card.status === "failed" ? "retry" : "queue"}
              </button>
              {serial ? (
                <button
                  className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 opacity-0 transition-opacity hover:border-cyan hover:text-cyan group-hover:opacity-100 cursor-pointer"
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
              className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 opacity-0 transition-opacity hover:border-amber hover:text-amber group-hover:opacity-100 cursor-pointer"
              title={card.archived_at ? "Bring it back onto the board" : "Hide it from the board — nothing is deleted"}
              onClick={(e) => act(e, () => (card.archived_at ? api.unarchive(card.id) : api.archive(card.id)))}
            >
              {card.archived_at ? "unarchive" : "archive"}
            </button>
          ) : null}
          {card.status === "queued" || live ? (
            <button
              className="rounded border border-ink-600 px-1.5 py-px font-mono text-[10.5px] text-ink-300 opacity-0 transition-opacity hover:border-rust hover:text-rust group-hover:opacity-100 cursor-pointer"
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
  const [creating, setCreating] = useState(false);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const [filter, setFilter] = useState({ q: "", type: "", priority: "", label: "" });
  const [view, setView] = useState<"board" | "graph">("board");
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const titles = useMemo(() => new Map(cards.map((c) => [c.id, c.title])), [cards]);
  const done = useMemo(() => new Set(cards.filter((c) => c.status === "done").map((c) => c.id)), [cards]);
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
    const rank = (s: TaskStatus) => (IN_PROGRESS.includes(s) ? IN_PROGRESS.indexOf(s) : 0);
    for (const list of m.values()) list.sort((a, b) => rank(a.status) - rank(b.status) || a.priority.localeCompare(b.priority) || a.position - b.position);
    return m;
  }, [visible]);
  const projectPending = pending.filter((a) => cards.some((c) => c.id === a.task_id));
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
      if (from === "backlog" && status === "queued") await api.queue(id);
      else if (from === "queued" && status === "backlog") await api.stop(id);
    } catch (err) {
      setDragError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-800 px-6 py-3.5">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">{project.name}</h1>
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
          {projectPending.length ? (
            <Button variant="outline" className="border-rose/60 text-rose" onClick={() => navigate({ taskId: projectPending[0].task_id })}>
              <span className="pulse-rose inline-block h-2 w-2 rounded-full bg-rose" />
              {projectPending.length} awaiting approval
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => setCreating(true)}>+ New task</Button>
        </div>
      </header>
      <LimitBanner />
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-6 py-2">
        <input className={`${inputCls} max-w-[220px]`} placeholder="Filter tasks…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <select className={`${inputCls} w-auto! font-mono text-[12px]`} value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
          <option value="">any type</option>
          {Object.keys(TYPE_META).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className={`${inputCls} w-auto! font-mono text-[12px]`} value={filter.priority} onChange={(e) => setFilter({ ...filter, priority: e.target.value })}>
          <option value="">any priority</option>
          {Object.keys(PRIORITY_META).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {labels.length ? (
          <select className={`${inputCls} w-auto! font-mono text-[12px]`} value={filter.label} onChange={(e) => setFilter({ ...filter, label: e.target.value })}>
            <option value="">any label</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
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
        <div className="mx-6 mt-3 flex items-center justify-between rounded-md border border-rust/40 bg-rust/10 px-3 py-2 text-[12.5px] text-rust">
          {dragError}
          <button className="cursor-pointer text-rust/70 hover:text-rust" onClick={() => setDragError(null)}>×</button>
        </div>
      ) : null}
      {view === "graph" ? (
        graphTasks.length ? (
          <DepGraph tasks={graphTasks} />
        ) : (
          <div className="mx-auto mt-20 max-w-md px-6 text-center text-[12.5px] text-ink-500">
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
              <div className={`flex items-center gap-2 border-t-2 ${meta.color} rounded-t-xl px-3 py-2.5`}>
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                <span className={`text-[11.5px] font-semibold uppercase tracking-[0.08em] ${meta.text}`}>{meta.label}</span>
                <span className="font-mono text-[11px] text-ink-500">{list.length}</span>
                {status === "backlog" ? (
                  <button className="ml-auto text-ink-400 hover:text-amber cursor-pointer" onClick={() => setCreating(true)} title="New task">+</button>
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
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                {list.map((c) => (
                  <Card
                    key={c.id}
                    card={c}
                    blocked={c.depends_on.some((d) => !done.has(d))}
                    progress={progress.get(c.id)}
                    parentTitle={c.parent_id ? titles.get(c.parent_id) : undefined}
                    serial={settings?.serial}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/task-id", c.id);
                      e.dataTransfer.setData("text/task-status", c.status);
                    }}
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
      {creating ? <NewTaskForm project={project} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
