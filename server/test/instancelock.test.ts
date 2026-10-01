import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../src/instanceLock.ts";

const folder = () => mkdtempSync(join(tmpdir(), "klock-"));
const lockFile = (dir: string) => join(dir, "kanban.lock");
/** Makes the lock look as if its board started long ago, so "still starting up" no longer explains a silent port. */
const age = (dir: string) => utimesSync(lockFile(dir), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
/** A process number that certainly belongs to nothing: a program that has already ended. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
/** A process that is certainly alive and is not this one: the test runner that started this file. */
const otherLivePid = process.ppid;

async function listener(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("the first board to start claims its state folder, and gives it back when it stops", async () => {
  const dir = folder();
  try {
    const lock = await acquireInstanceLock(dir, { port: 4310 });
    assert.equal(lock.ok, true);
    assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).pid, process.pid, "the file names the board that holds it");
    if (lock.ok) lock.release();
    assert.equal(existsSync(lockFile(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second board on the same folder is refused while the first is starting or answering", async () => {
  const dir = folder();
  const first = await listener();
  try {
    assert.equal((await acquireInstanceLock(dir, { port: first.port, pid: otherLivePid })).ok, true);

    const whileStarting = await acquireInstanceLock(dir, { port: 4999 });
    assert.equal(whileStarting.ok, false, "a board that has only just claimed the folder is still its owner");

    age(dir);
    const whileRunning = await acquireInstanceLock(dir, { port: 4999 });
    assert.equal(whileRunning.ok, false, "and so is one that answers on its port");
    if (!whileRunning.ok) assert.deepEqual([whileRunning.holder.pid, whileRunning.holder.port], [otherLivePid, first.port], "the refusal says which board to open");
    assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).pid, otherLivePid, "the first board's claim is left alone");
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim left behind by a board that was force-stopped is taken over", async () => {
  const dir = folder();
  try {
    assert.equal((await acquireInstanceLock(dir, { port: 4310, pid: deadPid() })).ok, true);
    const next = await acquireInstanceLock(dir, { port: 4310 });
    assert.equal(next.ok, true);
    assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an old claim whose process number now belongs to another program does not lock the board out", async () => {
  const dir = folder();
  const gone = await listener();
  await gone.close(); // a port nothing answers on
  try {
    assert.equal((await acquireInstanceLock(dir, { port: gone.port, pid: otherLivePid })).ok, true);
    age(dir);
    const next = await acquireInstanceLock(dir, { port: 4310 });
    assert.equal(next.ok, true, "alive, but not a board: nothing answers where the board would be");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
