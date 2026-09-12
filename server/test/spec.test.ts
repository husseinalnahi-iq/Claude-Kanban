import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, until } from "./helpers.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import { SpecWriter, SPEC_READ_TOOLS } from "../src/engine/specWriter.ts";
import { buildApp } from "../src/app.ts";

type Call = { prompt: string; options: Record<string, any> };

/** A rewrite that reads one file, then answers with a spec named after the model it ran on. */
function writer(opts: { hold?: Promise<void>; empty?: boolean } = {}) {
  const calls: Call[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += String(m.message.content);
      const options = params.options as Record<string, any>;
      calls.push({ prompt, options });
      yield { type: "system", subtype: "init", session_id: "s" } as any;
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `${options.cwd}/src/app.ts` } }] } } as any;
      if (opts.hold) await opts.hold;
      if (options.abortController?.signal.aborted) throw new Error("aborted");
      yield {
        type: "result", subtype: "success", is_error: false, total_cost_usd: 0.12, session_id: "s",
        structured_output: opts.empty ? {} : { spec_md: `## Done when\n- written by ${options.model}`, summary: "Named the file and made the checks testable." },
      } as any;
    })();
  return { fn, calls };
}

function rig(q: ReturnType<typeof writer>) {
  const s = setup(q.fn);
  const specs = new SpecWriter({ repo: s.repo, bus: s.bus, runner: s.runner });
  const task = s.repo.createTask({ project_id: s.project.id, title: "Faster search", spec_md: "make search faster pls" });
  const events = () => s.seen.filter((m) => m.type === "spec.rewrite") as { state: string; note?: string; error?: string }[];
  const settled = () => until(() => ["done", "failed", "stopped"].includes(events().at(-1)?.state ?? ""));
  return { ...s, specs, task, events, settled };
}

test("Rewrite: Opus at high by default, read-only tools, your text kept as the original", async () => {
  const q = writer();
  const r = rig(q);
  try {
    assert.equal(r.specs.start(r.task.id).model, "claude-opus-5");
    await r.settled();
    const o = q.calls[0].options;
    assert.equal(o.model, "claude-opus-5");
    assert.equal(o.effort, "high");
    assert.deepEqual(o.tools, SPEC_READ_TOOLS, "it can look, never change anything");
    assert.equal(o.permissionMode, "dontAsk");
    assert.equal(o.cwd, r.project.path);
    assert.match(q.calls[0].prompt, /make search faster pls/);

    assert.equal(r.repo.getTask(r.task.id)!.spec_md, "## Done when\n- written by claude-opus-5");
    const v = r.specs.status(r.task.id).versions;
    assert.deepEqual(v.map((x) => x.kind), ["yours", "ai"]);
    assert.equal(v[0].spec_md, "make search faster pls", "the original is stored");
    assert.equal(v[1].source_id, v[0].id);
    assert.equal(v[1].cost_usd, 0.12);
    assert.match(v[1].summary!, /testable/);
    assert.ok(r.events().some((e) => e.note === "read src/app.ts"), "progress says what it is reading");
    assert.equal(r.repo.specCost(r.project.id), 0.12, "counted on the dashboard");
  } finally {
    r.cleanup();
  }
});

test("Regenerate with another model starts from your words, not the first rewrite; your edits count as yours", async () => {
  const q = writer();
  const r = rig(q);
  try {
    r.specs.start(r.task.id);
    await r.settled();
    r.specs.start(r.task.id, { model: "claude-sonnet-5", effort: "medium", instruction: "keep it short" });
    await until(() => r.events().filter((e) => e.state === "done").length === 2);
    assert.match(q.calls[1].prompt, /make search faster pls/);
    assert.doesNotMatch(q.calls[1].prompt, /written by claude-opus-5/, "never a rewrite of a rewrite");
    assert.match(q.calls[1].prompt, /keep it short/);
    assert.equal(q.calls[1].options.effort, "medium");
    assert.equal(r.repo.getTask(r.task.id)!.spec_md, "## Done when\n- written by claude-sonnet-5");

    // You edit the rewrite by hand, then rewrite again: your edit is what gets rewritten, and it is kept.
    r.repo.updateTask(r.task.id, { spec_md: "search under 200 ms, my words" });
    r.specs.start(r.task.id);
    await until(() => r.events().filter((e) => e.state === "done").length === 3);
    assert.match(q.calls[2].prompt, /search under 200 ms, my words/);
    const kinds = r.specs.status(r.task.id).versions.map((v) => v.kind);
    assert.deepEqual(kinds, ["yours", "ai", "ai", "yours", "ai"]);
  } finally {
    r.cleanup();
  }
});

test("Back to any version: the original returns, and what was there is kept first", async () => {
  const r = rig(writer());
  try {
    r.specs.start(r.task.id);
    await r.settled();
    const [original] = r.specs.status(r.task.id).versions;
    r.repo.updateTask(r.task.id, { spec_md: "an edit nobody saved as a version" });
    r.specs.restore(r.task.id, original.id);
    assert.equal(r.repo.getTask(r.task.id)!.spec_md, "make search faster pls");
    assert.ok(r.specs.status(r.task.id).versions.some((v) => v.spec_md === "an edit nobody saved as a version"), "restoring never loses text");
    assert.throws(() => r.specs.restore(r.task.id, "sv_nope"), /No such version/);
  } finally {
    r.cleanup();
  }
});

test("Stop and a failed answer leave the spec untouched", async () => {
  let release!: () => void;
  const r = rig(writer({ hold: new Promise((res) => (release = res)) }));
  try {
    r.specs.start(r.task.id);
    assert.throws(() => r.specs.start(r.task.id), /already running/);
    assert.equal(r.specs.status(r.task.id).rewriting?.model, "claude-opus-5", "a drawer opened now shows it working");
    assert.equal(r.specs.stop(r.task.id), true);
    release();
    await r.settled();
    assert.equal(r.events().at(-1)!.state, "stopped");
    assert.equal(r.repo.getTask(r.task.id)!.spec_md, "make search faster pls");
  } finally {
    r.cleanup();
  }

  const bad = rig(writer({ empty: true }));
  try {
    bad.specs.start(bad.task.id);
    await bad.settled();
    assert.equal(bad.events().at(-1)!.state, "failed");
    assert.match(bad.events().at(-1)!.error!, /without a spec/);
    assert.equal(bad.repo.getTask(bad.task.id)!.spec_md, "make search faster pls");
  } finally {
    bad.cleanup();
  }
});

test("API: settings choose the default model and effort; the routes start, list and restore", async () => {
  const q = writer();
  const r = rig(q);
  const app = await buildApp({ repo: r.repo, bus: r.bus, runner: r.runner, allowedHosts: ["localhost:80"] });
  try {
    const set = await app.inject({ method: "PATCH", url: "/api/settings", payload: { specModel: "claude-fable-5-1", specEffort: "xhigh" } });
    assert.equal(set.statusCode, 200, set.body);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${r.task.id}/spec/rewrite`, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    await r.settled();
    assert.equal(q.calls[0].options.model, "claude-fable-5-1");
    assert.equal(q.calls[0].options.effort, "xhigh");
    const status = (await app.inject({ method: "GET", url: `/api/tasks/${r.task.id}/spec` })).json();
    assert.equal(status.versions.length, 2);
    const back = await app.inject({ method: "POST", url: `/api/tasks/${r.task.id}/spec/restore`, payload: { version_id: status.versions[0].id } });
    assert.equal(back.json().spec_md, "make search faster pls");
  } finally {
    await app.close();
    r.cleanup();
  }
});
