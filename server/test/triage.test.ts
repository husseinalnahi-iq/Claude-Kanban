import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, sizedPipeline, type QueryFn } from "../src/engine/runner.ts";
import { serialiseFileConflicts, triageTask } from "../src/engine/triage.ts";
import type { Stage } from "../src/types.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
/** The kind of expensive default a small task should not be run on. */
const THREE_STAGE: Stage[] = [
  { stage: "plan", model: "claude-fable-5-1", effort: "high" },
  { stage: "code", model: "claude-opus-5", effort: "high" },
  { stage: "review", model: "claude-sonnet-5", effort: "medium" },
];

/** A fake SDK that returns whatever structured_output the test asks for. */
function fakeStructured(structured: unknown, calls: any[] = []): QueryFn {
  return (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      calls.push({ prompt, options: params.options });
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.002, session_id: "s", modelUsage: {}, structured_output: structured } as any;
    })();
}

function setup(queryFn: QueryFn) {
  const dir = mkdtempSync(join(tmpdir(), "ktriage-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  const runner = new TaskRunner({ repo, bus, queryFn });
  return { repo, bus, project, runner, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("triage returns a validated result and never trusts the model's shape", async () => {
  const calls: any[] = [];
  const res = await triageTask(
    { title: "site slow", spec_md: "pages take ages", projectName: "demo", mode: "refine", cwd: ".", model: "m", knownLabels: ["ui"] },
    fakeStructured(
      {
        title: "Speed up page loads",
        type: "nonsense",          // invalid → falls back
        priority: "urgent",        // invalid → falls back
        labels: ["PERF", "", "ui"],
        spec_md: "## Done when\n- pages load under 2s",
        questions: ["Which pages?"],
        confidence: 0.9,
        split_reason: "The measuring and the fixing can be checked separately.",
        subtasks: [
          { title: "Measure", spec_md: "profile it", type: "nope", depends_on: [1, 99], files: ["docs/perf.md"] }, // self + out-of-range dropped
          { title: "Fix", spec_md: "fix worst", type: "bug", depends_on: [1], files: ["src/app.ts"] },
          { title: "Cache", spec_md: "add caching", type: "feature", depends_on: [], files: ["src/cache.ts"] },
          { title: "", spec_md: "ignored", type: "bug", depends_on: [], files: [] },                                // no title → dropped
        ],
      },
      calls,
    ),
  );
  assert.ok(res);
  assert.equal(res!.confidence, 0.9);
  assert.equal(res!.type, "feature");
  assert.equal(res!.priority, "p2");
  assert.deepEqual(res!.labels, ["perf", "ui"]);
  assert.deepEqual(res!.subtasks.map((s) => s.title), ["Measure", "Fix", "Cache"]);
  assert.equal(res!.split.decision, "subtasks");
  assert.match(res!.split.reason, /checked separately/);
  assert.deepEqual(res!.subtasks[0].depends_on, [], "self and out-of-range dependencies are dropped");
  assert.deepEqual(res!.subtasks[1].depends_on, [1]);
  assert.match(calls[0].prompt, /The only labels this project uses/);
  assert.deepEqual(calls[0].options.tools, [], "intake runs with no tools");
  assert.deepEqual(calls[0].options.settingSources, [], "and without the user's plugins or hooks");
  assert.equal(calls[0].options.outputFormat.type, "json_schema");
});

test("subtasks that touch the same file are serialised, not run in parallel", () => {
  const out = serialiseFileConflicts([
    { title: "A", spec_md: "", type: "feature", depends_on: [], files: ["src/api.ts", "docs/a.md"] },
    { title: "B", spec_md: "", type: "feature", depends_on: [], files: ["src/ui.tsx"] },            // disjoint → parallel
    { title: "C", spec_md: "", type: "feature", depends_on: [], files: ["src/api.ts"] },            // clashes with A
    { title: "D", spec_md: "", type: "feature", depends_on: [], files: ["src/**"] },                // glob covers both
  ]);
  assert.deepEqual(out[0].depends_on, []);
  assert.deepEqual(out[1].depends_on, [], "different files may run at the same time");
  assert.deepEqual(out[2].depends_on, [1], "same file → waits for A");
  assert.deepEqual(out[3].depends_on, [1, 2, 3], "a glob over src/ waits for everything touching src/");
});

test("a shaky classification is recorded as a suggestion instead of being applied", async () => {
  const s = setup(fakeStructured({ title: "Something", type: "bug", priority: "p0", labels: [], spec_md: "", questions: [], subtasks: [], confidence: 0.4 }));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "it's broken?", pipeline: ONE_STAGE });
    await s.runner.triage(task.id, "classify");
    const after = s.repo.getTask(task.id)!;
    assert.equal(after.type, "feature", "low confidence must not relabel the task");
    assert.equal(after.priority, "p2", "priority is never auto-applied");
    assert.equal(after.suggestion?.type, "bug");
    assert.equal(after.suggestion?.priority, "p0");
    assert.equal(after.suggestion?.confidence, 0.4);
  } finally {
    s.cleanup();
  }
});

test("labels outside the project's vocabulary are dropped", async () => {
  const s = setup(fakeStructured({ title: "x", type: "bug", priority: "p2", labels: ["auth", "invented"], spec_md: "", questions: [], subtasks: [], confidence: 0.95 }));
  try {
    s.repo.updateProject(s.project.id, { env: { worktreeInclude: [], setupCommand: null, verifyCommand: null, labels: ["auth", "ui"], onboarding: null } });
    const task = s.repo.createTask({ project_id: s.project.id, title: "login", pipeline: ONE_STAGE });
    await s.runner.triage(task.id, "classify");
    assert.deepEqual(s.repo.getTask(task.id)!.labels, ["auth"]);
  } finally {
    s.cleanup();
  }
});

test("triage survives a model that returns nothing useful", async () => {
  assert.equal(await triageTask({ title: "x", spec_md: "", projectName: "d", mode: "classify", cwd: ".", model: "m" }, fakeStructured(null)), null);
});

test("a confident classification sets the type and leaves spec and priority alone", async () => {
  const s = setup(fakeStructured({ title: "Fix login crash", type: "bug", priority: "p0", labels: ["auth"], spec_md: "REWRITTEN", questions: [], subtasks: [], confidence: 0.92 }));
  try {
    s.repo.updateProject(s.project.id, { env: { worktreeInclude: [], setupCommand: null, verifyCommand: null, labels: ["auth"], onboarding: null } });
    const task = s.repo.createTask({ project_id: s.project.id, title: "login broken", spec_md: "original text", pipeline: ONE_STAGE });
    await s.runner.triage(task.id, "classify");
    const after = s.repo.getTask(task.id)!;
    assert.equal(after.type, "bug");
    assert.equal(after.priority, "p2", "priority stays a suggestion for the human");
    assert.equal(after.suggestion?.priority, "p0");
    assert.deepEqual(after.labels, ["auth"]);
    assert.equal(after.spec_md, "original text", "classification must not rewrite the user's words");
    assert.ok(after.triaged_at);
  } finally {
    s.cleanup();
  }
});

test("applying a refine proposal creates subtasks wired to their dependencies", () => {
  const s = setup(fakeStructured(null));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "big thing", mode: "supervised", pipeline: ONE_STAGE });
    const { subtasks } = s.runner.applyTriage(task.id, {
      title: "Big thing, specified",
      spec_md: "## Done when\n- it works",
      type: "feature",
      priority: "p1",
      labels: ["api"],
      auto_queue_children: true,
      subtasks: [
        { title: "Schema", spec_md: "add table", type: "chore", depends_on: [], files: ["db/schema.sql"] },
        { title: "Endpoint", spec_md: "expose it", type: "feature", depends_on: [1], files: ["api/routes.ts"] },
      ],
    });
    assert.equal(s.repo.getTask(task.id)!.title, "Big thing, specified");
    assert.deepEqual(subtasks[0].depends_on, []);
    assert.deepEqual(subtasks[1].depends_on, [subtasks[0].id], "second waits for the first");
    assert.equal(subtasks[1].priority, "p1", "subtasks inherit the parent's priority");
  } finally {
    s.cleanup();
  }
});

test("a follow-up task carries the old task's outcome instead of reopening its session", async () => {
  const s = setup(fakeStructured(null));
  try {
    const done = s.repo.createTask({ project_id: s.project.id, title: "Add contact form", mode: "supervised", pipeline: ONE_STAGE, labels: ["ui"] });
    s.repo.updateTask(done.id, { status: "done", summary: "Added form + endpoint" });
    const run = s.repo.createRun({ task_id: done.id, stage: "code", stage_index: 0, model: "m", effort: "low" });
    s.repo.updateRun(run.id, { status: "success", result_md: "Created ContactForm.tsx and /api/contact" });

    const next = await s.runner.followUp(done.id, { note: "submitting twice sends two emails" });
    assert.equal(next.type, "bug");
    assert.deepEqual(next.related_to, [done.id]);
    assert.deepEqual(next.labels, ["ui"], "labels carry over");
    assert.match(next.spec_md, /follows up on "Add contact form"/);
    assert.match(next.spec_md, /Added form \+ endpoint/);
    assert.match(next.spec_md, /Created ContactForm.tsx/);
    assert.match(next.spec_md, /submitting twice sends two emails/);
    assert.match(next.spec_md, /Start from the current state of the repository/);
    assert.deepEqual(s.repo.getTask(done.id)!.related_to, [next.id], "the link goes both ways");
    assert.equal(next.status, "backlog");
  } finally {
    s.cleanup();
  }
});

test("dependencies gate queueing, and finishing one releases the next", async () => {
  const s = setup(fakeStructured(null));
  try {
    const parent = s.repo.createTask({ project_id: s.project.id, title: "parent", mode: "supervised", pipeline: ONE_STAGE, auto_queue_children: true });
    const a = s.repo.createTask({ project_id: s.project.id, parent_id: parent.id, title: "A", mode: "supervised", pipeline: ONE_STAGE });
    const b = s.repo.createTask({ project_id: s.project.id, parent_id: parent.id, title: "B", mode: "supervised", pipeline: ONE_STAGE, depends_on: [a.id] });

    assert.throws(() => s.runner.queueTask(b.id), /Waiting on "A"/);
    assert.deepEqual(s.runner.promoteReady(s.project.id).map((t) => t.title), ["A"], "only the unblocked one starts");

    s.repo.updateTask(a.id, { status: "done" });
    assert.deepEqual(s.runner.promoteReady(s.project.id).map((t) => t.title), ["B"], "B is released once A is done");
  } finally {
    s.cleanup();
  }
});

test("the board decides one-task-or-several: two thin pieces stay a single task, with the reason said out loud", async () => {
  const two = await triageTask(
    { title: "rename a field", spec_md: "", projectName: "demo", mode: "refine", cwd: ".", model: "m" },
    fakeStructured({
      title: "Rename the field", type: "refactor", priority: "p2", labels: [], spec_md: "x", questions: [], confidence: 0.9,
      split_reason: "Two small steps.",
      subtasks: [
        { title: "Rename in the model", spec_md: "", type: "refactor", depends_on: [], files: ["a.ts"] },
        { title: "Rename in the UI", spec_md: "", type: "refactor", depends_on: [], files: ["b.tsx"] },
      ],
    }),
  );
  assert.deepEqual(two!.subtasks, [], "below three pieces the extra sessions cost more than they save");
  assert.equal(two!.split.decision, "single");
  assert.match(two!.split.reason, /costs a full pipeline/, "and the user is told why, in cost terms");

  const none = await triageTask(
    { title: "fix typo", spec_md: "", projectName: "demo", mode: "refine", cwd: ".", model: "m" },
    fakeStructured({
      title: "Fix the typo", type: "docs", priority: "p3", labels: [], spec_md: "x", questions: [], confidence: 0.9,
      split_reason: "It is a one-line change in one file.", subtasks: [],
    }),
  );
  assert.equal(none!.split.decision, "single");
  assert.equal(none!.split.reason, "It is a one-line change in one file.", "the model's own reason is kept when it made the call");
});

test("the board sizes the pipeline itself, maps tiers to real models, and never applies it on its own", async () => {
  const calls: any[] = [];
  const res = await triageTask(
    { title: "rename a css class", spec_md: "", projectName: "demo", mode: "classify", cwd: ".", model: "m" },
    fakeStructured(
      {
        title: "Rename the class", type: "chore", priority: "p3", labels: [], spec_md: "", questions: [], confidence: 0.95,
        split_reason: "One file.", subtasks: [],
        pipeline: [{ stage: "code", tier: "cheap", effort: "low" }],
        pipeline_reason: "It is a find-and-replace in one stylesheet.",
      },
      calls,
    ),
  );
  assert.deepEqual(res!.sizing!.stages, [{ stage: "code", tier: "cheap", effort: "low" }]);
  assert.match(res!.sizing!.reason, /find-and-replace/);
  assert.match(calls[0].prompt, /Spending more than the work needs is a defect/, "the prompt makes it account for cost");

  const tiers = {
    cheap: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    balanced: { provider: "anthropic", model: "claude-sonnet-5" },
    strong: { provider: "anthropic", model: "claude-opus-5" },
  };
  assert.deepEqual(sizedPipeline(res!.sizing, tiers), [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }]);
  assert.equal(sizedPipeline(null, tiers), null);
});

test("a sized pipeline with no code stage is discarded — it would never change anything", async () => {
  const res = await triageTask(
    { title: "x", spec_md: "", projectName: "d", mode: "classify", cwd: ".", model: "m" },
    fakeStructured({
      title: "x", type: "chore", priority: "p2", labels: [], spec_md: "", questions: [], confidence: 0.9,
      split_reason: "", subtasks: [], pipeline: [{ stage: "plan", tier: "strong", effort: "max" }], pipeline_reason: "",
    }),
  );
  assert.equal(res!.sizing, null);
});

test("sizing reaches the task only as a suggestion, and is applied when the human accepts it", async () => {
  const s = setup(fakeStructured({
    title: "Rename", type: "chore", priority: "p3", labels: [], spec_md: "", questions: [], confidence: 0.95,
    split_reason: "", subtasks: [],
    pipeline: [{ stage: "code", tier: "cheap", effort: "low" }],
    pipeline_reason: "One-line change.",
  }));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "rename a class", pipeline: THREE_STAGE });
    await s.runner.triage(task.id, "classify");

    const proposed = s.repo.getTask(task.id)!;
    assert.deepEqual(proposed.pipeline, THREE_STAGE, "the expensive default is still what would run");
    assert.deepEqual(proposed.suggestion?.pipeline, [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }]);
    assert.equal(proposed.suggestion?.sizing_reason, "One-line change.");

    const accepted = s.runner.acceptSuggestion(task.id, { pipeline: true });
    assert.deepEqual(accepted.pipeline, [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }]);
    assert.equal(accepted.suggestion, null);
  } finally {
    s.cleanup();
  }
});

test("rejecting the suggestion leaves the project default untouched", async () => {
  const s = setup(fakeStructured({
    title: "x", type: "chore", priority: "p2", labels: [], spec_md: "", questions: [], confidence: 0.9,
    split_reason: "", subtasks: [], pipeline: [{ stage: "code", tier: "cheap", effort: "low" }], pipeline_reason: "",
  }));
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", pipeline: THREE_STAGE });
    await s.runner.triage(task.id, "classify");
    s.repo.updateTask(task.id, { suggestion: null }); // what "Keep default" does
    assert.deepEqual(s.repo.getTask(task.id)!.pipeline, THREE_STAGE);
  } finally {
    s.cleanup();
  }
});
