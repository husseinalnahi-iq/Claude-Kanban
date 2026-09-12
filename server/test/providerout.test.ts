import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { classifyProviderError, resetFrom, retryDelayMs } from "../src/engine/providers/limits.ts";
import { parseKimi, parseOpenRouter, parseZai, QuotaReader, type FetchLike } from "../src/engine/providers/usage.ts";
import { applyAnthropicCompatible } from "../src/engine/providers/anthropicCompatible.ts";
import type { Provider, Stage } from "../src/types.ts";

const ZAI: Provider = {
  id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic",
  authRef: "ZAI_API_KEY", models: [{ id: "glm-5.3", label: "GLM 5.3" }], mayEditFiles: true,
};
const ON_GLM: Stage[] = [{ stage: "code", model: "glm-5.3", effort: "low", provider: "zai" }];
const ON_CLAUDE: Stage[] = [{ stage: "code", model: "claude-opus-5", effort: "low" }];

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** "2026-09-12 18:43:01" the way z.ai writes it: Beijing time, no zone. */
function beijing(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

const glmWindow = (resetMs: number) =>
  `API Error: 429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at ${beijing(resetMs)}"}}`;
const GLM_BROKE = 'API Error: 429 {"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}';

type Reply = { error?: string; text?: string };
/** A fake SDK that answers per call by where the call goes (z.ai or Claude), and records every prompt. */
function fake(answer: (where: "zai" | "claude", n: number) => Reply) {
  const calls: { where: "zai" | "claude"; prompt: string; model: string }[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      // By model: the test machine's own environment may already point ANTHROPIC_BASE_URL somewhere.
      const where = /^glm/.test(String(params.options.model)) ? "zai" : "claude";
      const n = calls.filter((c) => c.where === where).length;
      calls.push({ where, prompt, model: String(params.options.model) });
      const r = answer(where, n);
      yield { type: "system", subtype: "init", session_id: `s-${where}-${n}` } as never;
      yield { type: "assistant", session_id: `s-${where}-${n}`, message: { content: [{ type: "text", text: `edited src/app.ts on ${where}` }] } } as never;
      yield {
        type: "result", subtype: "success", is_error: Boolean(r.error), result: r.error ?? r.text ?? "DONE", total_cost_usd: 0, session_id: `s-${where}-${n}`,
        modelUsage: { m: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      } as never;
    })();
  return { fn, calls };
}

function setup(queryFn: QueryFn, provider: Provider = ZAI, quota?: QuotaReader) {
  const dir = mkdtempSync(join(tmpdir(), "kout-"));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  repo.updateSettings({ providers: [provider] });
  const offline = new QuotaReader((async () => { throw new Error("offline"); }) as FetchLike);
  const runner = new TaskRunner({ repo, bus, queryFn, quota: quota ?? offline });
  const task = (pipeline: Stage[], title = "job") => repo.createTask({ project_id: project.id, title, mode: "supervised", pipeline });
  return { repo, bus, project, runner, task, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("errors are told apart: a window that comes back, credit that does not, a busy server, and real failures", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  const glm = classifyProviderError("Usage limit reached for 5 hour. Your limit will reset at 2026-09-12 20:43:01", now, 480);
  assert.equal(glm?.kind, "window");
  assert.equal(glm?.resetsAt, Date.parse("2026-09-12T12:43:01Z"), "z.ai writes Beijing time");
  assert.equal(classifyProviderError(GLM_BROKE, now)?.kind, "credit");
  assert.equal(classifyProviderError("You've reached your 5-hour usage limit", now)?.kind, "window", "Kimi Code");
  assert.equal(classifyProviderError("You've reached your weekly (7-day) usage limit", now)?.kind, "window");
  assert.equal(classifyProviderError("You've reached your concurrent request limit", now)?.kind, "busy");
  assert.equal(classifyProviderError("HTTP 402: Insufficient credits. Add more at openrouter.ai/credits", now)?.kind, "credit");
  assert.equal(classifyProviderError("you've reached your session usage limit, please wait or upgrade to continue", now)?.kind, "window", "Ollama cloud");
  assert.equal(classifyProviderError("API Error: 429 We're receiving too many requests", now)?.kind, "busy");
  assert.equal(classifyProviderError("Your request exceeded model token limit", now), null, "context length is not usage");
  assert.equal(classifyProviderError("Stopped after the same tool call was repeated 8 times", now), null);
  assert.equal(classifyProviderError("TypeError: cannot read properties of undefined", now), null);
  assert.equal(resetFrom("try again in 2h 10m", now), now + 130 * 60_000);
  assert.equal(resetFrom("reset at 2026-09-12T11:00:00Z", now), Date.parse("2026-09-12T11:00:00Z"));
  assert.equal(resetFrom("reset at 2020-01-01 00:00:00", now), null, "a time in the past is not believed");
  assert.deepEqual([0, 1, 2, 3, 9].map((n) => retryDelayMs("window", n) / 60_000), [30, 60, 120, 240, 240]);
});

test("each provider's usage figures are read, with the key sent the way that provider wants", async () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  const zai = parseZai({
    code: 200, success: true,
    data: { limits: [
      { type: "TOKENS_LIMIT", percentage: 42, nextResetTime: now + 3 * 3_600_000 },
      { type: "TOKENS_LIMIT", percentage: 12.5, nextResetTime: now + 4 * 86_400_000 },
      { type: "TIME_LIMIT", percentage: 3 },
    ] },
  }, now);
  assert.deepEqual(zai.windows.map((w) => [w.label, w.used, Boolean(w.soft)]), [["5-hour window", 0.42, false], ["Weekly", 0.125, false], ["Web tools (monthly)", 0.03, true]]);
  const kimi = parseKimi({
    user: { membership: { level: "LEVEL_ADVANCED" } },
    usage: { limit: "100", used: "25", remaining: "75", resetTime: "2026-09-15T07:05:56Z" },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "100", remaining: "0", resetTime: "2026-09-12T12:00:00Z" } }],
  });
  assert.deepEqual(kimi.windows.map((w) => [w.label, w.used]), [["5-hour window", 1], ["Weekly", 0.25]]);
  assert.equal(kimi.plan, "Advanced");
  assert.equal(parseOpenRouter({ data: { total_credits: 10, total_usage: 7.5 } }).balance?.amount, 2.5);

  const seen: { url: string; auth: string }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => (url.includes("z.ai") ? { data: { limits: [] } } : { usage: { limit: "1", used: "0" } }) };
  };
  const reader = new QuotaReader(fetchFn);
  await reader.read(ZAI, "zai-key");
  await reader.read({ ...ZAI, id: "kimi-code", baseUrl: "https://api.kimi.com/coding/" }, "sk-kimi");
  await reader.read(ZAI, "zai-key");
  assert.deepEqual(seen, [
    { url: "https://api.z.ai/api/monitor/usage/quota/limit", auth: "zai-key" },
    { url: "https://api.kimi.com/coding/v1/usages", auth: "Bearer sk-kimi" },
  ], "z.ai takes the bare key; Kimi a bearer; the second z.ai read came from the cache");
  assert.equal(await reader.read({ ...ZAI, baseUrl: "https://example.com/anthropic" }, "k"), null, "nobody to ask: no request at all");
});

test("Kimi Code's key goes out as an API key; every Claude alias, Fable included, is pinned to the model", () => {
  const env = (p: Provider) => applyAnthropicCompatible({ env: {} }, { provider: p, model: "k3-256k", secret: "sk-kimi" }).env as Record<string, string>;
  const kimi = env({ ...ZAI, id: "kimi-code", baseUrl: "https://api.kimi.com/coding/", authStyle: "api-key" });
  assert.equal(kimi.ANTHROPIC_API_KEY, "sk-kimi");
  assert.equal(kimi.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(kimi.ANTHROPIC_DEFAULT_FABLE_MODEL, "k3-256k");
  const glm = env(ZAI);
  assert.equal(glm.ANTHROPIC_AUTH_TOKEN, "sk-kimi");
  assert.equal(glm.ANTHROPIC_API_KEY, "", "the board's own key never goes to another endpoint");
});

test("a used-up window pauses the task until it resets, holds other work for that provider, then carries on", async () => {
  const reset = Date.now() + 2 * 3_600_000;
  let glmOut = true;
  const q = fake((where) => (where === "zai" && glmOut ? { error: glmWindow(reset) } : { text: "done" }));
  const s = setup(q.fn);
  try {
    const t = s.task(ON_GLM);
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "paused");
    const paused = s.repo.getTask(t.id)!;
    assert.equal(paused.pause_reason, "provider");
    assert.equal(paused.error, null, "running out is not a failure");
    assert.match(paused.note ?? "", /GLM \(z\.ai\) reached its usage limit.*carries on by itself/);
    const at = Date.parse(paused.resume_at!);
    assert.ok(at >= reset && at <= reset + 5 * 60_000, "it resumes just after z.ai's reset, read from its message");
    assert.equal(s.repo.providerOuts()[0]?.kind, "window");
    assert.equal(s.runner.limitedUntil(), null, "Claude's own window is not affected");

    // More work for GLM waits in the queue instead of failing; work on Claude is not held.
    const waiting = s.task(ON_GLM, "second");
    s.runner.queueTask(waiting.id);
    const claudeTask = s.task(ON_CLAUDE, "on claude");
    s.runner.queueTask(claudeTask.id);
    await until(() => s.repo.getTask(claudeTask.id)!.status === "review");
    assert.equal(s.repo.getTask(waiting.id)!.status, "queued");
    assert.equal(q.calls.filter((c) => c.where === "zai").length, 1, "nothing was sent to z.ai while it was out");

    // The window resets.
    glmOut = false;
    s.runner.resumeDue(at + 1000);
    await until(() => s.repo.getTask(t.id)!.status === "review" && s.repo.getTask(waiting.id)!.status === "review");
    assert.deepEqual(s.repo.providerOuts(), [], "a stage that worked clears it");
  } finally {
    s.cleanup();
  }
});

test("with a fallback set, the stage carries on there at once and the new model is told where things stand", async () => {
  const q = fake((where) => (where === "zai" ? { error: glmWindow(Date.now() + 3_600_000) } : { text: "finished it" }));
  const s = setup(q.fn, { ...ZAI, fallback: { provider: "anthropic", model: "claude-sonnet-5" } });
  try {
    const t = s.task(ON_GLM);
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "review");
    const done = s.repo.getTask(t.id)!;
    assert.equal(done.pipeline[0].provider, undefined, "the stage now runs on Claude");
    assert.equal(done.pipeline[0].model, "claude-sonnet-5");
    const second = q.calls[1];
    assert.equal(second.where, "claude");
    assert.match(second.prompt, /## Picking up from another model/);
    assert.match(second.prompt, /glm-5\.3 on GLM \(z\.ai\), which stopped partway/);
    assert.match(second.prompt, /edited src\/app\.ts on zai/, "what the first model said last is handed over");
    const run = s.repo.stageRuns(t.id)[0];
    assert.ok(s.repo.eventsAfter(run.id).some((e) => e.type === "board:switch"), "the switch is in the transcript");
  } finally {
    s.cleanup();
  }
});

test("credit that ran out waits for you: switch the stage (and remember it), or stop", async () => {
  const q = fake((where) => (where === "zai" ? { error: GLM_BROKE } : { text: "done" }));
  const s = setup(q.fn);
  try {
    const t = s.task(ON_GLM);
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "paused");
    const paused = s.repo.getTask(t.id)!;
    assert.equal(paused.resume_at, null, "nothing comes back by itself");
    assert.match(paused.note ?? "", /out of credit: Insufficient balance.*Top it up and press Try again/);

    s.runner.switchStage(t.id, { provider: "anthropic", model: "claude-sonnet-5" }, true);
    await until(() => s.repo.getTask(t.id)!.status === "review");
    assert.match(q.calls.at(-1)!.prompt, /Picking up from another model/);
    assert.deepEqual(s.repo.getSettings().providers[0].fallback, { provider: "anthropic", model: "claude-sonnet-5" }, "remembered for next time");

    // Stop, on another one.
    s.repo.updateSettings({ providers: [ZAI] });
    s.repo.clearProviderOut("zai");
    const other = s.task(ON_GLM, "other");
    s.runner.queueTask(other.id);
    await until(() => s.repo.getTask(other.id)!.status === "paused");
    s.runner.stopPaused(other.id);
    assert.equal(s.repo.getTask(other.id)!.status, "failed");
    assert.match(s.repo.getTask(other.id)!.error ?? "", /out of credit/);
  } finally {
    s.cleanup();
  }
});

test("Claude's usage running out carries the stage on to the Claude fallback when one is set", async () => {
  const q = fake((where) => (where === "claude" ? { error: "Claude AI usage limit reached|1757700000" } : { text: "done on glm" }));
  const s = setup(q.fn);
  try {
    s.repo.updateSettings({ claudeFallback: { provider: "zai", model: "glm-5.3" } });
    const t = s.task(ON_CLAUDE);
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "review");
    assert.equal(s.repo.getTask(t.id)!.pipeline[0].provider, "zai");
    assert.equal(q.calls.at(-1)!.where, "zai");
  } finally {
    s.cleanup();
  }
});

test("an ordinary failure on a provider still fails; the usage panel counts runs and reads the provider's own figures", async () => {
  const q = fake(() => ({ error: "TypeError: cannot read properties of undefined" }));
  const full: FetchLike = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 100, nextResetTime: Date.now() + 3_600_000 }] } }),
  });
  const s = setup(q.fn, ZAI, new QuotaReader(full));
  try {
    const t = s.task(ON_GLM);
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "failed");
    assert.deepEqual(s.repo.providerOuts(), []);

    s.runner.secrets.set("ZAI_API_KEY", "zai-key");
    const [u] = await s.runner.providerUsage(true);
    assert.equal(u.source, "live");
    assert.equal(u.board.d7.runs, 1);
    assert.equal(u.board.d7.input_tokens, 1000);
    assert.equal(u.windows[0].used, 1);
    assert.equal(u.out?.kind, "window", "a window the provider says is full holds its work before anything fails");
  } finally {
    s.cleanup();
  }
});
