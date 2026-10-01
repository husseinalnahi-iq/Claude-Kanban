import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { buildApp } from "../src/app.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { SecretStore } from "../src/secrets.ts";
import { serverRule } from "../src/engine/gate.ts";
import { buildStagePrompt } from "../src/engine/prompts.ts";
import {
  CLOUDFLARE_MODEL, claudeCodeArgs, claudeCodeCommand, CLOUDFLARE_TOKEN_REF, IMAGE_PREFIX, IMAGE_TOOL, POLLINATIONS_KEY_REF, POLLINATIONS_URL,
  generateImage, imageHandlers, imagePath, imageReadiness, slug, type FetchFn, type ImageConfig,
} from "../src/engine/images.ts";
import { handle } from "../src/imageMcp.ts";
import type { Mode, Stage } from "../src/types.ts";
import { until } from "./helpers.ts";
import { setCodexRunner } from "../src/engine/providers/codexLocal.ts";

// Settings → Images asks after Codex; these tests answer for it instead of the Codex on this computer.
setCodexRunner(async () => ({ code: 1, out: "" }));

/** A tiny valid JPEG header is enough: the code never decodes the picture. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

type Call = { url: string; init: Parameters<FetchFn>[1] };

/** A provider that answers each call from a script, recording what it was asked. */
function fakeFetch(script: ((call: Call, index: number) => Response)[]) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return step(call, calls.length - 1);
  };
  return { fn, calls };
}

const image = (type = "image/jpeg") => new Response(JPEG, { status: 200, headers: { "content-type": type } });
/** Every call in these tests goes through a fake provider, and a retry waits a millisecond, not sixteen seconds. */
const gen = (req: Parameters<typeof generateImage>[0], c: ImageConfig, fn: FetchFn) => generateImage(req, c, { fetchFn: fn, retryAfterMs: 1 });
const cfg = (over: Partial<ImageConfig> = {}): ImageConfig => ({ provider: "pollinations", pollinationsKey: null, cloudflareAccountId: "", cloudflareToken: null, ...over });

test("Pollinations is asked for a private flux image of the given size, with no key and no watermark removal by default", async () => {
  const f = fakeFetch([() => image()]);
  const out = await gen({ prompt: "a red bicycle, studio photo", width: 800, height: 600, seed: 7 }, cfg(), f.fn);
  assert.equal(out.provider, "pollinations");
  assert.equal(out.format, "jpeg");
  assert.equal(out.bytes.length, JPEG.length);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin, POLLINATIONS_URL);
  assert.equal(decodeURIComponent(u.pathname), "/prompt/a red bicycle, studio photo");
  assert.equal(u.searchParams.get("model"), "flux");
  assert.equal(u.searchParams.get("width"), "800");
  assert.equal(u.searchParams.get("height"), "600");
  assert.equal(u.searchParams.get("seed"), "7");
  assert.equal(u.searchParams.get("private"), "true", "a task's prompt can describe an unreleased product: off the public feed");
  assert.equal(u.searchParams.get("nologo"), null, "nologo needs a key; without one it is not asked for");
  assert.equal(f.calls[0].init.headers?.authorization, undefined);
});

test("a free Pollinations key goes in the Authorization header and asks for no watermark", async () => {
  const f = fakeFetch([() => image("image/png")]);
  const out = await gen({ prompt: "icon" }, cfg({ pollinationsKey: "sk_test" }), f.fn);
  assert.equal(out.format, "png", "the file gets the extension of what came back");
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get("nologo"), "true");
  assert.equal(u.searchParams.get("width"), "1024", "default size");
  assert.equal(f.calls[0].init.headers?.authorization, "Bearer sk_test");
});

test("sizes are clamped to what the models accept and rounded to a multiple of 8", async () => {
  const f = fakeFetch([() => image()]);
  await gen({ prompt: "x", width: 5000, height: 13 }, cfg(), f.fn);
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get("width"), "2048");
  assert.equal(u.searchParams.get("height"), "64");
});

test("a rate-limited Pollinations call is retried once, then explained in plain words", async () => {
  const f = fakeFetch([() => new Response("slow down", { status: 429 }), () => image()]);
  const ok = await gen({ prompt: "x" }, cfg(), f.fn);
  assert.equal(ok.bytes.length, JPEG.length);
  assert.equal(f.calls.length, 2, "one retry");

  const busy = fakeFetch([() => new Response("slow down", { status: 429 })]);
  await assert.rejects(gen({ prompt: "x" }, cfg(), busy.fn), /one image every 15 seconds/);
  assert.equal(busy.calls.length, 2, "never more than one retry");
});

test("a Pollinations 402 is explained: it needs a key, or the key's allowance is used up (D303)", async () => {
  const turned = fakeFetch([() => Response.json({}, { status: 402 })]);
  await assert.rejects(gen({ prompt: "x" }, cfg(), turned.fn), /needs your key from enter\.pollinations\.ai/);
  await assert.rejects(gen({ prompt: "x" }, cfg({ pollinationsKey: "sk" }), turned.fn), /allowance may be used up/);
  assert.equal(turned.calls.length, 2, "a 402 is not retried");
});

test("a Pollinations answer that is not an image is refused rather than saved", async () => {
  const f = fakeFetch([() => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } })]);
  await assert.rejects(gen({ prompt: "x" }, cfg(), f.fn), /text\/html instead of an image/);
});

test("Cloudflare gets a POST to the account's FLUX.1 schnell model with the token, and its base64 answer becomes a JPEG", async () => {
  const f = fakeFetch([() => Response.json({ success: true, result: { image: JPEG.toString("base64") } })]);
  const c = cfg({ provider: "cloudflare", cloudflareAccountId: "abc123", cloudflareToken: "cf-tok" });
  const out = await gen({ prompt: "a lighthouse", seed: 3 }, c, f.fn);
  assert.equal(out.provider, "cloudflare");
  assert.equal(out.format, "jpeg");
  assert.deepEqual(Buffer.from(out.bytes), JPEG);
  const call = f.calls[0];
  assert.equal(call.url, `https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/${CLOUDFLARE_MODEL}`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers?.authorization, "Bearer cf-tok");
  assert.deepEqual(JSON.parse(call.init.body!), { prompt: "a lighthouse", steps: 4, seed: 3 });
});

test("Cloudflare's errors name the fix: a bad token, a used-up allowance, or missing settings", async () => {
  const c = cfg({ provider: "cloudflare", cloudflareAccountId: "abc123", cloudflareToken: "bad" });
  const denied = fakeFetch([() => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 401 })]);
  await assert.rejects(gen({ prompt: "x" }, c, denied.fn), /refused the API token.*Workers AI.*Authentication error/s);
  const spent = fakeFetch([() => Response.json({ success: false, errors: [{ message: "quota" }] }, { status: 429 })]);
  await assert.rejects(gen({ prompt: "x" }, c, spent.fn), /daily allowance is used up.*midnight UTC/s);
  const unwrapped = fakeFetch([() => Response.json({ image: JPEG.toString("base64") })]);
  assert.equal((await gen({ prompt: "x" }, c, unwrapped.fn)).format, "jpeg", "the docs' unwrapped shape is accepted too");
  await assert.rejects(gen({ prompt: "x" }, cfg({ provider: "cloudflare" }), fakeFetch([]).fn), /account id and an API token/);
  await assert.rejects(gen({ prompt: "x" }, cfg({ provider: "off" }), fakeFetch([]).fn), /switched off/);
  await assert.rejects(gen({ prompt: "   " }, cfg(), fakeFetch([]).fn), /what the image should show/);
});

test("readiness says in plain words what would happen, and only a maker on your own account is ready (D303)", () => {
  assert.equal(imageReadiness(cfg()).ready, false, "Pollinations without a key turns requests away");
  assert.match(imageReadiness(cfg()).detail, /needs your key/);
  assert.equal(imageReadiness(cfg({ pollinationsKey: "sk" })).ready, true);
  assert.equal(imageReadiness(cfg({ provider: "codex", codex: null })).ready, false, "Codex not linked");
  assert.equal(imageReadiness(cfg({ provider: "cloudflare" })).ready, false);
  assert.equal(imageReadiness(cfg({ provider: "cloudflare", cloudflareAccountId: "a", cloudflareToken: "t" })).ready, true);
  assert.equal(imageReadiness(cfg({ provider: "off" })).ready, false);
});

test("an image is saved inside the project, under a name from its prompt, and never over an existing file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "kimg-"));
  try {
    assert.equal(slug("A Red Bicycle, studio photo!!"), "a-red-bicycle-studio-photo");
    assert.equal(slug("!!!"), "image");
    const first = imagePath(cwd, undefined, "A Red Bicycle", "jpeg");
    assert.equal(first, join(cwd, "generated-images", "a-red-bicycle.jpg"));
    mkdirSync(join(cwd, "generated-images"), { recursive: true });
    writeFileSync(first, "taken");
    assert.equal(imagePath(cwd, undefined, "A Red Bicycle", "jpeg"), join(cwd, "generated-images", "a-red-bicycle-2.jpg"));

    assert.equal(imagePath(cwd, "public/hero.png", "x", "jpeg"), join(cwd, "public", "hero.jpg"), "the extension follows what came back");
    assert.equal(imagePath(cwd, "public/hero", "x", "png"), join(cwd, "public", "hero.png"));
    assert.equal(imagePath(cwd, join(cwd, "a.jpg"), "x", "jpeg"), join(cwd, "a.jpg"), "an absolute path inside the project is fine");
    assert.throws(() => imagePath(cwd, "../outside.jpg", "x", "jpeg"), /inside the project/);
    assert.throws(() => imagePath(cwd, join(tmpdir(), "elsewhere.jpg"), "x", "jpeg"), /inside the project/);
    assert.throws(() => imagePath(cwd, ".", "x", "jpeg"), /inside the project/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the tool writes the file, reports its path relative to the project, and tells the board", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "kimg-"));
  try {
    const f = fakeFetch([() => image()]);
    const kept: { path: string; prompt: string; provider: string; bytes: number }[] = [];
    const h = imageHandlers({ cwd, config: () => cfg({ pollinationsKey: "sk" }), fetchFn: f.fn, onImage: (i) => kept.push(i) });
    const res = await h.generate({ prompt: "a lighthouse at dusk", file: "assets/hero.jpg" });
    assert.equal((res as { isError?: boolean }).isError, undefined);
    assert.match(res.content[0].text, /^Saved assets\/hero\.jpg \(0 KB, jpeg, made by Pollinations\.ai\)/);
    assert.deepEqual(readFileSync(join(cwd, "assets", "hero.jpg")), JPEG);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].path, join(cwd, "assets", "hero.jpg"));
    assert.equal(kept[0].provider, "pollinations");

    const outside = await h.generate({ prompt: "x", file: "../escape.jpg" });
    assert.equal((outside as { isError?: boolean }).isError, true);
    assert.match(outside.content[0].text, /inside the project/);
    assert.equal(existsSync(join(cwd, "..", "escape.jpg")), false);

    const off = await h.generate({ prompt: "x" });
    assert.equal(f.calls.length, 2);
    assert.equal((off as { isError?: boolean }).isError, undefined, "a second call for the same prompt is a new file");

    const none = await imageHandlers({ cwd, config: () => cfg(), fetchFn: f.fn }).generate({ prompt: "x" });
    assert.equal((none as { isError?: boolean }).isError, true);
    assert.match(none.content[0].text, /needs your key[\s\S]*Carry on without it/, "no maker ready: says so, asks nobody");
    assert.equal(f.calls.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the board

const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimgrepo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** Runs one stage with a fake session and returns what it was started with. */
async function stageFor(mode: Mode, settings: Record<string, unknown>, probe?: (o: Options, repo: Repo, taskId: string) => Promise<void>, keyed = true) {
  const dir = gitRepo();
  const seen: { prompt: string; options: Options }[] = [];
  const q: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      seen.push({ prompt, options: params.options });
      yield { type: "system", subtype: "init", session_id: "s1" } as never;
      await probe?.(params.options, repo, task.id);
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as never;
    })();
  const repo = new Repo(openDb(":memory:"));
  repo.setStateDir(mkdtempSync(join(tmpdir(), "kimgstate-")));
  repo.updateSettings(settings as never);
  // A maker on your own account: Pollinations with a key, unless a test says otherwise.
  const secrets = new SecretStore(":memory:");
  if (keyed) secrets.set(POLLINATIONS_KEY_REF, "sk_test");
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q, secrets });
  const project = repo.createProject({ name: "demo", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 3 } });
  const task = repo.createTask({ project_id: project.id, title: "hero image", mode, pipeline: ONE_STAGE });
  try {
    runner.queueTask(task.id);
    await until(() => ["review", "failed"].includes(repo.getTask(task.id)!.status));
    assert.equal(repo.getTask(task.id)!.error, null);
    return { ...seen[0], repo, task };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a run gets the images server and is told about it only when a picture maker is ready (D303)", async () => {
  const on = await stageFor("autonomous", { imageProvider: "pollinations" });
  assert.ok(on.options.mcpServers?.images, "the tool is there");
  assert.match(on.prompt, /## Images[\s\S]*`generate_image`/);
  assert.doesNotMatch(on.prompt, /approved on a card/, "nobody is watching an autonomous run");

  const off = await stageFor("autonomous", { imageProvider: "off" });
  assert.equal(off.options.mcpServers?.images, undefined);
  assert.doesNotMatch(off.prompt, /## Images/);

  const supervised = await stageFor("supervised", { imageProvider: "pollinations" });
  assert.match(supervised.prompt, /approved on a card/);

  const keyless = await stageFor("autonomous", { imageProvider: "pollinations" }, undefined, false);
  assert.equal(keyless.options.mcpServers?.images, undefined, "Pollinations without a key: no tool");
  assert.doesNotMatch(keyless.prompt, /## Images|generate_image/, "and nothing about pictures in the prompt");

  const unlinked = await stageFor("autonomous", { imageProvider: "codex" });
  assert.equal(unlinked.options.mcpServers?.images, undefined, "Codex not on the board: no tool");
  assert.doesNotMatch(unlinked.prompt, /## Images/);
});

test("a board still on keyless Pollinations moves to Codex-when-linked at start; one with a key keeps it (D303)", () => {
  for (const keyed of [false, true]) {
    const repo = new Repo(openDb(":memory:"));
    repo.updateSettings({ imageProvider: "pollinations" });
    const secrets = new SecretStore(":memory:");
    if (keyed) secrets.set(POLLINATIONS_KEY_REF, "sk");
    new TaskRunner({ repo, bus: new Bus(), queryFn: (() => (async function* () {})()) as QueryFn, secrets }).recover();
    assert.equal(repo.getSettings().imageProvider, keyed ? "pollinations" : "codex");
  }
});

test("an autonomous run may make an image without asking; a supervised one gets a card", async () => {
  const opts = { signal: new AbortController().signal, toolUseID: "t" } as never;
  let free = "none";
  await stageFor("autonomous", { imageProvider: "pollinations" }, async (o) => {
    free = (await o.canUseTool!(IMAGE_TOOL, { prompt: "a hero image" }, opts))?.behavior ?? "none";
  });
  assert.equal(free, "allow");

  let card = "";
  await stageFor("supervised", { imageProvider: "pollinations" }, async (o, repo, taskId) => {
    // The stage finishing expires the card, which is all this needs.
    void o.canUseTool!(IMAGE_TOOL, { prompt: "a hero image" }, opts);
    await until(() => repo.pendingApprovals(taskId).length === 1);
    card = repo.pendingApprovals(taskId)[0].tool_name;
  });
  assert.equal(card, IMAGE_TOOL);
  assert.match(serverRule(IMAGE_PREFIX), /image generation/i);
});

test("an autonomous run may make a picture through the board's guard too, not only canUseTool (D297)", async () => {
  let decision: unknown = "not asked";
  await stageFor("autonomous", { imageProvider: "pollinations" }, async (o) => {
    const matchers = (o.hooks?.PreToolUse ?? []) as { hooks: ((input: unknown, id: string, x: { signal: AbortSignal }) => Promise<unknown>)[] }[];
    const answers = [];
    for (const m of matchers) for (const h of m.hooks) answers.push(await h({ hook_event_name: "PreToolUse", tool_name: IMAGE_TOOL, tool_input: { prompt: "a hero image" } }, "t1", { signal: new AbortController().signal }));
    assert.ok(answers.length, "the guard hooks were asked");
    decision = answers.find((a) => (a as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput?.permissionDecision === "deny") ?? "allowed";
  });
  assert.equal(decision, "allowed", "the gate used to refuse it as an outside tool");
});

test("Settings → Images: keys are written and removed without ever being read back, and Try it makes a picture", async () => {
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const secrets = new SecretStore(":memory:");
  const f = fakeFetch([() => image()]);
  const runner = new TaskRunner({ repo, bus, queryFn: (() => (async function* () {})()) as QueryFn, secrets, imageFetch: f.fn });
  const app = await buildApp({ repo, bus, runner, allowedHosts: ["localhost:80"] });
  try {
    const status = async () => (await app.inject({ method: "GET", url: "/api/settings/images" })).json();
    let s = await status();
    assert.equal(s.provider, "codex");
    assert.equal(s.ready, false, "Codex is not on the board");
    assert.match(s.detail, /Setup → Codex/);
    assert.equal(s.hasPollinationsKey, false);
    const early = (await app.inject({ method: "POST", url: "/api/settings/images/test", payload: {} })).json();
    assert.deepEqual([early.ok, f.calls.length], [false, 0], "Try it with no maker ready asks nobody");
    assert.equal(s.hasCloudflareToken, false);

    const put = await app.inject({ method: "PUT", url: "/api/settings/images/secret", payload: { name: POLLINATIONS_KEY_REF, value: " sk_abc " } });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().hasPollinationsKey, true);
    assert.equal(secrets.get(POLLINATIONS_KEY_REF), "sk_abc", "trimmed, stored under its name");
    assert.equal(JSON.stringify(put.json()).includes("sk_abc"), false, "the value never travels back");
    assert.equal(JSON.stringify((await app.inject({ method: "GET", url: "/api/settings" })).json()).includes("sk_abc"), false);

    const bad = await app.inject({ method: "PUT", url: "/api/settings/images/secret", payload: { name: "ANTHROPIC_API_KEY", value: "x" } });
    assert.equal(bad.statusCode, 400, "only the two image keys can be stored here");

    const patched = await app.inject({ method: "PATCH", url: "/api/settings", payload: { imageProvider: "cloudflare", cloudflareAccountId: "abc123" } });
    assert.equal(patched.statusCode, 200);
    s = await status();
    assert.equal(s.provider, "cloudflare");
    assert.equal(s.ready, false, "no token yet");
    assert.match(s.detail, /API token/);
    await app.inject({ method: "PUT", url: "/api/settings/images/secret", payload: { name: CLOUDFLARE_TOKEN_REF, value: "cf" } });
    assert.equal((await status()).ready, true);
    const badId = await app.inject({ method: "PATCH", url: "/api/settings", payload: { cloudflareAccountId: "../x" } });
    assert.equal(badId.statusCode, 400);

    const del = await app.inject({ method: "DELETE", url: `/api/settings/images/secret/${CLOUDFLARE_TOKEN_REF}` });
    assert.equal(del.json().hasCloudflareToken, false);
    assert.equal(secrets.has(CLOUDFLARE_TOKEN_REF), false);

    await app.inject({ method: "PATCH", url: "/api/settings", payload: { imageProvider: "pollinations" } });
    const tried = (await app.inject({ method: "POST", url: "/api/settings/images/test", payload: {} })).json();
    assert.equal(tried.ok, true, tried.error);
    assert.equal(tried.provider, "pollinations");
    assert.match(tried.dataUrl, /^data:image\/jpeg;base64,/);
    const u = new URL(f.calls[0].url);
    assert.equal(u.searchParams.get("width"), "512", "a small one: it is only a check");
    assert.equal(f.calls[0].init.headers?.authorization, "Bearer sk_abc", "the stored key is used");
  } finally {
    await app.close();
  }
});

test("the stdio entry for your own Claude Code speaks MCP: initialize, tools/list, tools/call, and refuses what it does not know", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.deepEqual(init?.result, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "images", version: "1.0.0" } });
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined, "a notification gets no answer");

  const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))?.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[] };
  assert.equal(list.tools.length, 1);
  assert.equal(list.tools[0].name, "generate_image");
  assert.deepEqual(Object.keys(list.tools[0].inputSchema.properties).sort(), ["file", "height", "prompt", "seed", "width"]);
  assert.deepEqual(list.tools[0].inputSchema.required, ["prompt"]);

  const made: unknown[] = [];
  const call = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "generate_image", arguments: { prompt: "a leaf", width: 256 } } }, async (a) => {
    made.push(a);
    return { content: [{ type: "text", text: "Saved generated-images/a-leaf.jpg" }] };
  });
  assert.deepEqual(made, [{ prompt: "a leaf", width: 256 }]);
  assert.match(JSON.stringify(call?.result), /Saved generated-images/);

  const bad = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "generate_image", arguments: { width: 10 } } }, async () => assert.fail("never called"));
  assert.match(JSON.stringify(bad?.result), /Bad arguments: prompt/);
  assert.equal((bad?.result as { isError: boolean }).isError, true);

  assert.equal((await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "other" } }))?.error?.code, -32602);
  assert.equal((await handle({ jsonrpc: "2.0", id: 6, method: "resources/list" }))?.error?.code, -32601);
  assert.deepEqual((await handle({ jsonrpc: "2.0", id: 7, method: "ping" }))?.result, {});
});

test("the one line that adds the tool to your own Claude Code points at the board's own tsx and entry, quoted for a folder with spaces", () => {
  const cmd = claudeCodeCommand(join("C:\\Users\\me", "Claude Kanban"));
  assert.ok(cmd.startsWith("claude mcp add --scope user images -- node "), cmd);
  assert.match(cmd, /"[^"]*Claude Kanban[^"]*node_modules[^"]*tsx[^"]*cli\.mjs" "[^"]*Claude Kanban[^"]*server[^"]*imageMcp\.ts"$/);
  const args = claudeCodeArgs();
  assert.deepEqual(args.slice(0, 7), ["mcp", "add", "--scope", "user", "images", "--", "node"], "the one-click Setup fix runs exactly these after `claude`");
  assert.ok(existsSync(args[7]) && existsSync(args[8]), "the tsx launcher and the entry it names exist in this checkout");
});
