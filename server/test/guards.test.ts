import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { board } from "./board.ts";
import type { Stage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

test("a task's parent must exist, belong to the same project and not be the task itself or one of its own subtasks", async () => {
  const b = await board();
  try {
    const other = b.repo.createProject({ name: "elsewhere", path: join(b.dir, "elsewhere"), policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
    const foreign = b.repo.createTask({ project_id: other.id, title: "Theirs", pipeline: ONE });
    const parent = b.repo.createTask({ project_id: b.project.id, title: "Parent", pipeline: ONE });
    const child = b.repo.createTask({ project_id: b.project.id, title: "Child", pipeline: ONE, parent_id: parent.id });
    const patch = (id: string, payload: object) => b.app.inject({ method: "PATCH", url: `/api/tasks/${id}`, payload });
    const create = (payload: object) => b.app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: b.project.id, title: "New", triage: false, ...payload } });

    const missing = await create({ parent_id: "t_gone" });
    assert.equal(missing.statusCode, 409, "a plain refusal, not a database error");
    assert.match(missing.json().error, /no longer exists/);
    assert.match((await create({ parent_id: foreign.id })).json().error, /another project/);
    assert.match((await patch(child.id, { parent_id: child.id })).json().error, /its own parent/);
    assert.match((await patch(parent.id, { parent_id: child.id })).json().error, /already under this task/);
    assert.equal(b.repo.getTask(parent.id)!.parent_id, null, "nothing was saved");

    assert.equal((await create({ parent_id: parent.id })).statusCode, 200);
    assert.equal((await patch(child.id, { parent_id: null })).statusCode, 200, "and a task can still be moved out from under its parent");
  } finally {
    await b.close();
  }
});

test("a task's milestone must exist and belong to the same project", async () => {
  const b = await board();
  try {
    const other = b.repo.createProject({ name: "elsewhere", path: join(b.dir, "elsewhere"), policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
    const theirs = b.repo.createMilestone({ project_id: other.id, title: "Their launch" });
    const ours = b.repo.createMilestone({ project_id: b.project.id, title: "Our launch" });
    const task = b.repo.createTask({ project_id: b.project.id, title: "T", pipeline: ONE });
    const patch = (payload: object) => b.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload });

    assert.match((await patch({ milestone_id: "ms_gone" })).json().error, /milestone no longer exists/);
    assert.match((await patch({ milestone_id: theirs.id })).json().error, /another project/);
    assert.equal((await patch({ milestone_id: ours.id })).json().milestone_id, ours.id);
  } finally {
    await b.close();
  }
});

test("asking for worktrees without naming a project is refused as a bad request", async () => {
  const b = await board();
  try {
    assert.equal((await b.app.inject({ method: "GET", url: "/api/worktrees" })).statusCode, 400);
  } finally {
    await b.close();
  }
});

test("a long transcript is read a page at a time, and a page is never larger than the ceiling", async () => {
  const b = await board();
  try {
    const task = b.repo.createTask({ project_id: b.project.id, title: "Long", pipeline: ONE });
    const run = b.repo.createRun({ task_id: task.id, stage: "code", stage_index: 0, model: "m", effort: "low" });
    for (let i = 0; i < 2005; i++) b.repo.insertEvent(run.id, "assistant", { n: i });
    const page = (q: string) => b.get(`/api/runs/${run.id}/events${q}`) as Promise<{ id: number; payload: { n: number } }[]>;

    // The way a client reads the whole thing: keep asking from the last id until a page comes back short.
    const all: number[] = [];
    let after = 0;
    for (;;) {
      const p = await page(`?after=${after}&limit=500`);
      all.push(...p.map((e) => e.payload.n));
      if (p.length < 500) break;
      after = p.at(-1)!.id;
    }
    assert.equal(all.length, 2005, "nothing is skipped and nothing repeats");
    assert.deepEqual([all[0], all.at(-1)], [0, 2004]);

    assert.equal((await page("?limit=100000")).length, 2000, "an oversized page is cut to the ceiling");
    assert.equal((await page("")).length, 2000, "and no size asked for means the ceiling, as before");
    assert.equal((await page("?limit=3")).length, 3);
  } finally {
    await b.close();
  }
});

test("how far a task's branch has fallen behind is asked of git once, then remembered for a moment", async () => {
  const b = await board();
  try {
    git(b.dir, "init", "-q", "-b", "main");
    git(b.dir, "config", "user.email", "t@example.com");
    git(b.dir, "config", "user.name", "T");
    const commit = (name: string) => {
      writeFileSync(join(b.dir, name), name);
      git(b.dir, "add", "-A");
      git(b.dir, "commit", "-q", "-m", name);
    };
    commit("a.txt");
    git(b.dir, "branch", "kanban/t_demo");
    commit("b.txt");
    const task = b.repo.createTask({ project_id: b.project.id, title: "Behind", pipeline: ONE });
    b.repo.updateTask(task.id, { branch: "kanban/t_demo", worktree_path: b.dir });

    assert.deepEqual((await b.get(`/api/tasks/${task.id}`)).staleness, { base: "main", behind: 1 });
    commit("c.txt");
    assert.equal((await b.get(`/api/tasks/${task.id}`)).staleness.behind, 1, "an open drawer refreshes on every turn of a run: it reuses the answer instead of starting git again");

    b.repo.updateTask(task.id, { branch: "main" });
    assert.equal((await b.get(`/api/tasks/${task.id}`)).staleness.behind, 0, "a different branch is a different question");
  } finally {
    await b.close();
  }
});
