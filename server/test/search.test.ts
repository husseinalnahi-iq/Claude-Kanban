import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { board } from "./board.ts";
import type { Repo } from "../src/repo.ts";
import type { Stage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const POLICY = { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } as const;

/** A finished run with a result, one thing Claude said, and a message to the task. */
function runWith(repo: Repo, projectId: string, title: string, o: { result?: string; said?: string; message?: string }) {
  const task = repo.createTask({ project_id: projectId, title, pipeline: ONE });
  const run = repo.createRun({ task_id: task.id, stage: "code", stage_index: 0, model: "m", effort: "low" });
  repo.updateRun(run.id, { status: "success", result_md: o.result ?? "nothing to see", ended_at: new Date().toISOString() });
  if (o.said) repo.insertEvent(run.id, "assistant", { type: "assistant", message: { content: [{ type: "text", text: o.said }] } });
  if (o.message) repo.insertMessage({ task_id: task.id, from_task_id: null, from_run_id: null, body: o.message });
  return { task, run };
}

const kinds = (hits: { kind: string }[]) => [...new Set(hits.map((h) => h.kind))].sort();

test("searching one project finds its own results, transcripts and messages, however many newer matches another project has", async () => {
  const b = await board();
  try {
    const mine = runWith(b.repo, b.project.id, "Ours", { result: "moved the zebra table", said: "I renamed the zebra column", message: "check the zebra index" });
    const other = b.repo.createProject({ name: "busy neighbour", path: join(b.dir, "other"), policy: POLICY });
    for (let i = 0; i < 12; i++) runWith(b.repo, other.id, `Theirs ${i}`, { result: "zebra everywhere", said: "zebra zebra", message: "more zebra" });

    const hits = await b.get(`/api/search?q=zebra&project=${b.project.id}&limit=5`);
    assert.deepEqual(kinds(hits), ["message", "run", "transcript"], "the neighbour's newer matches used to fill the page and then be thrown away");
    assert.ok(hits.every((h: { taskId: string; projectId: string }) => h.taskId === mine.task.id && h.projectId === b.project.id));

    const everywhere = await b.get("/api/search?q=zebra&limit=80");
    assert.ok(everywhere.some((h: { projectName: string }) => h.projectName === "busy neighbour"), "without a project, every project is searched");
  } finally {
    await b.close();
  }
});

test("a Windows path, a quoted phrase and a percent sign can be searched for as they are written", async () => {
  const b = await board();
  try {
    runWith(b.repo, b.project.id, "Paths", {
      result: "edited server\\src\\db.ts and got 100% of the tests passing",
      said: 'the button now says "Save draft" and the path is C:\\work\\proj',
    });
    runWith(b.repo, b.project.id, "Decoy", { result: "edited serversrcdb.ts, 1000 tests" });

    const path = await b.get(`/api/search?q=${encodeURIComponent("server\\src")}`);
    assert.deepEqual(path.map((h: { taskTitle: string }) => h.taskTitle), ["Paths"], "a backslash is a character to find, not an instruction");
    const percent = await b.get(`/api/search?q=${encodeURIComponent("100%")}`);
    assert.deepEqual(percent.map((h: { taskTitle: string }) => h.taskTitle), ["Paths"], "and % matches a percent sign, not anything at all");

    const quoted = await b.get(`/api/search?q=${encodeURIComponent('"Save draft"')}`);
    assert.deepEqual(kinds(quoted), ["transcript"]);
    assert.match(quoted[0].snippet, /Save draft/);
    assert.deepEqual(kinds(await b.get(`/api/search?q=${encodeURIComponent("C:\\work")}`)), ["transcript"]);
  } finally {
    await b.close();
  }
});

test("the board's own Setup project stays out of search results", async () => {
  const b = await board();
  try {
    const setup = b.repo.setupProject(join(b.state, "setup"));
    runWith(b.repo, setup.id, "Set up git", { result: "installed the quokka tool", said: "quokka installed", message: "quokka" });
    assert.deepEqual(await b.get("/api/search?q=quokka"), []);
  } finally {
    await b.close();
  }
});
