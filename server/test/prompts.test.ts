import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStagePrompt, type PromptCtx } from "../src/engine/prompts.ts";
import { absolutePaths, autonomousGate, escalationHint, readViolation } from "../src/engine/gate.ts";
import { RUN_STYLES, runStyleFields, runStyleOf } from "../src/types.ts";

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

test("the review of an autonomous live task is told its keys are in its folder, and nobody else is (D404)", () => {
  const review = buildStagePrompt({ ...base, stage: "review", live: true, liveAllowed: true });
  assert.match(review, /key files that git leaves out \(such as \.env\) were copied into your folder/);
  assert.match(review, /never print them, and do not look for keys anywhere else/);
  assert.doesNotMatch(buildStagePrompt({ ...base, stage: "review", live: true }), /were copied into your folder/, "a sandboxed live review has no keys");
  assert.doesNotMatch(buildStagePrompt({ ...base, stage: "review", mode: "supervised", branch: null, live: true, liveAllowed: true }), /were copied into your folder/);
});

test("a `..` that lands inside the worktree after its `cd` is allowed; one that leaves, or follows a `cd` the board cannot follow, is not (D404)", () => {
  const cwd = "C:\\work\\proj\\.kanban\\wt\\t_1";
  const ok = (command: string, tool = "Bash") => autonomousGate(tool, { command }, cwd).behavior === "allow";
  // The commands a live run was refused four times in one stage, all inside the worktree.
  assert.equal(ok("cd scripts/direct_expense && python ../../tools/check.py"), true);
  assert.equal(ok("cd scripts && ls .."), true);
  assert.equal(ok("cat src/../README.md"), true);
  assert.equal(ok("cd a/b && cd .. && cat ../x.txt"), true, "each cd is followed");
  assert.equal(ok("cd a && python run.py --out=../y.json"), true, "an option's value is a path too");

  assert.equal(ok("cat ../secrets.json"), false);
  assert.equal(ok("cat ./../../../.env"), false);
  assert.equal(ok("cat src/../../x"), false);
  assert.equal(ok("cd scripts && cat ../../x"), false, "two up from scripts is outside");
  assert.equal(ok("cd a && cd .. && cd .. && ls"), false);
  assert.equal(ok("python run.py --out=../y.json"), false);
  assert.equal(ok("cd scripts; cat ../x"), false, "after ; the cat also runs when the cd failed");
  assert.equal(ok("cd scripts || cat ../x"), false);
  assert.equal(ok("ls | cd scripts && cat ../x"), false, "a cd in a pipe may or may not move, depending on the shell");
  assert.equal(ok("(cd scripts) && cat ../x"), false);
  assert.equal(ok("cd - && cat ../x"), false);
  assert.equal(ok('cd a && cat "$D/../x"'), false, "a variable could be anywhere");
  assert.equal(ok("cd a && cat a,../x"), false, "a list is not a path");
  assert.equal(ok('cd a && cat "../my x"'), false, "a space a program could split on");
  assert.equal(ok('cd a && bash -c "cat ../x"'), false, "a script handed to another program keeps the old rule");
  assert.equal(ok("cd a && python - <<'EOF'\nopen('../x')\nEOF"), false, "text fed to a program is not followed");
  assert.equal(ok("Set-Location scripts; Get-Content ../x", "PowerShell"), false);
});

test("the scratchpad Claude Code gives a session can be written, named in full; nowhere else outside the worktree can (D404)", () => {
  const cwd = "C:\\work\\proj\\.kanban\\wt\\t_1";
  const pad = "C:\\Temp\\claude\\C--work-proj--kanban-wt-t-1";
  const ok = (tool: string, input: Record<string, unknown>) => autonomousGate(tool, input, cwd, [pad], { scratch: [pad] }).behavior === "allow";
  // The writes runs were refused, word for word apart from the folder.
  assert.equal(ok("Write", { file_path: `${pad}\\b5892fef\\scratchpad\\verify.py` }), true);
  assert.equal(ok("Bash", { command: `python "${pad}\\b5892fef\\scratchpad\\erp.py"` }), true);
  assert.equal(ok("Bash", { command: "python /c/Temp/claude/C--work-proj--kanban-wt-t-1/s/scratchpad/erp.py > /c/Temp/claude/C--work-proj--kanban-wt-t-1/s/out.txt" }), true);

  assert.equal(ok("Write", { file_path: "C:\\Temp\\claude\\C--work-proj--kanban-wt-t-2\\x.py" }), false, "another task's scratchpad");
  assert.equal(ok("Write", { file_path: "C:\\Temp\\x.py" }), false);
  assert.equal(ok("Write", { file_path: "..\\C--work-proj--kanban-wt-t-1\\x.py" }), false, "a relative path is measured from the worktree, never from the scratchpad");
  assert.equal(autonomousGate("Write", { file_path: `${pad}\\x.py` }, cwd).behavior, "deny", "without the scratchpad given, nothing changes");
});

test("autonomous reads: the main checkout's secrets are out of reach, attachments and skills are not (D187)", () => {
  const repo = "C:\\Users\\me\\OneDrive\\Client Work Folder\\Acme-Ledger";
  const cwd = `${repo}\\.kanban\\wt\\t_1`;
  const roots = ["C:\\Users\\me\\.claude-kanban\\attachments\\t_1", "C:\\Users\\me\\.claude\\skills"];
  const read = (tool: string, input: Record<string, unknown>) => readViolation(tool, input, cwd, roots);
  // Seen in a real run: the secrets a worktree deliberately leaves out, one Read away.
  assert.match(read("Read", { file_path: `${repo}\\.codex-secrets\\bizapp-api.json` }) ?? "", /refused/);
  assert.match(read("Read", { file_path: "C:\\Users\\me\\.claude-kanban\\secrets.json" }) ?? "", /refused/, "the board's own provider keys");
  assert.match(read("Grep", { pattern: "api_key", path: repo }) ?? "", /refused/);
  assert.match(read("Glob", { pattern: "/c/Users/me/OneDrive/**/*.json" }) ?? "", /refused/, "an absolute glob is a path");
  assert.equal(read("Glob", { pattern: "**/*.ts" }), null, "a relative glob searches the worktree");
  assert.equal(read("Read", { file_path: "C:\\Users\\me\\.claude-kanban\\attachments\\t_1\\shot.png" }), null, "this task's attachments");
  assert.equal(read("Read", { file_path: "C:\\Users\\me\\.claude\\skills\\bizapp\\SKILL.md" }), null, "skills");
  assert.match(read("Read", { file_path: "C:\\Users\\me\\.claude-kanban\\attachments\\t_2\\other.png" }) ?? "", /refused/, "another task's attachments");
  assert.equal(read("Bash", { command: "cat x" }), null, "shell commands have their own check");
});

test("absolute paths are read the way a shell would, whatever quotes sit elsewhere in the command (D188)", () => {
  // The command that exposed it: a heredoc whose body the old tokenizer mis-paired, cutting the path at "Codes".
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
    assert.match(p, /does not stop the run/, "saying so is a suggestion, not a stop (D382)");
    assert.match(p, /Do not look for a way round the sandbox/);
  }
  assert.match(buildStagePrompt({ ...base, stage: "plan", capabilities: "sdk" }), /\*\*\(supervised run\)\*\*/, "the plan marks the steps that need the access");
  assert.match(buildStagePrompt({ ...base, stage: "code", capabilities: "sdk" }), /## Left for a supervised run/, "the code stage lists the steps it left");
  assert.match(buildStagePrompt({ ...base, stage: "review" }), /are not defects of this run/, "review does not fail a sandboxed run for them");
  assert.doesNotMatch(buildStagePrompt({ ...base, stage: "review", mode: "supervised", branch: null }), /are not defects of this run/);
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
  const left = buildStagePrompt({ ...base, mode: "supervised", branch: null, priorBlock: { ...priorBlock, advisory: true } });
  assert.match(left, /## What the last attempt waited for\nThe script lives only in live BizApp/, "a suggestion did not stop it");
  const unlocked = buildStagePrompt({ ...base, priorBlock: { ...priorBlock, advisory: true, needs_access: { kind: "sign_in", target: "erp.example.com" } } });
  assert.match(unlocked, /The person has since done this: sign in to erp\.example\.com\. Do that step now/, "an autonomous rerun after the sign-in is told it has it (D410)");
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

test("an \"Autonomous + asks me\" run is told to ask what changes the result and note the rest (D361)", () => {
  const ask = buildStagePrompt({ ...base, mayAsk: true });
  assert.match(ask, /ask with `AskUserQuestion`: the run waits on a card until they answer/);
  assert.match(ask, /small choice that does not change the result, use `board_ask`/);
  assert.doesNotMatch(ask, /Nobody is watching this run/);
  assert.doesNotMatch(ask, /cannot go on without an answer/, "it can get the answer by asking, so that is no reason to stop");
  assert.match(buildStagePrompt(base), /cannot go on without an answer/);
});

test("the run styles map to a mode and the may-ask switch, and back (D361)", () => {
  for (const s of RUN_STYLES) assert.equal(runStyleOf(runStyleFields(s)), s);
  assert.deepEqual(runStyleFields("ask"), { mode: "autonomous", may_ask: true });
  assert.equal(runStyleOf({ mode: "supervised", may_ask: true }), "supervised", "a supervised task ignores the switch");
});

test("an autonomous run may cd to a folder it named earlier in the same command, and only to that (D390)", () => {
  const wt = "C:/work/proj/.kanban/wt/t1";
  const bash = (command: string) => autonomousGate("Bash", { command }, wt).behavior;
  assert.equal(bash('W="C:/work/proj/.kanban/wt/t1"; cd "$W/scripts" && ls'), "allow");
  assert.equal(bash('S=C:/work/proj/.kanban/wt/t1/docs && cd "${S}/Server Scripts"'), "allow");
  assert.equal(bash('W="C:/work/other"; cd "$W" && ls'), "deny", "a name set outside the folder is still outside");
  assert.equal(bash('cd "$X/scripts"'), "deny", "a name it never set is still unknown");
  assert.equal(bash('W="$HOME"; cd "$W"'), "deny", "a name set from another name is not followed");
});

test("an autonomous run may read what Claude Code saved for its own sessions, and not another task's (D392)", async () => {
  const { claudeSessionRoots } = await import("../src/engine/runner.ts");
  const wt = String.raw`C:\work\proj\.kanban\wt\t_1`;
  const roots = claudeSessionRoots(wt, String.raw`C:\Users\me`, String.raw`C:\Users\me\AppData\Local\Temp`);
  const read = (file_path: string) => autonomousGate("Read", { file_path }, wt, roots).behavior;
  assert.equal(read(String.raw`C:\Users\me\AppData\Local\Temp\claude\C--work-proj--kanban-wt-t-1\s1\tasks\b1.output`), "allow", "a background command's output");
  assert.equal(read(String.raw`C:\Users\me\.claude\projects\C--work-proj--kanban-wt-t-1\s1\tool-results\r1.txt`), "allow", "a long tool result");
  assert.equal(read(String.raw`C:\Users\me\AppData\Local\Temp\claude\C--work-proj--kanban-wt-t-2\s9\tasks\b1.output`), "deny", "another task's sessions stay closed");
  assert.equal(read(String.raw`C:\Users\me\.claude\projects\C--work-proj\memory\notes.md`), "deny", "so does the project's own folder");
});

test("questions already on the card reach the stage as choices taken, so its report does not ask them again", () => {
  const p = buildStagePrompt({
    ...base,
    stage: "review",
    cardQuestions: [
      { text: "Any pending order, or only ones they sent?", default: "Any pending order", answer: null },
      { text: "Keep the old field?", default: "Keep it", answer: "Drop it" },
    ],
  });
  assert.match(p, /## Questions already on the card/);
  assert.match(p, /Any pending order, or only ones they sent\? → not answered yet; carried on with: Any pending order/);
  assert.match(p, /Keep the old field\? → answered: Drop it/);
  assert.match(p, /never again as something the person still has to decide/);
  assert.doesNotMatch(buildStagePrompt(base), /## Questions already on the card/);
});
