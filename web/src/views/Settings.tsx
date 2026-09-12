import { useEffect, useState } from "react";
import { ANTHROPIC_PROVIDER_ID, EFFORTS, type ModelEntry, type Note, type Provider, type Settings as SettingsShape, type Stage, type TierRef } from "../../../server/src/types.ts";
import { api, type ProjectWithGit, type WorktreeRow } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { useAppData } from "../lib/store.tsx";
import { navigate } from "../lib/router.ts";
import { Button, ErrorLine, Field, Help, ModeHelp, Switch, inputCls, useAction } from "../components/ui.tsx";
import { PipelineEditor } from "../components/PipelineEditor.tsx";
import { ProviderPicker } from "../components/ProviderPicker.tsx";
import { ClaudeModelPicker, EffortSelect } from "../components/ClaudeModelPicker.tsx";
import { ClaudeModelList } from "./settings/ClaudeModelList.tsx";
import { useClaudeModels } from "../lib/claudeModels.ts";
import { badClaudePicks } from "../../../server/src/engine/claudeModels.ts";
import { ProviderSettings } from "./settings/ProviderSettings.tsx";
import { GitSettings } from "./settings/GitSettings.tsx";
import { ClaudeMdSettings } from "./settings/ClaudeMdSettings.tsx";
import { SessionToolsPanel } from "./settings/ToolsSettings.tsx";
import { COLUMN_SIZES, setViewPrefs, useViewPrefs, ZOOMS } from "../lib/view.ts";
import { disableNotifications, enableNotifications, notifyState } from "../lib/notify.ts";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-5">
      <h2 className="text-[13px] font-semibold text-ink-100">{title}</h2>
      {hint ? <p className="mt-0.5 mb-4 text-[12px] text-ink-400">{hint}</p> : <div className="mb-4" />}
      {children}
    </section>
  );
}

/** Files, setup and verification for a project's task workspaces. */
function WorkspaceSettings({ project }: { project: ProjectWithGit }) {
  const { reloadProjects } = useAppData();
  const [include, setInclude] = useState(project.env.worktreeInclude.join("\n"));
  const [setup, setSetup] = useState(project.env.setupCommand ?? "");
  const [verify, setVerify] = useState(project.env.verifyCommand ?? "");
  const { busy, error, run } = useAction();
  useEffect(() => {
    setInclude(project.env.worktreeInclude.join("\n"));
    setSetup(project.env.setupCommand ?? "");
    setVerify(project.env.verifyCommand ?? "");
  }, [project]);
  return (
    <Section title="Task workspace" hint="A worktree is a fresh checkout: gitignored files are missing and nothing is installed.">
      <div className="space-y-3">
        <Field
          label="Copy these gitignored files into new worktrees"
          hint={<>One pattern per line, on top of the repo's <span className="font-mono">.worktreeinclude</span>. Only files git already ignores are copied — tracked files never are. A convenience, not secret management.</>}
        >
          <textarea className={`${inputCls} min-h-[72px] font-mono text-[12.5px]`} placeholder={".env\n.env.local\ncerts/**"} value={include} onChange={(e) => setInclude(e.target.value)} />
        </Field>
        <Field label="Setup command" hint="Runs once in a new worktree (dependency install). KANBAN_PORT is set for dev servers.">
          <input className={`${inputCls} font-mono`} placeholder="npm ci" value={setup} onChange={(e) => setSetup(e.target.value)} />
        </Field>
        <Field label="Verify command" hint="Must pass before a task reaches Review. The agent is blocked from finishing while it fails, and the board re-runs it.">
          <input className={`${inputCls} font-mono`} placeholder="npm test" value={verify} onChange={(e) => setVerify(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3"><ErrorLine error={error} /></div>
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            run(async () => {
              await api.patchProject(project.id, {
                env: {
                  worktreeInclude: include.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
                  setupCommand: setup.trim() || null,
                  verifyCommand: verify.trim() || null,
                },
              });
              await reloadProjects();
            })
          }
        >
          Save workspace
        </Button>
      </div>
    </Section>
  );
}

/** Worktrees on disk, with a prune that refuses anything still holding work. */
function WorktreeSettings({ project }: { project: ProjectWithGit }) {
  const [rows, setRows] = useState<WorktreeRow[] | null>(null);
  const { busy, error, run } = useAction();
  const load = () => void api.worktrees(project.id).then(setRows, () => setRows([]));
  useEffect(load, [project.id]);
  const removable = (rows ?? []).filter((r) => r.removable).length;
  return (
    <Section title="Worktrees" hint={`${rows?.length ?? "…"} on disk under .kanban\\wt. Prune removes only clean, merged worktrees of finished tasks.`}>
      <div className="space-y-1.5">
        {(rows ?? []).map((w) => (
          <div key={w.path} className="flex items-center gap-2 rounded-md border border-ink-700 px-3 py-1.5 font-mono text-[11.5px]">
            <span className={w.removable ? "text-moss" : "text-amber"}>{w.removable ? "removable" : "keep"}</span>
            <span className="text-ink-100">{w.branch}</span>
            <span className="truncate text-ink-400">{w.taskTitle ?? "(no task)"}</span>
            {w.behind > 0 ? <span className="text-slate" title={`Behind the base branch by ${w.behind} commit(s)`}>{w.behind} behind</span> : null}
            {w.blockers.length ? <span className="ml-auto truncate text-ink-500">{w.blockers.join(", ")}</span> : null}
          </div>
        ))}
        {rows && !rows.length ? <div className="text-[12px] text-ink-500">None.</div> : null}
      </div>
      <div className="mt-3"><ErrorLine error={error} /></div>
      <div className="mt-3 flex justify-end">
        <Button busy={busy} disabled={!removable} onClick={() => run(async () => { await api.pruneWorktrees(project.id); load(); })}>
          Prune {removable || ""} worktree{removable === 1 ? "" : "s"}
        </Button>
      </div>
    </Section>
  );
}

/** What the board remembers for this project, and hands to every later task. */
function MemorySettings({ project }: { project: ProjectWithGit }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [text, setText] = useState("");
  const { busy, error, run } = useAction();
  const load = () => void api.memory(project.id).then(setNotes, () => setNotes([]));
  useEffect(load, [project.id]);
  return (
    <Section title="Project memory" hint="Decisions carried into every later task in this project. The first 12 go into each prompt; runs can read the rest with board_memory. Delete anything stale — old notes mislead new runs.">
      <div className="space-y-1.5">
        {(notes ?? []).map((n) => (
          <div key={n.id} className="flex items-start gap-2 rounded-md border border-ink-700 px-3 py-1.5 text-[12.5px]">
            <span className="font-mono text-[10px] uppercase text-ink-500">{n.source}</span>
            <span className="flex-1 text-ink-200">{n.text}</span>
            <span className="font-mono text-[10px] text-ink-600">{ago(n.ts)}</span>
            <button className="cursor-pointer text-ink-500 hover:text-rust" title="Forget this" onClick={() => run(async () => { await api.deleteMemory(n.id); load(); })}>×</button>
          </div>
        ))}
        {notes && !notes.length ? <div className="text-[12px] text-ink-500">Nothing yet. Approved tasks add a line, and runs can call board_remember.</div> : null}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length < 8) return;
          void run(async () => {
            await api.addMemory(project.id, text.trim());
            setText("");
            load();
          });
        }}
      >
        <input className={inputCls} placeholder="A convention or decision future tasks should know…" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" busy={busy}>Remember</Button>
      </form>
      <div className="mt-2"><ErrorLine error={error} /></div>
    </Section>
  );
}

function ProjectSettings({ project }: { project: ProjectWithGit }) {
  const { reloadProjects } = useAppData();
  const [name, setName] = useState(project.name);
  const [policy, setPolicy] = useState(project.policy);
  const { busy, error, run } = useAction();
  useEffect(() => {
    setName(project.name);
    setPolicy(project.policy);
  }, [project]);
  const opt = (key: "worktrees" | "autonomous") => (
    <div className="flex items-center justify-between rounded-md border border-ink-700 px-3 py-2">
      <span className="flex items-center gap-1.5 text-[12.5px] capitalize text-ink-200">
        {key}
        {key === "autonomous" ? <ModeHelp /> : (
          <Help width="w-[320px]">
            A worktree is a second checkout of the same repository in a folder of its own, on its own branch. It lets a
            task edit files without touching what you have open. Forbid it and every task runs in the project folder itself.
          </Help>
        )}
      </span>
      <div className="flex overflow-hidden rounded border border-ink-600 font-mono text-[11px]">
        {(["allowed", "forbidden"] as const).map((v) => (
          <button key={v} onClick={() => setPolicy({ ...policy, [key]: v })} className={`px-2 py-0.5 cursor-pointer ${policy[key] === v ? (v === "allowed" ? "bg-moss/25 text-moss" : "bg-rust/25 text-rust") : "text-ink-400"}`}>
            {v}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <Section title={`Project · ${project.name}`} hint={project.path}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Max concurrent runs">
          <input type="number" min={1} max={8} className={`${inputCls} font-mono`} value={policy.maxConcurrent} onChange={(e) => setPolicy({ ...policy, maxConcurrent: Number(e.target.value) || 1 })} />
        </Field>
        {opt("worktrees")}
        {opt("autonomous")}
      </div>
      <div className="mt-4"><ErrorLine error={error} /></div>
      <div className="mt-4 flex justify-between">
        <Button
          variant="danger"
          busy={busy}
          onClick={() =>
            confirm(`Remove "${project.name}" from the board? Its tasks and runs are deleted from Claude Kanban (the folder is untouched).`) &&
            run(async () => {
              await api.deleteProject(project.id);
              await reloadProjects();
              navigate({ projectId: null, view: "board", taskId: null });
            })
          }
        >
          Remove project
        </Button>
        <Button variant="primary" busy={busy} onClick={() => run(async () => { await api.patchProject(project.id, { name, policy: { worktrees: policy.worktrees, autonomous: policy.autonomous, maxConcurrent: policy.maxConcurrent } }); await reloadProjects(); })}>
          Save project
        </Button>
      </div>
    </Section>
  );
}

/** How the board is displayed on this screen. Stored per machine, applied immediately. */
function AppearanceSettings() {
  const { zoom, columns } = useViewPrefs();
  return (
    <Section title="Size and layout" hint="Applies to this computer only, straight away — there is nothing to save.">
      <div className="space-y-4">
        <Field label="Interface size" group>
          <div className="flex flex-wrap items-center gap-1.5">
            {ZOOMS.map((z) => (
              <button
                key={z}
                onClick={() => setViewPrefs({ zoom: z })}
                className={`rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors cursor-pointer ${zoom === z ? "border-amber bg-amber/10 text-amber" : "border-ink-700 text-ink-300 hover:border-ink-500"}`}
              >
                {z}%
              </button>
            ))}
            <span className="ml-2 text-[11.5px] text-ink-500">Ctrl + − / = / 0 anywhere on the board.</span>
          </div>
        </Field>
        <Field label="Board column width" group>
          <div className="flex flex-wrap items-center gap-1.5">
            {COLUMN_SIZES.map((c) => (
              <button
                key={c.label}
                onClick={() => setViewPrefs({ columns: c.value })}
                className={`rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors cursor-pointer ${columns === c.value ? "border-amber bg-amber/10 text-amber" : "border-ink-700 text-ink-300 hover:border-ink-500"}`}
              >
                {c.label}
                {typeof c.value === "number" ? <span className="ml-1 text-ink-500">{c.value}</span> : null}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-400">
            <b>fill</b> spreads the columns across the whole window with no empty space on the right; the fixed sizes keep
            cards narrow and let the board scroll sideways instead.
          </div>
        </Field>
      </div>
    </Section>
  );
}

/** Intake models → Try it: a sample screenshot through the chosen vision model, and what it saw. */
function VisionTry({ vision, saved }: { vision: TierRef; saved: boolean }) {
  const [r, setR] = useState<{ ok: boolean; text: string | null; latencyMs: number; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const onClaude = vision.provider === ANTHROPIC_PROVIDER_ID;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          busy={busy}
          disabled={!vision.model || (!onClaude && !saved)}
          title={!onClaude && !saved ? "Save settings first: another provider is tested through the saved settings" : "Shows a sample screenshot to this model and prints what it saw"}
          onClick={() =>
            void (async () => {
              setBusy(true);
              setR(null);
              try {
                setR(await api.testVision(vision.provider, vision.model));
              } catch (err) {
                setR({ ok: false, text: null, latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          Try it
        </Button>
        <span className="text-[11px] text-ink-500">{!onClaude && !saved ? "save first, then try it" : "shows it a sample screenshot"}</span>
      </div>
      {r ? (
        <div className={`mt-2 rounded-md border px-3 py-2 text-[12px] ${r.ok ? "border-moss/40 text-ink-300" : "border-rust/50 text-rust"}`}>
          {r.ok ? (
            <>
              <div className="mb-1 text-moss">It can see · {(r.latencyMs / 1000).toFixed(1)} s</div>
              <div className="whitespace-pre-wrap">{r.text}</div>
            </>
          ) : (
            <>Could not describe it: {r.error}</>
          )}
        </div>
      ) : null}
    </div>
  );
}

type Tab = "appearance" | "models" | "providers" | "runs" | "tools" | "git" | "project" | "claudemd" | "memory" | "worktrees";
const TABS: { id: Tab; label: string; needsProject?: boolean }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "models", label: "Models & pipeline" },
  { id: "providers", label: "Providers" },
  { id: "runs", label: "Runs & limits" },
  { id: "tools", label: "Browser & plugins" },
  { id: "git", label: "Git & merging", needsProject: true },
  { id: "project", label: "Project", needsProject: true },
  { id: "claudemd", label: "CLAUDE.md", needsProject: true },
  { id: "memory", label: "Memory", needsProject: true },
  { id: "worktrees", label: "Worktrees", needsProject: true },
];
/** Tabs whose contents are saved by the global Save button. */
const GLOBAL_TABS: Tab[] = ["models", "providers", "runs", "tools"];

export function Settings({ project }: { project: ProjectWithGit | null }) {
  // #/settings?tab=providers opens on that tab (the model picker's "+ Add a provider" link).
  const [tab, setTab] = useState<Tab>(() => {
    const asked = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab");
    return TABS.find((t) => t.id === asked && !t.needsProject)?.id ?? "appearance";
  });
  const { settings, setSettings } = useAppData();
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [pipeline, setPipeline] = useState<Stage[]>([]);
  const [globalCap, setGlobalCap] = useState(8);
  const [serial, setSerial] = useState(false);
  const [forced, setForced] = useState(3);
  const [defMax, setDefMax] = useState(3);
  const [maxTurns, setMaxTurns] = useState(60);
  const [autoContinue, setAutoContinue] = useState(2);
  const [planApproval, setPlanApproval] = useState(false);
  const [liveReviewModel, setLiveReviewModel] = useState("claude-opus-5");
  const [maxCost, setMaxCost] = useState(5);
  const [subDepth, setSubDepth] = useState(2);
  const [subMax, setSubMax] = useState(5);
  const [cacheable, setCacheable] = useState(true);
  const [triageModel, setTriageModel] = useState("");
  const [chatModel, setChatModel] = useState("claude-sonnet-5");
  const [chatEffort, setChatEffort] = useState<SettingsShape["chatEffort"]>("medium");
  const [specModel, setSpecModel] = useState("claude-opus-5");
  const [specEffort, setSpecEffort] = useState<SettingsShape["specEffort"]>("high");
  const [vision, setVision] = useState<TierRef>({ provider: ANTHROPIC_PROVIDER_ID, model: "" });
  const [autoSizing, setAutoSizing] = useState(true);
  const [tiers, setTiers] = useState<SettingsShape["tiers"]>({
    cheap: { provider: "anthropic", model: "" }, balanced: { provider: "anthropic", model: "" }, strong: { provider: "anthropic", model: "" },
  });
  const [providers, setProviders] = useState<Provider[]>([]);
  const [delegateTimeout, setDelegateTimeout] = useState(30);
  const [debate, setDebate] = useState<SettingsShape["debate"]>({ enabled: false, critic: { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" } });
  const [maxTaskCost, setMaxTaskCost] = useState(15);
  const [maxRepeats, setMaxRepeats] = useState(8);
  const [retention, setRetention] = useState(30);
  const [blocked, setBlocked] = useState("");
  const [loadPlugins, setLoadPlugins] = useState(true);
  const [autoResume, setAutoResume] = useState(true);
  const [claudeFallback, setClaudeFallback] = useState<TierRef | null>(null);
  const [keepAwake, setKeepAwake] = useState(true);
  const [questionWait, setQuestionWait] = useState(0);
  const [browserChecks, setBrowserChecks] = useState(true);
  const [chrome, setChrome] = useState(false);
  const [readsFree, setReadsFree] = useState(true);
  const [liveView, setLiveView] = useState(true);
  const [checklist, setChecklist] = useState("");
  const [notif, setNotif] = useState(notifyState());
  const claude = useClaudeModels();
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setModels(settings.models);
    setPipeline(settings.defaultPipeline);
    setGlobalCap(settings.globalCap);
    setSerial(settings.serial);
    setForced(settings.maxForcedParallel);
    setDefMax(settings.defaultMaxConcurrent);
    setMaxTurns(settings.maxTurnsPerStage);
    setAutoContinue(settings.autoContinueTurns);
    setPlanApproval(settings.planApproval);
    setLiveReviewModel(settings.liveReviewModel);
    setMaxCost(settings.maxCostPerStageUsd);
    setSubDepth(settings.maxSubagentDepth);
    setSubMax(settings.maxConcurrentSubagents);
    setCacheable(settings.cacheableSystemPrompt);
    setTriageModel(settings.triageModel);
    setChatModel(settings.chatModel);
    setChatEffort(settings.chatEffort);
    setSpecModel(settings.specModel);
    setSpecEffort(settings.specEffort);
    setVision({ provider: settings.visionProvider || ANTHROPIC_PROVIDER_ID, model: settings.visionModel });
    setAutoSizing(settings.autoSizing);
    setTiers(settings.tiers);
    setProviders(settings.providers);
    setDelegateTimeout(settings.delegateTimeoutMin);
    setDebate(settings.debate);
    setMaxTaskCost(settings.maxCostPerTaskUsd);
    setMaxRepeats(settings.maxRepeatedToolCalls);
    setRetention(settings.eventRetentionDays);
    setBlocked(settings.blockedCommands.join(String.fromCharCode(10)));
    setLoadPlugins(settings.loadUserPlugins);
    setAutoResume(settings.autoResume);
    setClaudeFallback(settings.claudeFallback);
    setKeepAwake(settings.keepAwake);
    setQuestionWait(settings.questionWaitMin);
    setBrowserChecks(settings.browserChecks);
    setChrome(settings.chromeInSupervised);
    setReadsFree(settings.autoAllowReadCommands);
    setLiveView(settings.liveView);
    setChecklist(settings.onboardingChecklist);
  }, [settings]);

  if (!settings) return <div className="p-6 text-ink-400">Loading…</div>;
  const save = () =>
    run(async () => {
      setSettings(
        await api.patchSettings({
          models, defaultPipeline: pipeline, globalCap, serial, maxForcedParallel: forced, defaultMaxConcurrent: defMax,
          maxTurnsPerStage: maxTurns, maxCostPerStageUsd: maxCost, autoContinueTurns: autoContinue, planApproval, liveReviewModel,
          maxSubagentDepth: subDepth, maxConcurrentSubagents: subMax, cacheableSystemPrompt: cacheable,
          triageModel, chatModel, chatEffort, specModel, specEffort, visionModel: vision.model, visionProvider: vision.provider, autoSizing, tiers,
          providers: providers.map((p) => ({ ...p, models: p.models.filter((m) => m.id.trim()).map((m) => ({ ...m, label: m.label.trim() || m.id })) })),
          delegateTimeoutMin: delegateTimeout,
          debate,
          maxCostPerTaskUsd: maxTaskCost, maxRepeatedToolCalls: maxRepeats, eventRetentionDays: retention,
          blockedCommands: blocked.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
          loadUserPlugins: loadPlugins,
          autoResume,
          claudeFallback: claudeFallback?.model && claudeFallback.provider !== ANTHROPIC_PROVIDER_ID ? claudeFallback : null,
          keepAwake,
          questionWaitMin: questionWait,
          browserChecks,
          chromeInSupervised: chrome,
          autoAllowReadCommands: readsFree,
          liveView,
          onboardingChecklist: checklist,
        }),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-center">
          <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">Settings</h1>
          <div className="ml-auto flex items-center gap-3">
            {saved ? <span className="text-[12px] text-moss">Saved</span> : null}
            {GLOBAL_TABS.includes(tab) ? <Button variant="primary" busy={busy} onClick={save}>Save settings</Button> : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-1 border-b border-ink-800">
          {TABS.map((t) => {
            const disabled = t.needsProject && !project;
            return (
              <button
                key={t.id}
                disabled={disabled}
                onClick={() => setTab(t.id)}
                title={disabled ? "Pick a project on the left first" : undefined}
                className={`relative px-3 py-2 text-[12.5px] transition-colors ${
                  disabled ? "cursor-not-allowed text-ink-600" : tab === t.id ? "cursor-pointer text-ink-100" : "cursor-pointer text-ink-400 hover:text-ink-200"
                }`}
              >
                {t.label}
                {tab === t.id ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-amber" /> : null}
              </button>
            );
          })}
        </div>
        <ErrorLine error={error} />

        {(() => {
          // Picks a run would fail on, or likely typos — said before they cost a failed run.
          if (!GLOBAL_TABS.includes(tab) || !settings) return null;
          const bad = badClaudePicks({ models, defaultPipeline: pipeline, tiers, debate, triageModel, chatModel, specModel, visionModel: vision.model, visionProvider: vision.provider }, claude.result);
          if (!bad.length) return null;
          const fails = bad.some((b) => b.status === "invalid");
          return (
            <div className={`fade-in rounded-lg border px-3 py-2 text-[12px] ${fails ? "border-rust/50 bg-rust/5 text-rust" : "border-amber/40 bg-amber/5 text-amber"}`}>
              <div className="font-medium">
                ⚠ {bad.length === 1 ? "1 Claude model isn't" : `${bad.length} Claude models aren't`} on your Claude login's list
                {fails ? " — a run on a red one fails" : " — check the spelling"}
              </div>
              <ul className="mt-1 space-y-0.5 text-ink-300">
                {bad.map((b, i) => (
                  <li key={i}>
                    {b.where}: <span className={`font-mono ${b.status === "invalid" ? "text-rust" : "text-amber"}`}>{b.id}</span>
                  </li>
                ))}
              </ul>
              {tab !== "models" ? (
                <button type="button" className="mt-1 cursor-pointer text-ink-300 underline-offset-2 hover:text-ink-100 hover:underline" onClick={() => setTab("models")}>
                  Fix in Models &amp; pipeline
                </button>
              ) : null}
            </div>
          );
        })()}

        {tab === "appearance" ? <AppearanceSettings /> : null}

        {tab === "models" ? (<>
        <Section
          title="Claude models"
          hint="The Claude models the pickers offer, checked against your Claude login — a misspelt id shows here in red instead of failing a run. Add a new one from the list the day it ships."
        >
          <ClaudeModelList models={models} onChange={setModels} providers={providers} onOpenProviders={() => setTab("providers")} />
        </Section>

        <Section title="Default pipeline" hint="New tasks start with this (a project can override it).">
          <PipelineEditor value={pipeline} onChange={setPipeline} models={models} />
        </Section>

        <Section
          title="Plan debate"
          hint="Before code starts, a second model can critique the plan. You then pick the original, the revised plan, or your own — nothing runs until you choose. A pipeline's plan stage can override this."
        >
          <label className="mb-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={debate.enabled} onChange={(e) => setDebate({ ...debate, enabled: e.target.checked })} />
            <span>
              Debate every plan by default
              <span className="block text-[11.5px] text-ink-400">One extra critique call per plan stage, plus one revision. Off: no debate unless a stage turns it on.</span>
            </span>
          </label>
          <Field label="Critic" hint="The model that argues against the plan. A different family from the planner tends to catch more.">
            <div className="flex items-center gap-2">
              <ProviderPicker compact value={{ provider: debate.critic.provider, model: debate.critic.model }} models={models} providers={providers} onChange={(v) => setDebate({ ...debate, critic: { ...debate.critic, ...v } })} />
              <EffortSelect
                className="w-auto!"
                model={debate.critic.model}
                disabled={Boolean(debate.critic.provider) && debate.critic.provider !== ANTHROPIC_PROVIDER_ID}
                value={debate.critic.effort}
                onChange={(effort) => setDebate({ ...debate, critic: { ...debate.critic, effort } })}
              />
            </div>
          </Field>
        </Section>
        </>) : null}

        {tab === "providers" ? <ProviderSettings providers={providers} onChange={setProviders} /> : null}

        {tab === "runs" ? (<>
        <Section title="Concurrency" hint="Per-project FIFO queues, capped per project and globally.">
          <Field
            group
            label="One task at a time"
            hint="Each task finishes and commits before the next starts, so your usage limit is spent more slowly. The caps below are kept and come back when you turn this off."
          >
            <div className="flex items-center gap-2">
              <Switch on={serial} onChange={setSerial} />
              <span className="text-[12.5px] text-ink-300">{serial ? `on — the caps below are ignored` : `off — up to ${globalCap} tasks at once`}</span>
            </div>
          </Field>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="Global cap (all projects)"><input type="number" min={1} max={32} disabled={serial} className={`${inputCls} font-mono disabled:opacity-40`} value={globalCap} onChange={(e) => setGlobalCap(Number(e.target.value) || 1)} /></Field>
            <Field label="Default per-project cap"><input type="number" min={1} max={8} disabled={serial} className={`${inputCls} font-mono disabled:opacity-40`} value={defMax} onChange={(e) => setDefMax(Number(e.target.value) || 1)} /></Field>
            <Field label="Forced runs at once" hint="How many tasks “Run now” may start outside the caps."><input type="number" min={1} max={8} className={`${inputCls} font-mono`} value={forced} onChange={(e) => setForced(Number(e.target.value) || 1)} /></Field>
          </div>
        </Section>

        <Section
          title="Onboarding"
          hint="What the bootstrap task does for an empty project. Edit it once; every future bootstrap follows it. Leave it empty to restore the default."
        >
          <textarea className={`${inputCls} mt-1 min-h-[160px] font-mono text-[12.5px]`} value={checklist} onChange={(e) => setChecklist(e.target.value)} spellCheck={false} />
          <p className="mt-1.5 text-[11.5px] text-ink-500">
            Projects with code skip this and get Claude Code's own <code className="text-cyan">/init</code> instead. Nothing here is added to ordinary runs: a
            project's CLAUDE.md is what every stage reads.
          </p>
        </Section>

        <Section
          title="Intake models"
          hint="Small jobs the board does for you before a task ever runs. Keep these cheap — they are called often and never write code."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field group label="Triage model" hint="Classifies a new task and writes the improved spec.">
              <ClaudeModelPicker value={triageModel} onChange={setTriageModel} models={models} />
            </Field>
            <Field label="Vision model" hint="Looks at each attached image once and writes down what is in it, so the stages that follow read words instead of pixels.">
              <ProviderPicker compact value={vision} models={models} providers={providers} onChange={setVision} />
            </Field>
          </div>
          <VisionTry vision={vision} saved={settings.visionProvider === vision.provider && settings.visionModel === vision.model} />
          <p className="mt-2 text-[11.5px] text-ink-500">
            The default, <span className="font-mono">claude · haiku-4-5</span> at low effort, is Claude's cheapest model that can see — a fraction of a cent per
            image. Another provider works if its model can see images: Kimi or GLM (through Claude Code), a vision model on OpenRouter, Ollama or LM Studio,
            or the Codex and Gemini CLIs. If the one you pick cannot describe an image, Claude's default does it instead, and the file says so.
          </p>
        </Section>

        <Section
          title="Spec rewrite"
          hint="The ✦ Rewrite button on a task's Spec: Claude reads the code the request is about, then rewrites it into a clear spec with checkable outcomes. Your text is always kept, and each task can try another model."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field group label="Model" hint="Opus by default: it is one call per rewrite, and a spec that names the right files saves a whole run going the wrong way.">
              <ClaudeModelPicker value={specModel} onChange={setSpecModel} models={models} />
            </Field>
            <Field label="Effort" hint="High is Claude's default. Lower is quicker and cheaper for short requests.">
              <EffortSelect model={specModel} value={specEffort} onChange={setSpecEffort} />
            </Field>
          </div>
          <p className="mt-2 text-[11.5px] text-ink-500">It only reads — it cannot change a file — and it stops at $3 per rewrite. Its cost shows on the version and on the dashboard.</p>
        </Section>

        <Section
          title="Side chat"
          hint="The ✦ Chat panel: talk about a project, and have Claude write the task cards. It reads code and never changes it."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field group label="Model for new chats" hint="Sonnet is the balance: sharp enough to explain code and plan work, a fraction of Opus's price.">
              <ClaudeModelPicker value={chatModel} onChange={setChatModel} models={models} />
            </Field>
            <Field label="Effort" hint="How hard it thinks before answering. Medium suits questions; high for hard design talks.">
              <EffortSelect model={chatModel} value={chatEffort} onChange={setChatEffort} />
            </Field>
          </div>
          <p className="mt-2 text-[11.5px] text-ink-500">Each chat can switch model and effort from its own panel; this is only where new chats start.</p>
        </Section>

        <Section
          title="Right-sizing"
          hint="The board proposes a pipeline for each new task — which stages it needs, and the cheapest model that can do each one well. It never applies it: you press Use it, or Keep default."
        >
          <label className="mb-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={autoSizing} onChange={(e) => setAutoSizing(e.target.checked)} />
            <span>
              Propose a pipeline for each new task
              <span className="block text-[11.5px] text-ink-400">Costs nothing extra — it comes back in the same intake call that classifies the task.</span>
            </span>
          </label>
          <div className="grid gap-3 md:grid-cols-3">
            {([
              ["cheap", "Cheap", "Mechanical work: renames, copy changes, config."],
              ["balanced", "Balanced", "The everyday model for ordinary features and fixes."],
              ["strong", "Strong", "Only where getting it right is genuinely hard."],
            ] as const).map(([key, label, hint]) => (
              <Field key={key} label={label} hint={hint}>
                <ProviderPicker compact value={tiers[key]} models={models} providers={providers} onChange={(v) => setTiers({ ...tiers, [key]: v })} />
              </Field>
            ))}
          </div>
          <p className="mt-2 text-[11.5px] text-ink-500">
            Sizing picks a tier, never a model id, so it cannot invent one — and changing a model here changes every future
            proposal at once.
          </p>
        </Section>

        <Section title="Plan approval & live tasks" hint="Catch a wrong plan before any code is written, and put more care into tasks that touch real data.">
          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={planApproval} onChange={(e) => setPlanApproval(e.target.checked)} />
            <span>
              Wait for my approval after every plan
              <span className="block text-[11.5px] text-ink-400">
                Supervised and autonomous alike: when the Plan stage finishes, the task waits in <b>Needs you</b> with the plan, and you
                approve it, edit it, or send it back with a note. Each task can override this on its Pipeline tab.
              </span>
            </span>
          </label>
          <div className="mt-3" />
          <Field label="Review model for live tasks" hint="A task marked “touches a live system” always waits for plan approval, and its review stage runs on this model at high effort, whatever its pipeline says.">
            <ClaudeModelPicker value={liveReviewModel} onChange={setLiveReviewModel} models={models} />
          </Field>
        </Section>

        <Section title="Run ceilings" hint="Applied to every stage so a looping or runaway session stops by itself.">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Max turns per stage"><input type="number" min={1} max={500} className={`${inputCls} font-mono`} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value) || 1)} /></Field>
            <Field label="Continue after the turn limit" hint="A stage that uses all its turns carries on in the same session this many times (nothing is lost) before it fails. 0 = fail straight away."><input type="number" min={0} max={5} className={`${inputCls} font-mono`} value={autoContinue} onChange={(e) => setAutoContinue(Math.max(0, Math.min(5, Number(e.target.value) || 0)))} /></Field>
            <Field label="Max cost per stage (USD)"><input type="number" min={0.05} max={100} step={0.25} className={`${inputCls} font-mono`} value={maxCost} onChange={(e) => setMaxCost(Number(e.target.value) || 0.05)} /></Field>
            <Field label="Delegated stage timeout (minutes)" hint="Wall-clock ceiling for a stage on a text-only or CLI provider, which the board cannot meter mid-run."><input type="number" min={1} max={240} className={`${inputCls} font-mono`} value={delegateTimeout} onChange={(e) => setDelegateTimeout(Number(e.target.value) || 1)} /></Field>
            <Field label="Subagent nesting depth" hint="1 = a run may not spawn subagents that spawn more."><input type="number" min={1} max={5} className={`${inputCls} font-mono`} value={subDepth} onChange={(e) => setSubDepth(Number(e.target.value) || 1)} /></Field>
            <Field label="Max concurrent subagents" hint="A single prompt can otherwise fan out and burn a window in minutes."><input type="number" min={1} max={20} className={`${inputCls} font-mono`} value={subMax} onChange={(e) => setSubMax(Number(e.target.value) || 1)} /></Field>
          </div>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={cacheable} onChange={(e) => setCacheable(e.target.checked)} />
            <span>
              Cacheable system prompt
              <span className="block text-[11.5px] text-ink-400">
                Strips per-session sections (cwd, git status) so the prefix is reused across runs; the stripped content is re-sent as the
                first message. Measured: a warm stage reads ~34,700 tokens at a tenth of the price instead of paying for them.
              </span>
            </span>
          </label>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={loadPlugins} onChange={(e) => setLoadPlugins(e.target.checked)} />
            <span>
              Load your global plugins, hooks and skills into runs
              <span className="block text-[11.5px] text-ink-400">
                Measured at <b>~5,400 extra input tokens on every stage</b> (about 12%), paid whether the task uses them or not. Turning
                this off keeps project settings — CLAUDE.md and the project's own skills still load.
              </span>
            </span>
          </label>
        </Section>

        <Section
          title="Usage limits"
          hint="What happens when your Claude subscription window runs out in the middle of a task."
        >
          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={autoResume} onChange={(e) => setAutoResume(e.target.checked)} />
            <span>
              Pause and resume automatically
              <span className="block text-[11.5px] text-ink-400">
                A task stopped by the limit goes to <b className="text-iris">Paused</b> instead of Failed, and continues by itself when the
                window resets — in the same session, from the stage it was on, so nothing already done is redone. Off: it fails, and you
                press Retry. The same goes for another provider's plan running out (Settings → Providers → “When it runs out”).
              </span>
            </span>
          </label>
          <div className="mt-3 text-[12.5px] text-ink-200">
            When Claude's usage runs out mid-task
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <select
                className={`${inputCls} w-auto!`}
                value={claudeFallback ? "move" : "wait"}
                onChange={(e) => {
                  if (e.target.value === "wait") return setClaudeFallback(null);
                  const p = providers.find((x) => x.enabled && x.kind === "anthropic-compatible") ?? providers.find((x) => x.enabled);
                  setClaudeFallback(p ? { provider: p.id, model: p.models[0]?.id ?? "" } : null);
                }}
              >
                <option value="wait">Wait for it to reset</option>
                <option value="move" disabled={!providers.some((p) => p.enabled)}>Carry the stage on with another provider</option>
              </select>
              {claudeFallback ? (
                <div className="min-w-[300px] flex-1">
                  <ProviderPicker value={claudeFallback} onChange={setClaudeFallback} models={models} providers={providers} compact />
                </div>
              ) : null}
            </div>
            <span className="mt-1 block text-[11.5px] text-ink-400">
              {providers.some((p) => p.enabled)
                ? "Carrying on elsewhere keeps night work moving: the next model is told what Claude did and finds its changes in place. Claude stages go back to Claude on the next task."
                : "Add a provider (Settings → Providers) to be able to carry on elsewhere."}
            </span>
            {claudeFallback?.provider === ANTHROPIC_PROVIDER_ID ? <span className="mt-1 block text-[11.5px] text-rust">Pick another provider: Claude cannot stand in for itself.</span> : null}
          </div>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={keepAwake} onChange={(e) => setKeepAwake(e.target.checked)} />
            <span>
              Keep this computer awake while work is waiting
              <span className="block text-[11.5px] text-ink-400">
                While anything is queued, running or scheduled, the computer is asked not to go to sleep, so night work actually
                happens. The screen can still turn off. The board has to stay open, and closing a laptop's lid may still put it to
                sleep (Windows: Control Panel, Power Options, "Choose what closing the lid does").
              </span>
            </span>
          </label>
          <div className="mt-4 text-[12.5px] text-ink-200">
            When Claude asks you a question mid-task
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <select className={`${inputCls} w-auto!`} value={questionWait} onChange={(e) => setQuestionWait(Number(e.target.value))}>
                <option value={0}>Wait for my answer, however long it takes</option>
                {[15, 30, 60, 120, 240].map((m) => (
                  <option key={m} value={m}>Wait {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}, then let Claude decide</option>
                ))}
              </select>
            </div>
            <span className="mt-1 block text-[11.5px] text-ink-400">
              The task shows <b className="text-iris">asks you</b> and plays the “needs you” sound. Waiting is safest for decisions that
              matter; a time limit keeps night work moving: Claude picks the most sensible option and says which in its summary.
            </span>
          </div>
        </Section>

        <Section
          title="Guardrails"
          hint="What stops an unattended run from doing damage or burning a window. These apply in both modes and cannot be overridden by a settings file or by the model."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Max cost per task (USD)" hint="Across every stage and retry. A 3-stage task can otherwise cost 3× the per-stage cap.">
              <input type="number" min={0.1} max={500} step={1} className={`${inputCls} font-mono`} value={maxTaskCost} onChange={(e) => setMaxTaskCost(Number(e.target.value) || 0.1)} />
            </Field>
            <Field label="Stop after N identical tool calls" hint="A session repeating one call is stuck, not working. It is stopped and the reason is recorded.">
              <input type="number" min={2} max={50} className={`${inputCls} font-mono`} value={maxRepeats} onChange={(e) => setMaxRepeats(Number(e.target.value) || 2)} />
            </Field>
          </div>
          <Field
            label="Blocked commands"
            hint={<>One per line, matched case-insensitively against the whole command. These are refused outright — <b>not</b> offered as an approval card, because a card is just a chance to click the wrong button.</>}
          >
            <textarea className={`${inputCls} mt-1 min-h-[120px] font-mono text-[12.5px]`} value={blocked} onChange={(e) => setBlocked(e.target.value)} />
          </Field>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={readsFree} onChange={(e) => setReadsFree(e.target.checked)} />
            <span>
              Supervised tasks: run read-only commands without a card
              <span className="block text-[11.5px] text-ink-400">
                Commands that only look — <code>grep</code>, <code>wc</code>, <code>ls</code>, <code>git status</code>, <code>git diff</code> — run straight away
                and are listed in the run log, so the cards you get are the ones that change something. Anything the board can't prove is
                read-only (a script, a redirect to a file, <code>python</code>, <code>npm</code>) still asks.
              </span>
            </span>
          </label>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Field label="Keep transcripts for (days)" hint="Runs, costs and results are kept forever; only the message-by-message detail of old finished runs is pruned, on restart.">
              <input type="number" min={1} max={365} className={`${inputCls} font-mono`} value={retention} onChange={(e) => setRetention(Number(e.target.value) || 1)} />
            </Field>
            <Field label="Desktop notifications" hint="When a task needs approval, is ready for review, or fails — only while the board is in a background tab." group>
              <Button
                onClick={() =>
                  void (async () => {
                    if (notif === "on") {
                      disableNotifications();
                      setNotif("off");
                    } else setNotif((await enableNotifications()) ? "on" : "off");
                  })()
                }
                disabled={notif === "unsupported"}
              >
                {notif === "unsupported" ? "Not supported here" : notif === "on" ? "On — turn off" : "Turn on"}
              </Button>
            </Field>
          </div>
        </Section>

        <Section title="State">
          <div className="font-mono text-[12px] text-ink-300">{settings.stateDir}</div>
          <div className="mt-1 text-[11.5px] text-ink-500">kanban.db + logs\ live here. Worktrees live in each project's .kanban\wt\ (git-excluded locally).</div>
        </Section>
        </>) : null}

        {tab === "tools" ? (<>
        <Section
          title="Browser checks"
          hint="Lets a run open what it built and look at it, the way Claude Code does — instead of only saying it should look right."
        >
          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={browserChecks} onChange={(e) => setBrowserChecks(e.target.checked)} />
            <span>
              Check visible changes in a browser
              <span className="block text-[11.5px] text-ink-400">
                Each run gets its own browser (Playwright, in the background — no windows open over your work). When a change affects
                something you can see, the code stage starts the app on the task's own port, takes a screenshot and fixes what looks
                wrong; the review stage looks for itself before approving. Screenshots appear in the task's <b>Files</b> tab.
                Nothing visible changed? It skips the whole thing, so a backend task pays nothing for it.
              </span>
            </span>
          </label>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-ink-500">
                <tr><th className="py-1 pr-3 font-medium">In the browser</th><th className="py-1 pr-3 font-medium">Autonomous</th><th className="py-1 font-medium">Supervised</th></tr>
              </thead>
              <tbody className="text-ink-300">
                {([
                  ["Open a local page, take screenshots, read the console", "yes", "yes, no card — nothing changes"],
                  ["Click, type, fill forms on a local page", "yes", "approval card"],
                  ["Open any other site", "refused", "approval card"],
                  ["Run custom browser code, upload files", "refused", "approval card"],
                ] as const).map(([what, auto, sup]) => (
                  <tr key={what} className="border-t border-ink-800">
                    <td className="py-1 pr-3">{what}</td>
                    <td className={`py-1 pr-3 ${auto === "refused" ? "text-rust" : "text-moss"}`}>{auto}</td>
                    <td className="py-1">{sup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={liveView} onChange={(e) => setLiveView(e.target.checked)} />
            <span>
              Live view: watch a task use its browser
              <span className="block text-[11.5px] text-ink-400">
                A task's <b>Browser</b> tab shows its page as it clicks and types, and a <b className="text-rose">live</b> chip appears on its
                card. The picture is streamed only while you are watching; nothing is recorded beyond the screenshots in Files.
              </span>
            </span>
          </label>
          <label className="mt-4 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={chrome} onChange={(e) => setChrome(e.target.checked)} />
            <span>
              Also offer Claude in Chrome to supervised tasks
              <span className="block text-[11.5px] text-ink-400">
                Your own Chrome, signed in to your accounts — for checks that need your login. Every action in it is an approval card,
                and autonomous tasks never get it, whatever this says. Needs the Claude in Chrome extension.
              </span>
            </span>
          </label>
        </Section>
        <SessionToolsPanel />
        </>) : null}

        {tab === "git" && project ? <GitSettings project={project} /> : null}
        {tab === "project" && project ? (<>
          <ProjectSettings project={project} />
          <WorkspaceSettings project={project} />
        </>) : null}
        {tab === "claudemd" && project ? <ClaudeMdSettings project={project} /> : null}
        {tab === "memory" && project ? <MemorySettings project={project} /> : null}
        {tab === "worktrees" && project ? <WorktreeSettings project={project} /> : null}
      </div>
    </div>
  );
}
