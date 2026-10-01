import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { until } from "./helpers.ts";
import { board, holding } from "./board.ts";
import type { Stage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
/** A 1×1 transparent PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("the board is busy while a task is being worked on, not while one only waits its turn, and not once it is done", async () => {
  const sdk = holding();
  const b = await board(sdk.fn);
  try {
    assert.deepEqual(await b.get("/api/busy"), { busy: false, tasks: 0, chats: 0, specRewrites: 0, setupFixes: 0, terminals: 0 });

    b.repo.updateSettings({ serial: true });
    const first = b.repo.createTask({ project_id: b.project.id, title: "first", pipeline: ONE });
    const second = b.repo.createTask({ project_id: b.project.id, title: "second", pipeline: ONE });
    b.runner.queueTask(first.id);
    b.runner.queueTask(second.id);
    await until(() => sdk.waiting.length === 1);
    const during = await b.get("/api/busy");
    assert.equal(during.busy, true);
    assert.equal(during.tasks, 1, "the card waiting behind it would simply be queued again after a restart");

    sdk.waiting[0]();
    await until(() => sdk.waiting.length === 2);
    sdk.waiting[1]();
    await until(() => b.repo.getTask(second.id)!.status === "review");
    await until(() => !b.runner.isBusy(second.id));
    assert.equal((await b.get("/api/busy")).busy, false);
  } finally {
    await b.close();
  }
});

test("a side chat writing its reply counts as busy, and its project cannot be deleted under it", async () => {
  const sdk = holding();
  const b = await board(sdk.fn);
  try {
    const chat = (await b.app.inject({ method: "POST", url: `/api/projects/${b.project.id}/chats`, payload: {} })).json();
    const sent = await b.app.inject({ method: "POST", url: `/api/chats/${chat.id}/send`, payload: { text: "How is it going?" } });
    assert.equal(sent.statusCode, 200, sent.body);
    await until(() => sdk.waiting.length === 1);

    const during = await b.get("/api/busy");
    assert.deepEqual([during.busy, during.chats, during.tasks], [true, 1, 0], "the queue is empty, and the board is still in the middle of something");

    const refused = await b.app.inject({ method: "DELETE", url: `/api/projects/${b.project.id}` });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /side chat/);
    assert.ok(b.repo.getProject(b.project.id), "nothing was deleted");

    sdk.waiting[0]();
    for (let i = 0; i < 500 && (await b.get("/api/busy")).busy; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await b.get("/api/busy")).busy, false, "once the reply is written there is nothing left to wait for");
    assert.equal((await b.app.inject({ method: "DELETE", url: `/api/projects/${b.project.id}` })).statusCode, 200);
  } finally {
    await b.close();
  }
});

test("deleting a project takes its tasks' files with it and tells every open tab", async () => {
  const b = await board();
  try {
    const task = b.repo.createTask({ project_id: b.project.id, title: "with a picture", pipeline: ONE });
    const up = await b.app.inject({ method: "POST", url: `/api/tasks/${task.id}/attachments`, payload: { name: "shot.png", data: PNG } });
    assert.equal(up.statusCode, 200, up.body);
    const dir = join(b.state, "attachments", task.id);
    assert.equal(existsSync(dir), true);

    const res = await b.app.inject({ method: "DELETE", url: `/api/projects/${b.project.id}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(existsSync(dir), false, "the files lived outside the database and used to stay for good");
    assert.equal(b.repo.getTask(task.id), undefined);
    assert.ok(b.seen.some((m) => m.type === "project.deleted" && m.id === b.project.id));
    assert.ok(b.seen.some((m) => m.type === "task.deleted" && m.taskId === task.id), "a drawer open on one of its tasks closes too");
  } finally {
    await b.close();
  }
});
