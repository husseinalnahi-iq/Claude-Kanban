import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudId, ModelCatalog } from "../src/engine/providers/catalog.ts";
import { estimateCost } from "../src/engine/providers/cost.ts";
import type { Provider } from "../src/types.ts";

const OLLAMA: Provider = {
  id: "ollama", label: "Ollama", kind: "anthropic-compatible", enabled: true, baseUrl: "http://localhost:11434", authRef: "OLLAMA_TOKEN",
  models: [{ id: "qwen3-coder", label: "Qwen3 Coder" }, { id: "gpt-oss:20b", label: "GPT-OSS 20B" }], mayEditFiles: true,
};
const OR_TEXT: Provider = {
  id: "openrouter", label: "OpenRouter", kind: "openai-compatible", enabled: true, baseUrl: "https://openrouter.ai/api/v1", authRef: "OPENROUTER_API_KEY",
  models: [{ id: "my/pinned", label: "Pinned", inputPer1M: 9, outputPer1M: 9 }], mayEditFiles: false,
};
const OR_AGENT: Provider = { ...OR_TEXT, id: "openrouter-anthropic", kind: "anthropic-compatible", baseUrl: "https://openrouter.ai/api", models: [] };
const ZAI: Provider = {
  id: "zai", label: "GLM", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic", authRef: "ZAI_API_KEY",
  models: [{ id: "glm-5.3", label: "GLM 5.3" }], mayEditFiles: true,
};

const TAGS = {
  models: [
    { name: "qwen3-coder:latest", details: { parameter_size: "30.5B" } },
    { name: "gemma4:31b-cloud", remote_host: "https://ollama.com:443", remote_model: "gemma4:31b" },
  ],
};

const OR_MODELS = {
  data: [
    { id: "b/paid-tools", name: "Paid Tools", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } },
    { id: "a/free:free", name: "Free One", context_length: 128000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } },
    { id: "c/free-notools:free", name: "Free No Tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: [], architecture: { output_modalities: ["text"] } },
    { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" }, supported_parameters: ["tools"] },
    { id: "d/image-gen", name: "Image", pricing: { prompt: "0.000001", completion: "0.00004" }, architecture: { output_modalities: ["image"] } },
  ],
};

const LMSTUDIO: Provider = {
  id: "lmstudio", label: "LM Studio", kind: "anthropic-compatible", enabled: true, baseUrl: "http://localhost:1234", authRef: "LM_API_TOKEN", models: [], mayEditFiles: true,
};

function fake(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  const fn = async (url: string, h?: Record<string, string>) => {
    calls.push(url);
    headers.push(h);
    if (!(url in responses)) throw new Error("connect ECONNREFUSED");
    return responses[url];
  };
  return { calls, headers, fn };
}

test("Ollama: pulled models split into local and cloud; a listed model that is not pulled is flagged", async () => {
  const f = fake({ "http://localhost:11434/api/tags": TAGS });
  const r = await new ModelCatalog(f.fn).list(OLLAMA);
  assert.equal(r.source, "live");
  assert.deepEqual(
    r.models.map((m) => [m.id, m.group, m.installed]),
    [["qwen3-coder", "local", true], ["gemma4:31b-cloud", "cloud", true], ["gpt-oss:20b", "saved", false]],
  );
  assert.equal(r.models[0].label, "30.5B");
  assert.match(r.models[1].label, /Ollama's servers/);
});

test("Ollama: its public cloud list is added under the names your Ollama runs them as; ollama.com down changes nothing", async () => {
  assert.equal(cloudId("gemma4:31b"), "gemma4:31b-cloud");
  assert.equal(cloudId("glm-5.3"), "glm-5.3:cloud");
  assert.equal(cloudId("deepseek-v4-flash:0731"), "deepseek-v4-flash:cloud");
  const f = fake({
    "http://localhost:11434/api/tags": TAGS,
    "https://ollama.com/api/tags": { models: [{ name: "gemma4:31b" }, { name: "glm-5.3" }, { name: "glm-5.3" }] },
  });
  const r = await new ModelCatalog(f.fn).list(OLLAMA);
  assert.deepEqual(
    r.models.filter((m) => m.group === "cloud").map((m) => [m.id, m.installed]),
    [["gemma4:31b-cloud", true], ["glm-5.3:cloud", false]],
    "the one you pulled is not listed twice",
  );
});

const LMS = {
  models: [
    { type: "llm", key: "qwen/qwen3.8-27b", display_name: "Qwen3.8 27B", params_string: "27B", quantization: { name: "Q4_K_M" }, size_bytes: 17_990_911_801, max_context_length: 262144, loaded_instances: [], capabilities: { trained_for_tool_use: true } },
    { type: "llm", key: "google/gemma-4-26b-a4b", display_name: "Gemma 4 26B A4B", size_bytes: 1e10, max_context_length: 262144, loaded_instances: [{ id: "google/gemma-4-26b-a4b", config: { context_length: 4096 } }] },
    { type: "llm", key: "old/no-tools", display_name: "No Tools", loaded_instances: [], capabilities: { trained_for_tool_use: false } },
    { type: "embedding", key: "nomic-embed", loaded_instances: [] },
  ],
};

test("LM Studio: loaded before downloaded, size and quantisation shown, too-small context and no tool training flagged", async () => {
  const f = fake({ "http://localhost:1234/api/v1/models": LMS });
  const r = await new ModelCatalog(f.fn).list(LMSTUDIO, "lmstudio");
  assert.equal(r.source, "live");
  assert.deepEqual(r.models.map((m) => [m.id, m.group]), [
    ["google/gemma-4-26b-a4b", "loaded"], ["old/no-tools", "downloaded"], ["qwen/qwen3.8-27b", "downloaded"],
  ]);
  assert.equal(r.models[2].label, "Qwen3.8 27B · 27B · Q4_K_M · 18.0 GB");
  assert.match(r.models[0].warning ?? "", /4k context/);
  assert.equal(r.models[1].warning, "not trained for tools");
  assert.deepEqual(f.headers[0], { authorization: "Bearer lmstudio" });
});

test("LM Studio: server off, or a token needed, says what to do", async () => {
  const off = await new ModelCatalog(fake({}).fn).list(LMSTUDIO);
  assert.match(off.error ?? "", /LM Studio is not answering at http:\/\/localhost:1234\. Open LM Studio → Developer/);
  const locked = await new ModelCatalog(async () => { throw new Error("HTTP 401 from x"); }).list(LMSTUDIO);
  assert.match(locked.error ?? "", /wants a token/);
});

test("OpenRouter text: free before paid, prices per million, routers and image models skipped, your pinned model kept", async () => {
  const f = fake({ "https://openrouter.ai/api/v1/models": OR_MODELS });
  const r = await new ModelCatalog(f.fn).list(OR_TEXT);
  assert.deepEqual(r.models.map((m) => [m.id, m.group]), [
    ["a/free:free", "free"], ["c/free-notools:free", "free"], ["b/paid-tools", "paid"], ["my/pinned", "saved"],
  ]);
  const paid = r.models.find((m) => m.id === "b/paid-tools")!;
  assert.equal(paid.inputPer1M, 3);
  assert.equal(paid.outputPer1M, 15);
  assert.equal(paid.contextWindow, 200000);
});

test("OpenRouter agentic: only models that take tools", async () => {
  const f = fake({ "https://openrouter.ai/api/v1/models": OR_MODELS });
  const r = await new ModelCatalog(f.fn).list(OR_AGENT);
  assert.deepEqual(r.models.map((m) => m.id), ["a/free:free", "b/paid-tools"]);
});

test("a provider with no list to ask gets your list; a failed fetch says why and falls back", async () => {
  const f = fake({});
  const cat = new ModelCatalog(f.fn);
  const z = await cat.list(ZAI);
  assert.equal(z.source, "saved");
  assert.equal(z.error, undefined);
  assert.deepEqual(z.models.map((m) => m.id), ["glm-5.3"]);
  assert.equal(f.calls.length, 0, "nothing to ask");

  const o = await cat.list(OLLAMA);
  assert.equal(o.source, "saved");
  assert.match(o.error ?? "", /Ollama is not answering at http:\/\/localhost:11434/);
  assert.deepEqual(o.models.map((m) => [m.id, m.installed]), [["qwen3-coder", undefined], ["gpt-oss:20b", undefined]]);
});

test("lists are cached: ten minutes for an answer, thirty seconds for a failure", async () => {
  let now = 0;
  const f = fake({ "https://openrouter.ai/api/v1/models": OR_MODELS });
  const cat = new ModelCatalog(f.fn, () => now);
  await cat.list(OR_TEXT);
  now = 9 * 60_000;
  await cat.list(OR_TEXT);
  assert.equal(f.calls.length, 1);
  now = 11 * 60_000;
  await cat.list(OR_TEXT);
  assert.equal(f.calls.length, 2);

  const down = fake({});
  const cat2 = new ModelCatalog(down.fn, () => now);
  const asked = () => down.calls.filter((u) => u.startsWith("http://localhost")).length;
  await cat2.list(OLLAMA);
  now += 20_000;
  await cat2.list(OLLAMA);
  assert.equal(asked(), 1);
  now += 20_000;
  await cat2.list(OLLAMA);
  assert.equal(asked(), 2);
});

test("a paid model picked from the live list is priced from it, not billed as a $0 subscription", async () => {
  const f = fake({ "https://openrouter.ai/api/v1/models": OR_MODELS });
  const cat = new ModelCatalog(f.fn);
  assert.equal(cat.priceOf(OR_TEXT, "b/paid-tools"), undefined, "priceOf never fetches");
  await cat.list(OR_TEXT);
  const usage = { inputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1_000_000 };
  assert.deepEqual(estimateCost(OR_TEXT, "b/paid-tools", usage, cat.priceOf(OR_TEXT, "b/paid-tools")), { usd: 18, source: "estimated" });
  // Your own price wins over the list.
  assert.deepEqual(estimateCost(OR_TEXT, "my/pinned", usage, { inputPer1M: 1, outputPer1M: 1 }), { usd: 18, source: "estimated" });
  assert.deepEqual(estimateCost(OR_TEXT, "a/free:free", usage, cat.priceOf(OR_TEXT, "a/free:free")), { usd: 0, source: "subscription" });
});
