import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH, HOST, LOG_DIR, PORT, SECRETS_PATH } from "./config.ts";
import { SecretStore } from "./secrets.ts";
import { openDb } from "./db.ts";
import { Repo } from "./repo.ts";
import { Bus } from "./bus.ts";
import { TaskRunner } from "./engine/runner.ts";
import { buildApp } from "./app.ts";
import { openBrowser } from "./openBrowser.ts";
import { Scheduler } from "./engine/scheduler.ts";

const repo = new Repo(openDb(DB_PATH));
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
const app = await buildApp({ repo, bus, runner, scheduler, webDist, logger: process.env.KANBAN_LOG === "1" });
await app.listen({ host: HOST, port: PORT });
console.log(`Claude Kanban server on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
scheduler.start();
// The launcher asks for this: open the board only now that it answers, never before.
if (process.env.KANBAN_OPEN_BROWSER === "1") openBrowser(`http://${HOST}:${PORT}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    scheduler.stop();
    await app.close();
    repo.db.close();
    process.exit(0);
  });
}
