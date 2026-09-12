// Real Agent SDK smoke test: one Haiku stage in a temp folder, board MCP attached.
// Run: npx tsx scripts/smoke.ts   (from server/)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner } from "../src/engine/runner.ts";

const dir = mkdtempSync(join(tmpdir(), "ksmoke-"));
const repo = new Repo(openDb(":memory:"));
const bus = new Bus();
bus.subscribe((m) => {
  if (m.type === "event") console.log("  event", m.event.type);
  if (m.type === "task.updated") console.log("  task →", m.task.status, m.task.summary ? `summary="${m.task.summary}"` : "");
});
const runner = new TaskRunner({ repo, bus, logDir: join(dir, "logs") });
const project = repo.createProject({ name: "smoke", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
const task = repo.createTask({
  project_id: project.id,
  title: "Smoke",
  spec_md: "Call board_set_summary with the text 'pong', then reply with exactly the word PONG.",
  mode: "supervised",
  pipeline: [{ stage: "custom", model: "claude-haiku-4-5-20251001", effort: "low", prompt: "Do exactly what the task spec says. Do not use any other tools." }],
});

const t0 = Date.now();
runner.queueTask(task.id);
while (!["review", "failed"].includes(repo.getTask(task.id)!.status)) await new Promise((r) => setTimeout(r, 250));
const run = repo.latestRun(task.id)!;
const final = repo.getTask(task.id)!;
console.log(JSON.stringify({ status: final.status, summary: final.summary, error: final.error, run: { status: run.status, session_id: run.session_id, cost_usd: run.cost_usd, input_tokens: run.input_tokens, output_tokens: run.output_tokens, result: run.result_md, error: run.error }, seconds: (Date.now() - t0) / 1000 }, null, 2));
rmSync(dir, { recursive: true, force: true });
process.exit(final.status === "review" && final.summary === "pong" ? 0 : 1);
