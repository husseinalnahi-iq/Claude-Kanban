import { test } from "node:test";
import assert from "node:assert/strict";
import { explainCommand, splitChain, shellWords } from "../src/engine/explain.ts";
import { commandsForTask } from "../src/engine/commands.ts";
import type { Approval, EventRow, Run } from "../src/types.ts";

test("a command is explained in plain words from the table, with the highest risk of its parts (D336)", () => {
  const e = explainCommand("git status");
  assert.equal(e.summary, "Git shows which files changed and what is staged.");
  assert.equal(e.risk, "reads");
  assert.equal(e.complete, true);

  const chain = explainCommand("cd server && npm ci && npm test 2>&1 | tail -20");
  assert.equal(chain.parts.length, 4, "one part per chained command, pipes included");
  assert.equal(chain.risk, "installs", "installing beats running and looking");
  assert.match(chain.summary, /^Moves into the folder “server”, then installs the project's dependencies, then runs the project's tests, then shows the last lines/);

  assert.equal(explainCommand("rm -rf node_modules dist").risk, "deletes");
  assert.match(explainCommand("rm -rf node_modules dist").summary, /Deletes “node_modules dist”, folders and all, without asking/);
  assert.equal(explainCommand("curl -s https://example.com/api -o out.json").risk, "network");
  assert.match(explainCommand("curl -X POST -d '{}' https://example.com/api").summary, /Sends data to “https:\/\/example.com\/api”/);
  assert.equal(explainCommand("sudo apt-get install -y jq").risk, "system", "sudo lifts anything to the computer level");
  assert.equal(explainCommand("git push --force origin main").parts[0]!.meaning.includes("force push"), true);
  assert.equal(explainCommand("git checkout -- src/app.ts").risk, "deletes", "throwing away edits is a delete");
  assert.equal(explainCommand("npx tsc --noEmit").risk, "installs", "npx may download the tool");
  assert.equal(explainCommand("grep -rn foo src > hits.txt").risk, "writes", "a redirect saves the output");
  assert.equal(explainCommand("Remove-Item -Recurse -Force .\\dist").risk, "deletes", "PowerShell too");

  const odd = explainCommand("frobnicate --all");
  assert.equal(odd.complete, false, "a command the table does not know says so");
  assert.equal(odd.risk, "unknown");
  assert.match(odd.summary, /Runs “frobnicate”/);
});

test("the shell splitter keeps quotes and subshells whole", () => {
  assert.deepEqual(splitChain(`echo "a && b" && ls; (cd x && make) | wc -l`), [`echo "a && b"`, "ls", "(cd x && make)", "wc -l"]);
  assert.deepEqual(shellWords(`git commit -m "fix: it's done"`), ["git", "commit", "-m", "fix: it's done"]);
});

test("a task's commands are read off its transcripts with their state: done, failed, waiting, running, denied (D337)", () => {
  const run: Run = { id: "r1", task_id: "t1", stage: "code", stage_index: 1, status: "running", session_id: null, model: "m", effort: "low" } as unknown as Run;
  const ev = (id: number, payload: unknown, ts: string): EventRow => ({ id, run_id: "r1", ts, type: "x", payload });
  const use = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
  const events: EventRow[] = [
    ev(1, { type: "assistant", message: { content: [use("a", "npm test"), use("b", "rm -rf dist")] } }, "2026-10-03T10:00:00Z"),
    ev(2, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: false }, { type: "tool_result", tool_use_id: "b", is_error: true }] } }, "2026-10-03T10:00:05Z"),
    ev(3, { type: "auto_allowed", command: "git status" }, "2026-10-03T10:00:06Z"),
    ev(4, { type: "assistant", message: { content: [use("c", "git status"), use("d", "curl https://x.y"), use("e", "npm run build")] } }, "2026-10-03T10:00:07Z"),
    ev(5, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c", is_error: false }] } }, "2026-10-03T10:00:08Z"),
  ];
  const approvals: Approval[] = [
    { id: "ap1", run_id: "r1", task_id: "t1", tool_name: "Bash", input: { command: "curl https://x.y" }, title: null, decision: null, decided_at: null, note: null, answers: null, created_at: "2026-10-03T10:00:07Z" } as unknown as Approval,
    { id: "ap2", run_id: "r1", task_id: "t1", tool_name: "Bash", input: { command: "npm run build" }, title: null, decision: "deny", decided_at: "x", note: null, answers: null, created_at: "2026-10-03T10:00:07Z" } as unknown as Approval,
    { id: "ap3", run_id: "r1", task_id: "t1", tool_name: "Bash", input: { command: "echo soon" }, title: null, decision: null, decided_at: null, note: null, answers: null, created_at: "2026-10-03T10:00:09Z" } as unknown as Approval,
  ];
  const list = commandsForTask([run], () => events, approvals);
  assert.deepEqual(list.map((c) => [c.command, c.status, c.via]), [
    ["npm test", "done", "autonomous"],
    ["rm -rf dist", "failed", "autonomous"],
    ["git status", "done", "auto"],
    ["curl https://x.y", "waiting", "approval"],
    ["npm run build", "denied", "approval"],
    ["echo soon", "waiting", "approval"],
  ]);
  const stopped = commandsForTask([{ ...run, status: "failed" } as Run], () => events.slice(0, 4), []);
  assert.equal(stopped.find((c) => c.command === "curl https://x.y")!.status, "stopped", "no result and the run is over");
});
