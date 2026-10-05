// The rounds plan's real-run check (docs/plans/card-rounds-and-follow-up-routing.md, step 1): does a done
// card's round really continue its coder's session in the recreated folder, and hit the prompt cache? Does a
// fork? Real Haiku runs through the board's own runner, in a throwaway git repo and an in-memory board:
// a few cents, and nothing touches your board. Each line ends YES or NO; a NO is worth telling the plan.
// Run (from server/): node --disable-warning=ExperimentalWarning --import tsx scripts/rounds-check.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner } from "../src/engine/runner.ts";
import { worktreePathFor } from "../src/git/worktree.ts";
import type { Stage } from "../src/types.ts";

const MODEL = "claude-haiku-4-5-20251001";
const CODE: Stage[] = [{ stage: "code", model: MODEL, effort: "low" }];

const dir = mkdtempSync(join(tmpdir(), "krounds-"));
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
git("init", "-q", "-b", "main");
git("config", "user.email", "r@example.com");
git("config", "user.name", "R");
writeFileSync(join(dir, "README.md"), "rounds check\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const repo = new Repo(openDb(":memory:"));
repo.updateSettings({ autoTriage: false, confirmSetup: false });
const runner = new TaskRunner({ repo, bus: new Bus(), logDir: join(dir, ".logs") });
const project = repo.createProject({ name: "r", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });

const settle = async (id: string, want: string[]) => {
  const t0 = Date.now();
  while (!(want.includes(repo.getTask(id)!.status) && !runner.isBusy(id))) {
    if (["failed", "paused"].includes(repo.getTask(id)!.status) && !runner.isBusy(id)) break;
    if (Date.now() - t0 > 300_000) throw new Error(`timed out waiting for ${id}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return repo.getTask(id)!;
};
/** The first turn's usage of a run: what it read from the cache, and what it had to write. */
const firstTurn = (runId: string) => {
  const m = repo.assistantMessages(runId)[0] as { message?: { usage?: Record<string, number> } } | undefined;
  const u = m?.message?.usage ?? {};
  return { read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 };
};
const rows: [string, boolean, string][] = [];
const say = (what: string, ok: boolean, detail: string) => {
  rows.push([what, ok, detail]);
  console.log(`${ok ? "YES" : "NO "}  ${what} — ${detail}`);
};

try {
  const t = repo.createTask({ project_id: project.id, title: "Hello page", spec_md: "Create page.html containing exactly <h1>Hello</h1>. Do nothing else.", mode: "autonomous", pipeline: CODE });
  runner.queueTask(t.id);
  const first = await settle(t.id, ["review"]);
  if (first.status !== "review") throw new Error(`round 1 ended ${first.status}: ${first.error}`);
  await runner.approveTask(t.id);
  const r1 = repo.workRun(t.id)!;
  console.log(`round 1: $${r1.cost_usd.toFixed(4)}, landed (${repo.getTask(t.id)!.files.join(", ")})`);

  await runner.startRound(t.id, "Change the heading text in page.html to Hi. Do nothing else.");
  const second = await settle(t.id, ["review"]);
  const r2 = repo.workRun(t.id)!;
  const fell = repo.roundsFor(t.id)[0]?.fell_back ?? false;
  say("Round 2 continued the coder's own session", r2.session_id === r1.session_id && !fell, fell ? "it could not reopen the session and started fresh" : `session ${r2.session_id === r1.session_id ? "the same" : "a different one"}`);
  say("Round 2 worked in the recreated folder at the same path", second.worktree_path === worktreePathFor(dir, t.id), second.worktree_path ?? "no folder");
  const hit = firstTurn(r2.id);
  say("Round 2's first turn read the memory from the cache (within the hour)", hit.read > hit.write, `${hit.read.toLocaleString()} tokens read from the cache, ${hit.write.toLocaleString()} written`);
  say("Round 2 cost less than round 1", r2.cost_usd < r1.cost_usd, `$${r2.cost_usd.toFixed(4)} against $${r1.cost_usd.toFixed(4)}`);
  if (second.status === "review") await runner.approveTask(t.id);

  const fork = await runner.forkTask(t.id, { title: "Footer", request: "Create footer.html containing exactly <footer>Bye</footer>. Do nothing else." });
  const forked = await settle(fork.id, ["review"]);
  const rf = repo.workRun(fork.id)!;
  say("A fork started a session of its own (the original stays as it was)", Boolean(rf.session_id) && rf.session_id !== r1.session_id, `${forked.status}, session ${rf.session_id === r1.session_id ? "shared — wrong" : "new"}`);
  const fhit = firstTurn(rf.id);
  say("The fork's first turn read the copied memory from the cache", fhit.read > fhit.write, `${fhit.read.toLocaleString()} read, ${fhit.write.toLocaleString()} written`);
} catch (err) {
  console.error(`The check stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  const spent = repo.listTasks({ project_id: project.id }).reduce((s, t) => s + repo.taskCost(t.id), 0);
  console.log(`\n${rows.filter((r) => r[1]).length} of ${rows.length} YES · spent $${spent.toFixed(4)}`);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // a temp folder; the OS reclaims it
  }
  process.exit();
}
