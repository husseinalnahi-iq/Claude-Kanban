import { useEffect, useMemo, useRef, useState } from "react";
import { layout } from "../../../server/src/engine/graph.ts";
import type { Priority, TaskStatus, TaskType } from "../../../server/src/types.ts";
import { PRIORITY_META, STATUS_META, TYPE_META } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { api } from "../lib/api.ts";
import { Chip } from "./ui.tsx";

const W = 210;
const H = 68;
const GAP_X = 78;
const GAP_Y = 14;
const PAD = 16;
const HEADER = 26;

const x0 = (col: number) => PAD + col * (W + GAP_X);
const y0 = (row: number) => PAD + HEADER + row * (H + GAP_Y);

/**
 * The dependency graph, drawn left to right: everything in one column can run at the same time,
 * and an arrow means "wait for that one first". Dragging the handle on a card's right edge onto
 * another card creates the dependency; the server refuses loops, and the error is shown here.
 */
/** The minimum a card needs to be drawn — both `Task` and `TaskCard` satisfy it. */
export interface GraphCard {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  type: TaskType;
  depends_on: string[];
  parent_id?: string | null;
}

export function DepGraph({ tasks, editable = true }: { tasks: GraphCard[]; editable?: boolean }) {
  const inner = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: string; x: number; y: number } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Removing a dependency is two clicks — the first arms the arrow and says what will happen. */
  const [armed, setArmed] = useState<string | null>(null);

  const { nodes, edges, columns } = useMemo(() => layout(tasks), [tasks]);
  const at = useMemo(() => new Map(nodes.map((n) => [n.task.id, n])), [nodes]);
  const done = useMemo(() => new Set(tasks.filter((t) => t.status === "done").map((t) => t.id)), [tasks]);
  /** A task with children on screen is a container, not work of its own — it shows progress instead. */
  const group = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const t of tasks) {
      if (!t.parent_id) continue;
      const e = m.get(t.parent_id) ?? { done: 0, total: 0 };
      e.total += 1;
      if (t.status === "done") e.done += 1;
      m.set(t.parent_id, e);
    }
    return m;
  }, [tasks]);
  const perColumn = useMemo(() => {
    const m = new Map<number, number>();
    for (const n of nodes) m.set(n.col, (m.get(n.col) ?? 0) + 1);
    return m;
  }, [nodes]);
  const rows = Math.max(1, ...[...perColumn.values()]);
  const width = Math.max(360, x0(columns - 1) + W + PAD);
  const height = y0(rows - 1) + H + PAD;

  // The live line follows the pointer until it is released over a card (or nowhere).
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const box = inner.current?.getBoundingClientRect();
      if (box) setDrag((d) => (d ? { ...d, x: e.clientX - box.left, y: e.clientY - box.top } : d));
    };
    const up = () => {
      setDrag((d) => {
        if (d && over && over !== d.from) void link(d.from, over);
        return null;
      });
      setOver(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, over]);

  const link = async (from: string, to: string) => {
    const target = tasks.find((t) => t.id === to);
    if (!target || target.depends_on.includes(from)) return;
    setErr(null);
    try {
      await api.patchTask(to, { depends_on: [...target.depends_on, from] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const unlink = async (from: string, to: string) => {
    const target = tasks.find((t) => t.id === to);
    if (!target) return;
    setArmed(null);
    setErr(null);
    try {
      await api.patchTask(to, { depends_on: target.depends_on.filter((d) => d !== from) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!tasks.length) return <div className="px-6 py-10 text-center text-[12.5px] text-ink-500">Nothing to draw yet.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2 text-[11.5px] text-ink-500">
        <span>A column runs in parallel · an arrow means “wait for this first”.</span>
        {editable ? <span>Drag the ● on a card's right edge onto another card to make it wait. Click an arrow to remove it.</span> : null}
      </div>
      {err ? (
        <div className="mx-6 mb-2 flex items-center justify-between rounded-md border border-rust/40 bg-rust/10 px-3 py-2 text-[12.5px] text-rust">
          {err}
          <button className="cursor-pointer text-rust/70 hover:text-rust" onClick={() => setErr(null)}>×</button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div ref={inner} className="relative select-none" style={{ width, height }} onClick={() => setArmed(null)}>
          <svg className="absolute inset-0 overflow-visible" width={width} height={height}>
            <defs>
              <marker id="depArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--color-ink-500)" />
              </marker>
            </defs>
            {edges.map(({ from, to }) => {
              const a = at.get(from)!;
              const b = at.get(to)!;
              const ax = x0(a.col) + W;
              const ay = y0(a.row) + H / 2;
              const bx = x0(b.col);
              const by = y0(b.row) + H / 2;
              const d = `M ${ax} ${ay} C ${ax + GAP_X * 0.6} ${ay}, ${bx - GAP_X * 0.6} ${by}, ${bx} ${by}`;
              const satisfied = done.has(from);
              const key = `${from}->${to}`;
              const isArmed = armed === key;
              return (
                <g key={key} className={editable ? "cursor-pointer" : undefined}>
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={isArmed ? 3 : 2}
                    stroke={isArmed ? "var(--color-rust)" : satisfied ? "var(--color-moss)" : "var(--color-ink-600)"}
                    strokeDasharray={satisfied && !isArmed ? undefined : "5 4"}
                    markerEnd="url(#depArrow)"
                  />
                  {editable ? (
                    <>
                      <path
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={14}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isArmed) void unlink(from, to);
                          else setArmed(key);
                        }}
                      >
                        <title>Remove this dependency</title>
                      </path>
                      {isArmed ? (
                        <text x={(ax + bx) / 2} y={(ay + by) / 2 - 8} textAnchor="middle" fontSize={11} fill="var(--color-rust)" className="font-mono">
                          click again to let these run together
                        </text>
                      ) : null}
                    </>
                  ) : null}
                </g>
              );
            })}
            {drag ? (
              <path
                d={`M ${x0(at.get(drag.from)!.col) + W} ${y0(at.get(drag.from)!.row) + H / 2} L ${drag.x} ${drag.y}`}
                stroke="var(--color-amber)"
                strokeWidth={2}
                strokeDasharray="4 4"
                fill="none"
              />
            ) : null}
          </svg>

          {[...perColumn.keys()].sort((a, b) => a - b).map((col) => (
            <div key={col} className="absolute font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500" style={{ left: x0(col), top: PAD, width: W }}>
              {col === 0 ? "start" : `after step ${col}`}
              {(perColumn.get(col) ?? 0) > 1 ? <span className="text-ink-600"> · {perColumn.get(col)} in parallel</span> : null}
            </div>
          ))}

          {nodes.map(({ task, col, row }) => {
            const blocked = task.depends_on.some((d) => !done.has(d));
            const meta = STATUS_META[task.status];
            const g = group.get(task.id);
            const isTarget = drag && over === task.id && drag.from !== task.id;
            return (
              <div
                key={task.id}
                onMouseEnter={() => setOver(task.id)}
                onMouseLeave={() => setOver((o) => (o === task.id ? null : o))}
                onClick={() => !drag && navigate({ taskId: task.id })}
                style={{ left: x0(col), top: y0(row), width: W, height: H }}
                className={`group absolute cursor-pointer rounded-lg border bg-ink-850 px-2.5 py-2 transition-colors hover:border-ink-500 ${
                  isTarget ? "border-amber bg-amber/10" : task.status === "approval" ? "border-rose/60" : g ? "border-dashed border-ink-600" : "border-ink-700"
                } ${blocked ? "opacity-70" : ""}`}
                title={blocked ? "Waiting on another task" : task.title}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot} ${task.status === "running" ? "breathe" : ""}`} />
                  <span className={`font-mono text-[9.5px] uppercase tracking-wider ${meta.text}`}>{meta.label}</span>
                  {g ? (
                    <span className="font-mono text-[9.5px] text-ink-400" title={`${g.done} of ${g.total} subtasks done`}>
                      · {g.done}/{g.total}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1">
                    <Chip className={`${PRIORITY_META[task.priority].tone} px-1! py-0! text-[9px]!`}>{task.priority}</Chip>
                    <Chip className={`${TYPE_META[task.type].tone} px-1! py-0! text-[9px]!`}>{TYPE_META[task.type].short}</Chip>
                  </span>
                </div>
                <div className="line-clamp-2 text-[12px] leading-snug text-ink-100">{task.title}</div>
                {editable ? (
                  <span
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const box = inner.current?.getBoundingClientRect();
                      setDrag({ from: task.id, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
                    }}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag onto another task to make it wait for this one"
                    className="absolute -right-[7px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-ink-600 bg-ink-900 opacity-0 transition-opacity group-hover:opacity-100 hover:border-amber"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
