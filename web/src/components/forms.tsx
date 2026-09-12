import { useEffect, useState } from "react";
import type { Mode, Stage } from "../../../server/src/types.ts";
import { api, type FolderProbe, type ProjectWithGit } from "../lib/api.ts";
import { useAppData } from "../lib/store.tsx";
import { navigate } from "../lib/router.ts";
import { Button, ErrorLine, Field, inputCls, Modal, useAction, ModeHelp } from "./ui.tsx";
import { PipelineEditor } from "./PipelineEditor.tsx";
import { defaultWhen, startAtOf, WhenPicker, whenInvalid, type When } from "./WhenPicker.tsx";

export function autonomousBlocked(p: ProjectWithGit): string | null {
  if (p.policy.autonomous === "forbidden") return "This project's policy forbids autonomous runs.";
  if (p.policy.worktrees === "forbidden") return "This project's policy forbids worktrees (autonomous runs need one).";
  if (!p.isGit) return "Not a git repository — autonomous runs need a worktree.";
  return null;
}

export function NewTaskForm({ project, parentId, milestoneId, initialWhen, onClose }: {
  project: ProjectWithGit;
  parentId?: string;
  milestoneId?: string | null;
  /** Opened from the Schedules panel: start on Repeat. */
  initialWhen?: When["kind"];
  onClose: () => void;
}) {
  const { settings } = useAppData();
  const blocked = autonomousBlocked(project);
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [mode, setMode] = useState<Mode>("supervised");
  const [pipeline, setPipeline] = useState<Stage[]>(project.policy.defaultPipeline?.length ? project.policy.defaultPipeline : settings?.defaultPipeline ?? []);
  const [when, setWhen] = useState<When>(defaultWhen(initialWhen ?? "now"));
  const { busy, error, run } = useAction();
  const invalid = whenInvalid(when);

  const submit = () =>
    run(async () => {
      if (when.kind === "repeat") {
        // A repeating schedule is a template: no card now, a fresh one each time it comes round.
        await api.createSchedule({ project_id: project.id, title, spec_md: spec, mode, pipeline, days: when.days, time: when.time });
        onClose();
        return;
      }
      const t = await api.createTask({ project_id: project.id, title, spec_md: spec, mode, pipeline, parent_id: parentId ?? null, milestone_id: milestoneId ?? null });
      const startAt = startAtOf(when);
      if (startAt) await api.scheduleTask(t.id, startAt);
      onClose();
      navigate({ taskId: t.id });
    });

  return (
    <Modal title={parentId ? "New subtask" : `New task · ${project.name}`} onClose={onClose} width="max-w-2xl">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Title">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add hello.md with three lines" autoFocus />
        </Field>
        <Field label="Spec (markdown)">
          <textarea className={`${inputCls} min-h-[120px] font-mono text-[12.5px]`} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="What done looks like, constraints, files…" />
        </Field>
        <Field group label={<span className="flex items-center gap-1.5">Run mode <ModeHelp /></span>} hint={mode === "autonomous" ? "Runs in its own worktree on branch kanban/<id>; Approve merges it." : "Runs in the main checkout; every write waits for your approval."}>
          <div className="flex gap-2">
            {(["supervised", "autonomous"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={m === "autonomous" && !!blocked}
                title={m === "autonomous" && blocked ? blocked : undefined}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md border px-3 py-2 text-left text-[12.5px] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                  mode === m ? (m === "autonomous" ? "border-amber/70 bg-amber/10 text-amber" : "border-cyan/70 bg-cyan/10 text-cyan") : "border-ink-700 text-ink-300 hover:border-ink-500"
                }`}
              >
                <div className="font-semibold capitalize">{m}</div>
                <div className="text-[11px] opacity-80">{m === "autonomous" ? blocked ?? "worktree · no approvals" : "main checkout · approval cards"}</div>
              </button>
            ))}
          </div>
        </Field>
        <Field
          group
          label="Pipeline"
          hint={
            <>
              One session per stage. Pick <b>where each stage runs</b> — Claude, or a provider from Settings → Providers — and turn
              on <b>debate</b> on a plan stage to have a second model critique it before any code is written.
            </>
          }
        >
          <PipelineEditor value={pipeline} onChange={setPipeline} models={settings?.models ?? []} />
        </Field>
        {!parentId ? (
          <Field group label="When">
            <WhenPicker value={when} onChange={setWhen} />
          </Field>
        ) : null}
        <ErrorLine error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!title.trim() || !!invalid} title={invalid ?? undefined}>
            {when.kind === "repeat" ? "Create schedule" : when.kind === "now" ? "Create task" : "Create & schedule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function NewProjectForm({ onClose }: { onClose: () => void }) {
  const { reloadProjects } = useAppData();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<"allowed" | "forbidden">("allowed");
  const [autonomous, setAutonomous] = useState<"allowed" | "forbidden">("allowed");
  const [maxConcurrent, setMax] = useState(3);
  // Onboarding: what the folder holds decides what is offered — /init on code, a bootstrap on nothing.
  const [probe, setProbe] = useState<FolderProbe | null>(null);
  const [onboard, setOnboard] = useState(true);
  const [goal, setGoal] = useState("");
  const [stack, setStack] = useState("");
  const [verify, setVerify] = useState("");
  const { busy, error, run } = useAction();

  useEffect(() => {
    const p = path.trim();
    if (!p) {
      setProbe(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => void api.probeFolder(p).then((r) => live && setProbe(r), () => live && setProbe(null)), 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path]);

  const bootstrapping = probe?.kind === "empty" && onboard;
  const onboarding = probe?.kind === "code" && onboard ? { init: true } : bootstrapping ? { bootstrap: { goal, stack, verify } } : undefined;

  const submit = () =>
    run(async () => {
      const p = await api.createProject({ name: name || path.split(/[\\/]/).filter(Boolean).at(-1) || "project", path, policy: { worktrees, autonomous, maxConcurrent }, onboarding });
      await reloadProjects();
      onClose();
      navigate({ view: "board", projectId: p.id, taskId: p.onboardingTask?.id ?? null });
    });

  const Toggle = ({ label, value, onChange }: { label: string; value: "allowed" | "forbidden"; onChange: (v: "allowed" | "forbidden") => void }) => (
    <div className="flex items-center justify-between rounded-md border border-ink-700 px-3 py-2">
      <span className="text-[12.5px] text-ink-200">{label}</span>
      <div className="flex overflow-hidden rounded border border-ink-600 font-mono text-[11px]">
        {(["allowed", "forbidden"] as const).map((v) => (
          <button key={v} type="button" onClick={() => onChange(v)} className={`px-2 py-0.5 cursor-pointer ${value === v ? (v === "allowed" ? "bg-moss/25 text-moss" : "bg-rust/25 text-rust") : "text-ink-400 hover:text-ink-200"}`}>
            {v}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Modal title="Register a project" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          group
          label="Folder"
          hint={
            picking
              ? "A folder window is open — choose a folder and press “Use this folder”. If you can't see it, check the taskbar."
              : "Paste a path, or Browse to choose one in Windows' own folder picker."
          }
        >
          <div className="flex gap-2">
            <input className={`${inputCls} font-mono`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\Documents\My Project" autoFocus />
            <Button
              type="button"
              busy={picking}
              onClick={() =>
                void (async () => {
                  setPicking(true);
                  setPickError(null);
                  try {
                    const r = await api.pickFolder(path || undefined);
                    if (r.error) setPickError(r.error);
                    if (r.path) {
                      setPath(r.path);
                      // The name is what you will see in the sidebar; default it to the folder's own name.
                      if (!name.trim()) setName(r.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
                    }
                  } catch (e) {
                    setPickError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setPicking(false);
                  }
                })()
              }
            >
              {picking ? "Waiting…" : "Browse…"}
            </Button>
          </div>
          {pickError ? <div className="mt-1.5"><ErrorLine error={pickError} /></div> : null}
        </Field>
        <Field label="Name" hint="Defaults to the folder name.">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">Policy</div>
            <button
              type="button"
              className="text-[11.5px] text-cyan hover:underline cursor-pointer"
              onClick={() => {
                setWorktrees("forbidden");
                setAutonomous("forbidden");
              }}
            >
              Supervised-only preset
            </button>
          </div>
          <Toggle label="Worktrees" value={worktrees} onChange={setWorktrees} />
          <Toggle label="Autonomous runs" value={autonomous} onChange={setAutonomous} />
          <div className="flex items-center justify-between rounded-md border border-ink-700 px-3 py-2">
            <span className="text-[12.5px] text-ink-200">Max concurrent runs</span>
            <input type="number" min={1} max={8} className={`${inputCls} w-16! text-center font-mono`} value={maxConcurrent} onChange={(e) => setMax(Number(e.target.value) || 1)} />
          </div>
        </div>
        {probe && probe.kind !== "missing" ? (
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">Onboarding</div>
            <label className="flex items-start gap-2.5 rounded-md border border-ink-700 px-3 py-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={onboard} onChange={(e) => setOnboard(e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-[12.5px] text-ink-200">
                  {probe.kind === "code" ? (probe.hasClaudeMd ? "Improve CLAUDE.md with /init" : "Set up CLAUDE.md with /init") : "Bootstrap this project"}
                </span>
                <span className="block text-[11.5px] text-ink-500">
                  {probe.kind === "code"
                    ? "Claude reads the code and writes build, test and convention notes. Lands as a change you approve, and the board sets the verify command from it."
                    : "The folder is empty. One task sets up a skeleton, tests, CLAUDE.md and a verify command, following the checklist in Settings → Runs."}
                </span>
              </span>
            </label>
            {bootstrapping ? (
              <div className="space-y-2 pl-1">
                <Field label="Goal" hint="One paragraph: what this project is for. The bootstrap works from this.">
                  <textarea className={`${inputCls} min-h-[72px]`} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="A CLI that watches a folder and mirrors it to S3, for one user, on Windows and macOS." />
                </Field>
                <div className="grid gap-2 md:grid-cols-2">
                  <Field label="Stack">
                    <input className={inputCls} value={stack} onChange={(e) => setStack(e.target.value)} placeholder="let Claude choose" />
                  </Field>
                  <Field label="How to verify">
                    <input className={`${inputCls} font-mono`} value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" />
                  </Field>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <ErrorLine error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!path.trim() || (bootstrapping && !goal.trim())}>Register</Button>
        </div>
      </form>
    </Modal>
  );
}
