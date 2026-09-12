import { useEffect, useState } from "react";
import type { InstructionFile } from "../../../../server/src/routes/claudeMd.ts";
import { api, type FolderProbe, type ProjectWithGit } from "../../lib/api.ts";
import { ago } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { navigate } from "../../lib/router.ts";
import { useWs } from "../../lib/ws.ts";
import { Button, ErrorLine, Field, Help, inputCls, useAction } from "../../components/ui.tsx";

const SCOPE_LABEL: Record<InstructionFile["scope"], string> = {
  project: "CLAUDE.md",
  "project (.claude)": ".claude/CLAUDE.md",
  local: "CLAUDE.local.md",
  user: "~/.claude/CLAUDE.md",
  rule: ".claude/rules",
};

const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/**
 * What Claude reads before every run in this project — shown read-only, exactly as it is on disk.
 *
 * Nothing here edits a file. "Create" and "Improve" run Claude Code's own `/init` as a task, so the
 * change arrives the way every other change does: an approval card, or a diff you approve.
 */
export function ClaudeMdSettings({ project }: { project: ProjectWithGit }) {
  const [files, setFiles] = useState<InstructionFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [probe, setProbe] = useState<FolderProbe | null>(null);
  const [asking, setAsking] = useState(false);
  const [goal, setGoal] = useState(project.env.onboarding?.goal ?? "");
  const [stack, setStack] = useState(project.env.onboarding?.stack ?? "");
  const [verify, setVerify] = useState(project.env.onboarding?.verify ?? "");
  const { busy, error, run } = useAction();

  const load = () => void api.claudeMd(project.id).then((f) => {
    void api.probeFolder(project.path).then(setProbe, () => setProbe(null));
    setFiles(f);
    // Open the project's own file by default: it is the one that matters most and the one you control.
    setOpen((cur) => cur ?? f.find((x) => x.exists && x.scope !== "user")?.path ?? f.find((x) => x.exists)?.path ?? null);
  }, () => setFiles([]));
  useEffect(load, [project.id]);
  // A /init task that lands the file should show up here without a reload.
  useWs((m) => {
    if (m.type === "task.updated" && m.task.project_id === project.id && m.task.status === "done") load();
  });

  const projectFile = files?.find((f) => (f.scope === "project" || f.scope === "project (.claude)") && f.exists);
  const present = (files ?? []).filter((f) => f.exists);
  const shown = present.find((f) => f.path === open) ?? null;

  const init = () =>
    run(async () => {
      const task = await api.initClaudeMd(project.id);
      navigate({ projectId: project.id, taskId: task.id, view: "board" });
    });
  const bootstrap = () =>
    run(async () => {
      const task = await api.bootstrapProject(project.id, { goal, stack, verify });
      navigate({ projectId: project.id, taskId: task.id, view: "board" });
    });
  // An empty folder has nothing for /init to read; the bootstrap is what sets it up.
  const empty = probe?.kind === "empty";

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-100">
              Project instructions
              <Help width="w-[340px]">
                Claude Code reads these at the start of every session, in this order — your personal file, then the project's, then
                your local one — and <b>concatenates</b> them rather than letting one override another. Every file that exists here
                reaches every run on this board, the same as it would in Claude Code.
              </Help>
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-400">
              {projectFile
                ? `What Claude is told about ${project.name} before every run. Read-only — the board never edits these files itself.`
                : `${project.name} has no CLAUDE.md yet, so Claude starts every run knowing nothing about how this project works.`}
            </p>
          </div>
          {empty ? (
            <Button variant="primary" busy={busy} onClick={() => setAsking((v) => !v)}>Bootstrap…</Button>
          ) : (
            <Button variant={projectFile ? "outline" : "primary"} busy={busy} onClick={init}>
              {projectFile ? "Improve with /init" : "Create with /init"}
            </Button>
          )}
        </div>
        {empty && asking ? (
          <div className="mt-3 space-y-2 rounded-lg border border-ink-800 bg-ink-950/60 p-3">
            <Field label="Goal" hint="One paragraph: what this project is for.">
              <textarea className={`${inputCls} min-h-[72px]`} value={goal} onChange={(e) => setGoal(e.target.value)} autoFocus />
            </Field>
            <div className="grid gap-2 md:grid-cols-2">
              <Field label="Stack"><input className={inputCls} value={stack} onChange={(e) => setStack(e.target.value)} placeholder="let Claude choose" /></Field>
              <Field label="How to verify"><input className={`${inputCls} font-mono`} value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" /></Field>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" busy={busy} disabled={!goal.trim()} onClick={bootstrap}>Queue the bootstrap</Button>
            </div>
          </div>
        ) : null}
        <p className="mt-2 text-[11.5px] text-ink-500">
          {empty ? (
            <>The folder is empty, so there is nothing for <code className="text-cyan">/init</code> to read yet. The bootstrap sets up a skeleton, tests, CLAUDE.md and a verify command, following the checklist in Settings → Runs.</>
          ) : projectFile ? (
            <>Runs Claude Code's own <code className="text-cyan">/init</code>, which — in Claude's words — <i>"suggests improvements rather than overwriting it."</i></>
          ) : (
            <>Runs Claude Code's own <code className="text-cyan">/init</code>: <i>"Claude analyzes your codebase and creates a file with build commands, test instructions, and project conventions it discovers."</i></>
          )}{" "}
          It runs as a task, so {project.policy.autonomous === "forbidden" || project.policy.worktrees === "forbidden" ? "writing the file is an approval card" : "you review the diff before it lands"}.
        </p>
        <div className="mt-3"><ErrorLine error={error} /></div>
      </div>

      <div className="rounded-xl border border-ink-800 bg-ink-900/60">
        <div className="flex flex-wrap items-center gap-1 border-b border-ink-800 px-3 pt-2">
          {(files ?? []).map((f) => (
            <button
              key={f.path}
              disabled={!f.exists}
              onClick={() => setOpen(f.path)}
              title={f.exists ? `${f.path}\n${f.purpose}` : `Not present — ${f.purpose}`}
              className={`relative px-2.5 py-2 font-mono text-[11.5px] transition-colors ${
                !f.exists ? "cursor-default text-ink-600 line-through decoration-ink-700" : f.path === open ? "cursor-pointer text-ink-100" : "cursor-pointer text-ink-400 hover:text-ink-200"
              }`}
            >
              {f.scope === "rule" ? `rules/${f.path.split(/[\\/]/).at(-1)}` : SCOPE_LABEL[f.scope]}
              {f.path === open ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-amber" /> : null}
            </button>
          ))}
          {shown ? (
            <button className="ml-auto mb-1 rounded border border-ink-700 px-2 py-0.5 font-mono text-[10.5px] text-ink-400 hover:text-ink-100 cursor-pointer" onClick={() => setRaw((v) => !v)}>
              {raw ? "rendered" : "raw"}
            </button>
          ) : null}
        </div>

        {files === null ? (
          <div className="p-5 text-[12px] text-ink-500">Reading…</div>
        ) : shown ? (
          <div className="p-5">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink-500">
              <span className="truncate" title={shown.path}>{shown.path}</span>
              <span>{kb(shown.bytes)}</span>
              {shown.modified ? <span>changed {ago(shown.modified)}</span> : null}
              <span className="text-ink-400">{shown.purpose}</span>
            </div>
            {raw ? (
              <pre className="max-h-[60vh] overflow-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[12px] whitespace-pre-wrap text-ink-200">{shown.content}</pre>
            ) : (
              <div className="max-h-[60vh] overflow-auto">
                <Markdown text={shown.content ?? ""} className="text-[13px]" />
              </div>
            )}
          </div>
        ) : (
          <div className="p-5 text-[12.5px] text-ink-400">
            None of the files Claude reads exist for this project yet.{" "}
            {empty ? (
              <><b className="text-ink-200">Bootstrap</b> sets the folder up and writes the first CLAUDE.md as part of it.</>
            ) : (
              <><b className="text-ink-200">Create with /init</b> writes a starting CLAUDE.md from what is actually in the repository.</>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
