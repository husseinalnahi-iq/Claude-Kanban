import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { browserCaption, liveConfig } from "../src/engine/browser.ts";
import { BrowserWatch, frameThrottle, type LiveMeta } from "../src/engine/browserWatch.ts";

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the live-view browser is the same headless, in-memory one, plus a debugging port for the board", () => {
  const c = liveConfig("msedge", 9444, "/tmp/out");
  assert.equal(c.browser.isolated, true);
  assert.equal(c.browser.launchOptions.headless, true, "never a window over your work");
  assert.equal(c.browser.launchOptions.channel, "msedge");
  assert.deepEqual(c.browser.launchOptions.args, ["--remote-debugging-port=9444"]);
  assert.equal(c.outputDir, "/tmp/out");
  assert.equal("channel" in liveConfig("chromium", 1, "/x").browser.launchOptions, false, "Playwright's own Chromium needs no channel");
});

test("captions say what the task is doing in the browser", () => {
  assert.equal(browserCaption("mcp__playwright__browser_click", { element: "Add to cart button", ref: "e3" }), "clicking “Add to cart button”");
  assert.equal(browserCaption("mcp__playwright__browser_navigate", { url: "http://localhost:5173/" }), "opening http://localhost:5173/");
  assert.equal(browserCaption("Read", {}), null, "not a browser tool");
});

test("frames are paced, and a late frame is replaced by a newer one rather than queued", async () => {
  let now = 0;
  const sent: number[] = [];
  const t = frameThrottle<number>(200, (v) => sent.push(v), () => now);
  t.push(1);
  now = 50;
  t.push(2);
  t.push(3); // replaces 2
  assert.deepEqual(sent, [1]);
  now = 200;
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(sent, [1, 3], "only the newest held frame is sent");
  t.cancel();
});

/** A stand-in browser: /json/list names one page; its socket answers screencast calls with a frame. */
async function fakeBrowser() {
  const calls: string[] = [];
  const jpeg = Buffer.from("fake-jpeg-bytes").toString("base64");
  const http = createServer((req, res) => {
    const port = (http.address() as { port: number }).port;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ id: "P1", type: "page", url: "http://localhost:5173/cart", title: "Cart", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/P1` }]));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      calls.push(m.method);
      if (m.method === "Page.captureScreenshot") ws.send(JSON.stringify({ id: m.id, result: { data: jpeg } }));
      if (m.method === "Page.startScreencast") ws.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: jpeg, sessionId: 7 } }));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  return { port: (http.address() as { port: number }).port, calls, close: () => (wss.close(), http.close()) };
}

test("a watched task streams its page, only while someone watches, and keeps the last picture after the run", async () => {
  const b = await fakeBrowser();
  const published: unknown[] = [];
  const watch = new BrowserWatch({ publish: (m: unknown) => published.push(m) } as never);
  try {
    watch.begin("t1", "r1", b.port);
    const frames: Buffer[] = [];
    const metas: LiveMeta[] = [];
    const v = watch.watch("t1", (f) => frames.push(f), (m) => metas.push(m));
    await until(() => frames.length > 0);
    assert.equal(frames[0].toString(), "fake-jpeg-bytes");
    assert.ok(b.calls.includes("Page.startScreencast"), "screencasting started for the viewer");
    assert.ok(b.calls.includes("Page.screencastFrameAck"), "every frame is acknowledged, or Chrome stops sending");
    const live = metas.at(-1)!;
    assert.equal(live.live, true);
    assert.equal(live.url, "http://localhost:5173/cart");
    assert.deepEqual(watch.liveTasks(), ["t1"]);
    assert.ok(published.some((m: any) => m.type === "browser.live" && m.live), "the board hears it went live");

    watch.action("t1", "clicking “Pay”");
    assert.equal(watch.status("t1")!.action, "clicking “Pay”");

    v.unwatch();
    await until(() => b.calls.includes("Page.stopScreencast"));

    watch.end("t1", "r1");
    const after = watch.status("t1")!;
    assert.equal(after.live, false);
    assert.equal(after.hasFrame, true, "the last picture stays");
    const later = watch.watch("t1", () => {}, () => {});
    assert.equal(later.frame?.toString(), "fake-jpeg-bytes", "a viewer who opens the card later still sees it");
    later.unwatch();
  } finally {
    watch.stopAll();
    b.close();
  }
});

test("the view follows the task's page, not an extension's welcome tab", async () => {
  const { pickPage } = await import("../src/engine/browserWatch.ts");
  const P = (id: string, url: string) => ({ id, type: "page", url, title: id, webSocketDebuggerUrl: `ws://x/${id}` });
  const pages = [P("ext", "https://vault.example.com/browser-start/"), P("app", "http://localhost:5173/cart"), P("other", "https://docs.example.org/")];
  assert.equal(pickPage(pages, null)!.id, "app", "a local page beats a tab something else opened");
  assert.equal(pickPage(pages, "https://docs.example.org/guide")!.id, "other", "where the task navigated wins");
  assert.equal(pickPage([P("only", "https://a.example/")], null)!.id, "only");
  assert.equal(pickPage([{ ...P("bg", "chrome-extension://abc/bg.html") }], null), undefined, "an extension page is never shown");
});
