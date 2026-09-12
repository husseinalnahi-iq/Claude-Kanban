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
import { createsCycle, dependencyError, layout } from "../src/engine/graph.ts";

const okQuery: QueryFn = () =>
  (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as any;
  })();

const T = (id: string, ...depends_on: string[]) => ({ id, depends_on });

test("layout puts a task one column right of its deepest dependency", () => {
  //  a ─┐            a and b have nothing to wait for, so they share column 0
  //  b ─┴→ c ──→ d
  const { nodes, edges, columns } = layout([T("a"), T("b"), T("c", "a", "b"), T("d", "c")]);
  const col = new Map(nodes.map((n) => [n.task.id, n.col]));
  assert.deepEqual([col.get("a"), col.get("b"), col.get("c"), col.get("d")], [0, 0, 1, 2]);
  assert.equal(columns, 3);
  assert.equal(nodes.find((n) => n.task.id === "a")!.row, 0);
  assert.equal(nodes.find((n) => n.task.id === "b")!.row, 1, "tasks that can run together stack in one column");
  assert.deepEqual(edges.map((e) => `${e.from}->${e.to}`), ["a->c", "b->c", "c->d"]);
});

test("layout ignores dependencies on tasks outside the drawn set", () => {
  const { nodes, edges } = layout([T("child", "some-other-task")]);
  assert.equal(nodes[0].col, 0);
  assert.deepEqual(edges, [], "an arrow to a task that is not on screen is not drawn");
});

test("layout survives a cycle in stored data instead of hanging", () => {
  const { nodes } = layout([T("a", "b"), T("b", "a")]);
  assert.equal(nodes.length, 2);
});

test("createsCycle catches loops of any length, and self-links", () => {
  const deps: Record<string, string[]> = { a: [], b: ["a"], c: ["b"] };
  const depsOf = (id: string) => deps[id] ?? null;
  assert.equal(createsCycle("a", ["c"], depsOf), true, "a→c would close a→b→c→a");
  assert.equal(createsCycle("a", ["a"], depsOf), true);
  assert.equal(createsCycle("d", ["c"], depsOf), false, "a new leaf is fine");
});

test("dependencyError names what is wrong in the user's words", () => {
  const tasks: Record<string, { id: string; project_id: string; depends_on: string[] }> = {
    a: { id: "a", project_id: "p", depends_on: [] },
    b: { id: "b", project_id: "p", depends_on: ["a"] },
    x: { id: "x", project_id: "other", depends_on: [] },
  };
  const lookup = (id: string) => tasks[id] ?? null;
  const title = (id: string) => `task ${id}`;
  assert.equal(dependencyError("b", "p", ["a"], lookup, title), null);
  assert.match(dependencyError("a", "p", ["a"], lookup, title)!, /cannot wait for itself/);
  assert.match(dependencyError("a", "p", ["b"], lookup, title)!, /create a loop/);
  assert.match(dependencyError("a", "p", ["x"], lookup, title)!, /another project/);
  assert.match(dependencyError("a", "p", ["ghost"], lookup, title)!, /No task ghost/);
  assert.match(dependencyError("a", "p", ["b", "b"], lookup, title)!, /listed twice/);
});

test("API: drawing a dependency that closes a loop is refused with 409", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kgraph-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: okQuery }), allowedHosts: ["localhost:80"] });
  try {
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "demo", path: dir } })).json();
    const mk = async (title: string) => (await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: project.id, title } })).json();
    const a = await mk("Schema");
    const b = await mk("Endpoint");

    const link = await app.inject({ method: "PATCH", url: `/api/tasks/${b.id}`, payload: { depends_on: [a.id] } });
    assert.equal(link.statusCode, 200, link.body);
    assert.deepEqual(link.json().depends_on, [a.id]);

    const loop = await app.inject({ method: "PATCH", url: `/api/tasks/${a.id}`, payload: { depends_on: [b.id] } });
    assert.equal(loop.statusCode, 409);
    assert.match(loop.json().error, /loop/);
    assert.deepEqual(repo.getTask(a.id)!.depends_on, [], "the refused edge was not written");

    const self = await app.inject({ method: "PATCH", url: `/api/tasks/${a.id}`, payload: { depends_on: [a.id] } });
    assert.equal(self.statusCode, 409);

    const ghost = await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: project.id, title: "c", depends_on: ["nope"] } });
    assert.equal(ghost.statusCode, 409);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
