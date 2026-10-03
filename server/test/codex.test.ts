import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SEED_DEBATE } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { codexPicture, codexUpgrades, criticModel, pictureModel, readLoginStatus, setCodexRunner } from "../src/engine/providers/codexLocal.ts";
import { linkCodexPatch } from "../src/engine/codexLink.ts";
import { generateImage, imageMakerLine, imageReadiness, POLLINATIONS_KEY_REF, type ImageConfig } from "../src/engine/images.ts";
import { buildStagePrompt } from "../src/engine/prompts.ts";
import type { Child, SpawnFn } from "../src/engine/providers/cli/spawn.ts";
import type { Provider, Settings } from "../src/types.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ROWS = [{ id: "gpt-6-luna" }, { id: "gpt-5.6-terra" }, { id: "gpt-5.6-luna" }];

const codexProvider = (over: Partial<Provider> = {}): Provider =>
  ({ id: "codex", label: "Codex · ChatGPT subscription", kind: "cli", enabled: true, authRef: "", models: [], cli: { preset: "codex", auth: "login" }, mayEditFiles: false, ...over }) as Provider;

test("Codex's sign-in is read in its own words: a ChatGPT plan, an API key, or nobody (D296)", () => {
  assert.equal(readLoginStatus(0, "Logged in using ChatGPT\n").signedIn, "chatgpt");
  assert.equal(readLoginStatus(0, "Logged in using an API key - sk-proj-***\n").signedIn, "api-key");
  assert.equal(readLoginStatus(1, "Not logged in\n").signedIn, null);
});

test("linking adds the subscription entry once, moves an untouched critic to the newest Sol at high (else the first listed) and a keyless Pollinations to Codex, and says what it changed (D296, D299, D303)", () => {
  const repo = new Repo(openDb(":memory:"));
  const s = repo.getSettings();
  assert.deepEqual(s.debate, SEED_DEBATE);
  assert.equal(s.imageProvider, "codex", "a new board makes pictures with Codex once it is linked");

  const first = linkCodexPatch(s, ROWS, () => false);
  assert.equal(first.patch.providers?.length, 1);
  assert.equal(first.patch.providers![0].cli?.auth, "login");
  assert.deepEqual(first.patch.debate?.critic, { provider: "codex", model: "gpt-6-luna", effort: "high" }, "no Sol on the account: the first model Codex lists");
  assert.equal(first.patch.imageProvider, undefined, "already Codex");
  assert.equal(first.changed.length, 2);

  const old = { ...s, imageProvider: "pollinations" as const };
  assert.equal(linkCodexPatch(old, ROWS, () => false).patch.imageProvider, "codex", "the old shipped Pollinations, with no key, moves");
  assert.equal(linkCodexPatch(old, ROWS, (n) => n === POLLINATIONS_KEY_REF).patch.imageProvider, undefined, "Pollinations with your key stays");

  const withSol = linkCodexPatch(s, [...ROWS, { id: "gpt-6-sol" }, { id: "gpt-6.1-sol" }], () => false);
  assert.equal(withSol.patch.debate?.critic.model, "gpt-6.1-sol", "the newest Sol when the account has one");

  repo.updateSettings({ ...first.patch });
  const again = linkCodexPatch(repo.getSettings(), ROWS, () => false);
  assert.deepEqual(again.patch, {}, "linking twice changes nothing");

  repo.updateSettings({ debate: { enabled: true, critic: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, mode: "once", rounds: 3 }, imageProvider: "cloudflare" });
  const chosen = linkCodexPatch(repo.getSettings(), ROWS, () => false);
  assert.equal(chosen.patch.debate, undefined, "a critic you chose is left alone");
  assert.equal(chosen.patch.imageProvider, undefined, "a picture maker you chose is left alone");

  assert.equal(criticModel([]), null);
  assert.equal(pictureModel(ROWS), "gpt-6-luna", "pictures default to the newest Luna");
});

test("a newer model of the same family moves Codex picks in Settings, and only those (D298)", () => {
  const s = {
    providers: [codexProvider()],
    debate: { enabled: true, critic: { provider: "codex", model: "gpt-6-luna", effort: "high" as const } },
    tiers: { cheap: { provider: "codex", model: "gpt-5.6-luna" }, balanced: { provider: "anthropic", model: "claude-sonnet-5-5" }, strong: { provider: "anthropic", model: "claude-opus-5-5" } },
    defaultPipeline: [{ stage: "review" as const, model: "gpt-5.6-terra", effort: "medium" as const, provider: "codex" }],
    imageModel: "gpt-6-luna",
  } as Pick<Settings, "debate" | "tiers" | "defaultPipeline" | "imageModel" | "providers">;
  const { moves, patch } = codexUpgrades(s, [{ id: "gpt-6.1-luna" }, { id: "gpt-6-luna" }, { id: "gpt-5.6-terra" }, { id: "gpt-6-terra" }]);
  assert.equal(patch.debate?.critic.model, "gpt-6.1-luna");
  assert.equal(patch.tiers?.cheap.model, "gpt-6.1-luna", "5.6 Luna moves to the newest Luna");
  assert.equal(patch.tiers?.balanced.model, "claude-sonnet-5-5", "a Claude pick is not Codex's to move");
  assert.equal(patch.defaultPipeline?.[0].model, "gpt-6-terra");
  assert.equal(patch.imageModel, "gpt-6.1-luna");
  assert.equal(moves.length, 4);
});

/** A fake `codex exec` that saves a picture where Codex does, under its thread id. */
function codexChild(opts: { home: string; thread: string; save: boolean; said: string }): SpawnFn {
  return () => {
    const listeners: Record<string, ((a: unknown) => void)[]> = {};
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: opts.thread }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: opts.said } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9000, output_tokens: 90 } }),
    ];
    if (opts.save) {
      const dir = join(opts.home, "generated_images", opts.thread);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ig_abc.png"), PNG);
    }
    const child: Child = {
      pid: 1,
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () { for (const l of lines) yield `${l}\n`; })(),
      stderr: (async function* () {})(),
      on: (event, cb) => { (listeners[event] ??= []).push(cb); },
      kill: () => {},
    };
    setTimeout(() => (listeners.close ?? []).forEach((cb) => cb(0)), 5);
    return child;
  };
}

test("a picture by Codex is read from where Codex saves it; a Codex without the image tool says so (D297)", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  setCodexRunner(async () => ({ code: 0, out: "codex-cli 0.159.2" }));
  try {
    const made = await codexPicture({ prompt: "a paper airplane", model: "gpt-6-luna" }, { env: {}, spawnFn: codexChild({ home, thread: "th-1", save: true, said: "Done." }) });
    assert.equal(made.ok, true);
    assert.equal(made.ok && made.format, "png");

    const none = await codexPicture({ prompt: "a paper airplane", model: "gpt-6-luna" }, { env: {}, spawnFn: codexChild({ home, thread: "th-2", save: false, said: "I can’t access a built-in image generation tool in this session." }) });
    assert.deepEqual(none.ok ? null : [none.unavailable, /known Codex limitation/.test(none.reason)], [true, true]);
  } finally {
    setCodexRunner(null);
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});

test("pictures by Codex have no stand-in: when Codex cannot, it says so, remembers it for that version, and runs stop being given the tool (D297, D303)", async () => {
  let fetched = 0;
  const fetchFn = (async () => (fetched++, new Response("", { status: 500 }))) as never;
  const remembered: [boolean, string][] = [];
  const codex = (over: Partial<NonNullable<ImageConfig["codex"]>> = {}): ImageConfig["codex"] => ({
    model: "gpt-6-luna",
    version: "codex-cli 0.159.2",
    pictures: { works: null, version: null, detail: "", checked_at: null },
    make: async () => ({ ok: true, bytes: new Uint8Array(PNG), format: "png" }),
    remember: (works, detail) => remembered.push([works, detail]),
    ...over,
  });
  const cfg = (c: ImageConfig["codex"]): ImageConfig => ({ provider: "codex", pollinationsKey: null, cloudflareAccountId: "", cloudflareToken: null, codex: c });

  const byCodex = await generateImage({ prompt: "x" }, cfg(codex()), { fetchFn, retryAfterMs: 1 });
  assert.deepEqual([byCodex.provider, byCodex.format, remembered.at(-1)?.[0]], ["codex", "png", true]);

  await assert.rejects(generateImage({ prompt: "x" }, cfg(codex({ make: async () => ({ ok: false, unavailable: true, reason: "No image tool here." }) })), { fetchFn, retryAfterMs: 1 }), /No image tool here/);
  assert.equal(remembered.at(-1)?.[0], false);

  let asked = 0;
  const knownCannot = codex({ pictures: { works: false, version: "codex-cli 0.159.2", detail: "Codex cannot here.", checked_at: "t" }, make: async () => (asked++, { ok: true, bytes: new Uint8Array(PNG), format: "png" }) });
  await assert.rejects(generateImage({ prompt: "x" }, cfg(knownCannot), { fetchFn, retryAfterMs: 1 }), /Codex cannot here/);
  assert.equal(asked, 0, "the same Codex is not asked again");
  assert.equal(imageReadiness(cfg(knownCannot)).ready, false, "so runs are not given the tool");
  const newer = codex({ version: "codex-cli 0.160.0", pictures: { works: false, version: "codex-cli 0.159.2", detail: "", checked_at: "t" }, make: async () => (asked++, { ok: true, bytes: new Uint8Array(PNG), format: "png" }) });
  assert.equal(imageReadiness(cfg(newer)).ready, true);
  await generateImage({ prompt: "x" }, cfg(newer), { fetchFn, retryAfterMs: 1 });
  assert.equal(asked, 1, "a newer Codex is tried again");

  await assert.rejects(generateImage({ prompt: "x" }, cfg(null), { fetchFn, retryAfterMs: 1 }), /Setup → Codex/);
  assert.equal(imageReadiness(cfg(null)).ready, false, "Codex not linked: no picture tool");
  assert.equal(fetched, 0, "no other service is ever asked instead");
});

test("the Images section says who makes the pictures; a Codex stage is told to use its own image tool (D297)", () => {
  const ctx = (over: Record<string, unknown>) =>
    ({ stage: "code", mode: "autonomous", task: { id: "t", title: "Hero", spec_md: "x" }, branch: null, parent: null, siblings: [], previousResult: null, skills: [], messages: [], imageTool: true, ...over }) as never;
  const line = imageMakerLine({ imageProvider: "codex" });
  assert.match(buildStagePrompt(ctx({ imageMaker: line })), /## Images[\s\S]*Codex on your ChatGPT plan/);
  assert.doesNotMatch(buildStagePrompt(ctx({ imageTool: false })), /## Images|picture/, "no maker ready: nothing about pictures at all");
  const cli = buildStagePrompt(ctx({ capabilities: "cli" }));
  assert.match(cli, /## Images\nWhen the task needs a picture, make it with your own image generation tool/);
  assert.doesNotMatch(cli, /generate_image/, "another agent has no board tools");
});
