import { useCallback, useEffect, useState } from "react";
import type { Schedule, Task, TaskCard } from "../../../server/src/types.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { useAppData } from "../lib/store.tsx";
import { clock, until } from "../lib/format.ts";
import { Button, ErrorLine, Modal, Switch, useAction } from "./ui.tsx";
import { defaultWhen, describeDays, startAtOf, WhenPicker, whenInvalid, type When } from "./WhenPicker.tsx";

/** A project's repeating schedules, kept live over the websocket. */
export function useSchedules(projectId: string) {
  const [list, setList] = useState<Schedule[]>([]);
  const reload = useCallback(() => void api.schedules(projectId).then(setList, () => {}), [projectId]);
  useEffect(reload, [reload]);
  useWs((m) => {
    if (m.type === "schedule.updated" && m.schedule.project_id === projectId) {
      setList((prev) => (prev.some((s) => s.id === m.schedule.id) ? prev.map((s) => (s.id === m.schedule.id ? m.schedule : s)) : [...prev, m.schedule]));
    } else if (m.type === "schedule.deleted" && m.project_id === projectId) {
      setList((prev) => prev.filter((s) => s.id !== m.id));
    }
  });
  return list;
}

/** "starts Tue 02:00 · in 5h" or "starts after your limit resets". */
export function startLabel(startAt: string): string {
  return startAt === "reset" ? "after your limit resets" : `${clock(startAt)} · ${until(startAt)}`;
}

/** Rows fade out before they leave, so a delete reads as a delete, not a flicker. */
function useLeaving() {
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const leave = (id: string, then: () => Promise<unknown>) => {
    setLeaving((s) => new Set(s).add(id));
    setTimeout(() => void then().catch(() => setLeaving((s) => { const n = new Set(s); n.delete(id); return n; })), 180);
  };
  return { leaving, leave };
}

function ScheduleRow({ s, onError }: { s: Schedule; onError: (e: string) => void }) {
  const [time, setTime] = useState(s.time);
  useEffect(() => setTime(s.time), [s.time]);
  const patch = (b: Parameters<typeof api.patchSchedule>[1]) => api.patchSchedule(s.id, b).catch((e: Error) => onError(e.message));
  return (
    <div className={`rounded-lg border px-3 py-2.5 transition-all duration-200 ${s.enabled ? "border-ink-700 bg-ink-850" : "border-ink-800 bg-ink-900/60 opacity-70"}`}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-ink-100">↻ {s.title}</span>
        <span className="ml-auto" />
        <Switch on={s.enabled} onChange={(v) => void patch({ enabled: v })} title={s.enabled ? "On — pause it" : "Paused — switch on"} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const on = s.days.includes(d);
          return (
            <button
              key={d}
              className={`h-6 w-9 rounded border text-[10.5px] transition-all duration-150 cursor-pointer active:scale-95 ${on ? "border-cyan/60 bg-cyan/10 text-cyan" : "border-ink-700 text-ink-500 hover:border-ink-500"}`}
              onClick={() => {
                const days = on ? s.days.filter((x) => x !== d) : [...s.days, d];
                if (days.length) void patch({ days });
              }}
              title={on && s.days.length === 1 ? "A schedule needs at least one day — pause it instead" : undefined}
            >
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}
            </button>
          );
        })}
        <input
          type="time"
          className="ml-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-[11.5px] text-ink-200"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          onBlur={() => time && time !== s.time && void patch({ time })}
        />
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-400">
        <span>
          {s.enabled && s.next_run_at ? <>Next: <b className="text-ink-200">{clock(s.next_run_at)}</b> · {until(s.next_run_at)}</> : "Paused"}
          {" · "}{describeDays(s.days)}
        </span>
        {s.last_task_id ? (
          <button className="cursor-pointer text-ink-500 underline-offset-2 hover:text-ink-200 hover:underline" onClick={() => navigate({ taskId: s.last_task_id })}>
            last card
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Everything set to start later in this project: repeating schedules you can pause, retime or run
 * now, and cards waiting for a one-time start. Slides in from the right, over the board.
 */
export function SchedulesPanel({ project, cards, schedules, onClose, onNew }: {
  project: ProjectWithGit;
  cards: TaskCard[];
  schedules: Schedule[];
  onClose: () => void;
  onNew: () => void;
}) {
  const { settings } = useAppData();
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const { leaving, leave } = useLeaving();
  const close = () => {
    setClosing(true);
    setTimeout(onClose, 180);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const oneTime = cards.filter((c) => c.start_at).sort((a, b) => (a.start_at === "reset" ? 1 : b.start_at === "reset" ? -1 : a.start_at!.localeCompare(b.start_at!)));

  return (
    <div className="fixed inset-0 z-40">
      <div className={`absolute inset-0 bg-ink-950/50 ${closing ? "fade-out" : "fade-in"}`} onClick={close} />
      <aside className={`absolute inset-y-0 right-0 flex w-[440px] max-w-full flex-col border-l border-ink-700 bg-ink-900 shadow-2xl ${closing ? "slide-out-right" : "slide-in-right"}`}>
        <header className="flex items-center gap-3 border-b border-ink-800 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink-100">Schedules</h2>
            <p className="text-[11.5px] text-ink-400">Work set to start while you are away · {project.name}</p>
          </div>
          <button className="ml-auto cursor-pointer text-[18px] leading-none text-ink-400 hover:text-ink-100" onClick={close} title="Close (Esc)">×</button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          <ErrorLine error={error} />
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-300">Repeating</h3>
              <span className="font-mono text-[11px] text-ink-500">{schedules.length}</span>
              <Button size="sm" className="ml-auto" onClick={onNew}>+ New</Button>
            </div>
            <div className="space-y-2">
              {schedules.map((s, i) => (
                <div key={s.id} className={leaving.has(s.id) ? "fade-out" : "rise"} style={{ animationDelay: leaving.has(s.id) ? undefined : `${i * 40}ms` }}>
                  <ScheduleRow s={s} onError={setError} />
                  <div className="mt-1 flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => void api.runSchedule(s.id).then((t) => navigate({ taskId: t.id }), (e: Error) => setError(e.message))}>
                      ▶ Run now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => confirm(`Delete the schedule "${s.title}"? Cards it already made stay.`) && leave(s.id, () => api.deleteSchedule(s.id))}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
              {!schedules.length ? (
                <div className="rounded-lg border border-dashed border-ink-800 px-4 py-5 text-center text-[12px] leading-relaxed text-ink-500">
                  Nothing repeats yet. A repeating schedule makes a fresh card on the days you pick — nightly tests, a weekly tidy-up,
                  a morning report — and queues it.
                </div>
              ) : null}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-300">Starting later</h3>
              <span className="font-mono text-[11px] text-ink-500">{oneTime.length}</span>
            </div>
            <div className="space-y-1.5">
              {oneTime.map((c) => (
                <div key={c.id} className={`flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 ${leaving.has(c.id) ? "fade-out" : "rise"}`}>
                  <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => navigate({ taskId: c.id })}>
                    <div className="truncate text-[12.5px] text-ink-100">{c.title}</div>
                    <div className="font-mono text-[10.5px] text-cyan">⏰ {startLabel(c.start_at!)}</div>
                  </button>
                  <Button size="sm" variant="ghost" onClick={() => void api.scheduleTask(c.id, null).then(() => api.queue(c.id)).catch((e: Error) => setError(e.message))}>Start now</Button>
                  <Button size="sm" variant="ghost" onClick={() => leave(c.id, () => api.scheduleTask(c.id, null))}>Cancel</Button>
                </div>
              ))}
              {!oneTime.length ? (
                <div className="rounded-lg border border-dashed border-ink-800 px-4 py-4 text-center text-[12px] text-ink-500">
                  No cards waiting for a start time. Open a card and press <b className="text-ink-300">⏰ Schedule</b>, or pick <b className="text-ink-300">Later</b> when you create one.
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <footer className="border-t border-ink-800 px-5 py-3 text-[11.5px] leading-relaxed text-ink-400">
          {settings?.keepAwake ? (
            <>☾ <b className="text-ink-200">Keep this computer awake</b> is on: Windows won't sleep while work is queued, running or scheduled. The board must stay open, and a closed laptop lid may still sleep.</>
          ) : (
            <>☾ Keep awake is off, so the computer may sleep through a schedule. Turn it on in <button className="cursor-pointer text-amber hover:underline" onClick={() => navigate({ view: "settings" })}>Settings → Runs &amp; limits</button>.</>
          )}
        </footer>
      </aside>
    </div>
  );
}

/** The drawer's "⏰ Schedule" dialog: start this card later, or repeat it on set days. */
export function ScheduleModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [when, setWhen] = useState<When>(task.start_at === "reset" ? { kind: "reset" } : defaultWhen("at"));
  const { busy, error, run } = useAction();
  const invalid = whenInvalid(when);
  const save = () =>
    run(async () => {
      if (when.kind === "repeat") {
        await api.createSchedule({
          project_id: task.project_id, title: task.title, spec_md: task.spec_md, mode: task.mode, type: task.type,
          priority: task.priority, pipeline: task.pipeline, skills: task.skills, days: when.days, time: when.time,
        });
      } else {
        await api.scheduleTask(task.id, startAtOf(when));
      }
      onClose();
    });
  return (
    <Modal title={`Schedule “${task.title}”`} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        {task.start_at ? (
          <div className="flex items-center gap-2 rounded-md border border-cyan/40 bg-cyan/5 px-3 py-2 text-[12.5px] text-cyan">
            ⏰ Set to start {startLabel(task.start_at)}
            <Button size="sm" variant="ghost" className="ml-auto" busy={busy} onClick={() => run(async () => { await api.scheduleTask(task.id, null); onClose(); })}>Cancel it</Button>
          </div>
        ) : null}
        <WhenPicker value={when} onChange={setWhen} allowNow={false} />
        {when.kind === "repeat" ? (
          <p className="text-[11.5px] text-ink-400">This card stays as it is; the schedule copies its title, spec and pipeline into a new card each time.</p>
        ) : null}
        <ErrorLine error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!!invalid} title={invalid ?? undefined} onClick={() => void save()}>
            {when.kind === "repeat" ? "Create schedule" : "Schedule"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
