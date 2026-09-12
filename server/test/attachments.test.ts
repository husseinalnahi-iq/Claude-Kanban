import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";
import { buildStagePrompt } from "../src/engine/prompts.ts";
import type { Stage } from "../src/types.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
/** A 1×1 transparent PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const okQuery: QueryFn = () =>
  (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as any;
  })();

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "katt-"));
  const state = mkdtempSync(join(tmpdir(), "kstate-"));
  const repo = new Repo(openDb(":memory:"));
  // stateDir is set at boot, not through updateSettings — point it at a temp dir for the test.
  repo.db.prepare("INSERT INTO settings(key, value) VALUES ('stateDir', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(state);
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: okQuery }), allowedHosts: ["localhost:80"] });
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  return { app, repo, bus, project, state, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); } };
}

test("an attached image is stored outside the project, served back, and given to the run by path", async () => {
  const s = await setup();
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "Fix the header", pipeline: ONE_STAGE });
    const up = await s.app.inject({
      method: "POST", url: `/api/tasks/${task.id}/attachments`,
      payload: { name: "bug.png", media_type: "image/png", data: PNG, note: "the misaligned header" },
    });
    assert.equal(up.statusCode, 200, up.body);
    const at = up.json();
    assert.equal(at.source, "user");
    assert.ok(at.path.startsWith(s.state), "images live under the state dir, never inside the user's project");
    assert.ok(existsSync(at.path));
    assert.deepEqual([...readFileSync(at.path).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the bytes really are a PNG");

    const raw = await s.app.inject({ method: "GET", url: `/api/attachments/${at.id}/raw` });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.headers["content-type"], "image/png");

    // The run is told to open it, by absolute path, before it starts.
    const prompt = buildStagePrompt({
      stage: "code", mode: "supervised", task: { id: task.id, title: task.title, spec_md: "" },
      siblings: [], skills: [], messages: [], images: [{ name: at.name, path: at.path, note: at.note, description: at.description, kind: "image" }],
    });
    assert.match(prompt, /## Files attached to this task/);
    assert.match(prompt, /the misaligned header/);
    assert.ok(prompt.includes(at.path));
    assert.match(prompt, /Open one only when you need more/);

    const del = await s.app.inject({ method: "DELETE", url: `/api/attachments/${at.id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(existsSync(at.path), false, "deleting the row deletes the file");
  } finally {
    await s.app.close();
    s.cleanup();
  }
});

test("uploads are limited to types the board can actually handle, and deleting a task takes its files with it", async () => {
  const s = await setup();
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "x", pipeline: ONE_STAGE });
    const bad = await s.app.inject({
      method: "POST", url: `/api/tasks/${task.id}/attachments`,
      payload: { name: "payload.exe", media_type: "application/octet-stream", data: "aGk=" },
    });
    assert.equal(bad.statusCode, 409, "an executable is refused");
    assert.match(bad.json().error, /does not handle "\.exe"/);

    const at = (await s.app.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, payload: { name: "a.png", media_type: "image/png", data: PNG } })).json();
    assert.equal(existsSync(at.path), true);
    assert.equal((await s.app.inject({ method: "DELETE", url: `/api/tasks/${task.id}` })).statusCode, 200);
    assert.equal(existsSync(at.path), false, "no orphaned files left behind");
  } finally {
    await s.app.close();
    s.cleanup();
  }
});

test("images a session produces are captured: a screenshot in a tool result, and an image file it writes", async () => {
  const s = await setup();
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "shoot", mode: "supervised", pipeline: ONE_STAGE });
    // A run that hands back a screenshot inside a tool_result, then writes a chart file.
    const chart = join(s.project.path, "chart.png");
    const withImages: QueryFn = () =>
      (async function* () {
        // Opening an existing image (say, one the user attached) is not producing one: not kept.
        yield { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", id: "read1", name: "Read", input: { file_path: "C:/attached.png" } }] } } as any;
        yield {
          type: "user", session_id: "s1",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] },
        } as any;
        yield {
          type: "user", session_id: "s1",
          message: { role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] },
        } as any;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(chart, Buffer.from(PNG, "base64"));
        yield { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: chart } }] } } as any;
        yield { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as any;
      })();
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: withImages });
    runner.queueTask(task.id);
    const t0 = Date.now();
    while (s.repo.getTask(task.id)!.status !== "review") {
      if (Date.now() - t0 > 4000) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
    const kept = s.repo.listAttachments(task.id);
    assert.equal(kept.length, 2, "the screenshot and the written image were kept — the image it only opened was not");
    assert.deepEqual(kept.map((a) => a.source), ["run", "run"]);
    assert.match(kept[0].name, /^screenshot-/);
    assert.match(kept[0].note ?? "", /^screenshot from the \w+ stage$/);
    assert.equal(kept[1].name, "chart.png");
    assert.match(kept[1].note ?? "", /written during the code stage/);
    // Copied into the board's storage, so they outlive a worktree being removed.
    for (const a of kept) assert.ok(a.path.startsWith(s.state), `${a.name} is stored by the board`);
  } finally {
    await s.app.close();
    s.cleanup();
  }
});

test("a spreadsheet or document is accepted, previewed where it can be, and put in the prompt", async () => {
  const s = await setup();
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "reconcile", pipeline: ONE_STAGE });
    const post = (name: string, data: string) =>
      s.app.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, payload: { name, data } });

    const csv = (await post("rows.csv", Buffer.from(["name,amount", "Invoice A,120", "Invoice B,80", ""].join("\n")).toString("base64"))).json();
    assert.equal(csv.media_type, "text/csv");
    assert.match(csv.description, /Invoice A,120/, "text files carry their own preview — no model call needed");

    // A .xlsx is binary: it is stored and offered, but not previewed as text.
    const xlsx = (await post("book.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]).toString("base64"))).json();
    assert.equal(xlsx.media_type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(xlsx.description, null);

    // Only images are served inline; everything else downloads, and never as its own type in this origin.
    const rawCsv = await s.app.inject({ method: "GET", url: `/api/attachments/${csv.id}/raw` });
    assert.match(rawCsv.headers["content-disposition"] as string, /^attachment/);
    assert.equal(rawCsv.headers["x-content-type-options"], "nosniff");

    const text = await s.app.inject({ method: "GET", url: `/api/attachments/${csv.id}/text` });
    assert.equal(text.statusCode, 200);
    assert.match(text.headers["content-type"] as string, /^text\/plain/);
    assert.equal((await s.app.inject({ method: "GET", url: `/api/attachments/${xlsx.id}/text` })).statusCode, 409, "a binary file has no text view");

    const prompt = buildStagePrompt({
      stage: "code", mode: "supervised", task: { id: task.id, title: "reconcile", spec_md: "" },
      siblings: [], skills: [], messages: [],
      images: [
        { name: csv.name, path: csv.path, note: null, description: csv.description, kind: "text" },
        { name: xlsx.name, path: xlsx.path, note: null, description: null, kind: "document" },
      ],
    });
    assert.match(prompt, /rows\.csv/);
    assert.match(prompt, /Invoice B,80/, "the stage sees the data without opening the file");
    assert.match(prompt, /open it with a short script/, "and is told not to guess at the xlsx");
  } finally {
    await s.app.close();
    s.cleanup();
  }
});

test("a run's output files are kept as artifacts; source files and vendored files are not", async () => {
  const s = await setup();
  try {
    const task = s.repo.createTask({ project_id: s.project.id, title: "report", mode: "supervised", pipeline: ONE_STAGE });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const report = join(s.project.path, "report.html");
    const source = join(s.project.path, "index.ts");
    const vendored = join(s.project.path, "node_modules", "pkg", "page.html");
    mkdirSync(join(s.project.path, "node_modules", "pkg"), { recursive: true });

    const writes: QueryFn = () =>
      (async function* () {
        writeFileSync(report, "<h1>Totals</h1>");
        writeFileSync(source, "export const x = 1;");
        writeFileSync(vendored, "<p>not ours</p>");
        yield {
          type: "assistant", session_id: "s1",
          message: { content: [
            { type: "tool_use", name: "Write", input: { file_path: report } },
            { type: "tool_use", name: "Write", input: { file_path: source } },
            { type: "tool_use", name: "Write", input: { file_path: vendored } },
            { type: "tool_use", name: "Write", input: { file_path: report } },
          ] },
        } as any;
        yield { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as any;
      })();
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: writes });
    runner.queueTask(task.id);
    const t0 = Date.now();
    while (s.repo.getTask(task.id)!.status !== "review") {
      if (Date.now() - t0 > 4000) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
    const kept = s.repo.listAttachments(task.id);
    assert.deepEqual(kept.map((a) => a.name), ["report.html"], "only the output file, and only once despite two writes");
    assert.match(kept[0].description ?? "", /Totals/);
  } finally {
    await s.app.close();
    s.cleanup();
  }
});

test("archiving hides a task from the board without touching anything else", async () => {
  const s = await setup();
  try {
    const done = s.repo.createTask({ project_id: s.project.id, title: "old thing", pipeline: ONE_STAGE });
    s.repo.updateTask(done.id, { status: "done", summary: "shipped" });
    const open = s.repo.createTask({ project_id: s.project.id, title: "still going", pipeline: ONE_STAGE });

    const res = await s.app.inject({ method: "POST", url: "/api/tasks/archive-done", payload: { project_id: s.project.id } });
    assert.deepEqual(res.json().archived, [done.id], "only finished tasks are archived");
    const after = s.repo.getTask(done.id)!;
    assert.ok(after.archived_at);
    assert.equal(after.status, "done", "archiving is not a status change");
    assert.equal(after.summary, "shipped", "and nothing else is lost");
    assert.equal(s.repo.getTask(open.id)!.archived_at, null);

    // It is still in the record: search finds it, and it is still a task the board knows.
    const hits = (await s.app.inject({ method: "GET", url: `/api/search?q=old%20thing&project=${s.project.id}` })).json();
    assert.ok(hits.some((h: { taskId: string }) => h.taskId === done.id), "an archived task is still searchable");

    assert.equal((await s.app.inject({ method: "POST", url: `/api/tasks/${done.id}/unarchive` })).statusCode, 200);
    assert.equal(s.repo.getTask(done.id)!.archived_at, null, "and it comes straight back");
  } finally {
    await s.app.close();
    s.cleanup();
  }
});

test("an attached image is described once by the cheap vision model, and the stages then read words", async () => {
  const s = await setup();
  try {
    const calls: any[] = [];
    const vision: QueryFn = (params) =>
      (async function* () {
        let prompt = "";
        for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
        calls.push({ prompt, options: params.options });
        yield {
          type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.001, session_id: "v", modelUsage: {},
          structured_output: { description: "A screenshot of a login form with the submit button overlapping the footer.", text_in_image: "Sign in" },
        } as any;
      })();
    const runner = new TaskRunner({ repo: s.repo, bus: s.bus, queryFn: vision });
    const task = s.repo.createTask({ project_id: s.project.id, title: "fix it", pipeline: ONE_STAGE });
    const at = (await s.app.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, payload: { name: "bug.png", media_type: "image/png", data: PNG } })).json();

    const text = await runner.describeAttachment(at.id);
    assert.match(text ?? "", /submit button overlapping the footer/);
    assert.match(text ?? "", /Text in the image: Sign in/, "text in the image is kept verbatim");
    assert.equal(calls[0].options.model, s.repo.getSettings().visionModel, "it uses the cheap vision model, not a stage model");
    assert.deepEqual(calls[0].options.tools, ["Read"], "and gets exactly one tool");
    assert.equal(s.repo.getAttachment(at.id)!.description, text);

    // Asking again is free: the description is stored, not recomputed.
    const before = calls.length;
    await runner.describeAttachment(at.id);
    assert.equal(calls.length, before, "an image is looked at once, not once per stage");

    const prompt = buildStagePrompt({
      stage: "code", mode: "supervised", task: { id: task.id, title: "fix it", spec_md: "" },
      siblings: [], skills: [], messages: [],
      images: [{ name: at.name, path: at.path, note: null, description: text, kind: "image" }],
    });
    assert.match(prompt, /submit button overlapping the footer/, "the stage is given the words");
    assert.match(prompt, /Open one only when you need more than is shown above/);
  } finally {
    await s.app.close();
    s.cleanup();
  }
});
