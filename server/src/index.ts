import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH, HOST, LOG_DIR, PORT, SECRETS_PATH, STATE_DIR } from "./config.ts";
import { SecretStore } from "./secrets.ts";
import { openDb } from "./db.ts";
import { Repo } from "./repo.ts";
import { Bus } from "./bus.ts";
import { TaskRunner } from "./engine/runner.ts";
import { buildApp } from "./app.ts";
import { openBrowser } from "./openBrowser.ts";
import { Scheduler } from "./engine/scheduler.ts";
import { ChatService } from "./engine/chat.ts";
import { acquireInstanceLock } from "./instanceLock.ts";

// Before the database is touched: starting up rewrites the state of everything that was running.
const lock = await acquireInstanceLock(STATE_DIR, { port: PORT });
if (!lock.ok) {
  const since = lock.holder.startedAt ? ` (started ${new Date(lock.holder.startedAt).toLocaleString()})` : "";
  console.error(
    [
      `Claude Kanban is already running on this computer${since}.`,
      `Open it at http://${HOST}:${lock.holder.port} — or close that one first, then start this again.`,
      "Two boards sharing the same data would interrupt each other's tasks, so this one has not started.",
      "",
      `If you are sure no board is running, delete this file and start again: ${lock.file}`,
      "To run a second board for testing, give it its own folder by setting KANBAN_STATE_DIR.",
    ].join("\n"),
  );
  process.exit(1);
}
process.on("exit", lock.release);

const repo = new Repo(openDb(DB_PATH));
// The folder this board is actually running from, even if it was moved since the last start.
repo.setStateDir(STATE_DIR);
const bus = new Bus();
const runner = new TaskRunner({ repo, bus, logDir: LOG_DIR, secrets: new SecretStore(SECRETS_PATH) });
runner.recover();
// Your usage changes whenever you use Claude anywhere, not only when the board runs something.
runner.pollUsage();

// Transcripts are the one table that grows without bound. Runs, costs and results are kept forever;
// only the message-by-message detail of old finished runs is dropped.
{
  const days = repo.getSettings().eventRetentionDays;
  const pruned = repo.pruneEvents(days);
  if (pruned) console.log(`Pruned ${pruned.toLocaleString()} transcript rows from runs finished over ${days} days ago.`);
}

const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
// Scheduled starts and repeating schedules. Its first tick catches up on anything missed while the board was off.
const scheduler = new Scheduler({ repo, bus, runner });
// The side chat, with its watch on each chat's cache window (D331).
const chat = new ChatService({ repo, bus, runner, scheduler });
const app = await buildApp({ repo, bus, runner, scheduler, chat, webDist, logger: process.env.KANBAN_LOG === "1" });
await app.listen({ host: HOST, port: PORT });
console.log(`Claude Kanban server on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
scheduler.start();
chat.startWatch();
// Ask Claude Code which models this login has now, and again a few times a day: a newer model of a
// family the settings name is picked up without anyone opening Settings. Free: no prompt is sent.
void runner.claudeModels();
setInterval(() => void runner.claudeModels(true), 6 * 60 * 60_000).unref();
// The launcher asks for this: open the board only now that it answers, never before.
if (process.env.KANBAN_OPEN_BROWSER === "1") openBrowser(`http://${HOST}:${PORT}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    scheduler.stop();
    chat.stopWatch();
    await app.close();
    repo.db.close();
    process.exit(0);
  });
}
