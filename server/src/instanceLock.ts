import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/**
 * One board per state folder.
 *
 * Starting up is not harmless: the server marks every run that was in flight as interrupted, expires
 * the approvals that were waiting and starts the queue again. Done by a second copy while the first is
 * still working, that fails live tasks and leaves their approval cards unanswerable. A second copy is
 * easy to start by accident — `npm run dev` next to the launcher's board, or a task that starts the app
 * to look at it — so the folder is claimed before the database is opened.
 */
export interface LockHolder {
  pid: number;
  port: number;
  startedAt: string;
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: LockHolder; file: string };

/** A board this young may not have opened its port yet; it is still the owner. */
const STARTING_MS = 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, and belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A plain connection, not a request: a board busy with a long query still accepts one. */
function listening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function read(file: string): LockHolder | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<LockHolder>;
    return typeof j.pid === "number" && typeof j.port === "number" ? { pid: j.pid, port: j.port, startedAt: String(j.startedAt ?? "") } : null;
  } catch {
    return null;
  }
}

/**
 * Is the board named in the file still there? A forced stop leaves the file behind, and Windows hands
 * old process numbers to new programs, so a live process alone proves nothing: it must also be
 * answering on the board's port, unless the file is so new that the board is still starting.
 */
async function held(holder: LockHolder, file: string, now: number): Promise<boolean> {
  if (!alive(holder.pid)) return false;
  let age = Infinity;
  try {
    age = now - statSync(file).mtimeMs;
  } catch {
    // gone meanwhile: nobody holds it
    return false;
  }
  return age < STARTING_MS || (await listening(holder.port));
}

export async function acquireInstanceLock(dir: string, me: { port: number; pid?: number }, now: () => number = Date.now): Promise<LockResult> {
  const file = join(dir, "kanban.lock");
  const pid = me.pid ?? process.pid;
  mkdirSync(dir, { recursive: true });
  const mine: LockHolder = { pid, port: me.port, startedAt: new Date(now()).toISOString() };
  const release = () => {
    if (read(file)?.pid === pid) rmSync(file, { force: true });
  };
  let holder: LockHolder | null = null;
  // Twice is enough for a stale file; the third covers two boards clearing the same stale file at once.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // "wx" fails if the file is there: creating it is the claim, so two starts cannot both win.
      writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
      return { ok: true, release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    holder = read(file);
    if (holder && holder.pid !== pid && (await held(holder, file, now()))) return { ok: false, holder, file };
    rmSync(file, { force: true });
  }
  return { ok: false, holder: holder ?? { pid: 0, port: me.port, startedAt: "" }, file };
}
