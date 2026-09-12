import { useCallback, useEffect, useState } from "react";
import type { Milestone, TaskCard } from "../../../server/src/types.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { STATUS_META } from "../lib/format.ts";
import { Button, inputCls, ModeChip } from "../components/ui.tsx";
import { NewTaskForm } from "../components/forms.tsx";
import { useTaskCards } from "./Board.tsx";

const UNSCHEDULED = "__none";

export function Roadmap({ project }: { project: ProjectWithGit }) {
  const { cards } = useTaskCards(project.id);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [over, setOver] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const load = useCallback(() => void api.milestones(project.id).then(setMilestones), [project.id]);
  useEffect(load, [load]);
  useWs((m) => m.type === "milestone.updated" && m.milestone.project_id === project.id && load());

  const top = cards.filter((c) => !c.parent_id);
  const columns: { id: string; ms: Milestone | null }[] = [...milestones.map((ms) => ({ id: ms.id, ms })), { id: UNSCHEDULED, ms: null }];

  const drop = async (colId: string, e: React.DragEvent) => {
    setOver(null);
    const id = e.dataTransfer.getData("text/task-id");
    if (id) await api.patchTask(id, { milestone_id: colId === UNSCHEDULED ? null : colId });
  };
  const swap = async (i: number, d: -1 | 1) => {
    const a = milestones[i];
    const b = milestones[i + d];
    if (!a || !b) return;
    await api.patchMilestone(a.id, { position: b.position });
    await api.patchMilestone(b.id, { position: a.position });
    load();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-ink-800 px-6 py-3.5">
        <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">Roadmap · {project.name}</h1>
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await api.createMilestone({ project_id: project.id, title, due_date: due || null });
            setTitle("");
            setDue("");
            load();
          }}
        >
          <input className={`${inputCls} w-56!`} placeholder="Milestone title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="date" className={`${inputCls} w-36! font-mono`} value={due} onChange={(e) => setDue(e.target.value)} />
          <Button type="submit" variant="primary">+ Milestone</Button>
        </form>
      </header>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 py-4">
        {columns.map(({ id, ms }, i) => {
          const list = top.filter((c) => (c.milestone_id ?? UNSCHEDULED) === id);
          const done = list.filter((c) => c.status === "done").length;
          return (
            <section
              key={id}
              onDragOver={(e) => (e.preventDefault(), setOver(id))}
              onDragLeave={() => setOver((o) => (o === id ? null : o))}
              onDrop={(e) => drop(id, e)}
              className={`flex w-[300px] shrink-0 flex-col rounded-xl border bg-ink-900/70 ${over === id ? "border-amber/60" : "border-ink-800"}`}
            >
              <div className="border-b border-ink-800 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  {ms ? (
                    <input
                      className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-ink-100 focus:outline-none"
                      defaultValue={ms.title}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== ms.title && void api.patchMilestone(ms.id, { title: e.target.value }).then(load)}
                    />
                  ) : (
                    <span className="flex-1 text-[13px] font-semibold text-ink-400">Unscheduled</span>
                  )}
                  {ms ? (
                    <div className="flex text-ink-500">
                      <button className="px-0.5 hover:text-ink-100 disabled:opacity-30 cursor-pointer" disabled={i === 0} onClick={() => swap(i, -1)}>←</button>
                      <button className="px-0.5 hover:text-ink-100 disabled:opacity-30 cursor-pointer" disabled={i === milestones.length - 1} onClick={() => swap(i, 1)}>→</button>
                      <button className="px-0.5 hover:text-rust cursor-pointer" onClick={() => confirm(`Delete milestone "${ms.title}"? Tasks become unscheduled.`) && void api.deleteMilestone(ms.id).then(load)}>×</button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-ink-500">
                  {ms?.due_date ? <span>due {ms.due_date}</span> : null}
                  <span>{done}/{list.length} done</span>
                  <div className="h-1 flex-1 overflow-hidden rounded bg-ink-800">
                    <div className="h-full bg-moss" style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} />
                  </div>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                {list.map((c: TaskCard) => (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/task-id", c.id)}
                    onClick={() => navigate({ view: "roadmap", taskId: c.id })}
                    className="rise cursor-pointer rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 hover:border-ink-500"
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_META[c.status].dot}`} />
                      <span className="flex-1 text-[12.5px] text-ink-100">{c.title}</span>
                      <ModeChip mode={c.mode} />
                    </div>
                    <div className={`mt-1 pl-3.5 font-mono text-[10.5px] ${STATUS_META[c.status].text}`}>{c.status}</div>
                  </div>
                ))}
                <button className="rounded-lg border border-dashed border-ink-800 py-1.5 text-[11.5px] text-ink-500 hover:border-ink-600 hover:text-ink-300 cursor-pointer" onClick={() => setCreatingIn(id)}>
                  + task
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {creatingIn ? <NewTaskForm project={project} milestoneId={creatingIn === UNSCHEDULED ? null : creatingIn} onClose={() => setCreatingIn(null)} /> : null}
    </div>
  );
}
