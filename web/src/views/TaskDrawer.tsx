import { SetupCard } from "../components/RunSetup.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Approval, Stage, TaskRound } from "../../../server/src/types.ts";
import { IMAGE_TOOL, runStyleFields, runStyleOf, stoppedBy } from "../../../server/src/types.ts";
import { api, type TaskDetail } from "../lib/api.ts";
import { useWs, useWsReconnect, watchTask } from "../lib/ws.ts";
import { navigate } from "../lib/router.ts";
import { memoryLine, useTaskMemory } from "../lib/memory.ts";
import { MEMORY_WARM_MIN } from "../../../server/src/engine/memory.ts";
import { ConflictPanel } from "../components/ConflictPanel.tsx";
import { ScheduleModal, startLabel } from "../components/SchedulesPanel.tsx";
import { QuestionCard, QuestionHistory } from "../components/QuestionCard.tsx";
import { isQuestion } from "../lib/questions.ts";
import { openTerminal } from "../lib/terminal.ts";
import { LiveBrowser, useBrowserLive } from "../components/LiveBrowser.tsx";
import { useAppData } from "../lib/store.tsx";
import { Markdown } from "../lib/markdown.tsx";
import { ago, cost, costLabel, duration, modelLabel, PRIORITY_META, shortModel, STATUS_META, TYPE_META } from "../lib/format.ts";
import type { Stage as PipelineStage } from "../../../server/src/types.ts";
import { PRIORITIES, TASK_TYPES } from "../../../server/src/types.ts";
import { RefineModal } from "../components/RefineModal.tsx";
import { SpecSection } from "../components/SpecSection.tsx";
import { Button, Chip, Empty, ErrorLine, inputCls, ModeChip, ModeHelp, RunStyleSwitch, Select, useAction, useEscape, useFocusTrap } from "../components/ui.tsx";
import { PipelineEditor, pipelineLine } from "../components/PipelineEditor.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { DepGraph } from "../components/DepGraph.tsx";
import { Gallery } from "../components/Gallery.tsx";
import { CostPanel } from "../components/CostPanel.tsx";
import { PlanGate } from "../components/PlanGate.tsx";
import { SafetyOptions } from "../components/SafetyOptions.tsx";
import { OutOfUsage } from "../components/OutOfUsage.tsx";
import { autonomousBlocked, autonomousInFolder, branchBlocked, lookupAutoBlocked, NewTaskForm } from "../components/forms.tsx";
import { AlwaysAllow } from "../components/AlwaysAllow.tsx";
import { isAnswerPipeline } from "../../../server/src/engine/answer.ts";
import { useAsk } from "../components/Ask.tsx";
import { BlockedPanel, CheckoutNote, QuestionsPanel, ResultPanel, hasResult } from "../components/Outcome.tsx";
import { CredentialWarning } from "../components/CredentialWarning.tsx";
import { CommandExplainer, CommandList, useTaskCommands } from "../components/CommandExplainer.tsx";
import { ChecklistPanel } from "../components/Checklist.tsx";
import { RunSuggestions } from "../components/Suggestions.tsx";
import { DependsOn } from "../components/DependsOn.tsx";
import { effortsFor, useClaudeModels } from "../lib/claudeModels.ts";

type Tab = "result" | "spec" | "plan" | "pipeline" | "activity" | "commands" | "approvals" | "browser" | "diff" | "subtasks" | "files" | "messages";
/** Result is listed only once there is one (D347); Activity is the live stream of what the task does, with the box to talk to it. */
const TABS: Tab[] = ["result", "spec", "plan", "pipeline", "activity", "commands", "approvals", "browser", "diff", "subtasks", "files", "messages"];
const TAB_LABEL: Record<Tab, string> = {
  result: "Result", spec: "Spec", plan: "Plan", pipeline: "Pipeline", activity: "Activity", commands: "Commands",
  approvals: "Approvals", browser: "Browser", diff: "Changes", subtasks: "Subtasks", files: "Files", messages: "Messages",
};
const TAB_HINT: Partial<Record<Tab, string>> = {
  result: "What it delivered: the report, with the review's verdict",
  activity: "Everything it does as it works, step by step, and a box to talk to it",
  diff: "The files it changed, line by line",
};

/** Open a task's drawer on a given tab (the board's "live" chip opens the Browser tab). */
let requestedTab: { taskId: string; tab: Tab } | null = null;
export function openTaskOn(taskId: string, tab: Tab) {
  requestedTab = { taskId, tab };
  navigate({ taskId });
}
const takeRequested = (taskId: string): Tab | null => {
  const t = requestedTab?.taskId === taskId ? requestedTab.tab : null;
  requestedTab = null;
  return t;
};

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
  useWsReconnect(load);
  const shown = useRef(detail);
  shown.current = detail;
  useWs((m) => {
    // A running stage reports its context size on nearly every message. That is one number on one
    // run, so it is put in place here; asking for the whole task again each time also ran git twice
    // on the server, several times a second. A change of status still reloads: it moves other things.
    if (m.type === "run.updated" && m.run.task_id === taskId && shown.current?.runs.find((r) => r.id === m.run.id)?.status === m.run.status) {
      setDetail((d) => d && { ...d, runs: d.runs.map((r) => (r.id === m.run.id ? m.run : r)) });
      return;
    }
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
  if (a.tool_name === IMAGE_TOOL)
    return (
      <div className="rounded bg-ink-950 px-2.5 py-2 text-[11px] text-ink-200">
        <div className="mb-0.5 text-[11px] uppercase tracking-wide text-ink-500">Make an image with the picture maker in Settings → Images</div>
        <div className="whitespace-pre-wrap">{String(input.prompt ?? "")}</div>
        <div className="mt-1 font-mono text-[11.5px] text-ink-400">
          → {String(input.file ?? "generated-images/…")}{input.width || input.height ? ` · ${input.width ?? 1024}×${input.height ?? 1024}` : ""}
        </div>
      </div>
    );
  if (typeof input.command === "string" && (a.tool_name === "Bash" || a.tool_name === "PowerShell"))
    return (
      <div>
        <CommandExplainer command={input.command} open />
        <pre className="rounded bg-ink-950 px-2.5 py-2 font-mono text-[11px] text-amber whitespace-pre-wrap">$ {input.command}</pre>
      </div>
    );
  if (a.tool_name === "Write")
    return (
      <div>
        <div className="font-mono text-[11px] text-ink-100">{input.file_path}</div>
        <pre className="mt-1 max-h-56 overflow-auto rounded bg-ink-950 px-2.5 py-2 font-mono text-[11.5px] text-[var(--kb-diff-add)] whitespace-pre-wrap">{String(input.content ?? "")}</pre>
      </div>
    );
  if (a.tool_name === "Edit")
    return (
      <div className="space-y-1">
        <div className="font-mono text-[11px] text-ink-100">{input.file_path}</div>
        <pre className="max-h-40 overflow-auto rounded bg-rust/10 px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--kb-diff-del)] whitespace-pre-wrap">{String(input.old_string ?? "")}</pre>
        <pre className="max-h-40 overflow-auto rounded bg-moss/10 px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--kb-diff-add)] whitespace-pre-wrap">{String(input.new_string ?? "")}</pre>
      </div>
    );
  return <pre className="max-h-56 overflow-auto rounded bg-ink-950 px-2.5 py-2 font-mono text-[11.5px] text-ink-300 whitespace-pre-wrap">{JSON.stringify(input, null, 2)}</pre>;
}

function PendingApproval({ a }: { a: Approval }) {
  if (isQuestion(a)) return <QuestionCard a={a} focused />;
  return <PendingToolApproval a={a} />;
}

function PendingToolApproval({ a }: { a: Approval }) {
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  return (
    <div className="rise rounded-lg border border-rose/50 bg-rose/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="pulse-rose inline-block h-2 w-2 rounded-full bg-rose" />
        <span className="font-mono text-[11px] font-semibold text-rose">{a.tool_name}</span>
        <span className="truncate text-[11.5px] text-ink-200">{a.title === a.tool_name ? "" : a.title}</span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-500">{ago(a.created_at)}</span>
      </div>
      <CredentialWarning a={a} />
      <ApprovalInput a={a} />
      <div className="mt-2.5 flex items-center gap-2">
        <input className={inputCls} placeholder="Note to Claude (optional, sent with Deny)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="danger" busy={busy} onClick={() => run(() => api.decide(a.id, "deny", note))}>Deny</Button>
        <AlwaysAllow a={a} busy={busy} run={run} />
        <Button variant="go" busy={busy} onClick={() => run(() => api.decide(a.id, "allow", note))}>Allow</Button>
      </div>
      <div className="mt-2"><ErrorLine error={error} /></div>
    </div>
  );
}

function SpecTab({ d }: { d: TaskDetail }) {
  const { projects, settings } = useAppData();
  const project = projects.find((p) => p.id === d.task.project_id);
  const { busy, error, run } = useAction();
  // A lookup needs no worktree: what decides is the project's autonomous access (D352).
  const blocked = project ? (isAnswerPipeline(d.task.pipeline) ? lookupAutoBlocked(project) : autonomousBlocked(project)) : null;
  const branchBlockedReason = project ? branchBlocked(project) : null;
  const [refining, setRefining] = useState(false);
  const t = d.task;
  const sug = t.suggestion;
  return (
    <div className="space-y-5">
      {t.setup_pending && t.status === "backlog" && project ? <SetupCard card={t} project={project} /> : null}
      <CheckoutNote d={d} />
      <ConflictPanel t={t} busy={d.busy} />
      <div className="flex flex-wrap items-center gap-2">
        <Select className="font-mono text-[11px]" aria-label="Type" value={t.type} onChange={(e) => run(() => api.patchTask(t.id, { type: e.target.value as typeof t.type }))}>
          {TASK_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
        </Select>
        <Select className="font-mono text-[11px]" aria-label="Priority" title={PRIORITY_META[t.priority].title} value={t.priority} onChange={(e) => run(() => api.patchTask(t.id, { priority: e.target.value as typeof t.priority }))}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].short}</option>)}
        </Select>
        {t.labels.map((l) => (
          <Chip key={l} className="border-ink-600 text-ink-200 normal-case">
            {l}
            <button className="ml-1 cursor-pointer text-ink-500 hover:text-rust" onClick={() => run(() => api.patchTask(t.id, { labels: t.labels.filter((x) => x !== l) }))} aria-label={`Remove the label ${l}`}>×</button>
          </Chip>
        ))}
        <Button size="sm" onClick={() => setRefining(true)} title="Quick intake: a cheap model tidies the request, suggests type and priority, and proposes subtasks. For a deeper spec that reads the code, use ✦ Rewrite on the Spec below.">✧ Improve</Button>
      </div>
      {sug && (sug.priority !== t.priority || sug.type !== t.type) ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-2 text-[11.5px] text-ink-200">
          <span className="text-cyan">Claude suggests</span>
          <span className="font-mono">{sug.type} · {sug.priority}</span>
          <span className="text-ink-500">({Math.round((sug.confidence ?? 0) * 100)}% sure)</span>
          <Button size="sm" variant="go" onClick={() => run(() => api.acceptSuggestion(t.id, { fields: true }))}>Accept</Button>
          <Button size="sm" variant="ghost" onClick={() => run(() => api.dismissSuggestion(t.id, { fields: true }))}>Dismiss</Button>
        </div>
      ) : null}
      {/* A task that needs a live system cannot be done from an autonomous run's sandbox (D191). */}
      {sug?.mode && sug.mode !== t.mode && t.status === "backlog" && !d.busy ? (
        <div className="rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-2 text-[11.5px]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-cyan">Claude suggests running this {sug.mode}</span>
          </div>
          {sug.mode_reason ? <div className="mb-1.5 text-ink-300">{sug.mode_reason}</div> : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="go" onClick={() => run(() => api.acceptSuggestion(t.id, { mode: true }))}>Switch to {sug.mode}</Button>
            <Button size="sm" variant="ghost" onClick={() => run(() => api.dismissSuggestion(t.id, { mode: true }))}>Keep {t.mode}</Button>
          </div>
        </div>
      ) : null}
      {/* Is it live, and which models: the same two decisions the side chat shows on its card (D288). */}
      <RunSuggestions t={t} busy={d.busy} />
      {refining ? <RefineModal taskId={t.id} onClose={() => setRefining(false)} onApplied={() => undefined} /> : null}
      <div className="grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-500">
            Mode <ModeHelp />
          </div>
          <RunStyleSwitch
            capitalized
            value={runStyleOf(t)}
            onChange={(m) => run(() => api.patchTask(t.id, runStyleFields(m)))}
            disabled={d.busy}
            blocked={blocked}
          />
          {d.busy ? (
            <div className="mt-1.5 text-[11.5px] leading-snug text-ink-400">
              Mode can't change while it runs: it chose where to work when it started.{" "}
              <button className="cursor-pointer text-amber hover:underline" onClick={() => run(() => api.stop(t.id))}>Stop it to change mode</button>
            </div>
          ) : null}
          {t.mode === "supervised" ? (
            <label className="mt-2 flex cursor-pointer items-start gap-1.5 text-[11.5px] text-ink-300" title={branchBlockedReason ?? undefined}>
              <input
                type="checkbox"
                className="mt-0.5 accent-cyan"
                checked={t.own_branch}
                disabled={d.busy || !!branchBlockedReason || !!t.branch}
                onChange={(e) => run(() => api.patchTask(t.id, { own_branch: e.target.checked }))}
              />
              <span>
                Work on its own branch
                <span className="block text-ink-500">
                  {branchBlockedReason ?? (t.branch ? "Approve or discard its work to change this." : "Its own copy of the project; lands only when you approve.")}
                </span>
              </span>
            </label>
          ) : null}
        </div>
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-500">Workspace</div>
          <div className="font-mono text-[11.5px] text-ink-300">
            {t.branch ? (
              <>
                <div className="text-amber">{t.branch}</div>
                <div className="truncate text-ink-500" title={t.worktree_path ?? ""}>{t.worktree_path}</div>
              </>
            ) : t.in_folder ? (
              "the project folder itself"
            ) : t.mode === "autonomous" && !t.own_branch && !isAnswerPipeline(t.pipeline) && project && autonomousInFolder(project, settings) ? (
              blocked ? <span className="text-rust">{blocked}</span> : "the project folder itself (no worktree)"
            ) : t.mode === "autonomous" || t.own_branch ? (
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
        <div className="text-[11px] text-ink-400">
          Subtask of{" "}
          <button className="text-amber hover:underline cursor-pointer" onClick={() => navigate({ taskId: d.parent!.id })}>{d.parent.title}</button>
        </div>
      ) : null}
      {t.related_to.length ? (
        <div className="text-[11px] text-ink-400">
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
      {/* What this task starts after: it waits in Queued until they are done, then starts with their results (D289–D291). */}
      {t.depends_on.length || ["backlog", "failed"].includes(t.status) ? (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-500">Starts after</div>
          <DependsOn
            projectId={t.project_id}
            selfId={t.id}
            value={t.depends_on}
            editable={t.status !== "done" && t.status !== "running" && t.status !== "planning"}
            onChange={(next) => api.patchTask(t.id, { depends_on: next })}
          />
          {t.depends_on.length ? <div className="mt-1 text-[11.5px] text-ink-500">Queued before they are done, it waits and starts by itself — and is told what they did.</div> : null}
        </div>
      ) : null}
      {t.skills.length ? (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-ink-500">Skills</div>
          <div className="flex flex-wrap gap-1.5">
            {t.skills.map((s) => (
              <Chip key={s} className="border-ink-600 text-ink-200 normal-case">
                {s}
                <button className="ml-1 text-ink-500 hover:text-rust cursor-pointer" onClick={() => run(() => api.patchTask(t.id, { skills: t.skills.filter((x) => x !== s) }))} aria-label={`Remove the skill ${s}`}>×</button>
              </Chip>
            ))}
          </div>
        </div>
      ) : null}
      <SpecSection task={t} busy={d.busy} />
      <ErrorLine error={error} />
    </div>
  );
}

function PipelineTab({ d }: { d: TaskDetail }) {
  const { settings } = useAppData();
  const [value, setValue] = useState<Stage[]>(d.task.pipeline);
  const { busy, error, run } = useAction();
  // Keyed on what the pipeline says, not on the object: every reload of the task brings a new object
  // with the same stages, and that wiped an edit in progress (a suggestion arriving, or ticking a
  // Safety box below, which saves straight away).
  const saved = JSON.stringify(d.task.pipeline);
  useEffect(() => setValue(d.task.pipeline), [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(value) !== saved;
  // While it runs, the steps up to the newest one that started are fixed; the rest can still change (D364).
  const stageRuns = d.runs.filter((r) => r.role === "stage");
  const lockedThrough = d.busy && stageRuns.length ? stageRuns.reduce((a, r) => (r.started_at > a.started_at ? r : a)).stage_index : -1;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-ink-400">
        Each stage is its own session with its own model, and the previous stage's result is handed to the next. The first box
        is <b className="text-ink-300">where it runs</b>: Claude, or any provider you added in Settings → Providers. A plan stage
        can also be <b className="text-iris">debated</b> — a second model critiques it and you pick the plan before code starts.
      </p>
      {d.busy ? (
        <p className="rounded-md border border-amber/30 bg-amber/5 px-2.5 py-1.5 text-[11.5px] text-ink-300">
          It is running: you can change the model and effort of the steps that haven't started yet. They are used when each one starts.
        </p>
      ) : null}
      <PipelineEditor value={value} onChange={setValue} models={settings?.models ?? []} lockedThrough={lockedThrough} />
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        {dirty ? <Button variant="ghost" onClick={() => setValue(d.task.pipeline)}>Reset</Button> : null}
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => run(() => api.patchTask(d.task.id, { pipeline: value }))}>
          Save pipeline
        </Button>
      </div>
      <div className="border-t border-ink-800 pt-3">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-500">Safety</div>
        <SafetyOptions
          live={d.task.live}
          planApproval={d.task.plan_approval}
          settingOn={settings?.planApproval ?? false}
          liveModel={settings?.liveReviewModel ?? "opus"}
          onChange={(v) => void run(() => api.patchTask(d.task.id, v))}
        />
        {d.busy ? <p className="mt-1.5 text-[11.5px] text-ink-500">These two take effect from the next step that starts.</p> : null}
      </div>
    </div>
  );
}

/** The plan the code stage works to, next to the code stage's own report on each of its steps (D229). */
function PlanTab({ d }: { d: TaskDetail }) {
  const ok = d.runs.filter((r) => r.status === "success" && r.role !== "critic" && r.result_md?.trim());
  const plan = [...ok].reverse().find((r) => r.stage === "plan");
  const code = [...ok].reverse().find((r) => r.stage === "code" || r.stage === "custom");
  const steps = code?.result_md ? planStepsOf(code.result_md) : null;
  if (!plan) {
    return <Empty>No plan yet. It appears here when the Plan stage finishes — and, with plan approval on, the task waits here for you before any code is written.</Empty>;
  }
  return (
    <div className="space-y-4">
      {steps ? (
        <section className="rounded-lg border border-moss/30 bg-moss/5 p-3">
          <div className="mb-1.5 text-[11px] uppercase tracking-wider text-moss">What the {code!.stage} stage did with each step · {modelLabel(code!)}</div>
          <Markdown text={steps} className="text-[11.5px]" />
        </section>
      ) : code ? (
        <p className="text-[11px] text-rust">The {code.stage} stage finished without a “Plan steps” checklist — check its result against the plan below.</p>
      ) : null}
      <section>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-500">
          Plan · {modelLabel(plan)} · {ago(plan.ended_at ?? plan.started_at)}
        </div>
        <Markdown text={plan.result_md!} className="text-[11.5px]" />
      </section>
    </div>
  );
}

/** The "## Plan steps" section of a code stage's summary, up to the next heading of the same level. */
function planStepsOf(md: string): string | null {
  const m = /^##\s+Plan steps[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(md);
  return m && m[1].trim() ? m[1].trim() : null;
}

/**
 * Activity: the live stream of what a run does, one run at a time, with the box to talk to the task
 * under it (D347). A message goes to the task's latest session whichever run is on show: a running
 * stage reads it at its next step (D215); a finished one picks its session up again (D9).
 */
function ActivityTab({ d }: { d: TaskDetail }) {
  const [selected, setSelected] = useState<string | null>(null);
  // The session a message continues is the latest stage run's, as the server sees it: a critic's run is not it (D132).
  const latest = [...d.runs].reverse().find((r) => r.role !== "critic") ?? d.runs.at(-1);
  const runId = selected ?? d.runs.at(-1)?.id;
  const run = d.runs.find((r) => r.id === runId);
  const [text, setText] = useState("");
  const { busy, error, run: act } = useAction();
  const canSend = d.busy || Boolean(latest?.session_id);
  const send = () => {
    if (!text.trim()) return;
    void act(async () => {
      await api.chat(d.task.id, text);
      setText("");
    });
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {d.runs.length ? (
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
      ) : null}
      {run?.error ? <div className="font-mono text-[11.5px] text-rust">{run.error}</div> : null}
      <div className="min-h-0 flex-1">
        {runId ? <Transcript runId={runId} meta={run} /> : <Empty>Nothing yet. Start the task and every step it takes shows up here as it works.</Empty>}
      </div>
      <form
        className="border-t border-ink-800 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="mb-1.5 text-[11px] text-ink-400">
          {!d.runs.length ? (
            "Start the task to talk to it: once it runs, what you type here is read at its next step."
          ) : d.busy ? (
            <>
              It is working right now. <b className="text-ink-200">Type what you want it to know</b> — "use the header's blue", "skip the tests for now" — and it reads it at its next step and carries on. Your message shows above once sent.
            </>
          ) : canSend ? (
            <>
              Continue this session (<span className="font-mono">{latest?.stage}{latest ? ` · ${modelLabel(latest)}` : ""}</span>) with your message.
            </>
          ) : (
            "This session cannot be continued from here: queue the task, or use ↪ Follow-up task."
          )}
        </div>
        <div className="flex gap-2">
          <textarea
            className={`${inputCls} min-h-[44px] flex-1`}
            placeholder={!d.runs.length ? "Start the task first" : d.busy ? "Tell it something while it works… (Ctrl+Enter to send)" : "Continue this session… (Ctrl+Enter to send)"}
            value={text}
            disabled={!canSend}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
            }}
          />
          <Button type="submit" variant="primary" busy={busy} disabled={!canSend || !text.trim()}>Send</Button>
        </div>
      </form>
      <ErrorLine error={error} />
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
        <p className="min-w-[200px] flex-1 text-[11px] text-ink-400">
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
                <div className={`text-[12px] ${c.status === "done" ? "text-ink-400 line-through" : "text-ink-100"}`}>{c.title}</div>
                {waiting.length ? (
                  <div className="truncate text-[11.5px] text-slate">waits for {waiting.map((x) => titles.get(x) ?? x).join(", ")}</div>
                ) : c.summary ? (
                  <div className="truncate text-[11.5px] text-ink-400">{c.summary}</div>
                ) : null}
              </div>
              <span className={`font-mono text-[10.5px] ${STATUS_META[c.status].text}`}>{c.status}</span>
              <ModeChip mode={c.mode} mayAsk={c.may_ask} />
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
            <div className="text-[12px] text-ink-200 whitespace-pre-wrap">{m.body}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A card that remembers (D374–D376): how warm its coder's memory is, the rounds it has done, and — on a
 * done card — the next round, or a new card branched from that memory.
 */
function RoundsPanel({ d }: { d: TaskDetail }) {
  const t = d.task;
  const memory = useTaskMemory(t.id, `${t.status}:${t.updated_at}:${d.runs.length}`);
  const [rounds, setRounds] = useState<TaskRound[]>([]);
  useEffect(() => {
    let gone = false;
    api.rounds(t.id).then((r) => !gone && setRounds(r), () => {});
    return () => {
      gone = true;
    };
  }, [t.id, t.round, t.status]);
  const [ask, setAsk] = useState("");
  const [review, setReview] = useState(false);
  const { busy, error, run } = useAction();
  if (!memory || !(t.status === "done" || t.round > 1)) return null;
  const hasReview = t.pipeline.some((st) => st.stage === "review");
  const next = t.round + 1;
  const price = (usd: number | null, w: number) => (usd !== null ? `about $${usd.toFixed(2)}` : `about ${Math.round(w / 1000)}k tokens`);
  const leftMin = memory.warmUntil ? Math.max(0, (Date.parse(memory.warmUntil) - Date.now()) / 60_000) : 0;
  return (
    <div className="border-b border-ink-800 px-5 py-3">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="font-medium text-ink-100">Anything more on this?</span>
        {memory.memory === "warm" && memory.warmUntil ? (
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800" title={memoryLine(memory)}>
            <span className="block h-full rounded-full bg-moss transition-[width] duration-500" style={{ width: `${Math.min(100, (100 * leftMin) / MEMORY_WARM_MIN)}%` }} />
          </span>
        ) : null}
        <span className={`font-mono text-[11px] ${memory.memory === "warm" ? "text-moss" : memory.memory === "cool" ? "text-ink-300" : "text-ink-500"}`}>
          {memory.memory === "warm" ? (memory.warmUntil ? `warm · ${Math.round(leftMin)} min left` : "working") : memory.memory === "cool" ? "cooled" : "gone"}
        </span>
        {memory.memory !== "gone" ? <span className="font-mono text-[11px] text-ink-500" title="How full its memory is, against what its model can hold">{memory.contextPct}% full</span> : null}
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-ink-400">{memoryLine(memory)}</p>
      {rounds.length ? (
        <ol className="mt-2 space-y-0.5 text-[11.5px]">
          <li className="text-ink-400"><span className="font-mono text-ink-500">1</span> · {t.title}</li>
          {rounds.map((r) => (
            <li key={r.id} className="text-ink-300" title={r.fell_back ? "Its session could not be reopened, so this round started fresh with what the card did" : undefined}>
              <span className="font-mono text-ink-500">{r.round}</span> · {r.request}
              <span className="ml-1.5 text-ink-500">{r.landed_at ? "· landed" : r.round === t.round ? `· ${t.status}` : ""}{r.fell_back ? " · started fresh" : ""}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {t.status === "done" && memory.memory !== "gone" ? (
        <div className="mt-2.5 space-y-1.5">
          <textarea
            className={`${inputCls} min-h-[56px] text-[12.5px]`}
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="What else should it do? It picks up where it left off, with everything it already knows about this work."
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !ask.trim()}
              title={`Round ${next} of this same card: its coder carries on in its own session, ${price(memory.continueUsd, memory.continueWeight)}, against ${price(memory.freshUsd, memory.freshWeight)} for a new card finding the same files. It gets its own steps, changes and Approve.`}
              onClick={() => run(async () => {
                await api.startRound(t.id, { request: ask.trim(), review });
                setAsk("");
              })}
            >
              Continue on this card
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !ask.trim()}
              title="For separate work beside this one: a new card that starts with a copy of what this card knows. This card stays as it is."
              onClick={() => run(async () => {
                const created = await api.forkTask(t.id, { request: ask.trim(), review });
                setAsk("");
                navigate({ taskId: created.id });
              })}
            >
              As a new card
            </Button>
            {hasReview ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-300" title="A fresh review of this round's changes after the coder; worth it for new work, not for a small change">
                <input type="checkbox" className="accent-amber" checked={review} onChange={(e) => setReview(e.target.checked)} />
                review it after
              </label>
            ) : null}
            <span className="text-[11px] text-ink-500">
              this card {price(memory.continueUsd, memory.continueWeight)} · new card {price(memory.freshUsd, memory.freshWeight)}
            </span>
          </div>
          <ErrorLine error={error} />
        </div>
      ) : null}
    </div>
  );
}

function Actions({ d }: { d: TaskDetail }) {
  const t = d.task;
  const { settings } = useAppData();
  const { busy, error, setError, run } = useAction();
  const dialog = useAsk();
  const [stageIdx, setStageIdx] = useState<number | "">("");
  // A task in the project folder has work to discard once it has written something (D398).
  const hasWork = !!(t.branch || t.worktree_path || (t.in_folder && t.footprint.touched.length));
  const inFolder = t.in_folder && !t.branch;
  // A done card that still remembers offers "Anything more on this?" above, which covers a follow-up
  // with its memory; a third button doing nearly the same read as a different thing (D406).
  const memory = useTaskMemory(t.id, `${t.status}:${t.updated_at}:${d.runs.length}`);
  const offersMore = t.status === "done" && !!memory && memory.memory !== "gone";
  const { projects } = useAppData();
  const isGit = projects.find((p) => p.id === t.project_id)?.isGit ?? true;
  const live = d.busy;
  const retry = () => run(() => api.retry(t.id, stageIdx === "" ? undefined : stageIdx));
  const reject = async () => {
    const note = await dialog.ask({
      title: "Send it back",
      message: `Why? The reason stays on the card and the next run is told it before anything else. ${inFolder ? "Its changes stay in the project folder." : "The worktree is kept."}`,
      input: { placeholder: "What's wrong or missing" },
      confirmLabel: "Reject",
      danger: true,
    });
    if (note !== null) await run(() => api.reject(t.id, note || null));
  };
  const followUp = async () => {
    const note = await dialog.ask({ title: "Follow-up task", message: "What's wrong or what's next? It goes into the new task's spec.", input: { placeholder: "Optional" }, confirmLabel: "Create follow-up" });
    if (note === null) return;
    await run(async () => {
      const created = await api.followUp(t.id, { note: note || undefined });
      navigate({ taskId: created.id });
    });
  };
  const discard = async () => {
    const message = inFolder
      ? "Puts back every file this task changed in the project folder, as it found them, and deletes the files it created. The card and its note stay."
      : "Removes the worktree and deletes the branch with its changes. The card and its note stay.";
    if (await dialog.confirm({ title: `Discard ${t.branch ?? "this work"}?`, message, confirmLabel: "Discard", danger: true })) {
      await run(() => api.discard(t.id));
    }
  };
  const remove = async () => {
    if (await dialog.confirm({ title: `Delete "${t.title}"?`, message: "The task, its runs and its transcript are removed from the board.", confirmLabel: "Delete", danger: true })) {
      await run(async () => {
        await api.deleteTask(t.id);
        navigate({ taskId: null });
      });
    }
  };
  const [scheduling, setScheduling] = useState(false);
  return (
    <div className="border-b border-ink-800 px-5 py-2.5">
      {dialog.element}
      {/* Right above Approve, so you see whether it is up to date and resolve a conflict here, not on
          another tab (D410). The board keeps Review cards current on its own; this is what is left to do. */}
      {t.status === "review" && !live ? (
        <div className="mb-2 space-y-2">
          <ConflictPanel t={t} busy={d.busy} />
          {d.staleness && d.staleness.behind > 0 && !t.conflict_risk && !t.resolution ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate/40 bg-slate/5 px-3 py-2 text-[11.5px] text-slate">
              <span className="flex-1">{d.staleness.behind} commit{d.staleness.behind === 1 ? "" : "s"} landed on <span className="font-mono">{d.staleness.base}</span> since this started. Approve brings them in; or update now.</span>
              <Button size="sm" busy={busy} disabled={d.busy} onClick={() => run(() => api.updateFromBase(t.id))}>Update it</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {t.status === "backlog" && !live ? (
          <>
            {/* Open on its Spec tab, a card waiting on its setup shows the mode and models right above (D365). */}
            <Button variant="primary" busy={busy} onClick={() => run(() => api.queue(t.id, false, t.setup_pending))}>▶ Queue</Button>
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
        {(t.status === "backlog" || t.status === "failed") && !live ? (
          <Button
            className={t.start_at ? "border-cyan/60 text-cyan" : ""}
            onClick={() => setScheduling(true)}
            title="Start it later: at a time, after your usage limit resets, or on repeating days"
          >
            ⏰ {t.start_at ? startLabel(t.start_at) : "Schedule"}
          </Button>
        ) : null}
        {live ? <Button variant="danger" busy={busy} onClick={() => run(() => api.stop(t.id))}>■ Stop</Button> : null}
        {t.status === "paused" && t.pause_reason === "cost" && !live ? (
          <>
            <Button
              variant="go"
              busy={busy}
              onClick={() => run(() => api.continueTask(t.id))}
              title={`Let it spend up to $${(settings?.maxCostPerStageUsd ?? 0).toFixed(2)} more, in the same session — nothing already done is redone`}
            >
              ▶ Continue (+${(settings?.maxCostPerStageUsd ?? 0).toFixed(2)})
            </Button>
            <Button variant="danger" busy={busy} onClick={() => run(() => api.stopPaused(t.id))} title="Stop here. What it did so far is kept, and Retry is still possible later.">
              ■ Stop
            </Button>
          </>
        ) : null}
        {t.status === "review" && !live ? (
          <>
            <Button
              variant="go"
              busy={busy}
              onClick={() => run(() => api.approve(t.id))}
              title={inFolder ? (isGit ? "Commit exactly the files this task changed, on your current branch" : "Mark done") : t.branch ? `Merge ${t.branch} --no-ff into the project's current branch` : "Mark done"}
            >
              ✓ Approve{inFolder && isGit ? " & commit" : t.branch ? " & merge" : ""}
            </Button>
            <Button busy={busy} onClick={() => void reject()}>Reject</Button>
          </>
        ) : null}
        {(t.status === "failed" || t.status === "review") && !live ? (
          <div className="flex items-center gap-1">
            <Select className="h-8 py-0 font-mono text-[11px]" aria-label="Retry from which stage" value={stageIdx} onChange={(e) => setStageIdx(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">{t.status === "failed" ? "failed stage" : "stage…"}</option>
              {t.pipeline.map((s, i) => (
                <option key={i} value={i}>from #{i + 1} {s.stage}</option>
              ))}
            </Select>
            <Button busy={busy} onClick={retry}>↻ Retry</Button>
          </div>
        ) : null}
        {t.status === "failed" && !live && !stoppedBy(t) ? <Button variant="ghost" busy={busy} onClick={() => run(() => api.reject(t.id, null))}>Back to backlog</Button> : null}
        {["done", "review"].includes(t.status) && !live && !offersMore ? (
          <Button busy={busy} title="Start a fresh task that carries this one's outcome — better than reopening an old session days later" onClick={() => void followUp()}>
            ↪ Follow-up task
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          {d.runs.length ? (
            <a
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[12px] text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
              href={`/api/tasks/${t.id}/record?download=1`}
              title={`Save this task's whole story as one file: what was asked, every stage and step, what it cost and which files changed. The step-by-step detail is removed ${settings?.eventRetentionDays ?? 30} days after a run ends (Settings → Guardrails), so save the record if you want to keep it.`}
            >
              ⤓ Record
            </a>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => openTerminal({ projectId: t.project_id, taskId: t.id })}
            title={t.worktree_path ? "A terminal in this task's own copy of the project (its worktree)" : "A terminal in the project's folder"}
          >
            <span className="font-mono">&gt;_</span> Terminal here
          </Button>
          {hasWork && !live ? (
            <Button variant="danger" busy={busy} onClick={() => void discard()}>
              Discard work
            </Button>
          ) : null}
          {!live && !hasWork ? (
            <Button variant="ghost" busy={busy} onClick={() => void remove()}>
              Delete
            </Button>
          ) : null}
        </div>
      </div>
      {t.status === "paused" && t.pause_reason !== "cost" && !live && settings ? (
        <OutOfUsage
          task={t}
          settings={settings}
          states={t.pipeline.map((_, i) => d.runs.filter((r) => r.stage_index === i && r.role === "stage").at(-1)?.status ?? "idle")}
        />
      ) : null}
      {scheduling ? <ScheduleModal task={t} onClose={() => setScheduling(false)} /> : null}
      {error ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-rust/40 bg-rust/10 px-3 py-2 text-[11.5px] text-rust">
          <span className="flex-1">{error}</span>
          <button className="cursor-pointer" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
    </div>
  );
}

function TitleEditor({ d }: { d: TaskDetail }) {
  const [title, setTitle] = useState(d.task.title);
  const { error, run } = useAction();
  useEffect(() => setTitle(d.task.title), [d.task.title]);
  return (
    <>
      <input
        className="w-full bg-transparent text-[15px] font-semibold tracking-tight text-ink-100 focus:outline-none"
        aria-label="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== d.task.title && void run(() => api.patchTask(d.task.id, { title }))}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      {/* Without this the box kept showing a title that was never saved. */}
      {error ? <div className="mt-1 text-[11px] text-rust">The new title was not saved: {error}</div> : null}
    </>
  );
}

export function TaskDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { detail: d, missing, reload } = useTaskDetail(taskId);
  const [tab, setTab] = useState<Tab | null>(() => takeRequested(taskId));
  const [showCost, setShowCost] = useState(false);
  const pending = d?.approvals.filter((a) => !a.decision) ?? [];
  // For the tab's count; the tab itself keeps its own live list.
  const commands = useTaskCommands(taskId);
  const result = Boolean(d && hasResult(d));
  // Its browser is open and working: the Browser tab pulses blue so you can watch (D420).
  const browsing = useBrowserLive(taskId);
  const current: Tab =
    tab ?? (d?.task.plan_gate ? (d.task.plan_gate.kind === "approval" ? "plan" : "spec") : pending.length ? "approvals" : d && ["planning", "running"].includes(d.task.status) ? "activity" : result ? "result" : "spec");

  // Another task opened in the same drawer: its own default tab, or the one it was opened on.
  const shownTask = useRef(taskId);
  useEffect(() => {
    if (shownTask.current === taskId) return;
    shownTask.current = taskId;
    setTab(takeRequested(taskId));
  }, [taskId]);
  // Escape in a text box is "stop typing", not "close the task and lose what I wrote".
  useEscape((e) => !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) && onClose());
  const box = useFocusTrap<HTMLElement>();

  const totalCost = d?.runs.reduce((s, r) => s + r.cost_usd, 0) ?? 0;
  const creditOut = d?.task.status === "paused" && d.task.pause_reason === "provider" && !d.task.resume_at;
  const costPaused = (d?.task.status === "paused" && d.task.pause_reason === "cost") || creditOut;
  // Time actually spent running, not wall-clock since the first attempt.
  const workedMs = d?.runs.reduce((s, r) => s + Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.started_at)), 0) ?? 0;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[var(--kb-scrim-soft)]" onMouseDown={onClose}>
      <aside
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={d ? `Task: ${d.task.title}` : "Task"}
        className="slide-in flex h-full w-[min(780px,100vw)] flex-col border-l border-ink-700 bg-ink-900 kb-raise focus:outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {!d ? (
          <div className="p-6 text-[12px] text-ink-400">{missing ? "This task no longer exists." : "Loading…"}</div>
        ) : (
          <>
            <div className="flex items-start gap-3 border-b border-ink-800 px-5 pt-4 pb-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${costPaused ? "bg-rose" : STATUS_META[d.task.status].dot} ${d.busy ? "breathe" : ""}`} />
                  <span className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${costPaused ? "text-rose" : STATUS_META[d.task.status].text}`}>
                    {creditOut ? "Needs you · out of credit" : costPaused ? "Needs you · cost" : STATUS_META[d.task.status].label}
                  </span>
                  <ModeChip mode={d.task.mode} ownBranch={d.task.own_branch} lookup={isAnswerPipeline(d.task.pipeline)} mayAsk={d.task.may_ask} />
                  {d.task.live ? <Chip className="border-rose/50 text-rose" title="Touches a live system: plan approval is on and review runs on the live review model">prod</Chip> : null}
                  <Chip className={PRIORITY_META[d.task.priority].tone} title={PRIORITY_META[d.task.priority].title}>{d.task.priority}</Chip>
                  <Chip className={TYPE_META[d.task.type].tone}>{TYPE_META[d.task.type].short}</Chip>
                  <CopyId id={d.task.id} />
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
                {d.task.error && d.task.status === "failed" && !stoppedBy(d.task) ? <div className="mt-1 font-mono text-[11.5px] text-rust">{d.task.error}</div> : null}
                {/* A task that ran out says so in its own panel below, with the ways on. */}
                {/* Not while a strip below says the same thing (a plan to approve): once is enough (D419). */}
                {d.task.note && !d.task.plan_gate && !(d.task.status === "paused" && d.task.pause_reason !== "cost") ? (
                  <div className="mt-1 text-[11px] italic text-ink-400">Note: {d.task.note}</div>
                ) : null}
              </div>
              <button className="text-xl leading-none text-ink-400 hover:text-ink-100 cursor-pointer" onClick={onClose} aria-label="Close">×</button>
            </div>
            {showCost ? <div className="border-b border-ink-800 px-5 py-3"><CostPanel runs={d.runs} /></div> : null}
            {d.task.plan_gate ? <PlanGate d={d} showingPlan={current === "plan"} onShowPlan={() => setTab("plan")} /> : null}
            {/* A suggestion matters only while the work it is about waits on you (D382). */}
            {(stoppedBy(d.task) || (d.task.blocked?.advisory && ["review", "failed"].includes(d.task.status))) && !d.busy ? <BlockedPanel d={d} /> : null}
            <QuestionsPanel d={d} />
            <RoundsPanel d={d} />
            {/* While it works, and after a stop or failure: where it got to. A finished task's list is only noise. */}
            {d.task.checklist?.length && !["done", "review", "backlog"].includes(d.task.status) ? <ChecklistPanel list={d.task.checklist.slice(d.task.checklist_from)} live={d.busy} title={d.task.round > 1 ? `Round ${d.task.round}'s steps` : undefined} /> : null}
            <Actions d={d} />
            <nav className="flex shrink-0 gap-0.5 overflow-x-auto overflow-y-hidden border-b border-ink-800 px-3">
              {TABS.filter((t) => t !== "result" || result).map((t) => {
                const badge = t === "approvals" ? pending.length : t === "subtasks" ? d.children.length : t === "files" ? d.attachments.length : t === "messages" ? d.messages.length : t === "activity" ? d.runs.length : t === "commands" ? commands.length : 0;
                return (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    title={TAB_HINT[t]}
                    className={`relative whitespace-nowrap px-3 py-2.5 text-[11.5px] transition-colors cursor-pointer ${current === t ? "text-ink-100" : "text-ink-400 hover:text-ink-200"} ${t === "result" ? "font-semibold" : ""}`}
                  >
                    {t === "browser" && browsing ? (
                      <span className="mr-1.5 inline-flex items-center gap-1.5 text-live" title="Its browser is open and working — click to watch">
                        <span className="pulse-live inline-block h-1.5 w-1.5 rounded-full bg-live" />
                      </span>
                    ) : null}
                    <span className={t === "browser" && browsing ? "font-semibold text-live" : undefined}>{TAB_LABEL[t]}</span>
                    {badge ? <span className={`ml-1.5 font-mono text-[10.5px] ${t === "approvals" ? "text-rose" : "text-ink-500"}`}>{badge}</span> : null}
                    {current === t ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-amber" /> : null}
                  </button>
                );
              })}
            </nav>
            <div className={`min-h-0 flex-1 px-5 py-4 ${current === "activity" ? "flex flex-col" : "overflow-y-auto"}`}>
              {current === "result" ? <ResultPanel d={d} /> : null}
              {current === "spec" ? <SpecTab d={d} /> : null}
              {current === "plan" ? <PlanTab d={d} /> : null}
              {current === "pipeline" ? <PipelineTab d={d} /> : null}
              {current === "activity" ? <ActivityTab d={d} /> : null}
              {current === "commands" ? (
                <div className="-mx-5 -my-4">
                  <p className="border-b border-ink-800 px-5 py-2.5 text-[11px] text-ink-400">
                    Every shell command this task ran, is running or waits to run, newest first, with what it does in plain words. Autonomous runs show here too: they never ask, so this is where to see what they did.
                  </p>
                  <CommandList taskId={d.task.id} />
                </div>
              ) : null}
              {current === "approvals" ? (
                <div className="space-y-3">
                  {pending.map((a) => <PendingApproval key={a.id} a={a} />)}
                  {!pending.length ? <Empty>Nothing waiting. Supervised runs ask here before every write, and any task can ask you a question here.</Empty> : null}
                  {d.approvals.filter((a) => a.decision).reverse().map((a) => (
                    <div key={a.id} className="flex items-center gap-2 rounded-md border border-ink-800 px-3 py-1.5 font-mono text-[11.5px]">
                      <span className={a.decision === "allow" || a.decision === "answered" ? "text-moss" : a.decision === "deny" ? "text-rust" : "text-ink-500"}>{a.decision}</span>
                      {isQuestion(a) ? (
                        <QuestionHistory a={a} />
                      ) : (
                        <>
                          <span className="text-ink-200">{a.tool_name}</span>
                          <span className="truncate text-ink-400">{a.title}</span>
                          {a.note ? <span className="truncate text-ink-500 italic">“{a.note}”</span> : null}
                        </>
                      )}
                      <span className="ml-auto text-ink-500">{ago(a.created_at)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {current === "diff" ? <DiffView taskId={d.task.id} refreshKey={`${d.runs.length}-${d.task.status}-${d.task.updated_at}`} canComment={d.task.status !== "done"} /> : null}
              {current === "subtasks" ? <SubtasksTab d={d} /> : null}
              {current === "files" ? <Gallery taskId={d.task.id} attachments={d.attachments} onChange={reload} /> : null}
              {current === "browser" ? <LiveBrowser taskId={d.task.id} running={d.busy} onShowFiles={() => setTab("files")} /> : null}
              {current === "messages" ? <MessagesTab d={d} /> : null}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/** The task id, with a copy button: it is what you paste into a chat or a terminal to point at this card. */
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="group/id flex cursor-pointer items-center gap-1 font-mono text-[10.5px] text-ink-500 hover:text-ink-200"
      title={copied ? "Copied" : "Copy the task ID"}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {id}
      {copied ? (
        <span className="text-moss">✓ copied</span>
      ) : (
        <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3 opacity-60 group-hover/id:opacity-100" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5" y="5" width="8" height="9" rx="1.5" />
          <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" />
        </svg>
      )}
    </button>
  );
}
