import { useEffect, useState, type ReactNode } from "react";
import { api, type SetupCheckResult } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useWs } from "../lib/ws.ts";
import { enableNotifications, notifyState } from "../lib/notify.ts";
import { Button, ErrorLine, inputCls, useAction } from "../components/ui.tsx";

const GROUPS = [
  { level: "required", title: "Required", hint: "The board does not work without these." },
  { level: "recommended", title: "Recommended", hint: "Features that are on by default use these." },
  { level: "optional", title: "Optional", hint: "For what you have set up, plus free AI on this computer if you want it. Nothing here is needed." },
  { level: "info", title: "Good to know", hint: "" },
] as const;

/** Required + recommended items still failing, for the nav badge. */
export function useSetupCount(): number {
  const [n, setN] = useState(0);
  const load = () => void api.setup().then((r) => setN(r.summary.required + r.summary.recommended), () => {});
  useEffect(load, []);
  useWs((m) => {
    if (m.type === "setup.updated" || m.type === "health.updated" || m.type === "settings.updated") load();
  });
  return n;
}

function Shell({ ok, level, title, detail, why, actions, children }: { ok: boolean; level: string; title: string; detail: string; why: string; actions?: ReactNode; children?: ReactNode }) {
  const dot = ok ? "bg-moss" : level === "required" ? "bg-rust" : level === "recommended" ? "bg-amber" : "bg-ink-500";
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/60 p-3">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-ink-100">{title}</span>
            <span className={`break-words font-mono text-[11px] ${ok ? "text-moss" : "text-ink-400"}`}>{detail}</span>
          </div>
          <p className="mt-0.5 text-[12px] text-ink-500">{why}</p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap justify-end gap-1.5">{actions}</div> : null}
      </div>
      {children ? <div className="mt-2.5 space-y-2 pl-5">{children}</div> : null}
    </div>
  );
}

function Row({ c, output, onChange }: { c: SetupCheckResult; output?: string; onChange: (c: SetupCheckResult) => void }) {
  const { busy, error, run } = useAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const external = (href: string) => /^https?:/.test(href);
  const filled = (c.form ?? []).every((f) => form[f.name]?.trim());
  const actions = (
    <>
      {c.fixes.includes("login") ? (
        <Button size="sm" variant="primary" busy={loggingIn && !c.ok} onClick={() => run(async () => { setLoggingIn(true); await api.login(); })}>
          {loggingIn ? "Waiting for login…" : "Log in to Claude"}
        </Button>
      ) : null}
      {c.fixes.includes("run") ? (
        <Button size="sm" variant="primary" busy={c.running} disabled={!filled} onClick={() => run(() => api.fixSetup(c.id, { kind: "run", input: form }))}>
          {c.form ? "Save" : c.runLabel ?? "Install"}
        </Button>
      ) : null}
      {c.fixes.includes("claude") && !c.taskId ? (
        <Button size="sm" variant={c.fixes.includes("run") ? "outline" : "primary"} onClick={() => run(async () => {
          const r = await api.fixSetup(c.id, { kind: "claude" });
          if (r.task) navigate({ taskId: r.task.id });
        })}>
          Fix with Claude
        </Button>
      ) : null}
      {c.link && !c.ok ? (
        <a className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-ink-300 hover:text-amber" href={c.link.href} target={external(c.link.href) ? "_blank" : undefined} rel="noreferrer">
          {c.link.label}
        </a>
      ) : null}
      <Button size="sm" variant="ghost" busy={busy} onClick={() => run(async () => onChange(await api.recheckSetup(c.id)))}>Re-check</Button>
    </>
  );
  return (
    <Shell ok={c.ok} level={c.level} title={c.title} detail={c.detail} why={c.why} actions={actions}>
      {!c.ok && c.form && c.fixes.includes("run") ? (
        <div className="grid gap-2 md:grid-cols-2">
          {c.form.map((f) => (
            <input key={f.name} className={inputCls} placeholder={`${f.label} — ${f.placeholder}`} value={form[f.name] ?? ""} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
          ))}
        </div>
      ) : null}
      {!c.ok && c.manual ? (
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11.5px] text-ink-200">{c.manual}</pre>
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(c.manual!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
      {output ? <pre className="max-h-48 overflow-auto rounded border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11px] text-ink-300">{output}</pre> : null}
      {c.taskId ? (
        <button className="cursor-pointer text-[12px] text-cyan underline underline-offset-2" onClick={() => navigate({ taskId: c.taskId })}>
          Claude is working on it — open the session (approve its commands there)
        </button>
      ) : null}
      <ErrorLine error={error} />
    </Shell>
  );
}

/** The browser's permission, not the machine's: checked and asked for right here. */
function NotificationsRow() {
  const [state, setState] = useState(notifyState());
  return (
    <Shell
      ok={state === "on"}
      level="optional"
      title="Desktop notifications"
      detail={state === "on" ? "On" : state === "unsupported" ? "Not supported in this browser" : "Off"}
      why="A pop-up when a run needs you or a task finishes, while the board is in the background."
      actions={state === "off" ? <Button size="sm" variant="primary" onClick={() => void enableNotifications().then(() => setState(notifyState()))}>Turn on</Button> : undefined}
    />
  );
}

export function Setup() {
  const [checks, setChecks] = useState<SetupCheckResult[] | null>(null);
  const [out, setOut] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const load = (fresh = false) => {
    setBusy(true);
    void api.setup(fresh).then((r) => setChecks(r.checks), () => setChecks([])).finally(() => setBusy(false));
  };
  useEffect(() => load(true), []);
  useWs((m) => {
    if (m.type === "setup.updated") setChecks((cs) => cs?.map((c) => (c.id === m.check.id ? m.check : c)) ?? cs);
    if (m.type === "setup.output") setOut((o) => ({ ...o, [m.id]: ((o[m.id] ?? "") + m.chunk).slice(-20_000) }));
    if (m.type === "health.updated" || m.type === "settings.updated") load();
  });
  const put = (c: SetupCheckResult) => setChecks((cs) => cs?.map((x) => (x.id === c.id ? c : x)) ?? cs);
  const failing = (checks ?? []).filter((c) => !c.ok && (c.level === "required" || c.level === "recommended")).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <h1 className="text-[17px] font-semibold text-ink-100">Setup</h1>
            <p className="mt-1 text-[12.5px] text-ink-400">
              {checks === null ? "Looking at this computer…" : failing ? `${failing} thing${failing > 1 ? "s" : ""} to fix. Install does it in one click; Fix with Claude asks before every command.` : "Everything the board needs is here."}
            </p>
          </div>
          <Button size="sm" busy={busy} onClick={() => load(true)}>Re-check all</Button>
        </div>
        {GROUPS.map((g) => {
          const rows = (checks ?? []).filter((c) => c.level === g.level);
          if (!rows.length && g.level !== "optional") return null;
          return (
            <section key={g.level} className="space-y-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{g.title}</div>
                {g.hint ? <div className="text-[11.5px] text-ink-500">{g.hint}</div> : null}
              </div>
              {rows.map((c) => <Row key={c.id} c={c} output={out[c.id]} onChange={put} />)}
              {g.level === "optional" ? <NotificationsRow /> : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
