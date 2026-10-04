import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup, until } from "./helpers.ts";
import { chatBoardHandlers } from "../src/engine/chatBoard.ts";
import type { Stage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const tick = () => new Promise((r) => setTimeout(r, 30));

test("a task queued before what it depends on is done waits in Queued, then starts by itself with what that task reported (D289, D290)", async () => {
  const q = fakeQuery({ byCall: (i) => (i === 0 ? { result: "The latest PO is PUR-0042." } : undefined) });
  const s = setup(q.fn);
  try {
    const a = s.repo.createTask({ project_id: s.project.id, title: "Find the latest PO", mode: "supervised", pipeline: ONE });
    const b = s.repo.createTask({ project_id: s.project.id, title: "Email its supplier", mode: "supervised", pipeline: ONE, depends_on: [a.id] });

    assert.equal(s.runner.queueTask(b.id).status, "queued", "queued at once, not refused");
    await tick();
    assert.equal(q.calls.length, 0, "nothing runs while what it needs is not done");

    s.runner.queueTask(a.id);
    await until(() => s.repo.getTask(a.id)!.status === "review");
    await tick();
    assert.equal(s.repo.getTask(b.id)!.status, "queued", "review is not done: unmerged work is invisible to the next task");
    assert.equal(q.calls.length, 1);

    await s.runner.approveTask(a.id);
    await until(() => s.repo.getTask(b.id)!.status === "review");
    assert.equal(q.calls.length, 2, "it started by itself once its dependency was done");
    assert.match(q.calls[1].prompt, /## Done before this[\s\S]*Find the latest PO[\s\S]*The latest PO is PUR-0042\./, "and was told what that task reported");
  } finally {
    s.cleanup();
  }
});

test("unlinking or deleting what a queued task waits for lets it start; Stop puts a waiting task back in Backlog", async () => {
  const q = fakeQuery();
  const s = setup(q.fn);
  try {
    const a = s.repo.createTask({ project_id: s.project.id, title: "A", mode: "supervised", pipeline: ONE });
    const b = s.repo.createTask({ project_id: s.project.id, title: "B", mode: "supervised", pipeline: ONE, depends_on: [a.id] });
    const c = s.repo.createTask({ project_id: s.project.id, title: "C", mode: "supervised", pipeline: ONE, depends_on: [a.id] });
    const d = s.repo.createTask({ project_id: s.project.id, title: "D", mode: "supervised", pipeline: ONE, depends_on: [a.id] });
    for (const t of [b, c, d]) s.runner.queueTask(t.id);
    await tick();
    assert.equal(q.calls.length, 0);

    s.bus.publish({ type: "task.updated", task: s.repo.updateTask(b.id, { depends_on: [] }) });
    await until(() => s.repo.getTask(b.id)!.status === "review");
    assert.equal(s.repo.getTask(c.id)!.status, "queued", "the others still wait");

    assert.equal(s.runner.stopTask(d.id).status, "backlog", "a waiting task can be taken back off the queue");

    s.repo.deleteTask(a.id);
    s.bus.publish({ type: "task.deleted", taskId: a.id });
    await until(() => s.repo.getTask(c.id)!.status === "review");
  } finally {
    s.cleanup();
  }
});

test("the chat says a card it started will wait, and for what", () => {
  const s = setup(fakeQuery().fn);
  s.repo.updateSettings({ autoTriage: false });
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
  try {
    const a = s.repo.createTask({ project_id: s.project.id, title: "Build the API", mode: "supervised", pipeline: ONE });
    const made = JSON.parse(h.createTask({ title: "Build the page", spec_md: "x", depends_on: [a.id], stages: [{ stage: "code" }] }).content[0].text).created;
    const queued = JSON.parse(h.queueTask({ task_id: made.id }).content[0].text);
    assert.equal(queued.queued.status, "queued");
    assert.match(queued.note, /waits for "Build the API" \(backlog\) to be done, then starts by itself/);
  } finally {
    s.cleanup();
  }
});
