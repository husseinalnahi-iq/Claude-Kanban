import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillInfo, TaskCard } from "../../../server/src/types.ts";
import { api, type ProjectWithGit, type SetupCheckResult } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useAppData } from "../lib/store.tsx";
import { useWs } from "../lib/ws.ts";
import { Button, Chip, Empty, ErrorLine, inputCls, Modal, Switch, useAction } from "../components/ui.tsx";

const GROUPS: { key: SkillInfo["source"]; title: string; where: string }[] = [
  { key: "project", title: "Project", where: "<project>/.claude/skills" },
  { key: "user", title: "User", where: "~/.claude/skills" },
  { key: "plugin", title: "Plugins", where: "~/.claude/plugins (active install)" },
];

function AttachModal({ skill, project, onClose }: { skill: SkillInfo; project: ProjectWithGit; onClose: () => void }) {
  const [tasks, setTasks] = useState<TaskCard[]>([]);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => void api.tasks(project.id).then((t) => setTasks(t.filter((x) => x.status !== "done"))), [project.id]);
  return (
    <Modal title={`Attach ${skill.name}`} onClose={onClose}>
      <p className="mb-3 text-[12px] text-ink-400">The task's stage prompts will tell Claude to use this skill. Tasks in {project.name}:</p>
      <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
        {tasks.map((t) => {
          const has = t.skills.includes(skill.name);
          return (
            <div key={t.id} className="flex items-center gap-2 rounded-md border border-ink-700 px-3 py-1.5">
              <span className="flex-1 truncate text-[13px] text-ink-100">{t.title}</span>
              <span className="font-mono text-[10.5px] text-ink-500">{t.status}</span>
              <Button
                size="sm"
                variant={has ? "ghost" : "outline"}
                busy={busy}
                onClick={() =>
                  run(async () => {
                    await api.patchTask(t.id, { skills: has ? t.skills.filter((s) => s !== skill.name) : [...t.skills, skill.name] });
                    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, skills: has ? x.skills.filter((s) => s !== skill.name) : [...x.skills, skill.name] } : x)));
                    setDone(t.title);
                  })
                }
              >
                {has ? "Detach" : "Attach"}
              </Button>
            </div>
          );
        })}
        {!tasks.length ? <Empty>No open tasks in this project.</Empty> : null}
      </div>
      {done ? <div className="mt-2 text-[12px] text-moss">Updated “{done}”.</div> : null}
      {error ? <div className="mt-2 text-[12px] text-rust">{error}</div> : null}
    </Modal>
  );
}

/** One recommended skill: installed by the board in one click, or by a Claude session that asks first. */
function RecommendedCard({ c, output, onChange }: { c: SetupCheckResult; output?: string; onChange: (c: SetupCheckResult) => void }) {
  const { busy, error, run } = useAction();
  // The server says the install is running only when it ends; until that answer, this click is the news.
  const [started, setStarted] = useState(false);
  useEffect(() => setStarted(false), [c]);
  const installing = c.running || started;
  return (
    <div className="flex flex-col rounded-lg border border-ink-700 bg-ink-850 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] font-semibold text-ink-100">{c.title}</span>
        {c.ok ? (
          <Chip className="shrink-0 border-moss/50 text-moss">Installed</Chip>
        ) : (
          <Chip className={`shrink-0 ${c.warn ? "border-amber/50 text-amber" : "border-ink-600 text-ink-400"}`}>{installing ? "Installing…" : c.warn ? "Switched off" : "Not installed"}</Chip>
        )}
      </div>
      <p className="mt-1.5 flex-1 text-[12px] leading-snug text-ink-300">{c.why}</p>
      {c.warn && !c.ok ? <p className="mt-1.5 text-[12px] text-amber">{c.detail}</p> : null}
      {!c.ok && !c.warn && c.detail !== "Not installed" ? <p className="mt-1.5 text-[12px] text-ink-400">{c.detail}</p> : null}
      {c.ok && c.detail !== "Installed" ? <p className="mt-1.5 text-[12px] text-moss">{c.detail}</p> : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {c.fixes.includes("run") ? (
          <Button size="sm" variant="primary" busy={installing} onClick={() => run(async () => {
            setStarted(true);
            try {
              await api.fixSetup(c.id, { kind: "run" });
            } catch (e) {
              setStarted(false);
              throw e;
            }
          })}>
            Install
          </Button>
        ) : null}
        {c.fixes.includes("claude") && !c.taskId ? (
          <Button size="sm" title="A Claude session installs it, and asks you before every command" onClick={() => run(async () => {
            const r = await api.fixSetup(c.id, { kind: "claude" });
            if (r.task) navigate({ taskId: r.task.id });
          })}>
            Install with Claude
          </Button>
        ) : null}
        {/* Only when something outside the board must change first: Python installed, a plugin switched on. */}
        {!c.ok && !installing && (c.warn || !c.fixes.length) ? (
          <Button size="sm" variant="ghost" busy={busy} onClick={() => run(async () => onChange(await api.recheckSetup(c.id)))}>Check again</Button>
        ) : null}
        {c.link ? <a className="ml-auto text-[12px] text-ink-400 hover:text-amber" href={c.link.href} target="_blank" rel="noreferrer">{c.link.label}</a> : null}
      </div>
      {c.taskId && !c.ok ? (
        <button className="mt-2 cursor-pointer text-left text-[12px] text-cyan underline underline-offset-2" onClick={() => navigate({ taskId: c.taskId })}>
          Claude is installing it — open the session (approve its commands there)
        </button>
      ) : null}
      {output && !c.ok ? <pre className="mt-2 max-h-40 overflow-auto rounded border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11px] text-ink-300">{output}</pre> : null}
      <ErrorLine error={error} />
    </div>
  );
}

export function Skills({ project }: { project: ProjectWithGit | null }) {
  const { settings, setSettings } = useAppData();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [attach, setAttach] = useState<SkillInfo | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const loadSkills = () => api.skills(project?.id).then(setSkills, (e: Error) => (setSkills([]), setOpenError(`The skills could not be listed: ${e.message}`)));
  useEffect(() => void loadSkills(), [project?.id]);

  const [recommended, setRecommended] = useState<SetupCheckResult[]>([]);
  const [installOut, setInstallOut] = useState<Record<string, string>>({});
  useEffect(() => void api.recommendedSkills(true).then((r) => setRecommended(r.checks), () => setRecommended([])), []);
  useWs((m) => {
    if (m.type === "setup.updated" && recommended.some((c) => c.id === m.check.id)) {
      setRecommended((cs) => cs.map((c) => (c.id === m.check.id ? m.check : c)));
      // Just installed: it is a user skill now, so the list below picks it up.
      if (m.check.ok) void loadSkills();
    }
    if (m.type === "setup.output" && recommended.some((c) => c.id === m.id)) setInstallOut((o) => ({ ...o, [m.id]: ((o[m.id] ?? "") + m.chunk).slice(-20_000) }));
  });

  // The list of switched-off skills as of the last click, not the last answer from the server: two
  // quick clicks both started from the saved list, and the second one put the first back.
  const off = useRef<Set<string> | null>(null);
  const toggle = async (s: SkillInfo, on: boolean) => {
    const next = new Set(off.current ?? settings?.disabledSkills ?? []);
    if (on) next.delete(s.name);
    else next.add(s.name);
    off.current = next;
    const show = (enabled: boolean) => setSkills((prev) => prev?.map((x) => (x.name === s.name ? { ...x, enabled } : x)) ?? prev);
    show(on);
    setOpenError(null);
    try {
      setSettings(await api.patchSettings({ disabledSkills: [...next] }));
    } catch (e) {
      // Not saved: put the switch back, so it never shows something the runs will not get.
      off.current = null;
      show(!on);
      setOpenError(`${s.name} was not changed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const offCount = (settings?.disabledSkills ?? []).length;
  const filtered = useMemo(
    () => (skills ?? []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase())),
    [skills, q],
  );
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mb-5 flex items-center gap-4">
        <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">Skills</h1>
        <span className="font-mono text-[12px] text-ink-400">
          {skills?.length ?? "…"} found{offCount ? ` · ${offCount} off` : ""}{project ? ` · project: ${project.name}` : ""}
        </span>
        <input className={`${inputCls} ml-auto max-w-xs`} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {openError ? <div className="mb-3 text-[12px] text-rust">{openError}</div> : null}
      <div className="space-y-7">
        {recommended.length ? (
          <section>
            <div className="mb-2 flex items-baseline gap-3">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-ink-300">Recommended</h2>
              <span className="text-[11.5px] text-ink-500">
                Installed for you rather than one project, so every project gets them.{settings && !settings.loadUserPlugins ? " Tasks don't load your own skills right now: turn that on in Settings → Runs & limits." : ""}
              </span>
            </div>
            <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
              {recommended.map((c) => (
                <RecommendedCard key={c.id} c={c} output={installOut[c.id]} onChange={(n) => setRecommended((cs) => cs.map((x) => (x.id === n.id ? n : x)))} />
              ))}
            </div>
          </section>
        ) : null}
        {GROUPS.map((g) => {
          const list = filtered.filter((s) => s.source === g.key);
          return (
            <section key={g.key}>
              <div className="mb-2 flex items-baseline gap-3">
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-ink-300">{g.title}</h2>
                <span className="font-mono text-[11px] text-ink-500">{g.where} · {list.length}</span>
              </div>
              {list.length ? (
                <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
                  {list.map((s) => (
                    <div key={s.path} className={`flex flex-col rounded-lg border border-ink-700 bg-ink-850 px-3.5 py-3 ${s.enabled ? "" : "opacity-55"}`}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12.5px] font-semibold text-ink-100">{s.name}</span>
                        {!s.pluginEnabled ? <Chip className="border-ink-600 text-ink-400">plugin off</Chip> : null}
                        <Switch
                          on={s.enabled}
                          disabled={!s.pluginEnabled}
                          onChange={(v) => void toggle(s, v)}
                          title={!s.pluginEnabled ? "Its plugin is disabled in ~/.claude/settings.json" : s.enabled ? "On — runs can use this skill" : "Off — hidden from runs unless a task attaches it"}
                        />
                      </div>
                      <p className="mt-1.5 line-clamp-3 flex-1 text-[12px] leading-snug text-ink-300" title={s.description}>{s.description || "No description."}</p>
                      <div className="mt-2.5 flex gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => api.openSkill(s.path, project?.id).catch((e: Error) => setOpenError(e.message))}>Open</Button>
                        <Button size="sm" disabled={!project} title={project ? undefined : "Pick a project first"} onClick={() => setAttach(s)}>Attach to task</Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>{g.key === "project" ? (project ? "No skills in this project's .claude/skills." : "Pick a project to see its skills.") : "None."}</Empty>
              )}
            </section>
          );
        })}
      </div>
      {attach && project ? <AttachModal skill={attach} project={project} onClose={() => setAttach(null)} /> : null}
    </div>
  );
}
