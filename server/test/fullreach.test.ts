import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fullReachGate } from "../src/engine/gate.ts";
import { browserDecision } from "../src/engine/browser.ts";

const project = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
const wt = join(project, ".kanban", "wt", "t_1");
const home = process.platform === "win32" ? "C:\\Users\\someone" : "/home/someone";
const opts = { project, folder: false };
const decide = (tool: string, input: Record<string, unknown>, o = opts, cwd = wt) => fullReachGate(tool, input, cwd, o).behavior;

test("full reach lets an autonomous run do what Claude Code does: read your home folder, run anything, use connectors (D418)", () => {
  assert.equal(decide("Bash", { command: 'ls "$LOCALAPPDATA/ms-playwright"' }), "allow", "the refusal the owner saw on a planning card");
  assert.equal(decide("Bash", { command: "pip install openpyxl && npx playwright install chromium" }), "allow");
  assert.equal(decide("Read", { file_path: join(home, "notes", "spec.md") }), "allow");
  assert.equal(decide("Write", { file_path: join(home, "AppData", "Local", "Temp", "out.csv"), content: "x" }), "allow", "scratch files anywhere");
  assert.equal(decide("mcp__supabase__execute_sql", { query: "select 1" }), "allow", "any connector");
  assert.equal(decide("Bash", { command: "cd scripts && python ../tool.py" }), "allow");
  assert.equal(decide("Edit", { file_path: join(wt, "src", "a.ts"), old_string: "a", new_string: "b" }), "allow");
});

test("full reach keeps the walls that protect the board's bookkeeping: the main checkout, other tasks' copies, the board's git (D418)", () => {
  assert.equal(decide("Edit", { file_path: join(project, "src", "a.ts"), old_string: "a", new_string: "b" }), "deny", "a change in the main checkout would skip Approve and Discard");
  assert.equal(decide("Write", { file_path: join(project, ".kanban", "wt", "t_2", "x.ts"), content: "x" }), "deny", "another task's copy");
  assert.equal(decide("Bash", { command: `copy x.txt "${join(project, "x.txt")}"` }), "deny");
  assert.equal(decide("Bash", { command: "cp x ../../../x" }), "deny", "climbing out of the copy into the main checkout");
  assert.equal(decide("Bash", { command: "git push origin main" }), "deny");
  assert.equal(decide("Bash", { command: "git commit -m x" }), "allow", "committing in its own copy is fine");
  assert.equal(decide("AskUserQuestion", {}), "deny");
  // In the project folder: .git and .kanban stay out of reach, and git only looks.
  const folder = { project, folder: true };
  assert.equal(decide("Edit", { file_path: join(project, "src", "a.ts"), old_string: "a", new_string: "b" }, folder, project), "allow");
  assert.equal(decide("Read", { file_path: join(project, ".git", "config") }, folder, project), "deny");
  assert.equal(decide("Bash", { command: "git commit -am x" }, folder, project), "deny");
});

test("under full reach the board's browser may open any site, as Claude Code would (D418)", () => {
  const nav = { url: "https://erp.example.com/app" };
  assert.equal(browserDecision("mcp__playwright__browser_navigate", nav, true, wt, "/tmp/b", { anywhere: true })?.behavior, "allow");
  assert.equal(browserDecision("mcp__playwright__browser_navigate", nav, true, wt, "/tmp/b", {})?.behavior, "deny", "sandbox reach: only local pages and signed-in sites");
});
