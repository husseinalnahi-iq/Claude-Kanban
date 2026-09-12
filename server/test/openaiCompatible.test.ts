import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeQuery, setup, until } from "./helpers.ts";
import { setFetch } from "../src/engine/providers/openaiCompatible.ts";
import { ProviderError } from "../src/engine/providers/registry.ts";
import type { Provider, Stage } from "../src/types.ts";

const OR: Provider = {
  id: "openrouter", label: "OpenRouter (text)", kind: "openai-compatible", enabled: true, baseUrl: "https://openrouter.ai/api/v1", authRef: "OPENROUTER_API_KEY",
  models: [{ id: "moonshotai/kimi-k3", label: "Kimi K3", inputPer1M: 2, outputPer1M: 12, contextWindow: 1_000_000 }, { id: "free/model", label: "free" }],
  mayEditFiles: false,
};

type Recorded = { url: string; init: RequestInit; body: any };
function fakeFetch(reply: (r: Recorded) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = [];
  setFetch(async (input, init) => {
    const rec = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(rec);
    const signal = init?.signal;
    const res = await Promise.race([
      Promise.resolve(reply(rec)),
      new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    ]);
    return new Response(typeof res.body === "string" ? res.body : JSON.stringify(res.body), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

function withOr(s: ReturnType<typeof setup>, patch: Partial<Provider> = {}) {
  s.repo.updateSettings({ providers: [{ ...OR, ...patch }] });
  s.secrets.set("OPENROUTER_API_KEY", "sk-or-secret-value-1234");
}

const PLAN_STAGE: Stage = { stage: "plan", model: "moonshotai/kimi-k3", effort: "low", provider: "openrouter" };

test("a text-only plan stage is one chat call, priced by the API, recorded as SDK-shaped events, secret never stored", async () => {
  const calls = fakeFetch(() => ({ body: { choices: [{ message: { content: "PLAN" } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 } } }));
  const s = setup(fakeQuery().fn);
  try {
    withOr(s);
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "do x", mode: "supervised", pipeline: [PLAN_STAGE] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    const [run] = s.repo.runsForTask(task.id);
    assert.equal(run.result_md, "PLAN");
    assert.equal(run.cost_usd, 0.0012);
    assert.equal(run.cost_source, "provider");
    assert.equal(run.session_id, run.id);
    assert.equal(run.input_tokens, 10);
    assert.equal(run.output_tokens, 5);
    assert.equal(run.context_window, 1_000_000);
    const types = s.repo.eventsAfter(run.id).map((e) => e.type);
    assert.deepEqual(types, ["user:prompt", "delegate:command", "system:init", "assistant", "result:success"]);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.deepEqual(calls[0].body.usage, { include: true }, "OpenRouter is asked for the price");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer sk-or-secret-value-1234");
    const prompt = s.repo.eventsAfter(run.id)[0].payload as { text: string };
    assert.match(prompt.text, /Repository file list|cannot read files/);
    assert.doesNotMatch(prompt.text, /## Board/);
    const all = JSON.stringify(s.repo.eventsAfter(run.id));
    assert.doesNotMatch(all, /sk-or-secret/, "the key never reaches the transcript");
  } finally {
    setFetch(fetch);
    s.cleanup();
  }
});

test("without a price from the API the run is estimated from the table, or a subscription", async () => {
  fakeFetch(() => ({ body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } } }));
  const s = setup(fakeQuery().fn);
  try {
    withOr(s, { baseUrl: "http://localhost:11434/v1" });
    const t1 = s.repo.createTask({ project_id: s.project.id, title: "a", spec_md: "x", mode: "supervised", pipeline: [PLAN_STAGE] });
    s.runner.queueTask(t1.id);
    await until(() => s.repo.getTask(t1.id)!.status === "review");
    assert.equal(s.repo.runsForTask(t1.id)[0].cost_source, "estimated");
    assert.equal(s.repo.runsForTask(t1.id)[0].cost_usd, 2);
    const t2 = s.repo.createTask({ project_id: s.project.id, title: "b", spec_md: "x", mode: "supervised", pipeline: [{ ...PLAN_STAGE, model: "free/model" }] });
    s.runner.queueTask(t2.id);
    await until(() => s.repo.getTask(t2.id)!.status === "review");
    assert.equal(s.repo.runsForTask(t2.id)[0].cost_source, "subscription");
  } finally {
    setFetch(fetch);
    s.cleanup();
  }
});

test("an HTTP error fails the task (never pauses it); a code stage on a text-only provider is refused at queue", async () => {
  fakeFetch(() => ({ status: 401, body: { error: { message: "bad key" } } }));
  const s = setup(fakeQuery().fn);
  try {
    withOr(s);
    s.repo.updateSettings({ autoResume: true });
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [PLAN_STAGE] });
    s.runner.queueTask(task.id);
    await until(() => ["failed", "paused"].includes(s.repo.getTask(task.id)!.status));
    assert.equal(s.repo.getTask(task.id)!.status, "failed");
    assert.match(s.repo.getTask(task.id)!.error ?? "", /HTTP 401/);

    const code = s.repo.createTask({ project_id: s.project.id, title: "c", spec_md: "x", mode: "autonomous", pipeline: [{ ...PLAN_STAGE, stage: "code" }] });
    assert.throws(() => s.runner.queueTask(code.id), (e: Error) => e instanceof ProviderError && /has no tools/.test(e.message));
    assert.throws(() => s.runner.chat(task.id, "hi"), /cannot continue a session/);
  } finally {
    setFetch(fetch);
    s.cleanup();
  }
});

test("timeouts and stops abort the request; a retry starts over rather than resuming", async () => {
  const holder: { hold: (() => void) | null } = { hold: null };
  fakeFetch(() => new Promise((r) => (holder.hold = () => r({ body: { choices: [{ message: { content: "late" } }] } }))));
  const s = setup(fakeQuery().fn);
  try {
    withOr(s);
    s.repo.updateSettings({ delegateTimeoutMin: 1 });
    const task = s.repo.createTask({ project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised", pipeline: [PLAN_STAGE] });
    s.runner.queueTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "planning");
    s.runner.stopTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "failed");
    assert.equal(s.repo.getTask(task.id)!.error, "stopped by user");
    holder.hold?.();

    // Retry: a fresh call with no resume (the adapter cannot continue a session).
    fakeFetch(() => ({ body: { choices: [{ message: { content: "again" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
    s.runner.retryTask(task.id);
    await until(() => s.repo.getTask(task.id)!.status === "review");
    assert.equal(s.repo.runsForTask(task.id).at(-1)!.result_md, "again");
  } finally {
    setFetch(fetch);
    s.cleanup();
  }
});

test("a text-only review stage gets the diff inlined", async () => {
  const calls = fakeFetch(() => ({ body: { choices: [{ message: { content: "VERDICT: APPROVE\nfine" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
  const s = setup(fakeQuery({ result: "coded" }).fn);
  try {
    withOr(s);
    // The scratch project is a plain folder; make it a repo with an uncommitted change so the diff has content.
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: s.dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: s.dir });
    writeFileSync(join(s.dir, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: s.dir });
    const task = s.repo.createTask({
      project_id: s.project.id, title: "t", spec_md: "x", mode: "supervised",
      pipeline: [{ stage: "code", model: "claude-haiku-4-5-20251001", effort: "low" }, { ...PLAN_STAGE, stage: "review" }],
    });
    s.runner.queueTask(task.id);
    // The review stage sets task status to "review" while it runs; wait for the run itself to finish.
    await until(() => s.repo.runsForTask(task.id).some((r) => r.stage === "review" && r.status === "success"), 15_000);
    const prompt = calls[0].body.messages[1].content as string;
    assert.match(prompt, /## Diff \(1 file\)/);
    assert.match(prompt, /A a\.txt/);
    assert.match(prompt, /\+hello/);
    assert.match(prompt, /produced by another model|Previous stage result/);
  } finally {
    setFetch(fetch);
    s.cleanup();
  }
});
