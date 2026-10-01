// A second board for trying changes: its own port and its own state folder, so nothing it does —
// a migration, a failed run, a recovery at start — touches the board you actually use.
//
//   node scripts/test-board.mjs            http://127.0.0.1:4320, state in <temp>/claude-kanban-test
//   KANBAN_PORT=4330 KANBAN_STATE_DIR=... node scripts/test-board.mjs
//
// It uses your Claude login (that lives in ~/.claude, not in the state folder), so runs on it are real.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  KANBAN_PORT: process.env.KANBAN_PORT ?? "4320",
  KANBAN_STATE_DIR: process.env.KANBAN_STATE_DIR ?? join(tmpdir(), "claude-kanban-test"),
};
console.log(`Test board → http://127.0.0.1:${env.KANBAN_PORT}  (state: ${env.KANBAN_STATE_DIR})`);
// npm is a .cmd shim on Windows and needs a shell; the command is fixed text.
const child = spawn("npm run start -w server", { cwd: root, env, shell: true, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill());
