import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, stagePrompt, type QueryFn } from "../src/engine/runner.ts";
import { buildApp } from "../src/app.ts";
import { instructionFiles } from "../src/routes/claudeMd.ts";
import type { Stage } from "../src/types.ts";

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("the board lists the instruction files Claude Code reads, and reads them without changing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "kmd-"));
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "# Build\nnpm test\n");
    writeFileSync(join(dir, "CLAUDE.local.md"), "my notes\n");
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(dir, ".claude", "rules", "api.md"), "API rules\n");

    const files = instructionFiles(dir);
    const byScope = (s: string) => files.find((f) => f.scope === s);
    assert.equal(byScope("project")?.exists, true);
    assert.match(byScope("project")?.content ?? "", /npm test/);
    assert.equal(byScope("project (.claude)")?.exists, false, "the other project location is listed, as absent");
    assert.equal(byScope("local")?.content, "my notes\n");
    assert.ok(files.some((f) => f.scope === "rule" && f.path.endsWith("api.md")), "path-scoped rules are included");
    assert.deepEqual(files.slice(0, 4).map((f) => f.scope), ["user", "project", "project (.claude)", "local"], "in Claude's own order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slash-command stage is sent as the command itself; anything else gets the board's prompt", () => {
  const build = () => "# Stage: custom\n…board context…";
  const custom = (prompt: string): Stage => ({ stage: "custom", model: "m", effort: "high", prompt });
  assert.equal(stagePrompt(custom("/init"), build), "/init", "so Claude runs its own /init, not text about it");
  assert.equal(stagePrompt(custom("  /security-review "), build), "/security-review");
  assert.equal(stagePrompt(custom("please run /init for me"), build), build(), "a sentence mentioning a command is not a command");
  assert.equal(stagePrompt(custom("/"), build), build());
  assert.equal(stagePrompt({ stage: "code", model: "m", effort: "high", prompt: "/init" }, build), build(), "only custom stages send raw commands");
});

test("Create with /init runs Claude's /init as a task, supervised where the project requires it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kmdinit-"));
  const prompts: string[] = [];
  const q: QueryFn = (params) =>
    (async function* () {
      let text = "";
      for await (const m of params.prompt) text += typeof m.message.content === "string" ? m.message.content : "";
      prompts.push(text);
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as never;
    })();
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: q }), allowedHosts: ["localhost:80"] });
  try {
    // A locked-down project: the board must not write CLAUDE.md there behind an approval card's back.
    const project = repo.createProject({ name: "locked", path: dir, policy: { worktrees: "forbidden", autonomous: "forbidden", maxConcurrent: 3 } });
    const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/claude-md/init` });
    assert.equal(res.statusCode, 200, res.body);
    const task = res.json();
    assert.equal(task.title, "Create CLAUDE.md with /init");
    assert.equal(task.mode, "supervised", "a locked-down project gets approval cards, not a side door");
    assert.deepEqual(task.pipeline.map((s: Stage) => [s.stage, s.prompt]), [["custom", "/init"]]);
    await until(() => prompts.length === 1);
    assert.equal(prompts[0], "/init", "the session receives Claude's own command");

    // Once a CLAUDE.md exists, the same button improves it — which is what /init itself does.
    writeFileSync(join(dir, "CLAUDE.md"), "# existing\n");
    const again = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/claude-md/init` })).json();
    assert.equal(again.title, "Improve CLAUDE.md with /init");

    const listed = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/claude-md` })).json();
    assert.equal(listed.find((f: { scope: string }) => f.scope === "project").content, "# existing\n");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
