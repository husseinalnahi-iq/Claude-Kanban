// How many tokens a stage carries before it does anything, for each way of starting one.
// Runs one real Haiku stage per variant, through the board's own runner, in a throwaway git repo,
// and reads the first turn's prompt size off the transcript. A few cents in all.
// Run: npx tsx scripts/measure-overhead.ts   (from server/)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner } from "../src/engine/runner.ts";
import type { Settings, Stage, StageName } from "../src/types.ts";

interface Variant {
  name: string;
  mode: "autonomous" | "supervised";
  stage: StageName;
  settings: Partial<Settings>;
}

const MODEL = "claude-haiku-4-5-20251001";
const variants: Variant[] = JSON.parse(process.env.VARIANTS ?? "null") ?? [
  { name: "autonomous code", mode: "autonomous", stage: "code", settings: {} },
  { name: "autonomous code, no user plugins", mode: "autonomous", stage: "code", settings: { loadUserPlugins: false } },
  { name: "autonomous code, no browser or images", mode: "autonomous", stage: "code", settings: { browserChecks: false, imageProvider: "off" } },
  { name: "autonomous plan", mode: "autonomous", stage: "plan", settings: {} },
];

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kmeasure-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "m@example.com");
  git("config", "user.name", "M");
  writeFileSync(join(dir, "README.md"), "measure\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

const rows: { variant: string; startup: number; cost: number; seconds: number }[] = [];
for (const v of variants) {
  const dir = gitRepo();
  const repo = new Repo(openDb(":memory:"));
  repo.updateSettings({ autoTriage: false, ...v.settings });
  const runner = new TaskRunner({ repo, bus: new Bus(), logDir: join(dir, ".logs") });
  const project = repo.createProject({ name: "m", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
  const pipeline: Stage[] = [{ stage: v.stage, model: MODEL, effort: "low" }];
  const task = repo.createTask({ project_id: project.id, title: "Measure", spec_md: "Reply with exactly: ok. Use no tools.", mode: v.mode, pipeline });
  const t0 = Date.now();
  runner.queueTask(task.id);
  while (!["review", "failed", "done"].includes(repo.getTask(task.id)!.status)) await new Promise((r) => setTimeout(r, 250));
  const run = repo.runsForTask(task.id)[0];
  const first = repo.eventsAfter(run.id, 0, 2000).find((e) => (e.payload as { type?: string })?.type === "assistant");
  const u = (first?.payload as { message?: { usage?: Record<string, number> } })?.message?.usage ?? {};
  const startup = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  rows.push({ variant: v.name, startup, cost: run.cost_usd, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`${v.name}: ${startup.toLocaleString()} tokens at start · $${run.cost_usd.toFixed(4)} · ${rows.at(-1)!.seconds}s · ${repo.getTask(task.id)!.status}${run.error ? ` (${run.error})` : ""}`);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // a temp folder; the OS reclaims it
  }
}
console.log(JSON.stringify(rows));
process.exit(0);
