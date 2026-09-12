import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";

const okQuery: QueryFn = () =>
  (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as any;
  })();

test("API: policy-forbidden autonomous queue → 409 with a clear error; supervised queues", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kapi-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: okQuery }), allowedHosts: ["localhost:80"] });
  try {
    const proj = await app.inject({
      method: "POST", url: "/api/projects",
      payload: { name: "locked-down", path: dir, policy: { worktrees: "forbidden", autonomous: "forbidden" } },
    });
    assert.equal(proj.statusCode, 200, proj.body);
    const project = proj.json();
    assert.equal(project.policy.maxConcurrent, 3);
    assert.equal(project.isGit, false);

    const auto = (await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: project.id, title: "auto", mode: "autonomous" } })).json();
    assert.equal(auto.pipeline.length, 3, "default pipeline applied");
    const q = await app.inject({ method: "POST", url: `/api/tasks/${auto.id}/queue` });
    assert.equal(q.statusCode, 409);
    assert.match(q.json().error, /forbids autonomous runs/);

    const sup = (await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: project.id, title: "sup", mode: "supervised" } })).json();
    const q2 = await app.inject({ method: "POST", url: `/api/tasks/${sup.id}/queue` });
    assert.equal(q2.statusCode, 200, q2.body);

    const bad = await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: project.id } });
    assert.equal(bad.statusCode, 400);

    const settings = (await app.inject({ method: "PATCH", url: "/api/settings", payload: { models: [{ id: "claude-new-model", label: "New" }] } })).json();
    assert.deepEqual(settings.models.map((m: any) => m.id), ["claude-new-model"]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API: foreign origins and hosts are refused (no-cors POST, DNS rebinding)", async () => {
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: okQuery }) });
  try {
    const ok = await app.inject({ method: "GET", url: "/api/settings", headers: { host: "127.0.0.1:4310" } });
    assert.equal(ok.statusCode, 200);
    const viaVite = await app.inject({ method: "GET", url: "/api/settings", headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" } });
    assert.equal(viaVite.statusCode, 200);
    const evil = await app.inject({ method: "POST", url: "/api/tasks/t_x/discard", headers: { host: "127.0.0.1:4310", origin: "https://evil.example" } });
    assert.equal(evil.statusCode, 403);
    const rebind = await app.inject({ method: "GET", url: "/api/projects", headers: { host: "attacker.example:4310" } });
    assert.equal(rebind.statusCode, 403);
    const ws = await app.inject({ method: "GET", url: "/ws", headers: { host: "127.0.0.1:4310", origin: "https://evil.example", connection: "upgrade", upgrade: "websocket" } });
    assert.equal(ws.statusCode, 403);
  } finally {
    await app.close();
  }
});
