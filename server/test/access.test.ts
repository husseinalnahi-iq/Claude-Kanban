import { test } from "node:test";
import assert from "node:assert/strict";
import { handsOffGate, isTrusted, trustRules } from "../src/engine/gate.ts";
import { chatBoardHandlers } from "../src/engine/chatBoard.ts";
import { answerStage } from "../src/engine/answer.ts";
import { PolicyError, type QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";
import { setup, until, type Call } from "./helpers.ts";

const CODE: Stage[] = [{ stage: "code", model: "claude-opus-5", effort: "high" }];
const CWD = "C:\\work\\proj";

/** A fake session that makes the tool calls `act` asks for, then reports. */
function scripted(act: (o: any) => Promise<void>) {
  const calls: Call[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const i = calls.length;
      calls.push({ prompt, options: params.options as Record<string, any> });
      yield { type: "system", subtype: "init", session_id: `s${i}` } as any;
      await act(params.options);
      yield {
        type: "result", subtype: "success", is_error: false, result: "The latest receipt is PR-0042.", total_cost_usd: 0.01, session_id: `s${i}`,
        modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      } as any;
    })();
  return { fn, calls };
}
const OPTS = { signal: new AbortController().signal, toolUseID: "t" };

test("Always allow remembers the program and the script it runs, so other arguments match and nothing else does (D353)", () => {
  const rules = (command: string) => trustRules("Bash", { command }, CWD);
  assert.deepEqual(rules(`bash scripts/fetch.sh "Purchase Receipt" --limit 1`), ["bash scripts/fetch.sh"]);
  assert.deepEqual(rules("cd C:/work/proj && ls scripts && python tools/report.py --month 9 | head -5"), ["python tools/report.py"], "read-only parts and a cd inside the project need no rule");
  assert.deepEqual(rules("npm run test -- --watch"), ["npm run test"]);
  assert.deepEqual(rules("git push origin main"), ["git push"]);
  assert.deepEqual(rules("./scripts/fetch.sh one"), ["./scripts/fetch.sh"]);
  assert.deepEqual(trustRules("mcp__erp__get_doc", { name: "x" }, CWD), ["mcp__erp__get_doc"], "a connector's tool is trusted by name");
  // Nothing lasting to remember, or nothing the board will ever stop asking about.
  for (const c of [`python -c "print(1)"`, "bash scripts/fetch.sh > out.txt", "bash scripts/fetch.sh $(cat x)", "cat .env", "FOO=1 bash scripts/fetch.sh", ""]) {
    assert.equal(rules(c), null, c);
  }
  assert.equal(trustRules("Write", { file_path: "x.txt" }, CWD), null, "a file edit always asks");

  const ok = (command: string, list = ["bash scripts/fetch.sh"]) => isTrusted("Bash", { command }, CWD, list);
  assert.ok(ok("bash scripts/fetch.sh Item --limit 5"));
  assert.ok(ok("cd C:/work/proj && bash scripts/fetch.sh Item | head -3"));
  assert.ok(ok("bash scripts/fetch.sh --config .secrets/erp.json"), "a script that loads a credentials file is covered");
  for (const c of [
    "bash scripts/fetch.sh.bak", "bash scripts/other.sh", "bash scripts/fetch.sh && rm -rf build", "bash scripts/fetch.sh > out.txt",
    "bash scripts/fetch.sh | sh", "bash scripts/fetch.sh; cat .secrets/erp.json", "bash scripts/fetch.sh `id`",
  ]) {
    assert.equal(ok(c), false, c);
  }
  assert.equal(ok("git log -3"), false, "a read-only command is the read-only rule's business, not this list's");
  assert.equal(ok("bash scripts/fetch.sh", []), false);
  assert.ok(isTrusted("mcp__erp__get_doc", {}, CWD, ["mcp__erp__get_doc"]));
  assert.equal(isTrusted("Write", { file_path: "x" }, CWD, ["Write"]), false);
});

test("a lookup with nobody asked may run anything except an edit or a command that shows credentials (D352)", () => {
  const allowed = (tool: string, input: Record<string, unknown>) => handsOffGate(tool, input).behavior === "allow";
  assert.ok(allowed("Bash", { command: "bash scripts/fetch.sh --config .secrets/erp.json" }), "a script may load the key file");
  assert.ok(allowed("Bash", { command: "curl -s https://erp.example.com/api/resource/Item" }));
  assert.ok(allowed("Read", { file_path: "C:\\other\\notes.md" }));
  assert.ok(allowed("mcp__erp__get_doc", { name: "x" }));
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) assert.equal(allowed(tool, { file_path: "a.txt", notebook_path: "a.ipynb" }), false, tool);
  assert.equal(allowed("Bash", { command: "cat .secrets/erp.json" }), false);
  assert.equal(allowed("Read", { file_path: ".env" }), false);
  assert.equal(allowed("AskUserQuestion", {}), false, "nobody is there to answer");
});

test("Always allow on a card lets it through, and the same command never asks again in that project (D353)", async () => {
  const decisions: string[] = [];
  const f = scripted(async (o) => {
    decisions.push((await o.canUseTool("Bash", { command: "bash scripts/fetch.sh Item" }, OPTS)).behavior);
    decisions.push((await o.canUseTool("Bash", { command: "bash scripts/fetch.sh Supplier --limit 3" }, OPTS)).behavior);
  });
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    s.runner.decideApproval(s.repo.pendingApprovals(task.id)[0].id, "allow", null, undefined, true);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.deepEqual(decisions, ["allow", "allow"], "the second one, with other arguments, never became a card");
    assert.deepEqual(s.repo.getProject(s.project.id)!.policy.trusted, ["bash scripts/fetch.sh"]);
    assert.ok(s.seen.some((m) => m.type === "project.updated"), "the settings page hears about the new rule");

    // The next task in the project is not asked either; a different script still is.
    decisions.length = 0;
    const next = s.repo.createTask({ project_id: s.project.id, title: "y", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(next.id);
    await until(() => s.repo.getTask(next.id)!.status === "review");
    assert.deepEqual(decisions, ["allow", "allow"]);
    assert.equal(s.repo.pendingApprovals(next.id).length, 0);
  } finally {
    await s.cleanup();
  }
});

test("Always allow is refused for a command with nothing lasting to remember, and the card stays", async () => {
  const f = scripted(async (o) => void (await o.canUseTool("Bash", { command: `python -c "print(1)"` }, OPTS)));
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    const [card] = s.repo.pendingApprovals(task.id);
    assert.throws(() => s.runner.decideApproval(card.id, "allow", null, undefined, true), /cannot always allow/);
    assert.equal(s.repo.pendingApprovals(task.id).length, 1, "still waiting for a plain Allow or Deny");
    assert.equal(s.repo.getProject(s.project.id)!.policy.trusted, undefined);
    s.runner.decideApproval(card.id, "allow", null);
    await until(() => s.repo.getTask(task.id)!.status === "review");
  } finally {
    await s.cleanup();
  }
});

test("an autonomous lookup runs in the project's own folder with nothing on a card, and lands in Done (D352)", async () => {
  const decisions: string[] = [];
  const hooked: string[] = [];
  const f = scripted(async (o) => {
    for (const [tool, input] of [
      ["Bash", { command: "bash scripts/fetch.sh --config .secrets/erp.json" }],
      ["Write", { file_path: "notes.txt", content: "x" }],
      ["Bash", { command: "cat .secrets/erp.json" }],
    ] as const) {
      decisions.push((await o.canUseTool(tool, input, OPTS)).behavior);
      // The same gate as a hook: a settings file's own allow rule must not carry a call past it.
      const out = await o.hooks.PreToolUse[0].hooks[0]({ tool_name: tool, tool_input: input });
      hooked.push(out.hookSpecificOutput?.permissionDecision ?? "pass");
    }
  });
  const s = setup(f.fn);
  s.repo.updateSettings({ autoTriage: false });
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "Latest receipt", mode: "autonomous", pipeline: [answerStage(s.repo.getSettings())] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "done");
    assert.deepEqual(decisions, ["allow", "deny", "deny"]);
    assert.deepEqual(hooked, ["pass", "deny", "deny"]);
    assert.equal(s.repo.pendingApprovals(task.id).length, 0, "nothing waited for anyone");
    const done = s.repo.getTask(task.id)!;
    assert.deepEqual([done.worktree_path, done.branch, done.blocked], [null, null, null], "a read needs no copy of the project");
    assert.equal(f.calls[0].options.cwd, s.dir, "the project's own folder, where its scripts and keys are");
    assert.equal(f.calls[0].options.permissionMode, "default");
    assert.match(f.calls[0].prompt, /## Nobody is asked/);
    assert.doesNotMatch(f.calls[0].prompt, /This run is sandboxed/);
  } finally {
    await s.cleanup();
  }
});

test("a project that keeps autonomous in its sandbox sends a chat's lookup to supervised, and will not run an autonomous one", async () => {
  const f = scripted(async () => {});
  const s = setup(f.fn, { access: "sandboxed" });
  s.repo.updateSettings({ autoTriage: false });
  try {
    const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
    const made = JSON.parse(h.createTask({ title: "Latest receipt", spec_md: "x", stages: [{ stage: "answer" }], mode: "autonomous" } as never).content[0].text);
    assert.equal(s.repo.getTask(made.created.id)!.mode, "supervised");
    assert.match(made.note, /sandbox/);

    const forced = s.repo.createTask({ project_id: s.project.id, title: "Latest receipt", mode: "autonomous", pipeline: [answerStage(s.repo.getSettings())] });
    assert.throws(() => s.runner.assertRunnable(forced, s.repo.getProject(s.project.id)!), PolicyError);

    // Full access is what a project has until someone says otherwise.
    s.repo.updateProject(s.project.id, { policy: { worktrees: "forbidden", autonomous: "allowed", maxConcurrent: 3 } });
    const open = JSON.parse(h.createTask({ title: "Latest receipt", spec_md: "x", stages: [{ stage: "answer" }], mode: "autonomous" } as never).content[0].text);
    assert.equal(s.repo.getTask(open.created.id)!.mode, "autonomous", "a lookup needs no worktree, so forbidding them does not stop it");
    assert.match(open.note, /nothing is asked/);
    const change = JSON.parse(h.createTask({ title: "Dark mode", spec_md: "x", mode: "autonomous" } as never).content[0].text);
    assert.equal(s.repo.getTask(change.created.id)!.mode, "autonomous", "without worktrees a card that changes something works in the project folder (D398)");
  } finally {
    await s.cleanup();
  }
});
