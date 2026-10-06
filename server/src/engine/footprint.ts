// Whether two tasks may run side by side (D400). Pure, so the web draws the same answer the queue acts on.
//
// Two tasks in one folder would write over each other's files; two live tasks would write the same live
// records. The board compares what each is expected to change (its footprint) and what it has changed,
// and when it cannot tell, it assumes the worst: an unknown footprint in a shared folder is everything.

import { isAnswerPipeline, sharesProjectFolder, type Footprint, type Mode, type Stage } from "../types.ts";

/** What the comparison needs from a task. */
export interface FootprintOf {
  mode: Mode;
  own_branch?: boolean;
  in_folder?: boolean;
  pipeline?: Pick<Stage, "stage" | "prompt">[];
  live: boolean;
  footprint: Footprint;
}

/** Why two tasks should not run together, or null when they may. */
export interface Clash {
  files: string[];
  systems: string[];
  /** The board cannot tell what one of them touches, so it assumes it could be anything. */
  unknown: boolean;
}

export const EMPTY_FOOTPRINT: Footprint = { files: [], systems: [], touched: [] };

export function fileKey(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Does pattern `x` cover path or pattern `y`, or the other way round? A folder or glob covers what is under it. */
function covers(x: string, y: string): boolean {
  if (x === y) return true;
  const xDir = x.replace(/\/?\*+.*$/, "").replace(/\/$/, "");
  const yDir = y.replace(/\/?\*+.*$/, "").replace(/\/$/, "");
  if (xDir && (y.startsWith(`${xDir}/`) || y === xDir)) return true;
  if (yDir && (x.startsWith(`${yDir}/`) || x === yDir)) return true;
  return false;
}

export function overlaps(a: string[], b: string[]): boolean {
  return sharedFiles(a, b).length > 0;
}

/** The entries of `a` that overlap anything in `b`, as `a` wrote them. */
export function sharedFiles(a: string[], b: string[]): string[] {
  const keys = b.map(fileKey);
  return [...new Set(a.filter((x) => keys.some((y) => covers(fileKey(x), y))))];
}

const systemKey = (s: string) => s.trim().toLowerCase();

/** Everything the task is expected to change or has changed. */
export const filesOf = (f: Footprint): string[] => [...new Set([...f.files, ...f.touched])];

/**
 * Whether `a` and `b` would get in each other's way if run together. Files only matter when both work
 * in the project folder (a worktree is its own copy); live systems matter wherever they run.
 */
export function clash(a: FootprintOf, b: FootprintOf): Clash | null {
  const out: Clash = { files: [], systems: [], unknown: false };
  if (sharesProjectFolder(a) && sharesProjectFolder(b)) {
    const fa = filesOf(a.footprint);
    const fb = filesOf(b.footprint);
    if (!fa.length || !fb.length) out.unknown = true;
    else out.files = sharedFiles(fa, fb);
  }
  // A lookup only reads the live system; two of them, or one beside a change, do not collide.
  const writesLive = (t: FootprintOf) => t.live && !isAnswerPipeline(t.pipeline ?? []);
  if (writesLive(a) && writesLive(b)) {
    const sb = new Set(b.footprint.systems.map(systemKey));
    // A live task that names no system could be writing to any of them.
    if (!a.footprint.systems.length || !sb.size) out.unknown = true;
    else out.systems = a.footprint.systems.filter((s) => sb.has(systemKey(s)));
  }
  return out.unknown || out.files.length || out.systems.length ? out : null;
}

/**
 * Two worktree tasks that will change the same files: not a reason to wait (each has its own copy),
 * but the second to land is likely to conflict, so the card says so early (D400).
 */
export function mayConflict(a: FootprintOf, b: FootprintOf): string[] {
  if (sharesProjectFolder(a) || sharesProjectFolder(b)) return [];
  const fa = filesOf(a.footprint);
  const fb = filesOf(b.footprint);
  return fa.length && fb.length ? sharedFiles(fa, fb) : [];
}

/** The lines under a `## Heading` of a plan, as plain entries: bullets, numbers and backticks stripped. */
function section(md: string, heading: RegExp): string[] {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{2,4}\s/.test(l) && heading.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,4}\s/.test(line)) break;
    const entry = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/`/g, "").replace(/\s+[—–-]\s.*$/, "").trim();
    if (entry && entry.length <= 200 && !/^(none|nothing|n\/a)\.?$/i.test(entry)) out.push(entry);
  }
  return out;
}

/**
 * What a plan says it will change (D400): the paths under `## Files to change` and the systems under
 * `## Live systems`. Free text is ignored: a path has no spaces round a slash, a system is a short name.
 */
export function planFootprint(md: string): { files: string[]; systems: string[] } {
  const files = section(md, /files to change/i).filter((f) => /[\w.-][/\\.][\w*]/.test(f) || /\/$/.test(f)).slice(0, 60);
  const systems = section(md, /live systems?/i).filter((s) => s.length <= 60).slice(0, 10);
  return { files, systems };
}

/** The card's line for a hold, in plain words. */
export function holdLine(h: { title: string; files: string[]; systems: string[]; unknown: boolean; landing?: boolean }): string {
  if (h.landing) {
    return h.files.length
      ? `Waits for “${h.title}” to be approved or discarded: both change ${h.files.slice(0, 2).join(", ")}`
      : `Waits for “${h.title}” to be approved or discarded: the board can't tell which files this one changes`;
  }
  if (h.systems.length) return `Waits for “${h.title}”: both write to ${h.systems.slice(0, 2).join(", ")}`;
  if (h.files.length) return `Waits for “${h.title}”: both change ${h.files.slice(0, 2).join(", ")}${h.files.length > 2 ? ` and ${h.files.length - 2} more` : ""}`;
  return `Waits for “${h.title}”: the board can't tell which files they change, so they take turns`;
}
