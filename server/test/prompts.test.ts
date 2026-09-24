import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStagePrompt, type PromptCtx } from "../src/engine/prompts.ts";
import { absolutePaths, autonomousGate, escalationHint, readViolation } from "../src/engine/gate.ts";

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
  assert.equal(allow("Read", { file_path: "C:\\anywhere\\x.ts" }), false, "reads stay inside the worktree too (D187)");
  assert.equal(allow("Read", { file_path: `${cwd}\\src\\a.ts` }), true);
  assert.equal(allow("Read", { file_path: "src/a.ts" }), true);
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

test("autonomous reads: the main checkout's secrets are out of reach, attachments and skills are not (D187)", () => {
  const repo = "C:\\Users\\me\\CloudSync\\Client Work Folder\\Acme-Ledger";
  const cwd = `${repo}\\.kanban\\wt\\t_1`;
  const roots = ["C:\\Users\\me\\.claude-kanban\\attachments\\t_1", "C:\\Users\\me\\.claude\\skills"];
  const read = (tool: string, input: Record<string, unknown>) => readViolation(tool, input, cwd, roots);
  // Seen in a real run: the secrets a worktree deliberately leaves out, one Read away.
  assert.match(read("Read", { file_path: `${repo}\\.codex-secrets\\bizapp-api.json` }) ?? "", /refused/);
  assert.match(read("Read", { file_path: "C:\\Users\\me\\.claude-kanban\\secrets.json" }) ?? "", /refused/, "the board's own provider keys");
  assert.match(read("Grep", { pattern: "api_key", path: repo }) ?? "", /refused/);
  assert.match(read("Glob", { pattern: "/c/Users/me/CloudSync/**/*.json" }) ?? "", /refused/, "an absolute glob is a path");
  assert.equal(read("Glob", { pattern: "**/*.ts" }), null, "a relative glob searches the worktree");
  assert.equal(read("Read", { file_path: "C:\\Users\\me\\.claude-kanban\\attachments\\t_1\\shot.png" }), null, "this task's attachments");
  assert.equal(read("Read", { file_path: "C:\\Users\\me\\.claude\\skills\\bizapp\\SKILL.md" }), null, "skills");
  assert.match(read("Read", { file_path: "C:\\Users\\me\\.claude-kanban\\attachments\\t_2\\other.png" }) ?? "", /refused/, "another task's attachments");
  assert.equal(read("Bash", { command: "cat x" }), null, "shell commands have their own check");
});

test("absolute paths are read the way a shell would, whatever quotes sit elsewhere in the command (D188)", () => {
  // The command that exposed it: a heredoc whose body the old tokenizer mis-paired, cutting the path at "Client".
  const cmd = `cd "/c/Users/me/Client Work Folder/proj/.kanban/wt/t_1" && python - <<'EOF'\nimport json\nc=json.load(open(r"C:\\Users\\me\\Client Work Folder\\proj\\.codex-secrets\\bizapp-api.json"))\nprint("it's here")\nEOF`;
  assert.deepEqual(absolutePaths(cmd), ["/c/Users/me/Client Work Folder/proj/.kanban/wt/t_1", "C:\\Users\\me\\Client Work Folder\\proj\\.codex-secrets\\bizapp-api.json"]);
  assert.deepEqual(absolutePaths("ls /c/tmp/x && type C:\\a\\b.txt"), ["/c/tmp/x", "C:\\a\\b.txt"]);
  assert.deepEqual(absolutePaths("curl -s https://example.com/api && git clone https://github.com/a/b"), [], "a URL is not a path");

  const cwd = "C:\\Users\\me\\Client Work Folder\\proj\\.kanban\\wt\\t_1";
  const gate = (command: string) => autonomousGate("Bash", { command }, cwd);
  assert.equal(gate(`cat "${cwd}\\notes it's.md"`).behavior, "allow", "a quoted in-worktree path with spaces is inside");
  assert.equal(gate(`python - <<'EOF'\nprint("don't")\nopen(r"${cwd}\\data.json")\nEOF`).behavior, "allow", "an apostrophe in a heredoc no longer splits the path");
  assert.equal(gate("curl -s https://example.com").behavior, "allow", "a URL used to be refused as the path s://example.com");
  assert.equal(gate(`python -c "open(r'C:\\Users\\me\\Client Work Folder\\proj\\.env')"`).behavior, "deny");
});

test("every autonomous refusal says how to escalate, and the third one says to stop (D186)", () => {
  assert.match(escalationHint(1), /board_report_blocked[\s\S]*supervised/);
  assert.doesNotMatch(escalationHint(2), /stop trying/);
  assert.match(escalationHint(3), /refusal number 3[\s\S]*stop trying/);
});

test("autonomous plan and code stages are told to report a sandbox wall instead of routing round it", () => {
  for (const stage of ["plan", "code"] as const) {
    const p = buildStagePrompt({ ...base, stage, capabilities: "sdk" });
    assert.match(p, /board_report_blocked` with needs "supervised"/);
    assert.match(p, /Do not look for a way round the sandbox/);
  }
  assert.doesNotMatch(buildStagePrompt({ ...base, stage: "code", mode: "supervised", branch: null }), /sandboxed/, "supervised runs are not sandboxed");
});

test("plan hands facts on; code answers every ask; review judges against the spec, not the previous stage (D189, D190)", () => {
  assert.match(buildStagePrompt({ ...base, stage: "plan" }), /## Facts established/);
  const code = buildStagePrompt({ ...base, stage: "code" });
  assert.match(code, /Treat the plan's established facts as done work/);
  assert.match(code, /"show me \/ explain how" request is part of the task/);
  for (const caps of ["sdk", "text"] as const) {
    const review = buildStagePrompt({ ...base, stage: "review", capabilities: caps, inlineDiff: [] });
    assert.match(review, /not against what the previous stage says it did/);
    assert.match(review, /✅ delivered or ❌ not delivered/);
    assert.match(review, /VERDICT: BLOCKED/);
  }
  assert.match(buildStagePrompt({ ...base, stage: "review" }), /says it was blocked or only partly done has not delivered: never approve it/);
});

test("a rerun after a block is told what stopped it, and a supervised rerun knows it can now reach it", () => {
  const priorBlock = { reason: "The script lives only in live BizApp; its credentials are outside the worktree.", needs: "supervised" as const, ask: "Run supervised.", mode: "autonomous" as const };
  const p = buildStagePrompt({ ...base, mode: "supervised", branch: null, priorBlock });
  assert.match(p, /## What stopped the last attempt\nThe script lives only in live BizApp/);
  assert.match(p, /It asked: Run supervised\./);
  assert.match(p, /It now runs supervised, in the main checkout/);
  const again = buildStagePrompt({ ...base, priorBlock: { ...priorBlock, mode: "supervised" }, mode: "supervised", branch: null });
  assert.match(again, /Check whether what stopped it has changed/, "no claim of new access when the mode did not change");
});

test("a long plan reaches the code stage whole: the steps in its middle are not trimmed", () => {
  const plan = `# Plan\n${"step detail. ".repeat(800)}\n## Facts established\n- the script is INVOICE-PAY-SCRIPT`;
  assert.ok(plan.length > 6000 && plan.length < 12000);
  const p = buildStagePrompt({ ...base, previousResult: plan, previousStage: "plan" });
  assert.doesNotMatch(p, /characters trimmed/);
  assert.match(p, /INVOICE-PAY-SCRIPT/);
});

// A real 8,600-character plan lost its middle — the execution steps and a safety guard — at the old
// 6,000-character clamp, and the code stage never saw them (D229).
const longPlan = `# Plan\n${"Root cause detail. ".repeat(250)}\n## Execution steps\n2. **(required)** snapshot every user's roles, then restore any lost\n${"Docs and risks. ".repeat(200)}`;

test("a plan reaches the code stage whole; other results are still clamped", () => {
  const code = buildStagePrompt({ ...base, previousResult: longPlan, previousStage: "plan" });
  assert.ok(longPlan.length > 6000);
  assert.match(code, /## The plan \(previous stage\)/);
  assert.match(code, /snapshot every user's roles/);
  assert.doesNotMatch(code, /characters trimmed/);
  const custom = buildStagePrompt({ ...base, previousResult: longPlan, previousStage: "custom" });
  assert.match(custom, /characters trimmed — `board_get_task` has the full text/);
});

test("code stage works to the plan and reports each step; review checks the plan", () => {
  const code = buildStagePrompt({ ...base, previousResult: "## Execution steps\n1. do x", previousStage: "plan" });
  assert.match(code, /The plan above is your contract/);
  assert.match(code, /do not repeat its investigation/);
  assert.match(code, /## Plan steps` checklist/);
  const noPlan = buildStagePrompt({ ...base, previousStage: "custom" });
  assert.doesNotMatch(noPlan, /your contract/);

  const review = buildStagePrompt({
    ...base, stage: "review", previousResult: "Changed a.ts", previousStage: "code",
    earlierResults: [{ stage: "plan", result: longPlan }],
  });
  assert.match(review, /snapshot every user's roles/, "review sees the whole plan, not its first 1,500 characters");
  assert.match(review, /dropped silently[^\n]*CHANGES_NEEDED/);
  assert.match(buildStagePrompt({ ...base, stage: "plan" }), /\*\*\(required\)\*\*/);
});

test("supervised code stage asks for a gated step on a card instead of stopping", () => {
  const sup = buildStagePrompt({ ...base, mode: "supervised", branch: null });
  assert.match(sup, /## Approvals/);
  assert.match(sup, /The card is the approval/);
  assert.doesNotMatch(buildStagePrompt(base), /## Approvals/, "autonomous runs have no cards");
  assert.doesNotMatch(buildStagePrompt({ ...base, mode: "supervised", branch: null, stage: "plan" }), /## Approvals/);
});

test("the Board section names one way to ask per mode (D239)", () => {
  const sup = buildStagePrompt({ ...base, mode: "supervised", branch: null });
  assert.match(sup, /Ask the person with `AskUserQuestion`/);
  assert.doesNotMatch(sup, /Nobody is watching this run/);
  const auto = buildStagePrompt(base);
  assert.match(auto, /Nobody is watching this run, so every question for the person goes through `board_ask`/);
  assert.doesNotMatch(auto, /AskUserQuestion/);
});
