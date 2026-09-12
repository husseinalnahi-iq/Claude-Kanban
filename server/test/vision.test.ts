import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeQuery, setup } from "./helpers.ts";
import { parseDescription } from "../src/engine/vision.ts";
import { setFetch } from "../src/engine/providers/openaiCompatible.ts";
import { setCliSpawn } from "../src/engine/providers/cli/index.ts";
import type { Child, SpawnFn } from "../src/engine/providers/cli/spawn.ts";
import { DEFAULT_VISION_MODEL } from "../src/db.ts";
import type { Provider } from "../src/types.ts";

const ZAI: Provider = {
  id: "kimi", label: "Kimi", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.moonshot.ai/anthropic", authRef: "MOONSHOT_API_KEY",
  models: [{ id: "kimi-k3", label: "Kimi K3" }], mayEditFiles: true,
};
const OR_TEXT: Provider = {
  id: "openrouter", label: "OpenRouter", kind: "openai-compatible", enabled: true, baseUrl: "https://openrouter.ai/api/v1", authRef: "OPENROUTER_API_KEY",
  models: [{ id: "google/gemma-4-31b", label: "Gemma" }], mayEditFiles: false,
};
const CODEX: Provider = {
  id: "codex", label: "Codex", kind: "cli", enabled: true, authRef: "OPENAI_API_KEY", models: [{ id: "gpt-5.6-luna", label: "Luna" }], cli: { preset: "codex" }, mayEditFiles: false,
};

const DESCRIBED = { description: "A login form whose submit button overlaps the footer.", text_in_image: "Sign in" };

function image(): string {
  const dir = mkdtempSync(join(tmpdir(), "vision-test-"));
  const p = join(dir, "bug (1).png");
  writeFileSync(p, Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"));
  return p;
}

function attach(s: ReturnType<typeof setup>): string {
  const task = s.repo.createTask({ project_id: s.project.id, title: "fix it", spec_md: "x", mode: "supervised", pipeline: [{ stage: "plan", model: "claude-sonnet-5", effort: "low" }] });
  const path = image();
  return s.repo.addAttachment({ task_id: task.id, run_id: null, source: "user", name: "bug (1).png", media_type: "image/png", bytes: 30, path, note: null, description: null }).id;
}

test("parseDescription: the JSON it asked for, plain words as a fallback, and 'I cannot see it' as a failure", () => {
  assert.deepEqual(parseDescription('Here you go:\n{"description": "A red error dialog.", "text_in_image": "Error 42"}'), { description: "A red error dialog.", text: "Error 42" });
  assert.deepEqual(parseDescription("A bar chart of monthly sales, with March highlighted in orange."), { description: "A bar chart of monthly sales, with March highlighted in orange.", text: "" });
  assert.equal(parseDescription("I'm sorry, but I cannot see the image you attached."), null);
  assert.equal(parseDescription('{"description": "I am unable to view the image file."}'), null);
  assert.equal(parseDescription("ok"), null, "too short to be a description");
  assert.equal(parseDescription(""), null);
});

test("the default is Claude Haiku at low effort, and the attachment says who described it", async () => {
  const f = fakeQuery({ extra: [] });
  const s = setup(f.fn);
  try {
    const settings = s.repo.getSettings();
    assert.equal(settings.visionProvider, "anthropic");
    assert.equal(settings.visionModel, DEFAULT_VISION_MODEL);
    const calls: any[] = [];
    (s.runner as any).queryFn = (params: any) => {
      calls.push(params.options);
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.001, session_id: "v", modelUsage: {}, structured_output: DESCRIBED } as any;
      })();
    };
    const id = attach(s);
    await s.runner.describeAttachment(id);
    assert.equal(calls[0].model, DEFAULT_VISION_MODEL);
    assert.equal(calls[0].effort, "low");
    assert.equal(s.repo.getAttachment(id)!.described_by, `claude · ${DEFAULT_VISION_MODEL}`);
  } finally {
    s.cleanup();
  }
});

test("Kimi through Claude Code: the same job pointed at Kimi's endpoint; if it cannot see, Claude Haiku does it", async () => {
  const calls: any[] = [];
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [ZAI], visionProvider: "kimi", visionModel: "kimi-k3" });
    s.secrets.set("MOONSHOT_API_KEY", "sk-moonshot-secret");
    let blind = false;
    (s.runner as any).queryFn = (params: any) => {
      calls.push(params.options);
      const onKimi = params.options.env?.ANTHROPIC_BASE_URL === ZAI.baseUrl;
      return (async function* () {
        yield blind && onKimi
          ? ({ type: "result", subtype: "success", is_error: false, result: "I cannot see the image, sorry.", total_cost_usd: 0, session_id: "v", modelUsage: {} } as any)
          : ({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.001, session_id: "v", modelUsage: {}, structured_output: DESCRIBED } as any);
      })();
    };

    const id = attach(s);
    await s.runner.describeAttachment(id);
    assert.equal(calls[0].env.ANTHROPIC_BASE_URL, ZAI.baseUrl);
    assert.equal(calls[0].env.ANTHROPIC_AUTH_TOKEN, "sk-moonshot-secret");
    assert.equal(calls[0].model, "kimi-k3");
    assert.equal(calls[0].maxBudgetUsd, undefined, "Claude Code would price Kimi as Claude");
    assert.equal(s.repo.getAttachment(id)!.described_by, "kimi · kimi-k3");

    blind = true;
    const id2 = attach(s);
    const text = await s.runner.describeAttachment(id2);
    assert.match(text ?? "", /overlaps the footer/);
    assert.equal(calls.at(-1).model, DEFAULT_VISION_MODEL, "the fallback is Claude's default vision model");
    assert.match(s.repo.getAttachment(id2)!.described_by ?? "", /^claude · claude-haiku.* \(fallback: kimi · kimi-k3 could not describe it\)$/);
  } finally {
    s.cleanup();
  }
});

test("a plain chat API gets the image inline, as a data URL", async () => {
  const bodies: any[] = [];
  setFetch(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(DESCRIBED) } }], usage: { prompt_tokens: 900, completion_tokens: 40 } }), { status: 200 });
  });
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [OR_TEXT], visionProvider: "openrouter", visionModel: "google/gemma-4-31b" });
    s.secrets.set("OPENROUTER_API_KEY", "sk-or-secret-value");
    const id = attach(s);
    const text = await s.runner.describeAttachment(id);
    assert.match(text ?? "", /Text in the image: Sign in/);
    const parts = bodies[0].messages[1].content;
    assert.equal(parts[0].type, "text");
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,iVBORw0KGgo/);
    assert.equal(s.repo.getAttachment(id)!.described_by, "openrouter · google/gemma-4-31b");
  } finally {
    setFetch((...a) => fetch(...a));
    s.cleanup();
  }
});

test("Codex gets the image attached with -i: a plain-named copy, read-only", async () => {
  let args: string[] = [];
  const spawnFn: SpawnFn = (_c, a) => {
    args = a;
    const out = a[a.indexOf("-o") + 1];
    writeFileSync(out, JSON.stringify(DESCRIBED));
    const listeners: Record<string, ((x: unknown) => void)[]> = {};
    const child: Child = {
      pid: 1, stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {})(), stderr: (async function* () {})(),
      on: (e, cb) => { (listeners[e] ??= []).push(cb); }, kill: () => {},
    };
    setTimeout(() => (listeners.close ?? []).forEach((cb) => cb(0)), 5);
    return child;
  };
  setCliSpawn(spawnFn);
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [CODEX], visionProvider: "codex", visionModel: "gpt-5.6-luna" });
    const id = attach(s);
    const text = await s.runner.describeAttachment(id);
    assert.match(text ?? "", /overlaps the footer/);
    const img = args[args.indexOf("-i") + 1];
    assert.match(img, /image\.png$/, "a copy with a plain name, so the original's spaces and brackets never reach a shell");
    assert.ok(args.includes("read-only"));
    assert.equal(s.repo.getAttachment(id)!.described_by, "codex · gpt-5.6-luna");
  } finally {
    setCliSpawn(undefined);
    s.cleanup();
  }
});

test("Try it reports a model that cannot see, instead of quietly falling back", async () => {
  const s = setup(fakeQuery().fn);
  try {
    s.repo.updateSettings({ providers: [ZAI] });
    (s.runner as any).queryFn = () =>
      (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "I can't view images.", total_cost_usd: 0, session_id: "v", modelUsage: {} } as any;
      })();
    const r = await s.runner.testVision("kimi", "kimi-k3", image());
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /may not be able to see images/);
    const missing = await s.runner.testVision("nope", "x", image());
    assert.match(missing.error ?? "", /does not exist/);
  } finally {
    s.cleanup();
  }
});
