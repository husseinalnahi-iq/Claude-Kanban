import { useEffect, useState } from "react";
import type { SetupCheckResult, SuggestedSkill } from "../../../../server/src/types.ts";
import { api, type SuggestedList } from "../../lib/api.ts";
import { navigate } from "../../lib/router.ts";
import { useWs, useWsReconnect } from "../../lib/ws.ts";
import { Button, Chip, Switch } from "../../components/ui.tsx";

const UNATTENDED: Record<SuggestedSkill["tooltip"]["unattended"], string> = {
  yes: "Works unattended",
  note: "Works unattended, with a note",
  person: "Needs a person",
};

/**
 * The ⓘ on a card: whether it works with nobody watching, what to watch out for, how to turn it off.
 * The box is placed against the card, not the icon, so it never runs off the edge of the page in the
 * right-hand column. Focus opens it too, so a tap works on a touch screen.
 */
function Info({ s }: { s: SuggestedSkill }) {
  return (
    <>
      <span
        tabIndex={0}
        role="note"
        aria-label={`About ${s.name}`}
        className="peer/info flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-ink-600 font-serif text-[10px] italic leading-none text-ink-400 transition-colors hover:border-amber hover:text-amber focus:border-amber focus:text-amber focus:outline-none"
      >
        i
      </span>
      <span className="pointer-events-none absolute inset-x-2 top-9 z-50 rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-[12px] font-normal leading-snug text-ink-200 opacity-0 kb-raise-sm transition-opacity peer-hover/info:opacity-100 peer-focus/info:opacity-100">
        <span className="block font-semibold text-ink-100">{UNATTENDED[s.tooltip.unattended]}</span>
        <span className="mt-1 block">
          <span className="text-ink-400">Watch out for: </span>
          {s.tooltip.watch}
        </span>
        {s.tooltip.off ? (
          <span className="mt-1 block">
            <span className="text-ink-400">Turning it off: </span>
            {s.tooltip.off}
          </span>
        ) : null}
        <span className="mt-1 block font-mono text-[10.5px] text-ink-500">
          {s.kind} · {s.from}
        </span>
      </span>
    </>
  );
}

/** "Install with Claude", and the way back to the session it started (approve its commands there). */
function WithClaude({ s, check, act }: { s: SuggestedSkill; check?: SetupCheckResult; act: (fn: () => Promise<unknown>) => void }) {
  if (!check || check.ok) return null;
  if (check.taskId) {
    return (
      <button className="cursor-pointer text-left text-[12px] text-cyan underline underline-offset-2" onClick={() => navigate({ taskId: check.taskId })}>
        Claude is installing it: open the session
      </button>
    );
  }
  if (!check.fixes.includes("claude")) return null;
  return (
    <Button
      size="sm"
      title="A Claude session installs it, and asks you before every command"
      onClick={() => act(async () => {
        const r = await api.fixSetup(s.check, { kind: "claude" });
        if (r.task) navigate({ taskId: r.task.id });
      })}
    >
      Install with Claude
    </Button>
  );
}

function Card({
  s, check, fitsHere, output, onError, onCheck,
}: {
  s: SuggestedSkill;
  /** Its Setup check: Install with Claude for every card, and the whole state of a tool. */
  check?: SetupCheckResult;
  fitsHere: boolean;
  output: string;
  onError: (e: string) => void;
  onCheck: (c: SetupCheckResult) => void;
}) {
  const act = (fn: () => Promise<unknown>) => void fn().catch((e: Error) => onError(`${s.name}: ${e.message}`));
  const lastLine = output.trim().split("\n").at(-1) ?? "";
  const tool = s.kind === "tool";
  const installed = tool ? Boolean(check?.ok) : s.status === "installed";
  const running = tool ? (check?.running ? "install" : null) : s.running;
  return (
    <div className={`relative flex flex-col rounded-lg border bg-ink-850 px-3.5 py-3 ${installed ? "border-moss/40" : "border-ink-700"}`}>
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-[12.5px] font-semibold text-ink-100">{s.name}</span>
        <Info s={s} />
        {s.enabled !== null && !s.running ? (
          <span className="ml-auto">
            <Switch
              on={s.enabled}
              onChange={(v) => act(() => api.setSuggestedEnabled(s.id, v))}
              title={s.enabled ? "On: your tasks can use it" : "Off: your tasks do not connect to it"}
            />
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 flex-1 text-[12px] leading-snug text-ink-300">{s.what}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {s.starter ? <Chip className="border-amber/50 text-amber">Starter pack</Chip> : null}
        <Chip className="border-ink-600 text-ink-400">Free</Chip>
        {s.tooltip.unattended !== "person" ? (
          <Chip className="border-ink-600 text-ink-400" title={UNATTENDED[s.tooltip.unattended]}>
            Works unattended{s.tooltip.unattended === "note" ? " *" : ""}
          </Chip>
        ) : null}
        {s.fits === "web" ? <Chip className="border-ink-600 text-ink-400">Web projects</Chip> : null}
        {s.fits === "react" ? <Chip className="border-ink-600 text-ink-400">React projects</Chip> : null}
        {s.needsPython ? <Chip className="border-ink-600 text-ink-400">Needs Python</Chip> : null}
        {tool ? <Chip className="border-ink-600 text-ink-400">Tool</Chip> : null}
        {fitsHere ? <Chip className="border-moss/50 text-moss">Good for this project</Chip> : null}
      </div>
      {s.missing.length ? (
        <p className="mt-2 text-[11.5px] leading-snug text-amber">Not found on this computer: {s.missing.join(" and ")}. Install it too, or this will not fully work.</p>
      ) : null}
      {/* What its check found that the card does not already say: a plugin switched off, no Python that fits. */}
      {check && !check.ok && (check.warn || (tool && !/^Not (installed|added)/.test(check.detail))) ? (
        <p className={`mt-2 text-[11.5px] leading-snug ${check.warn ? "text-amber" : "text-ink-400"}`}>{check.detail}</p>
      ) : null}
      {s.error && !s.running ? (
        <details className="mt-2 text-[11.5px] text-rust">
          <summary className="cursor-pointer">That did not work. Show what happened</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-rust/30 bg-ink-950 p-2 font-mono text-[10.5px] text-ink-300">{s.error}</pre>
        </details>
      ) : null}
      {tool && output && !check?.ok ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-ink-800 bg-ink-950 p-2 font-mono text-[10.5px] text-ink-300">{output.slice(-3000)}</pre>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {running ? (
          <>
            <Button size="sm" busy disabled>
              {running === "install" ? "Installing" : "Removing"}
            </Button>
            {!tool ? (
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-500" title={lastLine}>
                {lastLine || "Waiting its turn…"}
              </span>
            ) : null}
          </>
        ) : installed ? (
          <>
            <span className="text-[12px] text-moss">✓ {tool ? (check?.detail ?? "Installed") : "Installed"}</span>
            {!tool ? (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => act(() => api.removeSuggested(s.id))}>
                Remove
              </Button>
            ) : null}
          </>
        ) : s.status === "installed-elsewhere" ? (
          <span className="text-[12px] text-ink-400" title="You or another tool installed it, so the board leaves it alone.">
            ✓ Already on this computer (not installed by the board)
          </span>
        ) : tool ? (
          <>
            {check?.fixes.includes("run") ? (
              <Button size="sm" variant="primary" onClick={() => act(() => api.fixSetup(s.check, { kind: "run" }))}>Install</Button>
            ) : null}
            <WithClaude s={s} check={check} act={act} />
            {check && (check.warn || !check.fixes.length) ? (
              <Button size="sm" variant="ghost" onClick={() => act(async () => onCheck(await api.recheckSetup(s.check)))}>Check again</Button>
            ) : null}
            {!check ? <span className="text-[12px] text-ink-500">Checking…</span> : null}
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => act(() => api.installSuggested(s.id))}>
              {s.error ? "Try again" : "Install"}
            </Button>
            <WithClaude s={s} check={check} act={act} />
          </>
        )}
        <a className="ml-auto text-[11.5px] text-ink-400 hover:text-amber" href={s.link} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
    </div>
  );
}

/**
 * The Skills tab's Recommended list (spec 2026-09-12 §3, D317–D321): one click in, one click out, or
 * installed by a Claude session that asks first. MarkItDown, a tool, is installed by its Setup check.
 * Installs run on the server one at a time; each card follows its own over the websocket.
 */
export function Suggested({ projectId, onInstalledChange }: { projectId?: string; onInstalledChange: () => void }) {
  const [data, setData] = useState<SuggestedList | null>(null);
  const [checks, setChecks] = useState<Record<string, SetupCheckResult>>({});
  const [output, setOutput] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = () => void api.suggestedSkills(projectId).then(setData, (e: Error) => setError(`The recommended skills could not be loaded: ${e.message}`));
  const putCheck = (c: SetupCheckResult) => setChecks((cs) => ({ ...cs, [c.id]: c }));
  // Fresh on opening the page: MarkItDown's check starts the tool to see whether it answers.
  const loadChecks = (fresh: boolean) =>
    void api.recommendedSkills(fresh).then((r) => setChecks(Object.fromEntries(r.checks.map((c) => [c.id, c]))), () => {});
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => loadChecks(true), []);
  useWsReconnect(() => {
    load();
    loadChecks(false);
  });
  useWs((m) => {
    if (m.type === "skills.output") setOutput((o) => ({ ...o, [m.id]: ((o[m.id] ?? "") + m.chunk).slice(-2000) }));
    if (m.type === "skills.suggested") {
      setData((d) => (d ? { ...d, skills: d.skills.map((x) => (x.id === m.skill.id ? m.skill : x)) } : d));
      // A finished install or removal changes the list of skills below.
      if (!m.skill.running) {
        setOutput((o) => ({ ...o, [m.skill.id]: "" }));
        onInstalledChange();
      }
    }
    // A check changes when Install with Claude's session stops, or a tool finishes installing.
    if (m.type === "setup.updated" && m.check.id in checks) {
      const was = checks[m.check.id];
      putCheck(m.check);
      if (m.check.ok && !was?.ok) {
        load();
        onInstalledChange();
      }
    }
    if (m.type === "setup.output" && m.id in checks) setOutput((o) => ({ ...o, [m.id]: ((o[m.id] ?? "") + m.chunk).slice(-20_000) }));
  });

  if (!data) return error ? <div className="text-[12px] text-rust">{error}</div> : null;
  const starter = data.skills.filter((s) => s.starter);
  const starterIn = starter.filter((s) => s.status !== "not-installed").length;
  const starterBusy = starter.some((s) => s.running);
  const fitsHere = (s: SuggestedSkill) => (s.fits === "react" ? data.project.react : s.fits === "web" ? data.project.web : false);
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-ink-300">Recommended</h2>
        <span className="text-[11.5px] text-ink-500">
          Checked to work with nobody watching, and installed for you rather than one project. Once installed, each skill has its switch in the list below.
        </span>
        <Button
          size="sm"
          variant={starterIn === starter.length ? "ghost" : "go"}
          className="ml-auto"
          disabled={starterIn === starter.length || starterBusy}
          busy={starterBusy}
          title="Installs the five essentials in one go"
          onClick={() => void api.installStarterPack().catch((e: Error) => setError(e.message))}
        >
          {starterIn === starter.length ? "Starter pack installed" : `Install the starter pack (${starterIn} of ${starter.length} installed)`}
        </Button>
      </div>
      {!data.loadUserPlugins ? (
        <div className="mb-2 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] text-amber">
          Your tasks only use these when “Load your global plugins, hooks and skills into runs” is on (Settings → Runs &amp; limits).
        </div>
      ) : null}
      {error ? (
        <div className="mb-2 text-[12px] text-rust">
          {error}{" "}
          <button className="underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]">
        {data.skills.map((s) => (
          <Card
            key={s.id}
            s={s}
            check={checks[s.check]}
            fitsHere={fitsHere(s)}
            output={output[s.kind === "tool" ? s.check : s.id] ?? ""}
            onError={setError}
            onCheck={putCheck}
          />
        ))}
      </div>
      <p className="mt-2.5 text-[11.5px] text-ink-500">
        Already built into Claude Code, nothing to install: <span className="font-mono">/code-review</span>, <span className="font-mono">/simplify</span> and{" "}
        <span className="font-mono">/security-review</span>.
      </p>
    </section>
  );
}
