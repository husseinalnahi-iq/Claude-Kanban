import { useEffect, useMemo, useState } from "react";
import type { SkillInfo, TaskCard } from "../../../server/src/types.ts";
import { api, type ProjectWithGit } from "../lib/api.ts";
import { useAppData } from "../lib/store.tsx";
import { Button, Chip, Empty, inputCls, Modal, Switch, useAction } from "../components/ui.tsx";

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

export function Skills({ project }: { project: ProjectWithGit | null }) {
  const { settings, setSettings } = useAppData();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [attach, setAttach] = useState<SkillInfo | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => void api.skills(project?.id).then(setSkills), [project?.id]);

  const toggle = async (s: SkillInfo, on: boolean) => {
    const off = new Set(settings?.disabledSkills ?? []);
    if (on) off.delete(s.name);
    else off.add(s.name);
    setSkills((prev) => prev?.map((x) => (x.name === s.name ? { ...x, enabled: on } : x)) ?? prev);
    setSettings(await api.patchSettings({ disabledSkills: [...off] }));
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
