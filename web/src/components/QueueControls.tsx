import { useEffect, useState } from "react";
import type { ProviderOut, Task } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useAppData } from "../lib/store.tsx";
import { useWs } from "../lib/ws.ts";
import { clock, until } from "../lib/format.ts";
import { Switch } from "./ui.tsx";

/**
 * One task at a time, or several. This writes the global setting, so it reads the same on every
 * project's board — said out loud in the tooltip rather than left to be discovered.
 */
export function SerialSwitch() {
  const { settings, setSettings } = useAppData();
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const serial = settings.serial;
  const flip = async (on: boolean) => {
    setBusy(true);
    try {
      setSettings(await api.patchSettings({ serial: on }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="flex items-center gap-2 whitespace-nowrap font-mono text-[11px] text-ink-400">
      <Switch
        on={serial}
        disabled={busy}
        onChange={(v) => void flip(v)}
        title={
          serial
            ? `Running one task at a time: each finishes and commits before the next starts. Applies to every project. Turn off to run up to ${settings.globalCap} at once.`
            : `Running up to ${settings.globalCap} tasks at once. Turn on to run them one at a time, which spends your limit more slowly. Applies to every project.`
        }
      />
      one at a time
    </label>
  );
}

/**
 * Why nothing is starting. The queue holds Claude work while a usage window is shut, but keeps
 * running stages delegated to other providers — which is not obvious from a card sitting in queued.
 */
export function LimitBanner() {
  const { settings } = useAppData();
  const [paused, setPaused] = useState<Task[]>([]);
  const [outs, setOuts] = useState<ProviderOut[]>([]);
  const load = () => void api.pausedTasks().then(setPaused, () => {});
  const loadOuts = () => void api.providerOuts().then(setOuts, () => {});
  useEffect(() => {
    load();
    loadOuts();
  }, []);
  useWs((m) => {
    if (m.type === "task.updated" && (m.task.status === "paused" || paused.some((p) => p.id === m.task.id))) load();
    if (m.type === "providers.out") setOuts(m.out);
  });
  // Re-render every half minute so the countdown stays true without a request.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  // Tasks paused for another provider are that provider's business, not Claude's window.
  const waiting = paused.filter((t) => t.pause_reason !== "provider" && t.resume_at && Date.parse(t.resume_at) > now);
  const away = outs.filter((o) => !o.resets_at || Date.parse(o.resets_at) > now);
  if (!waiting.length && !away.length) return null;
  const opens = waiting.length ? Math.max(...waiting.map((t) => Date.parse(t.resume_at!))) : 0;
  const label = (id: string) => settings?.providers.find((p) => p.id === id)?.label ?? id;

  return (
    <div className="flex flex-col gap-1 border-b border-iris/30 bg-iris/10 px-6 py-1.5 text-[12px] text-ink-200">
      {waiting.length ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-iris" />
          <span>
            Claude limit reached. Claude work resumes <span className="font-mono text-iris">{until(opens)}</span> · {clock(opens)}.
          </span>
          <span className="text-ink-400">Queued Claude tasks wait for the window; stages delegated to other providers keep running.</span>
        </div>
      ) : null}
      {away.map((o) => (
        <div key={o.provider_id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${o.kind === "credit" ? "bg-rust" : "bg-iris"}`} />
          {o.kind === "credit" ? (
            <span>
              <b className="text-rust">{label(o.provider_id)} is out of credit.</b>{" "}
              <span className="text-ink-400">Its paused tasks wait for you: open one to switch provider, or top up and press Try again.</span>
            </span>
          ) : (
            <span>
              {label(o.provider_id)} is out until <span className="font-mono text-iris">{until(o.resets_at)}</span> · {clock(o.resets_at!)}.{" "}
              <span className="text-ink-400">Its work waits and carries on by itself; everything else keeps running.</span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
