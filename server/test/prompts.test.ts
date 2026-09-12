import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStagePrompt, type PromptCtx } from "../src/engine/prompts.ts";
import { autonomousGate } from "../src/engine/gate.ts";

const base: PromptCtx = {
  stage: "code",
  mode: "autonomous",
  task: { id: "t_child1", title: "Write docs page", spec_md: "Create docs/intro.md explaining setup." },
  branch: "kanban/t_child1",
  parent: { id: "t_parent", title: "Documentation overhaul", spec_md: "Rewrite all docs for v2 launch." },
  siblings: [
    { id: "t_child2", title: "API reference", status: "running", summary: "Drafted 3 of 5 endpoints" },
    { id: "t_child3", title: "Changelog", status: "backlog", summary: null },
  ],
  previousResult: "PLAN: 1. create file 2. add sections",
  skills: ["pdf", "superpowers:brainstorming"],
  messages: [{ from: "t_child2 (API reference)", body: "Use the term 'workspace', not 'project'." }],
};

test("prompt carries task, parent, siblings, previous stage, skills and messages", () => {
  const p = buildStagePrompt(base);
  assert.match(p, /# Stage: code/);
  assert.match(p, /Create docs\/intro\.md explaining setup\./);
  assert.match(p, /## Parent task/);
  assert.match(p, /Rewrite all docs for v2 launch\./);
  assert.match(p, /API reference — running — Drafted 3 of 5 endpoints/);
  assert.match(p, /Changelog — backlog/);
  assert.match(p, /## Previous stage result/);
  assert.match(p, /PLAN: 1\. create file/);
  assert.match(p, /use the `pdf` skill/);
  assert.match(p, /use the `superpowers:brainstorming` skill/);
  assert.match(p, /Use the term 'workspace'/);
  assert.match(p, /kanban\/t_child1/, "autonomous prompt names the worktree branch");
  assert.match(p, /do not commit/i);
});

test("top-level task omits parent/sibling sections; supervised has no worktree note", () => {
  const p = buildStagePrompt({ ...base, mode: "supervised", branch: null, parent: null, siblings: [], previousResult: null, skills: [], messages: [] });
  assert.doesNotMatch(p, /## Parent task/);
  assert.doesNotMatch(p, /## Sibling tasks/);
  assert.doesNotMatch(p, /## Previous stage result/);
  assert.doesNotMatch(p, /worktree/i);
});

test("plan stage asks for subtasks via the board; custom stage uses the custom prompt", () => {
  assert.match(buildStagePrompt({ ...base, stage: "plan" }), /board_create_subtasks/);
  const c = buildStagePrompt({ ...base, stage: "custom", customPrompt: "Translate the README to Arabic." });
  assert.match(c, /Translate the README to Arabic\./);
});

test("autonomous gate", () => {
  const cwd = "C:\\work\\proj\\.kanban\\wt\\t_1";
  const allow = (tool: string, input: Record<string, unknown>) => autonomousGate(tool, input, cwd).behavior === "allow";
  assert.equal(allow("Read", { file_path: "C:\\anywhere\\x.ts" }), true);
  assert.equal(allow("Edit", { file_path: `${cwd}\\src\\a.ts` }), true);
  assert.equal(allow("Write", { file_path: "src/relative.ts" }), true, "relative paths resolve inside cwd");
  assert.equal(allow("Write", { file_path: "C:\\other\\x.ts" }), false);
  assert.equal(allow("Edit", { file_path: `${cwd}\\..\\..\\..\\secrets.txt` }), false);
  assert.equal(allow("Bash", { command: "npm test" }), true);
  assert.equal(allow("Bash", { command: "git push origin main" }), false);
  assert.equal(allow("Bash", { command: "git reset --hard HEAD~1" }), false);
  assert.equal(allow("Bash", { command: "git checkout main" }), false);
  assert.equal(allow("Bash", { command: "git status && git diff" }), true);
  assert.equal(allow("mcp__board__board_set_summary", { text: "hi" }), true);
});

test("autonomous gate: bypasses found in review are refused", () => {
  const cwd = "C:\\work\\my proj\\.kanban\\wt\\t_1";
  const deny = (tool: string, command: string) => autonomousGate(tool, { command }, cwd).behavior === "deny";
  // PowerShell is a shell too
  assert.equal(deny("PowerShell", "git push origin main"), true);
  assert.equal(deny("PowerShell", "Get-ChildItem"), false);
  // retargeting / quoted paths with spaces / -c before the subcommand
  assert.equal(deny("Bash", 'git -C "C:\\work\\my proj" reset --hard'), true);
  assert.equal(deny("Bash", "git -c core.x=y push"), true);
  assert.equal(deny("Bash", "git --git-dir=../../.git status"), true);
  // subcommands outside the allow-list
  assert.equal(deny("Bash", "git restore ."), true);
  assert.equal(deny("Bash", "git stash clear"), true);
  assert.equal(deny("Bash", "npm test && git checkout -- ."), true);
  // leaving the worktree
  assert.equal(deny("Bash", "cd ../../.. && git status"), true);
  assert.equal(deny("Bash", "cat ~/.ssh/id_rsa"), true);
  assert.equal(deny("PowerShell", "Remove-Item -Recurse $env:USERPROFILE\\x"), true);
  assert.equal(deny("Bash", "rm -rf /c/Users/me/Desktop"), true);
  assert.equal(deny("Bash", 'type "C:\\work\\my proj\\secrets.txt"'), true);
  // still allowed inside the worktree
  assert.equal(deny("Bash", `ls "${cwd}\\src"`), false);
  assert.equal(deny("Bash", "git status && git diff --stat && git add -A"), false);
  assert.equal(deny("Bash", "node -e \"console.log(1)\""), false);
  // external MCP tools and questions nobody can answer
  assert.equal(autonomousGate("mcp__plugin_supabase_supabase__execute_sql", { query: "delete from x" }, cwd).behavior, "deny");
  assert.equal(autonomousGate("mcp__plugin_context7_context7__query-docs", {}, cwd).behavior, "allow");
  assert.equal(autonomousGate("AskUserQuestion", {}, cwd).behavior, "deny");
});
