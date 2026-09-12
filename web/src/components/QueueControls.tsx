import { useEffect, useState } from "react";
import type { Task } from "../../../server/src/types.ts";
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
  const [paused, setPaused] = useState<Task[]>([]);
  const load = () => void api.pausedTasks().then(setPaused, () => {});
  useEffect(load, []);
  useWs((m) => {
    if (m.type === "task.updated" && (m.task.status === "paused" || paused.some((p) => p.id === m.task.id))) load();
  });
  // Re-render every half minute so the countdown stays true without a request.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const waiting = paused.filter((t) => t.resume_at && Date.parse(t.resume_at) > now);
  if (!waiting.length) return null;
  const opens = Math.max(...waiting.map((t) => Date.parse(t.resume_at!)));

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-iris/30 bg-iris/10 px-6 py-1.5 text-[12px] text-ink-200">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-iris" />
      <span>
        Claude limit reached. Claude work resumes <span className="font-mono text-iris">{until(opens)}</span> · {clock(opens)}.
      </span>
      <span className="text-ink-400">Queued Claude tasks wait for the window; stages delegated to other providers keep running.</span>
    </div>
  );
}
