import { useCallback, useEffect, useRef, useState } from "react";
import type { Approval, Mode, Stage } from "../../../server/src/types.ts";
import { api, type TaskDetail } from "../lib/api.ts";
import { useWs, watchTask } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { useAppData } from "../lib/store.tsx";
import { Markdown } from "../lib/markdown.tsx";
import { ago, cost, costLabel, duration, modelLabel, PRIORITY_META, shortModel, STATUS_META, TYPE_META } from "../lib/format.ts";
import type { Stage as PipelineStage } from "../../../server/src/types.ts";
import { PRIORITIES, TASK_TYPES } from "../../../server/src/types.ts";
import { RefineModal } from "../components/RefineModal.tsx";
import { Button, Chip, Empty, ErrorLine, inputCls, ModeChip, ModeHelp, useAction } from "../components/ui.tsx";
import { PipelineEditor } from "../components/PipelineEditor.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { DepGraph } from "../components/DepGraph.tsx";
import { Gallery } from "../components/Gallery.tsx";
import { CostPanel } from "../components/CostPanel.tsx";
import { PlanGate } from "../components/PlanGate.tsx";
import { autonomousBlocked, NewTaskForm } from "../components/forms.tsx";

type Tab = "spec" | "pipeline" | "transcript" | "approvals" | "diff" | "subtasks" | "files" | "messages" | "chat";
const TABS: Tab[] = ["spec", "pipeline", "transcript", "approvals", "diff", "subtasks", "files", "messages", "chat"];
/** Two pipelines are the same when every stage, model and effort matches. */
const samePipeline = (a: PipelineStage[], b: PipelineStage[]) =>
  a.length === b.length && a.every((s, i) => s.stage === b[i].stage && s.model === b[i].model && s.effort === b[i].effort);

const RUN_TONE = { running: "text-amber", approval: "text-rose", success: "text-moss", failed: "text-rust" } as const;

function useTaskDetail(taskId: string) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    api.task(taskId).then(
      (d) => {
        setDetail(d);
        setMissing(false);
      },
      () => setMissing(true),
    );
  }, [taskId]);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 120);
  }, [load]);
  useEffect(() => {
    setDetail(null);
    load();
    // Transcript events are only sent for the task being watched, so ask for this one.
    watchTask(taskId);
    return () => watchTask(null);
  }, [load, taskId]);
  useWs((m) => {
    const related =
      (m.type === "task.updated" && (m.task.id === taskId || m.task.parent_id === taskId)) ||
      ((m.type === "run.updated" || m.type === "run.finished") && m.run.task_id === taskId) ||
      ((m.type === "approval.requested" || m.type === "approval.decided") && m.approval.task_id === taskId) ||
      (m.type === "message.posted" && (m.message.task_id === taskId || m.message.from_task_id === taskId)) ||
      (m.type === "attachment.added" && m.attachment.task_id === taskId) ||
      (m.type === "task.deleted" && m.taskId === taskId);
    if (related) soon();
  });
  return { detail, missing, reload: load };
}

function ApprovalInput({ a }: { a: Approval }) {
  const input = (a.input ?? {}) as Record<string, any>;
  if (a.tool_name === "Bash") return <pre className="rounded bg-ink-950 px-2.5 py-2 font-mono text-[12px] text-amber whitespace-pre-wrap">$ {input.command}</pre>;
  if (a.tool_name === "Write")
    return (
      <div>
        <div className="font-mono text-[12px] text-ink-100">{input.file_path}</div>
        <pre className="mt-1 max-h-56 overflow-auto rounded bg-ink-950 px-2.5 py-2 font-mono text-[11.5px] text-[#b9dcb0] whitespace-pre-wrap">{String(input.content ?? "")}</pre>
      </div>
    );
  if (a.tool_name === "Edit")
    return (
      <div className="space-y-1">
        <div className="font-mono text-[12px] text-ink-100">{input.file_path}</div>
        <pre className="max-h-40 overflow-auto rounded bg-rust/10 px-2.5 py-1.5 font-mono text-[11.5px] text-[#f0a58c] whitespace-pre-wrap">{String(input.old_string ?? "")}</pre>
        <pre className="max-h-40 overflow-auto rounded bg-moss/10 px-2.5 py-1.5 font-mono text-[11.5px] text-[#b9dcb0] whitespace-pre-wrap">{String(input.new_string ?? "")}</pre>
      </div>
    );
  return <pre className="max-h-56 overflow-auto rounded bg-ink-950 px-2.5 py-2 font-mono text-[11.5px] text-ink-300 whitespace-pre-wrap">{JSON.stringify(input, null, 2)}</pre>;
}

function PendingApproval({ a }: { a: Approval }) {
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="rise rounded-lg border border-rose/50 bg-rose/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="pulse-rose inline-block h-2 w-2 rounded-full bg-rose" />
        <span className="font-mono text-[12px] font-semibold text-rose">{a.tool_name}</span>
        <span className="truncate text-[12.5px] text-ink-200">{a.title === a.tool_name ? "" : a.title}</span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-500">{ago(a.created_at)}</span>
      </div>
      <ApprovalInput a={a} />
      <div className="mt-2.5 flex items-center gap-2">
        <input className={inputCls} placeholder="Note to Claude (optional, sent with Deny)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="danger" busy={busy} onClick={() => run(() => api.decide(a.id, "deny", note))}>Deny</Button>
        <Button variant="go" busy={busy} onClick={() => run(() => api.decide(a.id, "allow", note))}>Allow</Button>
      </div>
      <div className="mt-2"><ErrorLine error={error} /></div>
    </div>
  );
}

function SpecTab({ d }: { d: TaskDetail }) {
  const { projects } = useAppData();
  const project = projects.find((p) => p.id === d.task.project_id);
  const [editing, setEditing] = useState(false);
  const [spec, setSpec] = useState(d.task.spec_md);
  const { busy, error, run } = useAction();
  // Never overwrite what the user is typing: a server-side change during an edit would silently
  // throw their work away.
  useEffect(() => {
    if (!editing) setSpec(d.task.spec_md);
  }, [d.task.spec_md, editing]);
  const blocked = project ? autonomousBlocked(project) : null;
  const [refining, setRefining] = useState(false);
  const t = d.task;
  const sug = t.suggestion;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputCls} w-auto! font-mono text-[12px]`} value={t.type} onChange={(e) => run(() => api.patchTask(t.id, { type: e.target.value as typeof t.type }))}>
          {TASK_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select className={`${inputCls} w-auto! font-mono text-[12px]`} value={t.priority} onChange={(e) => run(() => api.patchTask(t.id, { priority: e.target.value as typeof t.priority }))}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].title}</option>)}
        </select>
        {t.labels.map((l) => (
          <Chip key={l} className="border-ink-600 text-ink-200 normal-case">
            {l}
            <button className="ml-1 cursor-pointer text-ink-500 hover:text-rust" onClick={() => run(() => api.patchTask(t.id, { labels: t.labels.filter((x) => x !== l) }))}>×</button>
          </Chip>
        ))}
        <Button size="sm" onClick={() => setRefining(true)} title="Claude rewrites this into a spec with checkable outcomes, and proposes subtasks">✧ Improve</Button>
      </div>
      {sug && (sug.priority !== t.priority || sug.type !== t.type) ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-2 text-[12.5px] text-ink-200">
          <span className="text-cyan">Claude suggests</span>
          <span className="font-mono">{sug.type} · {sug.priority}</span>
          <span className="text-ink-500">({Math.round((sug.confidence ?? 0) * 100)}% sure)</span>
          <Button size="sm" variant="go" onClick={() => run(() => api.acceptSuggestion(t.id, { fields: true }))}>Accept</Button>
          <Button size="sm" variant="ghost" onClick={() => run(() => api.patchTask(t.id, { suggestion: null } as never))}>Dismiss</Button>
        </div>
      ) : null}
      {/* The board sizes the pipeline to the task, but never applies it: the wrong guess here costs money. */}
      {sug?.pipeline?.length && !samePipeline(sug.pipeline, t.pipeline) ? (
        <div className="rounded-lg border border-amber/40 bg-amber/5 px-3 py-2 text-[12.5px]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-amber">Claude sized this task</span>
            <span className="font-mono text-[11.5px] text-ink-200">
              {sug.pipeline.map((st) => `${st.stage} ${modelLabel(st)}/${st.effort}`).join("  →  ")}
            </span>
          </div>
          {sug.sizing_reason ? <div className="mb-1.5 text-ink-300">{sug.sizing_reason}</div> : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-ink-500">
              now: {t.pipeline.map((st) => `${st.stage} ${modelLabel(st)}/${st.effort}`).join(" → ")}
            </span>
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="go" busy={d.busy} onClick={() => run(() => api.acceptSuggestion(t.id, { pipeline: true }))}>Use it</Button>
              <Button size="sm" variant="ghost" onClick={() => run(() => api.patchTask(t.id, { suggestion: null } as never))}>Keep default</Button>
            </span>
          </div>
        </div>
      ) : null}
      {refining ? <RefineModal taskId={t.id} onClose={() => setRefining(false)} onApplied={() => undefined} /> : null}
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-500">
            Mode <ModeHelp />
          </div>
          <div className="flex gap-1.5">
            {(["supervised", "autonomous"] as Mode[]).map((m) => (
              <button
                key={m}
                disabled={d.busy || (m === "autonomous" && !!blocked) || t.mode === m}
                title={m === "autonomous" && blocked ? blocked : undefined}
                onClick={() => run(() => api.patchTask(t.id, { mode: m }))}
                className={`rounded border px-2 py-1 font-mono text-[11px] cursor-pointer disabled:cursor-default ${
                  t.mode === m ? (m === "autonomous" ? "border-amber/60 bg-amber/10 text-amber" : "border-cyan/60 bg-cyan/10 text-cyan") : "border-ink-700 text-ink-400 hover:text-ink-200 disabled:opacity-40"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-500">Workspace</div>
          <div className="font-mono text-[11.5px] text-ink-300">
            {t.branch ? (
              <>
                <div className="text-amber">{t.branch}</div>
                <div className="truncate text-ink-500" title={t.worktree_path ?? ""}>{t.worktree_path}</div>
              </>
            ) : t.mode === "autonomous" ? (
              blocked ? <span className="text-rust">{blocked}</span> : "worktree created on first run"
            ) : (
              "main checkout"
            )}
          </div>
          {d.staleness && d.staleness.behind > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-slate/40 bg-slate/5 px-2 py-1.5 text-[11.5px] text-slate">
              <span>
                {d.staleness.behind} commit{d.staleness.behind === 1 ? "" : "s"} landed on{" "}
                <span className="font-mono">{d.staleness.base}</span> since this started
              </span>
              <Button
                size="sm"
                busy={busy}
                disabled={d.busy}
                title={d.busy ? "Wait for the run to finish" : `Merge ${d.staleness.base} into this task's worktree now`}
                onClick={() => run(() => api.updateFromBase(t.id))}
              >
                Update it
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {d.parent ? (
        <div className="text-[12px] text-ink-400">
          Subtask of{" "}
          <button className="text-amber hover:underline cursor-pointer" onClick={() => navigate({ taskId: d.parent!.id })}>{d.parent.title}</button>
        </div>
      ) : null}
      {t.related_to.length ? (
        <div className="text-[12px] text-ink-400">
          Related:{" "}
          {t.related_to.map((id, i) => (
            <span key={id}>
              {i ? ", " : ""}
              <button className="text-amber hover:underline cursor-pointer" onClick={() => navigate({ taskId: id })}>{id}</button>
            </span>
          ))}
          <div className="mt-0.5 text-[11.5px] text-ink-500">Runs get these as context and can read them with board_get_task.</div>
        </div>
      ) : null}
      {t.depends_on.length ? (
        <div className="text-[12px] text-ink-400">
          Waiting on:{" "}
          {t.depends_on.map((id, i) => (
            <span key={id}>
              {i ? ", " : ""}
              <button className="text-amber hover:underline cursor-pointer" onClick={() => navigate({ taskId: id })}>{id}</button>
            </span>
          ))}
        </div>
      ) : null}
      {t.skills.length ? (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-500">Skills</div>
          <div className="flex flex-wrap gap-1.5">
            {t.skills.map((s) => (
              <Chip key={s} className="border-ink-600 text-ink-200 normal-case">
                {s}
                <button className="ml-1 text-ink-500 hover:text-rust cursor-pointer" onClick={() => run(() => api.patchTask(t.id, { skills: t.skills.filter((x) => x !== s) }))}>×</button>
              </Chip>
            ))}
          </div>
        </div>
      ) : null}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-ink-500">Spec</div>
          {editing ? (
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => (setSpec(t.spec_md), setEditing(false))}>Cancel</Button>
              <Button size="sm" variant="primary" busy={busy} onClick={() => run(async () => (await api.patchTask(t.id, { spec_md: spec }), setEditing(false)))}>Save</Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
          )}
        </div>
        {editing ? (
          <textarea className={`${inputCls} min-h-[260px] font-mono text-[12.5px]`} value={spec} onChange={(e) => setSpec(e.target.value)} autoFocus />
        ) : t.spec_md.trim() ? (
          <Markdown text={t.spec_md} />
        ) : (
          <Empty>No spec yet — the title is all Claude gets. Click Edit.</Empty>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

function PipelineTab({ d }: { d: TaskDetail }) {
  const { settings } = useAppData();
  const [value, setValue] = useState<Stage[]>(d.task.pipeline);
  const { busy, error, run } = useAction();
  useEffect(() => setValue(d.task.pipeline), [d.task.pipeline]);
  const dirty = JSON.stringify(value) !== JSON.stringify(d.task.pipeline);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-400">
        Each stage is its own session with its own model, and the previous stage's result is handed to the next. The first box
        is <b className="text-ink-300">where it runs</b>: Claude, or any provider you added in Settings → Providers. A plan stage
        can also be <b className="text-iris">debated</b> — a second model critiques it and you pick the plan before code starts.
      </p>
      <PipelineEditor value={value} onChange={setValue} models={settings?.models ?? []} />
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        {dirty ? <Button variant="ghost" onClick={() => setValue(d.task.pipeline)}>Reset</Button> : null}
        <Button variant="primary" busy={busy} disabled={!dirty || d.busy} title={d.busy ? "Stop the task to edit its pipeline" : undefined} onClick={() => run(() => api.patchTask(d.task.id, { pipeline: value }))}>
          Save pipeline
        </Button>
      </div>
    </div>
  );
}

function TranscriptTab({ d, chat }: { d: TaskDetail; chat?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const latest = d.runs.at(-1);
  const runId = chat ? latest?.id : selected ?? latest?.id;
  const run = d.runs.find((r) => r.id === runId);
  const [text, setText] = useState("");
  const { busy, error, run: act } = useAction();
  if (!d.runs.length) return <Empty>No runs yet. Queue the task to start its first stage.</Empty>;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {!chat ? (
        <div className="flex flex-wrap gap-1.5">
          {d.runs.map((r, i) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={`rounded-md border px-2 py-1 text-left font-mono text-[11px] cursor-pointer ${r.id === runId ? "border-amber/60 bg-amber/10" : "border-ink-700 hover:border-ink-500"}`}
            >
              <span className="text-ink-500">#{i + 1}</span> <span className="text-ink-100">{r.stage}</span>{r.role === "critic" ? <span className="text-iris"> critic</span> : null}{" "}
              <span className={r.provider ? "text-iris" : "text-ink-400"}>{modelLabel(r)}</span>{" "}
              <span className={RUN_TONE[r.status]}>{r.status}</span> <span className="text-ink-500">{costLabel(r)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-ink-400">
          Follow-up chat resumes the latest session (<span className="font-mono">{run?.stage} · {run && modelLabel(run)}</span>) with your message.
        </div>
      )}
      {run?.error ? <div className="font-mono text-[11.5px] text-rust">{run.error}</div> : null}
      <div className="min-h-0 flex-1">{runId ? <Transcript runId={runId} meta={run} /> : null}</div>
      {chat ? (
        <form
          className="flex gap-2 border-t border-ink-800 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void act(async () => {
              await api.chat(d.task.id, text);
              setText("");
            });
          }}
        >
          <textarea
            className={`${inputCls} min-h-[44px] flex-1`}
            placeholder={d.busy ? "Wait for the current run to finish…" : "Continue this session… (Ctrl+Enter to send)"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }}
          />
          <Button type="submit" variant="primary" busy={busy} disabled={d.busy || !latest?.session_id}>Send</Button>
        </form>
      ) : null}
      {chat ? <ErrorLine error={error} /> : null}
    </div>
  );
}

function SubtasksTab({ d }: { d: TaskDetail }) {
  const { projects } = useAppData();
  const project = projects.find((p) => p.id === d.task.project_id);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const { busy, error, run } = useAction();
  const done = new Set(d.children.filter((c) => c.status === "done").map((c) => c.id));
  const titles = new Map(d.children.map((c) => [c.id, c.title]));
  /** Only the children whose dependencies are all finished can start now. */
  const ready = d.children.filter((c) => c.status === "backlog" && c.depends_on.every((x) => done.has(x)));
  const pct = d.children.length ? Math.round((done.size / d.children.length) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-[200px] flex-1 text-[12px] text-ink-400">
          A Plan stage can split this task with <span className="font-mono text-cyan">board_create_subtasks</span>; children see this spec and each other's progress.
        </p>
        {d.children.length ? (
          <div className="flex rounded-md border border-ink-700">
            {(["list", "graph"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-2 py-1 font-mono text-[11px] transition-colors cursor-pointer ${view === v ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
              >
                {v}
              </button>
            ))}
          </div>
        ) : null}
        {ready.length ? (
          <Button size="sm" busy={busy} onClick={() => run(async () => { for (const c of ready) await api.queue(c.id); })} title="Queues only the subtasks whose dependencies are done">
            Queue {ready.length} ready
          </Button>
        ) : null}
        <Button size="sm" onClick={() => setCreating(true)}>+ Subtask</Button>
      </div>
      <ErrorLine error={error} />
      {d.children.length ? (
        <div className="flex items-center gap-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-moss transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-[11px] text-ink-400">{done.size}/{d.children.length} done</span>
        </div>
      ) : null}
      {!d.children.length ? (
        <Empty>No subtasks.</Empty>
      ) : view === "graph" ? (
        <div className="h-[420px] rounded-lg border border-ink-800 bg-ink-900/50">
          <DepGraph tasks={d.children} />
        </div>
      ) : (
        d.children.map((c) => {
          const waiting = c.depends_on.filter((x) => !done.has(x));
          return (
            <button
              key={c.id}
              onClick={() => navigate({ taskId: c.id })}
              className={`flex w-full items-start gap-2.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-left hover:border-ink-500 cursor-pointer ${waiting.length ? "opacity-70" : ""}`}
            >
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_META[c.status].dot}`} />
              <div className="min-w-0 flex-1">
                <div className={`text-[13px] ${c.status === "done" ? "text-ink-400 line-through" : "text-ink-100"}`}>{c.title}</div>
                {waiting.length ? (
                  <div className="truncate text-[11.5px] text-slate">waits for {waiting.map((x) => titles.get(x) ?? x).join(", ")}</div>
                ) : c.summary ? (
                  <div className="truncate text-[11.5px] text-ink-400">{c.summary}</div>
                ) : null}
              </div>
              <span className={`font-mono text-[10.5px] ${STATUS_META[c.status].text}`}>{c.status}</span>
              <ModeChip mode={c.mode} />
            </button>
          );
        })
      )}
      {creating && project ? <NewTaskForm project={project} parentId={d.task.id} milestoneId={d.task.milestone_id} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function MessagesTab({ d }: { d: TaskDetail }) {
  if (!d.messages.length) return <Empty>No messages. Runs post here with <span className="font-mono text-cyan">board_post_message</span>.</Empty>;
  return (
    <div className="space-y-2">
      {d.messages.map((m) => {
        const inbound = m.task_id === d.task.id;
        return (
          <div key={m.id} className={`rounded-lg border px-3 py-2 ${inbound ? "border-cyan/30 bg-cyan/5" : "border-ink-700 bg-ink-850"}`}>
            <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] text-ink-500">
              <span className={inbound ? "text-cyan" : "text-ink-300"}>{inbound ? `← from ${m.from_task_id ?? "you"}` : `→ to ${m.task_id}`}</span>
              <span className="ml-auto">{ago(m.ts)}</span>
            </div>
            <div className="text-[13px] text-ink-200 whitespace-pre-wrap">{m.body}</div>
          </div>
        );
      })}
    </div>
  );
}

function Actions({ d }: { d: TaskDetail }) {
  const t = d.task;
  const { settings } = useAppData();
  const { busy, error, setError, run } = useAction();
  const [stageIdx, setStageIdx] = useState<number | "">("");
  const hasWork = !!(t.branch || t.worktree_path);
  const live = d.busy;
  const retry = () => run(() => api.retry(t.id, stageIdx === "" ? undefined : stageIdx));
  return (
    <div className="border-b border-ink-800 px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {t.status === "backlog" && !live ? (
          <>
            <Button variant="primary" busy={busy} onClick={() => run(() => api.queue(t.id))}>▶ Queue</Button>
            {settings?.serial ? (
              <Button
                busy={busy}
                onClick={() => run(() => api.queue(t.id, true))}
                title="Start it now, beside whatever is already running, instead of taking its turn. It still waits for a Claude usage window if one is shut."
              >
                ⇥ Run now
              </Button>
            ) : null}
          </>
        ) : null}
        {live ? <Button variant="danger" busy={busy} onClick={() => run(() => api.stop(t.id))}>■ Stop</Button> : null}
        {t.status === "review" && !live ? (
          <>
            <Button variant="go" busy={busy} onClick={() => run(() => api.approve(t.id))} title={t.mode === "autonomous" ? `Merge ${t.branch} --no-ff into the project's current branch` : "Mark done"}>
              ✓ Approve{t.mode === "autonomous" && t.branch ? " & merge" : ""}
            </Button>
            <Button busy={busy} onClick={() => { const note = prompt("Why? (kept on the card; the worktree is kept)"); if (note !== null) void run(() => api.reject(t.id, note || null)); }}>Reject</Button>
          </>
        ) : null}
        {(t.status === "failed" || t.status === "review") && !live ? (
          <div className="flex items-center gap-1">
            <select className={`${inputCls} h-8 w-auto! py-0 font-mono text-[12px]`} value={stageIdx} onChange={(e) => setStageIdx(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">{t.status === "failed" ? "failed stage" : "stage…"}</option>
              {t.pipeline.map((s, i) => (
                <option key={i} value={i}>from #{i + 1} {s.stage}</option>
              ))}
            </select>
            <Button busy={busy} onClick={retry}>↻ Retry</Button>
          </div>
        ) : null}
        {t.status === "failed" && !live ? <Button variant="ghost" busy={busy} onClick={() => run(() => api.reject(t.id, null))}>Back to backlog</Button> : null}
        {["done", "review"].includes(t.status) && !live ? (
          <Button
            busy={busy}
            title="Start a fresh task that carries this one's outcome — better than reopening an old session days later"
            onClick={() => {
              const note = prompt("What's wrong or what's next? (goes into the new task's spec)");
              if (note === null) return;
              void run(async () => {
                const created = await api.followUp(t.id, { note: note || undefined });
                navigate({ taskId: created.id });
              });
            }}
          >
            ↪ Follow-up task
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          {hasWork && !live ? (
            <Button variant="danger" busy={busy} onClick={() => confirm(`Discard ${t.branch}? Removes the worktree and deletes the branch with its changes.`) && run(() => api.discard(t.id))}>
              Discard work
            </Button>
          ) : null}
          {!live && !hasWork ? (
            <Button variant="ghost" busy={busy} onClick={() => confirm(`Delete "${t.title}"?`) && run(async () => { await api.deleteTask(t.id); navigate({ taskId: null }); })}>
              Delete
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-rust/40 bg-rust/10 px-3 py-2 text-[12.5px] text-rust">
          <span className="flex-1">{error}</span>
          <button className="cursor-pointer" onClick={() => setError(null)}>×</button>
        </div>
      ) : null}
    </div>
  );
}

function TitleEditor({ d }: { d: TaskDetail }) {
  const [title, setTitle] = useState(d.task.title);
  useEffect(() => setTitle(d.task.title), [d.task.title]);
  return (
    <input
      className="w-full bg-transparent text-[17px] font-semibold tracking-tight text-ink-100 focus:outline-none"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => title.trim() && title !== d.task.title && void api.patchTask(d.task.id, { title })}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

export function TaskDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { detail: d, missing, reload } = useTaskDetail(taskId);
  const [tab, setTab] = useState<Tab | null>(null);
  const [showCost, setShowCost] = useState(false);
  const pending = d?.approvals.filter((a) => !a.decision) ?? [];
  const current: Tab = tab ?? (d?.task.plan_gate ? "spec" : pending.length ? "approvals" : d && ["planning", "running"].includes(d.task.status) ? "transcript" : "spec");

  useEffect(() => setTab(null), [taskId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const totalCost = d?.runs.reduce((s, r) => s + r.cost_usd, 0) ?? 0;
  // Time actually spent running, not wall-clock since the first attempt.
  const workedMs = d?.runs.reduce((s, r) => s + Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.started_at)), 0) ?? 0;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink-950/50" onMouseDown={onClose}>
      <aside className="slide-in flex h-full w-[min(780px,100vw)] flex-col border-l border-ink-700 bg-ink-900 shadow-2xl shadow-black/70" onMouseDown={(e) => e.stopPropagation()}>
        {!d ? (
          <div className="p-6 text-[13px] text-ink-400">{missing ? "This task no longer exists." : "Loading…"}</div>
        ) : (
          <>
            <div className="flex items-start gap-3 border-b border-ink-800 px-5 pt-4 pb-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${STATUS_META[d.task.status].dot} ${d.busy ? "breathe" : ""}`} />
                  <span className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${STATUS_META[d.task.status].text}`}>{STATUS_META[d.task.status].label}</span>
                  <ModeChip mode={d.task.mode} />
                  <Chip className={PRIORITY_META[d.task.priority].tone} title={PRIORITY_META[d.task.priority].title}>{d.task.priority}</Chip>
                  <Chip className={TYPE_META[d.task.type].tone}>{TYPE_META[d.task.type].short}</Chip>
                  <span className="font-mono text-[10.5px] text-ink-500">{d.task.id}</span>
                  <button
                    className={`ml-auto cursor-pointer rounded border px-1.5 py-px font-mono text-[11px] transition-colors ${
                      showCost ? "border-amber/60 text-amber" : "border-transparent text-ink-400 hover:border-ink-600 hover:text-ink-200"
                    }`}
                    onClick={() => setShowCost((v) => !v)}
                    title="Tokens, cost per stage, and how much of the five-hour window this task used"
                  >
                    {cost(totalCost)}
                    {workedMs > 0 ? ` · ${duration(workedMs)}` : ""}
                  </button>
                </div>
                <TitleEditor d={d} />
                {d.task.error && d.task.status === "failed" ? <div className="mt-1 font-mono text-[11.5px] text-rust">{d.task.error}</div> : null}
                {d.task.note ? <div className="mt-1 text-[12px] italic text-ink-400">Note: {d.task.note}</div> : null}
              </div>
              <button className="text-xl leading-none text-ink-400 hover:text-ink-100 cursor-pointer" onClick={onClose} aria-label="Close">×</button>
            </div>
            {showCost ? <div className="border-b border-ink-800 px-5 py-3"><CostPanel runs={d.runs} /></div> : null}
            {d.task.plan_gate ? <PlanGate d={d} /> : null}
            <Actions d={d} />
            <nav className="flex shrink-0 gap-0.5 overflow-x-auto overflow-y-hidden border-b border-ink-800 px-3">
              {TABS.map((t) => {
                const badge = t === "approvals" ? pending.length : t === "subtasks" ? d.children.length : t === "files" ? d.attachments.length : t === "messages" ? d.messages.length : t === "transcript" ? d.runs.length : 0;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`relative whitespace-nowrap px-3 py-2.5 text-[12.5px] capitalize transition-colors cursor-pointer ${current === t ? "text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
                  >
                    {t}
                    {badge ? <span className={`ml-1.5 font-mono text-[10.5px] ${t === "approvals" ? "text-rose" : "text-ink-500"}`}>{badge}</span> : null}
                    {current === t ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-amber" /> : null}
                  </button>
                );
              })}
            </nav>
            <div className={`min-h-0 flex-1 px-5 py-4 ${current === "transcript" || current === "chat" ? "flex flex-col" : "overflow-y-auto"}`}>
              {current === "spec" ? <SpecTab d={d} /> : null}
              {current === "pipeline" ? <PipelineTab d={d} /> : null}
              {current === "transcript" ? <TranscriptTab d={d} /> : null}
              {current === "chat" ? <TranscriptTab d={d} chat /> : null}
              {current === "approvals" ? (
                <div className="space-y-3">
                  {pending.map((a) => <PendingApproval key={a.id} a={a} />)}
                  {!pending.length ? <Empty>Nothing waiting. Supervised runs ask here before every write.</Empty> : null}
                  {d.approvals.filter((a) => a.decision).reverse().map((a) => (
                    <div key={a.id} className="flex items-center gap-2 rounded-md border border-ink-800 px-3 py-1.5 font-mono text-[11.5px]">
                      <span className={a.decision === "allow" ? "text-moss" : a.decision === "deny" ? "text-rust" : "text-ink-500"}>{a.decision}</span>
                      <span className="text-ink-200">{a.tool_name}</span>
                      <span className="truncate text-ink-400">{a.title}</span>
                      {a.note ? <span className="truncate text-ink-500 italic">“{a.note}”</span> : null}
                      <span className="ml-auto text-ink-500">{ago(a.created_at)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {current === "diff" ? <DiffView taskId={d.task.id} refreshKey={`${d.runs.length}-${d.task.status}-${d.task.updated_at}`} /> : null}
              {current === "subtasks" ? <SubtasksTab d={d} /> : null}
              {current === "files" ? <Gallery taskId={d.task.id} attachments={d.attachments} onChange={reload} /> : null}
              {current === "messages" ? <MessagesTab d={d} /> : null}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
