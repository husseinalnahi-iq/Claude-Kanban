import type { CostSource, Priority, TaskStatus, TaskType } from "../../../server/src/types.ts";

export const cost = (usd: number) => (usd >= 1 ? `$${usd.toFixed(2)}` : usd > 0 ? `$${usd.toFixed(3)}` : "$0");

export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function elapsed(fromIso: string, toIso?: string | null): string {
  return duration((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso));
}

export function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** "in 2h 13m" / "in 4m" / "now" — for countdowns to a reset or a resume. */
export function until(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  const ms = (typeof iso === "number" ? iso : Date.parse(iso)) - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `in ${h}h ${mins % 60}m` : `in ${Math.round(h / 24)}d`;
}

/** "18:50" today, or "Fri 18:50" further out — so a reset time means something at a glance. */
export function clock(iso: string | number): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** "claude-sonnet-5" → "sonnet-5", "claude-haiku-4-5-20251001" → "haiku-4-5", "moonshotai/kimi-k3" → "kimi-k3". */
export const shortModel = (id: string) => id.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/^[^/]+\//, "");

/** Model plus where it ran, when that is not Claude: "glm-4.7 · zai". */
export const modelLabel = (r: { model: string; provider?: string | null }) => (r.provider ? `${shortModel(r.model)} · ${r.provider}` : shortModel(r.model));

/** A dollar figure that says how sure it is: "$0.12", "$0.12 est.", "subscription". */
export function costLabel(r: { cost_usd: number; cost_source?: CostSource }): string {
  if (r.cost_source === "subscription") return "subscription";
  if (r.cost_source === "estimated") return `${cost(r.cost_usd)} est.`;
  return cost(r.cost_usd);
}

/** Type reads as a word, not a colour — colour alone never carries meaning. */
export const TYPE_META: Record<TaskType, { short: string; tone: string }> = {
  feature: { short: "feat", tone: "border-ink-600 text-ink-300" },
  bug: { short: "bug", tone: "border-rust/50 text-rust" },
  chore: { short: "chore", tone: "border-ink-600 text-ink-400" },
  docs: { short: "docs", tone: "border-cyan/40 text-cyan" },
  refactor: { short: "refac", tone: "border-ink-600 text-ink-300" },
};

export const PRIORITY_META: Record<Priority, { tone: string; title: string }> = {
  p0: { tone: "border-rust/60 text-rust bg-rust/10", title: "P0 — production broken or everything blocked" },
  p1: { tone: "border-amber/50 text-amber", title: "P1 — important, soon" },
  p2: { tone: "border-ink-600 text-ink-400", title: "P2 — normal" },
  p3: { tone: "border-ink-700 text-ink-500", title: "P3 — later" },
};

export const STATUS_META: Record<TaskStatus, { label: string; color: string; text: string; dot: string }> = {
  backlog: { label: "Backlog", color: "border-ink-600", text: "text-ink-300", dot: "bg-ink-500" },
  queued: { label: "Queued", color: "border-slate", text: "text-slate", dot: "bg-slate" },
  planning: { label: "Planning", color: "border-cyan", text: "text-cyan", dot: "bg-cyan" },
  running: { label: "Running", color: "border-amber", text: "text-amber", dot: "bg-amber" },
  approval: { label: "Needs approval", color: "border-rose", text: "text-rose", dot: "bg-rose" },
  paused: { label: "Paused · limit", color: "border-iris", text: "text-iris", dot: "bg-iris" },
  review: { label: "Review", color: "border-lime", text: "text-lime", dot: "bg-lime" },
  done: { label: "Done", color: "border-moss", text: "text-moss", dot: "bg-moss" },
  failed: { label: "Failed", color: "border-rust", text: "text-rust", dot: "bg-rust" },
};
