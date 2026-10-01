import { useEffect, useState } from "react";
import { isQuestion, questionTitle } from "./questions.ts";
import type { Approval, ApprovalDecision, Task, TaskQuestion, UsageLimit, WsMessage } from "../../../server/src/types.ts";
import { api } from "./api.ts";
import { clock, until } from "./format.ts";
import { desktopNotify } from "./notify.ts";
import { navigate } from "./router.ts";
import { isAnswerPipeline } from "../../../server/src/engine/answer.ts";
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
  { kind: "approval", label: "Needs you", hint: "A supervised run is waiting on a card, or Claude asked you a question", color: "var(--color-rose)", icon: "✋", defaults: { sound: true, toast: true, desktop: true } },
  { kind: "review", label: "Ready for review", hint: "Every stage finished; your turn to look", color: "var(--color-lime)", icon: "◉", defaults: { sound: true, toast: true, desktop: true } },
  { kind: "done", label: "Landed", hint: "Approved and landed", color: "var(--color-moss)", icon: "✓", defaults: { sound: true, toast: true, desktop: false } },
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

/** How a "needs you" thing ended, wherever it was dealt with. */
export type Outcome = "allowed" | "denied" | "answered" | "expired" | "handled";

export interface Alert {
  id: string;
  kind: AlertKind;
  /** Said instead of the kind's own word when that word would be wrong: an answer card is "Answered", not "Landed" (D284). */
  label?: string;
  title: string;
  body: string;
  taskId?: string;
  projectId?: string;
  at: number;
  /** A preview from the settings panel: shown and heard, never sent to the desktop. */
  preview?: boolean;
  /**
   * What a "needs you" alert is about — `approval:<id>`, `question:<task>:<id>`, `pause:<task>` — so
   * the event that settles it, from any screen, closes its pop-up, its desktop notification and its
   * inbox row (D279).
   */
  key?: string;
  /** The card itself, so the pop-up can Allow or Deny it. */
  approval?: Approval;
}

const alertListeners = new Set<(a: Alert) => void>();
export const onAlert = (fn: (a: Alert) => void) => {
  alertListeners.add(fn);
  return () => void alertListeners.delete(fn);
};

let seq = 0;
/** Sounds of one kind within this window collapse into one, so ten subtasks finishing is one chime. */
const lastSound = new Map<AlertKind, number>();

export const openTask = (a: Pick<Alert, "taskId" | "projectId">) => {
  if (a.taskId) navigate({ projectId: a.projectId ?? null, taskId: a.taskId, view: "board" });
};

export function raise(a: Omit<Alert, "id" | "at">) {
  // Something that already needs you is not news a second time (a repeated event, a reconnect).
  if (a.key && !a.preview && needsYou.has(a.key)) return;
  const alert: Alert = { ...a, id: `al${++seq}`, at: Date.now() };
  const ch = prefs.kinds[alert.kind];
  if (alert.key && !alert.preview) {
    needsYou.set(alert.key, alert);
    emitNeeds();
  }
  // Previews play their own sound (even when this kind is set to silent), so they skip this one.
  if (!alert.preview && ch.sound && !prefs.muted && Date.now() - (lastSound.get(alert.kind) ?? 0) > 1200) {
    lastSound.set(alert.kind, Date.now());
    playSound(alert.kind, prefs.theme, prefs.volume);
  }
  if (ch.toast || alert.preview) for (const l of alertListeners) l(alert);
  if (ch.desktop && !alert.preview) {
    const n = desktopNotify(alert.label ?? kindInfo(alert.kind).label, `${alert.title} — ${alert.body}`, alert.key ?? `${alert.kind}-${alert.taskId ?? ""}`, {
      sticky: !!alert.key,
      onClick: () => openTask(alert),
    });
    if (n && alert.key) desk.set(alert.key, n);
  }
  if (!alert.preview) addToInbox(alert);
  if (document.visibilityState !== "visible" && !alert.preview) noteUnseen(alert.kind, alert.label);
}

// ---------------------------------------------------------------- what needs you, right now

const needsYou = new Map<string, Alert>();
const needsListeners = new Set<(a: Alert[]) => void>();
const needsList = () => [...needsYou.values()].sort((a, b) => a.at - b.at);
function emitNeeds() {
  const list = needsList();
  for (const l of needsListeners) l(list);
}
/** Desktop notifications still on screen, by key, so settling the thing takes them down too. */
const desk = new Map<string, Notification>();

const resolveListeners = new Set<(key: string, outcome: Outcome) => void>();
/** Told when a "needs you" thing is settled — on this screen or any other. */
export const onResolve = (fn: (key: string, outcome: Outcome) => void) => {
  resolveListeners.add(fn);
  return () => void resolveListeners.delete(fn);
};

export function resolveNeed(key: string, outcome: Outcome) {
  const had = needsYou.delete(key);
  desk.get(key)?.close();
  desk.delete(key);
  stampInbox(key, outcome);
  if (had) emitNeeds();
  for (const l of resolveListeners) l(key, outcome);
}

/** Recorded without a sound or a pop-up: what was already waiting when the board was opened. */
function track(a: Omit<Alert, "id" | "at">, at: number) {
  if (a.key) needsYou.set(a.key, { ...a, id: `al${++seq}`, at });
}

/** Everything waiting on you, oldest first, kept current. */
export function useNeedsYou(): Alert[] {
  const [list, setList] = useState(needsList);
  useEffect(() => {
    needsListeners.add(setList);
    setList(needsList());
    return () => void needsListeners.delete(setList);
  }, []);
  return list;
}

// ---------------------------------------------------------------- the inbox (per computer)

export interface InboxEntry {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  taskId?: string;
  projectId?: string;
  at: number;
  key?: string;
  read: boolean;
  outcome?: Outcome;
}

const INBOX_KEY = "kanban.inbox";
const INBOX_MAX = 50;

function readInbox(): InboxEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(INBOX_KEY) ?? "[]") as InboxEntry[];
    return Array.isArray(v) ? v.filter((e) => e && typeof e.title === "string" && ALERT_KINDS.some((k) => k.kind === e.kind)).slice(0, INBOX_MAX) : [];
  } catch {
    return [];
  }
}

let inbox = readInbox();
const inboxListeners = new Set<(e: InboxEntry[]) => void>();

function saveInbox(next: InboxEntry[]) {
  inbox = next;
  try {
    localStorage.setItem(INBOX_KEY, JSON.stringify(inbox));
  } catch {
    // storage blocked: the inbox still holds for this session
  }
  for (const l of inboxListeners) l(inbox);
}

function addToInbox(a: Alert) {
  // A second tab on the board hears the same events and writes the same entries.
  const dup = inbox.some((e) => (a.key ? e.key === a.key : e.kind === a.kind && e.taskId === a.taskId && e.body === a.body && Math.abs(e.at - a.at) < 5000));
  if (dup) return;
  const e: InboxEntry = { id: `${a.id}-${a.at}`, kind: a.kind, title: a.title, body: a.body, taskId: a.taskId, projectId: a.projectId, at: a.at, key: a.key, read: false };
  saveInbox([e, ...inbox].slice(0, INBOX_MAX));
}

function stampInbox(key: string, outcome: Outcome) {
  if (!inbox.some((e) => e.key === key && !e.outcome)) return;
  saveInbox(inbox.map((e) => (e.key === key && !e.outcome ? { ...e, outcome } : e)));
}

export function markAllRead() {
  if (inbox.some((e) => !e.read)) saveInbox(inbox.map((e) => (e.read ? e : { ...e, read: true })));
}
export const clearInbox = () => saveInbox([]);

if (typeof window !== "undefined") {
  // Read, cleared or added in another tab: this one follows.
  window.addEventListener("storage", (e) => {
    if (e.key !== INBOX_KEY) return;
    inbox = readInbox();
    for (const l of inboxListeners) l(inbox);
  });
}

/** The last 50 things the board told you about, newest first. */
export function useInbox(): InboxEntry[] {
  const [list, setList] = useState(inbox);
  useEffect(() => {
    inboxListeners.add(setList);
    setList(inbox);
    return () => void inboxListeners.delete(setList);
  }, []);
  return list;
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
/** Question ids already seen per task, so only a new question is announced. */
const askedQuestions = new Map<string, Set<string>>();
let seeded = false;
let hadActivity = false;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

const ACTIVE = new Set<Task["status"]>(["queued", "planning", "running", "approval"]);
const firstLine = (s: string | null | undefined) => (s ?? "").split(/\r?\n/).find((l) => l.trim())?.slice(0, 160) ?? "";

const OUTCOME: Record<ApprovalDecision, Outcome> = { allow: "allowed", deny: "denied", answered: "answered", expired: "expired" };

function approvalAlert(a: Approval): Omit<Alert, "id" | "at"> {
  const body = isQuestion(a) ? `Asks: ${questionTitle(a)}` : `Wants to: ${a.title ?? a.tool_name}`;
  return { kind: "approval", title: a.task_title ?? "A task", body, taskId: a.task_id, projectId: a.project_id, key: `approval:${a.id}`, approval: a };
}

function questionAlert(t: Task, q: TaskQuestion): Omit<Alert, "id" | "at"> {
  return { kind: "approval", title: t.title, body: `Has a question for you: ${firstLine(q.text)}`, taskId: t.id, projectId: t.project_id, key: `question:${t.id}:${q.id}` };
}

/** A cost pause, or a provider out of credit with no time to resume: both wait for a person (D217). */
const pauseNeedsYou = (t: Task) => t.status === "paused" && (t.pause_reason === "cost" || (t.pause_reason === "provider" && !t.resume_at));

function pauseAlert(t: Task): Omit<Alert, "id" | "at"> {
  const body = t.pause_reason === "cost" ? "reached its cost ceiling — Continue or Stop" : `${firstLine(t.note).split(":")[0]} — switch provider, or top up and try again`;
  return { kind: "approval", title: t.title, body, taskId: t.id, projectId: t.project_id, key: `pause:${t.id}` };
}

const unanswered = (t: Task) => (t.questions ?? []).filter((q) => !q.answer);
const stamp = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : Date.now());

/** Learns the current state first, so opening the board does not replay every past event as news. */
export async function seedAlerts() {
  try {
    const [projects, pendingCards] = await Promise.all([api.projects(), api.pendingApprovals()]);
    const cards = (await Promise.all(projects.map((p) => api.tasks(p.id)))).flat();
    // Replaced in one go, after the requests: this also runs when the socket comes back, and a task
    // deleted during the gap must not stay "running" here and hold back the all-clear for ever.
    known.clear();
    reviewing.clear();
    for (const t of cards) {
      known.set(t.id, { status: t.status, title: t.title, project: t.project_id, stages: t.pipeline.length });
      askedQuestions.set(t.id, new Set((t.questions ?? []).map((q) => q.id)));
      if (t.status === "review" && t.stage_states.includes("running")) reviewing.add(t.id);
    }

    // What needs you now, rebuilt quietly. Anything open here that is no longer true was settled
    // while the socket was down — a restarted board expires its cards before anyone reconnects.
    const fresh = new Map<string, [Omit<Alert, "id" | "at">, number]>();
    for (const a of pendingCards) fresh.set(`approval:${a.id}`, [approvalAlert(a), stamp(a.created_at)]);
    for (const t of cards) {
      for (const q of unanswered(t)) fresh.set(`question:${t.id}:${q.id}`, [questionAlert(t, q), stamp(q.created_at)]);
      if (pauseNeedsYou(t)) fresh.set(`pause:${t.id}`, [pauseAlert(t), stamp(t.updated_at)]);
    }
    for (const key of [...needsYou.keys()]) if (!fresh.has(key)) resolveNeed(key, "handled");
    for (const [key, [a, at]] of fresh) if (!needsYou.has(key)) track(a, at);
    // An inbox row from an earlier visit, settled while the board was closed, must not look open.
    if (inbox.some((e) => e.key && !e.outcome && !fresh.has(e.key))) {
      saveInbox(inbox.map((e) => (e.key && !e.outcome && !fresh.has(e.key) ? { ...e, outcome: "handled" as const } : e)));
    }
    emitNeeds();

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
  // A board_ask question does not stop the run, so without a pop-up nobody sees it until the end (D203).
  const seen = askedQuestions.get(t.id);
  const fresh = unanswered(t).filter((q) => !seen?.has(q.id));
  askedQuestions.set(t.id, new Set((t.questions ?? []).map((q) => q.id)));
  for (const q of fresh) {
    if (seeded && seen) raise(questionAlert(t, q));
    else track(questionAlert(t, q), stamp(q.created_at));
  }
  // Answered here, on the card or from another tab: the question stops needing you.
  const open = new Set(unanswered(t).map((q) => `question:${t.id}:${q.id}`));
  for (const key of [...needsYou.keys()]) if (key.startsWith(`question:${t.id}:`) && !open.has(key)) resolveNeed(key, "answered");
  if (!pauseNeedsYou(t) && needsYou.has(`pause:${t.id}`)) resolveNeed(`pause:${t.id}`, "handled");
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
    // A supervised task has no branch: nothing was merged, and the pop-up should not say it was.
    // An answer card lands in Done by itself with its answer: nothing was approved or merged (D284).
    if (cur === "done" && isAnswerPipeline(t.pipeline)) raise({ kind: "done", label: "Answered", title: t.title, body: t.chat_id ? "The answer is in the chat that asked for it" : "Open it to read the answer", taskId: t.id, projectId: t.project_id });
    else if (cur === "done") taskAlert("done", t, t.mode === "autonomous" ? "Approved and merged" : "Approved — its changes were already in your checkout");
    else if (cur === "failed" && t.error !== "stopped by user") taskAlert("failed", t, firstLine(t.error));
    else if (pauseNeedsYou(t)) raise(pauseAlert(t));
    else if (cur === "paused" && t.pause_reason === "provider") taskAlert("paused", t, `${firstLine(t.note).split(":")[0]} · resumes ${until(t.resume_at)} · ${clock(t.resume_at!)}`);
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
    for (const [key, a] of [...needsYou]) if (a.taskId === m.taskId) resolveNeed(key, "handled");
  } else if (m.type === "limits.updated") onLimits(m.limits);
  else if (m.type === "approval.requested") {
    // Before the board has learned what is already waiting, a card is recorded but not announced.
    if (seeded) raise(approvalAlert(m.approval));
    else track(approvalAlert(m.approval), stamp(m.approval.created_at));
  } else if (m.type === "approval.decided") resolveNeed(`approval:${m.approval.id}`, OUTCOME[m.approval.decision ?? "expired"]);
}

// ---------------------------------------------------------------- tab badge

/** The most urgent thing that happened while you were looking elsewhere. */
const URGENCY: AlertKind[] = ["approval", "failed", "paused", "usage", "review", "done", "allClear", "resumed", "started"];
let unseen: AlertKind | null = null;
/** The word the unseen alert itself used, when it was not its kind's ("Answered", not "Landed"). */
let unseenLabel: string | undefined;
const unseenListeners = new Set<(k: AlertKind | null) => void>();

function noteUnseen(kind: AlertKind, label?: string) {
  if (unseen && URGENCY.indexOf(unseen) <= URGENCY.indexOf(kind)) return;
  unseen = kind;
  unseenLabel = label;
  for (const l of unseenListeners) l(unseen);
}

export const unseenWord = (): string | undefined => unseenLabel;

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
