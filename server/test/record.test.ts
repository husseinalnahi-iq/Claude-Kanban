import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { outcomeLine, recordLines } from "../src/engine/record.ts";
import { fakeQuery, setup, until } from "./helpers.ts";
import type { Stage } from "../src/types.ts";

const TWO: Stage[] = [
  { stage: "plan", model: "planner", effort: "medium" },
  { stage: "code", model: "coder", effort: "medium" },
];

test("a task's record is one file: what was asked, each stage, every step in order, the cost", async () => {
  const q = fakeQuery({
    extra: [{ type: "assistant", message: { content: [{ type: "text", text: "Reading the page first." }, { type: "tool_use", name: "Read", input: { file_path: "index.html" } }] } }],
  });
  const s = setup(q.fn);
  const app = await buildApp({ repo: s.repo, bus: s.bus, runner: s.runner, allowedHosts: ["localhost:80"] });
  try {
    const t = s.repo.createTask({ project_id: s.project.id, title: "Add a dark mode: toggle/save", spec_md: "Done when the toggle is remembered.", mode: "supervised", pipeline: TWO });
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "review");
    s.runner.chat(t.id, "Make the toggle bigger.");
    await until(() => !s.runner.isBusy(t.id));

    const res = await app.inject({ method: "GET", url: `/api/tasks/${t.id}/record?download=1` });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers["content-type"]), /text\/markdown/);
    assert.equal(res.headers["content-disposition"], 'attachment; filename="Add-a-dark-mode-toggle-save-record.md"', "a file name any system accepts");
    const md = res.body;
    assert.match(md, /^# Add a dark mode: toggle\/save$/m);
    assert.match(md, /## What was asked\n\nDone when the toggle is remembered\./);
    assert.match(md, /\| 1 \| plan \| planner \| medium \| success \|/);
    assert.match(md, /\| 2 \| code \| coder \| medium \| success \|/);
    assert.match(md, /\*\*Cost:\*\* \$0\.03 across 2 runs/, "two stages and the follow-up message, which is billed on the stage it continued");
    const steps = md.slice(md.indexOf("## Step by step"));
    assert.ok(steps.indexOf("### 1. plan") < steps.indexOf("### 2. code"));
    assert.match(steps, /\*\*Claude:\*\* Reading the page first\./);
    assert.match(steps, /→ Read — index\.html/);
    assert.match(steps, /\*\*You:\*\* Make the toggle bigger\./, "what you told it is part of the story");
    assert.match(steps, /\*\*Result\*\*\n\nDONE/);

    assert.equal((await app.inject({ method: "GET", url: "/api/tasks/t_nope/record" })).statusCode, 404);
  } finally {
    await app.close();
    await s.cleanup();
  }
});

test("rows that say nothing to a reader leave no line in the record", () => {
  const at = "2026-09-30T10:00:00.000Z";
  assert.deepEqual(recordLines({ id: 1, run_id: "r", ts: at, type: "system", payload: { type: "system", subtype: "init" } }), []);
  assert.deepEqual(recordLines({ id: 2, run_id: "r", ts: at, type: "x", payload: null }), []);
  assert.deepEqual(recordLines({ id: 3, run_id: "r", ts: at, type: "verify:failed", payload: { type: "verify", command: "npm test", ok: false } }), ["- `10:00:00` **Check** `npm test`: failed"]);
});

test("a task's outcome is what its work stage reported, not a progress line left over from review", () => {
  const run = (stage: string, result: string, status = "success") => ({ stage: stage as never, role: "stage" as const, status: status as never, result_md: result });
  const runs = [
    run("plan", "The plan is ready and fits one session."),
    run("code", "## Done\nNeon Drift is built and playable; 33 tests pass."),
    run("review", "It delivers the spec.\nVERDICT: APPROVE"),
  ];
  assert.equal(outcomeLine(runs, "Reviewing Neon Drift against spec"), "Done", "the first line, heading marks dropped");
  assert.equal(outcomeLine([runs[0], run("code", "Built it."), runs[2]], "Reviewing…"), "Built it.");
  assert.equal(outcomeLine([runs[0]], "Planning"), "The plan is ready and fits one session.", "with only a plan, the plan");
  assert.equal(outcomeLine([run("code", "x", "failed")], "Working on it"), "Working on it", "nothing finished: the summary is all there is");
  assert.equal(outcomeLine([], null), null);
});

test("a report written to a template gives its TL;DR as the outcome, never its model suggestion (D404)", () => {
  const run = (result: string) => ({ stage: "code" as never, role: "stage" as const, status: "success" as never, result_md: result });
  const report = "🎛️ Suggested: stay on **Opus 5.5** + **High** — live writes.\n\n## 🏁 Supplier field editable — ✅ done\n\n**TL;DR:** The drop list can now be changed on existing suppliers. Nothing is needed from you.\n\n### ✅ Done";
  assert.equal(outcomeLine([run(report)], null), "The drop list can now be changed on existing suppliers. Nothing is needed from you.");
  assert.equal(outcomeLine([run("🎛️ Suggested: stay on Opus.\n## 🏁 Supplier field editable — ✅ done\nmore")], null), "Supplier field editable — ✅ done", "no TL;DR: the headline");
  assert.equal(outcomeLine([run("**Switch to** Sonnet 5 + Low.\nRenamed the files.")], null), "Renamed the files.");
});
