import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { judge, localModelsStatus, resetHardwareCache } from "../src/setup/local.ts";
import type { Probe } from "../src/setup/probe.ts";
import type { Provider } from "../src/types.ts";

test("model picks are judged against this machine: fits the graphics card, runs from RAM, slow, or too big", () => {
  const laptop = judge({ gpu: "RTX 4070 Laptop", vramGB: 8, ramGB: 32, diskFreeGB: 36, unified: false });
  assert.deepEqual(laptop.budget, { fastGB: 6, okGB: 23 });
  const v = Object.fromEntries(laptop.picks.map((p) => [p.name, p.verdict]));
  assert.equal(v["Gemma 4 12B"], "ok", "a dense model a little bigger than the card spills a little");
  assert.equal(v["Qwen3.6 35B A3B"], "ok", "mixture-of-experts spills into RAM and stays usable");
  assert.equal(v["Qwen3.8 27B"], "slow", "a dense model much bigger than the card crawls");

  const desktop = judge({ gpu: "RTX 4090", vramGB: 24, ramGB: 64, diskFreeGB: 500, unified: false });
  assert.equal(desktop.picks.find((p) => p.name === "Qwen3.8 27B")!.verdict, "fast", "a strong PC runs the big one");

  const small = judge({ gpu: null, vramGB: null, ramGB: 8, diskFreeGB: 10, unified: false });
  assert.equal(small.budget.fastGB, null);
  assert.equal(small.picks.find((p) => p.name === "Qwen3.6 35B A3B")!.verdict, "too-big");
});

function probe(json: Record<string, unknown>, cmds: Record<string, string> = {}, files: string[] = []): Probe {
  return {
    platform: "win32", env: { LOCALAPPDATA: "L" }, claudeBin: "claude",
    run: async (c, a) => {
      const k = [c, ...a].join(" ");
      const hit = Object.entries(cmds).find(([p]) => k.startsWith(p));
      return hit ? { code: 0, stdout: hit[1], stderr: "" } : { code: null, stdout: "", stderr: "not found" };
    },
    stream: async () => 0,
    exists: (p) => files.some((f) => p.endsWith(f)),
    list: () => [],
    fetchJson: async (u) => {
      if (u in json) {
        const v = json[u];
        if (v instanceof Error) throw v;
        return v;
      }
      throw new Error("ECONNREFUSED");
    },
    refreshPath: async () => {},
  };
}

test("status: graphics card from nvidia-smi, LM Studio running with a model loaded, Ollama installed but off", async () => {
  resetHardwareCache();
  const repo = new Repo(openDb(":memory:"));
  repo.updateSettings({
    providers: [{ id: "lmstudio", label: "LM Studio", kind: "anthropic-compatible", enabled: true, baseUrl: "http://localhost:1234", authRef: "LM_API_TOKEN", models: [], mayEditFiles: true } as Provider],
  });
  const p = probe(
    {
      "http://localhost:1234/api/v1/models": {
        models: [
          { type: "llm", key: "qwen/qwen3.5-9b", loaded_instances: [{ id: "qwen/qwen3.5-9b", config: { context_length: 4096 } }] },
          { type: "embedding", key: "nomic", loaded_instances: [] },
        ],
      },
    },
    { "nvidia-smi": "NVIDIA GeForce RTX 4070 Laptop GPU, 8188\n", "ollama --version": "ollama version is 0.34.0" },
  );
  const s = await localModelsStatus(p, repo.getSettings());
  assert.equal(s.hardware.gpu, "NVIDIA GeForce RTX 4070 Laptop GPU");
  assert.equal(s.hardware.vramGB, 8);
  assert.deepEqual(s.lmstudio.models, [{ id: "qwen/qwen3.5-9b", loaded: true, contextLength: 4096 }]);
  assert.equal(s.lmstudio.running && s.lmstudio.installed && s.lmstudio.added, true);
  assert.equal(s.ollama.running, false);
  assert.equal(s.ollama.installed, true, "found by its command even while the app is closed");
  assert.equal(s.ollama.added, false);
  assert.equal(s.minContext, 32000);
});

test("status: LM Studio asking for a token counts as running; nothing installed says so", async () => {
  resetHardwareCache();
  const repo = new Repo(openDb(":memory:"));
  const locked = await localModelsStatus(probe({ "http://localhost:1234/api/v1/models": new Error("HTTP 401") }), repo.getSettings());
  assert.equal(locked.lmstudio.running, true);
  assert.equal(locked.lmstudio.locked, true);
  resetHardwareCache();
  const none = await localModelsStatus(probe({}), repo.getSettings());
  assert.equal(none.lmstudio.installed, false);
  assert.equal(none.ollama.installed, false);
  assert.equal(none.hardware.vramGB, null);
});
