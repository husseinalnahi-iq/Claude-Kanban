// Does a stage really hand its browser check to the cheaper helper, and does the helper's screenshot
// reach the task? One small Haiku stage in a throwaway repo; prints which tools ran, and where.
// Run: npx tsx scripts/helper-smoke.ts   (from server/)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner } from "../src/engine/runner.ts";

const dir = mkdtempSync(join(tmpdir(), "khelper-"));
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
git("init", "-q", "-b", "main");
git("config", "user.email", "m@example.com");
git("config", "user.name", "M");
writeFileSync(join(dir, "README.md"), "smoke\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const repo = new Repo(openDb(":memory:"));
repo.updateSettings({ autoTriage: false, liveView: false, stateDir: join(dir, ".state") } as never);
const runner = new TaskRunner({ repo, bus: new Bus(), logDir: join(dir, ".logs") });
const project = repo.createProject({ name: "smoke", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
const task = repo.createTask({
  project_id: project.id,
  title: "Red button",
  spec_md: "Create index.html with one big red button labelled Go. Then have it checked in a browser: the button must be visible and red. Keep it short.",
  mode: "autonomous",
  pipeline: [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }],
});
const t0 = Date.now();
runner.queueTask(task.id);
while (!["review", "failed", "done"].includes(repo.getTask(task.id)!.status)) await new Promise((r) => setTimeout(r, 500));
const run = repo.runsForTask(task.id)[0];
const tools: string[] = [];
for (const e of repo.eventsAfter(run.id, 0, 2000)) {
  const p = e.payload as { type?: string; parent_tool_use_id?: string | null; message?: { content?: { type: string; name?: string; input?: { subagent_type?: string } }[] } };
  if (p?.type !== "assistant") continue;
  for (const b of p.message?.content ?? []) {
    if (b.type === "tool_use") tools.push(`${p.parent_tool_use_id ? "  helper → " : ""}${b.name}${b.input?.subagent_type ? ` (${b.input.subagent_type})` : ""}`);
  }
}
console.log(`status ${repo.getTask(task.id)!.status} · $${run.cost_usd.toFixed(4)} · ${Math.round((Date.now() - t0) / 1000)}s${run.error ? ` · ${run.error}` : ""}`);
console.log(tools.join("\n"));
console.log("screenshots kept:", repo.listAttachments(task.id).length);
console.log("result:", (run.result_md ?? "").slice(0, 600));
process.exit(0);
