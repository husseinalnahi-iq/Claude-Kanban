// What an autonomous task in the project folder changed (D398). There is no branch to diff and nothing
// to throw away, so before its first write to a file the board keeps that file as it was. The copies
// give the card its Changes tab and let Discard put the folder back the way the task found it.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** "copied": the original is kept; "new": the task created it; "big": too big to keep, so it cannot be put back. */
export type Kept = Record<string, "copied" | "new" | "big">;

/** Bigger files are left alone: a copy of a database or a video costs more than Discard is worth. */
const MAX_COPY_BYTES = 20 * 1024 * 1024;

const manifestOf = (dir: string) => join(dir, "kept.json");
const copyOf = (dir: string, rel: string) => join(dir, "files", ...rel.split("/"));

/** `file` as a path inside `root` with forward slashes, or null when it is outside (or is root itself). */
export function relInside(root: string, file: string): string | null {
  const rel = relative(root, resolve(root, file));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export function keptFiles(dir: string): Kept {
  try {
    return JSON.parse(readFileSync(manifestOf(dir), "utf8")) as Kept;
  } catch {
    return {};
  }
}

/** Keeps `rel` as it is now, once: later writes by the same task must not replace the original. */
export function keepOriginal(dir: string, root: string, rel: string): void {
  const kept = keptFiles(dir);
  if (kept[rel]) return;
  const abs = join(root, ...rel.split("/"));
  if (!existsSync(abs)) kept[rel] = "new";
  else if (!statSync(abs).isFile() || statSync(abs).size > MAX_COPY_BYTES) kept[rel] = "big";
  else {
    const to = copyOf(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(abs, to);
    kept[rel] = "copied";
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestOf(dir), JSON.stringify(kept, null, 1));
}

/** The kept copy of `rel`, or null when the task created it (or it was too big to keep). */
export function keptCopy(dir: string, rel: string): string | null {
  return keptFiles(dir)[rel] === "copied" ? copyOf(dir, rel) : null;
}

/**
 * Puts every kept file back and deletes the ones the task created. A file too big to keep is left as
 * it is and named, so the card can say what Discard could not undo.
 */
export function restoreKept(dir: string, root: string): { restored: string[]; removed: string[]; left: string[] } {
  const out = { restored: [] as string[], removed: [] as string[], left: [] as string[] };
  for (const [rel, how] of Object.entries(keptFiles(dir))) {
    const abs = join(root, ...rel.split("/"));
    try {
      if (how === "copied") {
        mkdirSync(dirname(abs), { recursive: true });
        copyFileSync(copyOf(dir, rel), abs);
        out.restored.push(rel);
      } else if (how === "new") {
        if (existsSync(abs)) rmSync(abs, { force: true });
        out.removed.push(rel);
      } else out.left.push(rel);
    } catch {
      out.left.push(rel);
    }
  }
  return out;
}

export function dropKept(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Copies in the board's own folder; the next discard or approve of this task tries again.
  }
}
