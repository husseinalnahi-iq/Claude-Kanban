import { useEffect, useState } from "react";
import type { Task, UsageLimit, WsMessage } from "../../../server/src/types.ts";
import { api } from "./api.ts";
import { clock, until } from "./format.ts";
import { desktopNotify } from "./notify.ts";
import { playSound, type SoundId, type SoundTheme } from "./sounds.ts";

/**
 * What the board tells you about, and how: a sound, a pop-up in the board, and a desktop
 * notification when the board is in a background tab. Each kind has its own sound and its own
 * colour — the same colour the board already uses for that state, so a rose pop-up means the same
 * thing as a rose card: it needs you.
 */
export type AlertKind = SoundId;

export interface AlertKindInfo {
  kind: AlertKind;
  label: string;
  hint: string;
  /** CSS colour token, shared with the board's status colours. */
  color: string;
  icon: string;
  defaults: { sound: boolean; toast: boolean; desktop: boolean };
}

export const ALERT_KINDS: AlertKindInfo[] = [
  { kind: "approval", label: "Needs your approval", hint: "A supervised run is waiting on a card", color: "var(--color-rose)", icon: "✋", defaults: { sound: true, toast: true, desktop: true } },
  { kind: "review", label: "Ready for review", hint: "Every stage finished; your turn to look", color: "var(--color-lime)", icon: "◉", defaults: { sound: true, toast: true, desktop: true } },
  { kind: "done", label: "Landed", hint: "Approved and merged", color: "var(--color-moss)", icon: "✓", defaults: { sound: true, toast: true, desktop: false } },
  { kind: "failed", label: "Failed", hint: "A run, a check or a review said no", color: "var(--color-rust)", icon: "✕", defaults: { sound: true, toast: true, desktop: true } },
  { kind: "paused", label: "Paused by usage limit", hint: "Waiting for your window to reset", color: "var(--color-iris)", icon: "❚❚", defaults: { sound: true, toast: true, desktop: true } },
  { kind: "resumed", label: "Resumed", hint: "The window reset and it carried on", color: "var(--color-iris)", icon: "▶", defaults: { sound: true, toast: true, desktop: false } },
  { kind: "started", label: "Started", hint: "A task began its first stage", color: "var(--color-amber)", icon: "↗", defaults: { sound: false, toast: true, desktop: false } },
  { kind: "usage", label: "Usage getting high", hint: "A window passed 80% or 95%", color: "var(--color-amber)", icon: "◔", defaults: { sound: true, toast: true, desktop: true } },
  { kind: "allClear", label: "All clear", hint: "Nothing running, queued or waiting on you", color: "var(--color-cyan)", icon: "✦", defaults: { sound: true, toast: true, desktop: false } },
];
export const kindInfo = (k: AlertKind) => ALERT_KINDS.find((x) => x.kind === k)!;

// ---------------------------------------------------------------- preferences (per machine)

type Channel = "sound" | "toast" | "desktop";
export interface AlertPrefs {
  theme: SoundTheme;
  volume: number;
  muted: boolean;
  kinds: Record<AlertKind, Record<Channel, boolean>>;
}

const KEY = "kanban.alerts";
const DEFAULTS: AlertPrefs = {
  theme: "chimes",
  volume: 0.6,
  muted: false,
  kinds: Object.fromEntries(ALERT_KINDS.map((k) => [k.kind, { ...k.defaults }])) as AlertPrefs["kinds"],
};

function read(): AlertPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AlertPrefs> | null;
    if (!v) return DEFAULTS;
    return {
      theme: ["chimes", "arcade", "soft"].includes(v.theme as string) ? (v.theme as SoundTheme) : DEFAULTS.theme,
      volume: typeof v.volume === "number" ? Math.min(1, Math.max(0, v.volume)) : DEFAULTS.volume,
      muted: Boolean(v.muted),
      // Kinds added later start at their defaults instead of vanishing.
      kinds: Object.fromEntries(ALERT_KINDS.map((k) => [k.kind, { ...k.defaults, ...(v.kinds?.[k.kind] ?? {}) }])) as AlertPrefs["kinds"],
    };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();
const prefListeners = new Set<(p: AlertPrefs) => void>();

export function setAlertPrefs(patch: Partial<AlertPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked: the change still holds for this session
  }
  for (const l of prefListeners) l(prefs);
}

export function setKindChannel(kind: AlertKind, channel: Channel, on: boolean) {
  setAlertPrefs({ kinds: { ...prefs.kinds, [kind]: { ...prefs.kinds[kind], [channel]: on } } });
}

export function useAlertPrefs(): AlertPrefs {
  const [p, setP] = useState(prefs);
  useEffect(() => {
    prefListeners.add(setP);
    return () => void prefListeners.delete(setP);
  }, []);
  return p;
}

// ---------------------------------------------------------------- the alert stream

export interface Alert {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  taskId?: string;
  projectId?: string;
  at: number;
  /** A preview from the settings panel: shown and heard, never sent to the desktop. */
  preview?: boolean;
}

const alertListeners = new Set<(a: Alert) => void>();
export const onAlert = (fn: (a: Alert) => void) => {
  alertListeners.add(fn);
  return () => void alertListeners.delete(fn);
};

let seq = 0;
/** Sounds of one kind within this window collapse into one, so ten subtasks finishing is one chime. */
const lastSound = new Map<AlertKind, number>();

export function raise(a: Omit<Alert, "id" | "at">) {
  const alert: Alert = { ...a, id: `al${++seq}`, at: Date.now() };
  const ch = prefs.kinds[alert.kind];
  // Previews play their own sound (even when this kind is set to silent), so they skip this one.
  if (!alert.preview && ch.sound && !prefs.muted && Date.now() - (lastSound.get(alert.kind) ?? 0) > 1200) {
    lastSound.set(alert.kind, Date.now());
    playSound(alert.kind, prefs.theme, prefs.volume);
  }
  if (ch.toast || alert.preview) for (const l of alertListeners) l(alert);
  if (ch.desktop && !alert.preview) desktopNotify(kindInfo(alert.kind).label, `${alert.title} — ${alert.body}`, `${alert.kind}-${alert.taskId ?? ""}`);
  if (document.visibilityState !== "visible" && !alert.preview) noteUnseen(alert.kind);
}

// ---------------------------------------------------------------- what counts as an event

interface Known {
  status: Task["status"];
  title: string;
  project: string;
  stages: number;
}
const known = new Map<string, Known>();
/** The last stage that finished, per task — how "ready for review" is told apart from "review stage running". */
const lastFinished = new Map<string, number>();
/** Tasks in the "review" column whose review *stage* is still running. */
const reviewing = new Set<string>();
const usage = new Map<string, number>();
let seeded = false;
let hadActivity = false;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

const ACTIVE = new Set<Task["status"]>(["queued", "planning", "running", "approval"]);
const firstLine = (s: string | null | undefined) => (s ?? "").split(/\r?\n/).find((l) => l.trim())?.slice(0, 160) ?? "";

/** Learns the current state first, so opening the board does not replay every past event as news. */
export async function seedAlerts() {
  try {
    const projects = await api.projects();
    for (const p of projects) {
      for (const t of await api.tasks(p.id)) {
        known.set(t.id, { status: t.status, title: t.title, project: t.project_id, stages: t.pipeline.length });
        if (t.status === "review" && t.stage_states.includes("running")) reviewing.add(t.id);
      }
    }
    for (const l of await api.limits()) usage.set(l.type, l.utilization ?? 0);
  } catch {
    // Unseeded, the first update per task is only recorded, never announced.
  }
  seeded = true;
}

/** The pop-up already names the kind of event in its colour, so the headline is the task itself. */
function taskAlert(kind: AlertKind, t: Task, detail: string) {
  raise({ kind, title: t.title, body: detail || kindInfo(kind).hint, taskId: t.id, projectId: t.project_id });
}

function onTask(t: Task) {
  const prev = known.get(t.id)?.status;
  known.set(t.id, { status: t.status, title: t.title, project: t.project_id, stages: t.pipeline.length });
  if (!seeded || (prev === undefined && t.status === "backlog")) return;
  const cur = t.status;

  if (cur === "review") {
    // Ready only once the pipeline's last stage has finished; before that it is the review stage running.
    if (lastFinished.get(t.id) === t.pipeline.length - 1) {
      lastFinished.delete(t.id);
      reviewing.delete(t.id);
      taskAlert("review", t, "");
    } else if (prev !== "review") reviewing.add(t.id);
  } else reviewing.delete(t.id);

  if (prev !== cur) {
    if (cur === "done") taskAlert("done", t, "");
    else if (cur === "failed" && t.error !== "stopped by user") taskAlert("failed", t, firstLine(t.error));
    else if (cur === "paused" && t.pause_reason === "cost") taskAlert("approval", t, "reached its cost ceiling — Continue or Stop");
    else if (cur === "paused") taskAlert("paused", t, t.resume_at ? `resumes ${until(t.resume_at)} · ${clock(t.resume_at)}` : "resumes when the window resets");
    else if (prev === "paused" && ACTIVE.has(cur)) taskAlert("resumed", t, "");
    else if ((prev === "queued" || prev === "backlog" || prev === "failed") && (cur === "planning" || cur === "running")) taskAlert("started", t, "");
  }
  if (ACTIVE.has(cur) || reviewing.has(t.id)) hadActivity = true;
  checkAllClear();
}

/** Everything finished and nothing is waiting on you: worth one small fanfare. */
function checkAllClear() {
  if (clearTimer) clearTimeout(clearTimer);
  // Between two stages a task briefly looks idle; wait before believing it.
  clearTimer = setTimeout(() => {
    const busy = [...known.values()].some((k) => ACTIVE.has(k.status)) || reviewing.size > 0;
    if (!busy && hadActivity) {
      hadActivity = false;
      raise({ kind: "allClear", title: "All clear", body: "Nothing running, queued or waiting on you." });
    }
  }, 4000);
}

const LIMIT_NAMES: Record<string, string> = { five_hour: "5-hour window", seven_day: "Weekly limit", seven_day_opus: "Weekly Opus limit", seven_day_sonnet: "Weekly Sonnet limit" };

function onLimits(limits: UsageLimit[]) {
  for (const l of limits) {
    const before = usage.get(l.type);
    const now = l.utilization ?? 0;
    usage.set(l.type, now);
    if (before === undefined || !seeded) continue;
    const crossed = [0.95, 0.8].find((t) => before < t && now >= t);
    if (!crossed) continue;
    const name = LIMIT_NAMES[l.type] ?? `Weekly ${l.type.replace(/^seven_day_model:/, "")} limit`;
    const reset = l.resets_at ? ` · resets ${until(l.resets_at * 1000)} (${clock(l.resets_at * 1000)})` : "";
    raise({ kind: "usage", title: `${name} at ${Math.round(now * 100)}%`, body: `Tasks pause by themselves if it runs out${reset}` });
  }
}

/** Feed every board message through here. */
export function watchAlerts(m: WsMessage) {
  if (m.type === "run.finished" && m.run.status === "success") lastFinished.set(m.run.task_id, m.run.stage_index);
  else if (m.type === "task.updated") onTask(m.task);
  else if (m.type === "task.deleted") {
    known.delete(m.taskId);
    reviewing.delete(m.taskId);
  } else if (m.type === "limits.updated") onLimits(m.limits);
  else if (m.type === "approval.requested" && seeded) {
    const a = m.approval;
    raise({ kind: "approval", title: a.task_title ?? "A task", body: `Wants to: ${a.title ?? a.tool_name}`, taskId: a.task_id, projectId: a.project_id });
  }
}

// ---------------------------------------------------------------- tab badge

/** The most urgent thing that happened while you were looking elsewhere. */
const URGENCY: AlertKind[] = ["approval", "failed", "paused", "usage", "review", "done", "allClear", "resumed", "started"];
let unseen: AlertKind | null = null;
const unseenListeners = new Set<(k: AlertKind | null) => void>();

function noteUnseen(kind: AlertKind) {
  if (unseen && URGENCY.indexOf(unseen) <= URGENCY.indexOf(kind)) return;
  unseen = kind;
  for (const l of unseenListeners) l(unseen);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !unseen) return;
    unseen = null;
    for (const l of unseenListeners) l(null);
  });
}

export function useUnseen(): AlertKind | null {
  const [k, setK] = useState(unseen);
  useEffect(() => {
    unseenListeners.add(setK);
    return () => void unseenListeners.delete(setK);
  }, []);
  return k;
}
