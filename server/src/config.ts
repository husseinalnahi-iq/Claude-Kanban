import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.KANBAN_PORT ?? 4310);
/**
 * A test never reads or writes your real board: every test file (node --test runs each in a process
 * marked NODE_TEST_CONTEXT) gets a folder of its own. Before this, tests used ~/.claude-kanban, and every
 * run copied the board's real signed-in browser profile — 240 MB — which made ~90 tests time out (D409).
 */
function testStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kstate-"));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a file still held open on Windows; the system's temp clean-up takes it later
    }
  });
  return dir;
}

export const STATE_DIR = process.env.KANBAN_STATE_DIR ?? (process.env.NODE_TEST_CONTEXT ? testStateDir() : join(homedir(), ".claude-kanban"));
export const DB_PATH = join(STATE_DIR, "kanban.db");
export const LOG_DIR = join(STATE_DIR, "logs");
export const SECRETS_PATH = join(STATE_DIR, "secrets.json");
