import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { credentialRisk } from "../src/engine/credentials.ts";
import { isReadOnlyShell } from "../src/engine/gate.ts";
import { boardHandlers } from "../src/engine/boardMcp.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import type { Stage } from "../src/types.ts";
import { setup, until, type Call } from "./helpers.ts";

const CODE: Stage[] = [{ stage: "code", model: "claude-opus-5", effort: "high" }];
const TWO: Stage[] = [CODE[0], { stage: "review", model: "claude-sonnet-5", effort: "medium" }];

test("credentials: printing one is flagged as such, loading one only as touching (D201)", () => {
  // The command a review stage really asked for.
  assert.deepEqual(credentialRisk("Bash", { command: 'cd "C:\\p" && cat .codex-secrets/bizapp-api.json 2>/dev/null | head -5' }), {
    level: "prints",
    files: [".codex-secrets/bizapp-api.json"],
  });
  assert.equal(credentialRisk("PowerShell", { command: "Get-Content .env" })?.level, "prints");
  assert.equal(credentialRisk("Read", { file_path: "C:\\p\\.env.local" })?.level, "prints", "Read puts the contents in the transcript");
  const load = `python - <<'EOF'\nimport json\nc=json.load(open(r".codex-secrets/bizapp-api.json"))\nEOF`;
  assert.equal(credentialRisk("Bash", { command: load })?.level, "touches", "a script that only loads it");
  assert.equal(credentialRisk("Bash", { command: "cat .env.example" }), null, "a template is not a credential");
  assert.equal(credentialRisk("Bash", { command: "grep -n redact server/src/secrets.ts" }), null, "code about secrets is code");
  assert.equal(credentialRisk("Bash", { command: "cat ~/.ssh/id_ed25519" })?.level, "prints");
  assert.equal(credentialRisk("Bash", { command: "git status" }), null);
  assert.equal(credentialRisk("Edit", { file_path: ".env" }), null, "only reads and shells are judged");
});

test("read-only shell: what a supervised run may do without a card, and everything that still asks (D202)", () => {
  const cwd = "C:\\Users\\me\\Client Work Folder\\proj";
  const ro = (c: string) => isReadOnlyShell(c, cwd);
  // Real commands from the supervised run that took ~30 cards.
  assert.ok(ro(`cd "/c/Users/me/Client Work Folder/proj" && sed -n '212p' docs/ai/TASK_LEDGER.md | grep -io 'via journal'`));
  assert.ok(ro(`cd "/c/Users/me/Client Work Folder/proj" && git show --stat b11a70b5 | grep -i -E "rail|pay" | head -40`));
  assert.ok(ro(`ls "BIZAPP docs/Client Scripts/" | grep -i "PI-APPLY"; grep -n "PI-PAY" docs/*.md 2>/dev/null | head`));
  assert.ok(ro("git status --short && git log --oneline -5 && git diff --stat"));
  assert.ok(ro("git branch --show-current && git worktree list"));
  assert.ok(ro("Get-ChildItem -Recurse | Select-String -Pattern foo | Select-Object -First 5"));
  assert.ok(ro("find . -name '*.js' -newer x"));
  assert.ok(ro("sed -n '54p;145p' docs/ai/TASK_LEDGER_ARCHIVE.md | cut -c1-2500"), "several print addresses");
  // Anything that can write, run something else, or leave the project.
  for (const c of [
    "echo hi > notes.txt", "grep x a >> b", "sed -i 's/a/b/' f", "sed -n '1w out' f", "sort -o out.txt in",
    "find . -name x -delete", "find . -exec rm {} ;", "rg --pre ./run.sh foo", "git commit -m x", "git branch feature",
    "git checkout main", "git -c core.pager=x log", "python -c 'print(1)'", "node x.js", "npm test", "awk '{print > \"f\"}' a",
    "cat $(which x)", "cat `ls`", "xargs rm < list", "FOO=1 ls", "ls | Out-File x", "Set-Content x y", "cat <<EOF\nx\nEOF",
    "cat C:\\Windows\\win.ini", "ls /c/Users/other", "cat .env", "rm -rf build", "",
  ]) {
    assert.equal(ro(c), false, c);
  }
});

type Ctx = { repo: ReturnType<typeof setup>["repo"]; bus: ReturnType<typeof setup>["bus"] };
function scripted(results: (i: number) => string, act?: (i: number, o: any, board: () => ReturnType<typeof boardHandlers>) => Promise<void>) {
  const calls: Call[] = [];
  const holder: { ctx?: Ctx; taskId?: string } = {};
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const i = calls.length;
      calls.push({ prompt, options: params.options as Record<string, any> });
      yield { type: "system", subtype: "init", session_id: `s${i}` } as any;
      const board = () => boardHandlers(holder.ctx!.repo, holder.ctx!.bus, { taskId: holder.taskId!, runId: holder.ctx!.repo.latestRun(holder.taskId!)!.id });
      await act?.(i, params.options, board);
      yield {
        type: "result", subtype: "success", is_error: false, result: results(i), total_cost_usd: 0.01, session_id: `s${i}`,
        modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      } as any;
    })();
  return { fn, calls, holder };
}

test("a supervised run runs a read-only command without a card, and still asks for a write (D202)", async () => {
  const decisions: string[] = [];
  const f = scripted(
    () => "done",
    async (_i, o) => {
      const opts = { signal: new AbortController().signal, toolUseID: "t" };
      decisions.push((await o.canUseTool("Bash", { command: "git log --oneline -3 | head -1" }, opts)).behavior);
      // A skill's reference file lives outside the project: read freely, like an autonomous run may.
      decisions.push((await o.canUseTool("Read", { file_path: join(homedir(), ".claude", "skills", "bizapp", "references", "api.md") }, opts)).behavior);
      decisions.push((await o.canUseTool("Bash", { command: "cat .env" }, opts)).behavior);
    },
  );
  const s = setup(f.fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    const [card] = s.repo.pendingApprovals(task.id);
    assert.equal(card.tool_name, "Bash");
    assert.equal((card.input as { command: string }).command, "cat .env", "the read-only one never became a card; the credentials one did");
    s.runner.decideApproval(card.id, "deny", null);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.deepEqual(decisions, ["allow", "allow", "deny"]);
    const run = s.repo.latestRun(task.id)!;
    assert.ok(s.repo.eventsAfter(run.id).some((e) => e.type === "board:auto-allowed"), "the transcript says the board allowed it");

    s.repo.updateSettings({ autoAllowReadOnly: false });
    decisions.length = 0;
    s.runner.retryTask(task.id, 0);
    await until(() => s.repo.pendingApprovals(task.id).length === 1);
    assert.equal((s.repo.pendingApprovals(task.id)[0].input as { command: string }).command, "git log --oneline -3 | head -1", "switched off: every command asks again");
    s.runner.stopTask(task.id);
  } finally {
    await s.cleanup();
  }
});

test("board_ask puts a question on the card without stopping; the answer reaches the next stage (D203)", async () => {
  const f = scripted(
    (i) => (i === 0 ? "coded with the default" : "reviewed"),
    async (i, _o, board) => {
      if (i === 0) board().ask({ question: "Why is gain/loss settlement allowed?", options: ["FX margin", "Write-offs"], default: "Logging the request only" });
    },
  );
  const s = setup(f.fn);
  f.holder.ctx = s;
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: TWO });
    f.holder.taskId = task.id;
    // Answer as soon as the question appears, while the pipeline is still going.
    s.bus.subscribe((m) => {
      if (m.type === "task.updated" && m.task.id === task.id && m.task.questions.length && !m.task.questions[0].answer) {
        s.runner.answerQuestion(task.id, m.task.questions[0].id, "FX margin");
      }
    });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const [q] = s.repo.getTask(task.id)!.questions;
    assert.equal(q.text, "Why is gain/loss settlement allowed?");
    assert.deepEqual(q.options, ["FX margin", "Write-offs"]);
    assert.equal(q.default, "Logging the request only");
    assert.equal(q.answer, "FX margin");
    assert.equal(f.calls.length, 2, "the question did not stop the pipeline");
    assert.match(f.calls[1].prompt, /from the user: Answer to "Why is gain\/loss settlement allowed\?": FX margin/);
    assert.throws(() => s.runner.answerQuestion(task.id, "q_nope", "x"), /No question/);
  } finally {
    await s.cleanup();
  }
});

test("stage stats: median minutes and cost per stage from finished runs, critics left out (D205)", async () => {
  const s = setup(scripted(() => "x").fn);
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: TWO });
    const add = (stage: "plan" | "code", minutes: number, cost: number, role: "stage" | "critic" = "stage") => {
      const run = s.repo.createRun({ task_id: task.id, stage, stage_index: 0, model: "m", effort: "high", ...(role === "critic" ? { role } : {}) });
      // started_at is set when the run is created; a later ended_at gives the duration.
      s.repo.updateRun(run.id, { status: "success", ended_at: new Date(Date.parse(run.started_at) + minutes * 60_000).toISOString(), cost_usd: cost });
    };
    add("plan", 4, 3.4); add("plan", 7, 3.2); add("plan", 9, 3.1); add("plan", 60, 9, "critic");
    add("code", 10, 3.5);
    const stats = s.repo.stageStats(s.project.id);
    const plan = stats.find((x) => x.stage === "plan")!;
    assert.equal(plan.runs, 3, "the critic run is not a plan stage");
    assert.equal(plan.medianCost, 3.2);
    assert.ok(Math.abs(plan.medianMinutes - 7) < 0.2);
    assert.equal(stats.find((x) => x.stage === "code")!.runs, 1);
  } finally {
    await s.cleanup();
  }
});

test("a supervised run is told which uncommitted files are not its own, and the card lists the ones it changed (D204)", async () => {
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const f = scripted(
    () => "done",
    async (_i, o) => writeFileSync(join(o.cwd, "mine.txt"), "from the task\n"),
  );
  const s = setup(f.fn);
  git(s.dir, "init", "-q", "-b", "main");
  git(s.dir, "config", "user.email", "t@t");
  git(s.dir, "config", "user.name", "t");
  writeFileSync(join(s.dir, "README.md"), "hi\n");
  git(s.dir, "add", "-A");
  git(s.dir, "commit", "-q", "-m", "init");
  // Another session's work in progress, before the task starts.
  writeFileSync(join(s.dir, "theirs.md"), "someone else\n");
  writeFileSync(join(s.dir, "README.md"), "hi\nedited elsewhere\n");
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: CODE });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review" && s.repo.getTask(task.id)!.checkout?.touched !== null);
    const c = s.repo.getTask(task.id)!.checkout!;
    assert.deepEqual([...c.dirtyAtStart].sort(), ["README.md", "theirs.md"]);
    assert.deepEqual(c.touched, ["mine.txt"], "only what changed during the run is this task's");
    assert.match(f.calls[0].prompt, /## Your checkout already has other changes[\s\S]*- README\.md[\s\S]*- theirs\.md[\s\S]*Do not edit, revert, stage or commit them/);

    // A rerun of the same task counts its own earlier file as its own, not as someone else's.
    await until(() => !s.runner.isBusy(task.id));
    s.runner.retryTask(task.id, 0);
    await until(() => s.repo.getTask(task.id)!.status === "review" && f.calls.length === 2 && s.repo.getTask(task.id)!.checkout?.touched !== null);
    assert.ok(!s.repo.getTask(task.id)!.checkout!.dirtyAtStart.includes("mine.txt"));
    assert.ok(s.repo.getTask(task.id)!.checkout!.touched!.includes("mine.txt"));
  } finally {
    await s.cleanup();
  }
});
