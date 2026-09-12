import type { Bus } from "../bus.ts";

export interface LiveMeta {
  /** A page is open and being watched right now. */
  live: boolean;
  url: string | null;
  title: string | null;
  /** What the task last did in the browser, in words ("clicking “Add to cart”"). */
  action: string | null;
  /** A picture exists (the last one stays after the run ends). */
  hasFrame: boolean;
}

type FrameFn = (jpeg: Buffer) => void;

type PageInfo = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string };

const origin = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === "file:" ? "file:" : x.origin;
  } catch {
    return "";
  }
};
const isLocalPage = (u: string) => /^(file:|https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$))/i.test(u);

/**
 * Which open page is the task's: the one on the site it last navigated to; else a local page (what
 * it checks); else the most recently used. An extension's welcome tab (seen: a password manager a
 * company policy installs in every new profile) must not steal the view.
 */
export function pickPage(pages: PageInfo[], target: string | null): PageInfo | undefined {
  const real = pages.filter((p) => p.type === "page" && p.webSocketDebuggerUrl && !p.url.startsWith("chrome-extension:"));
  return (target ? real.find((p) => origin(p.url) === origin(target)) : undefined) ?? real.find((p) => isLocalPage(p.url)) ?? real[0];
}
type MetaFn = (meta: LiveMeta) => void;

/**
 * At most one frame per `intervalMs`, and never a stale one: a frame that arrives too soon is held,
 * and replaced by any newer one, until its slot comes. Pure apart from the timer, so it is tested.
 */
export function frameThrottle<T>(intervalMs: number, send: (v: T) => void, now: () => number = Date.now) {
  let last = -Infinity; // no frame sent yet: the first goes straight out
  let held: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (held === null) return;
    const v = held;
    held = null;
    last = now();
    send(v);
  };
  return {
    push(v: T) {
      const wait = last + intervalMs - now();
      if (wait <= 0 && !timer) {
        last = now();
        send(v);
        return;
      }
      held = v;
      timer ??= setTimeout(flush, Math.max(0, wait));
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      held = null;
    },
  };
}

interface Watch {
  taskId: string;
  runId: string;
  port: number;
  ended: boolean;
  pageId: string | null;
  ws: WebSocket | null;
  msgId: number;
  casting: boolean;
  poll: ReturnType<typeof setInterval> | null;
  meta: LiveMeta;
  frame: Buffer | null;
  frames: Set<FrameFn>;
  metas: Set<MetaFn>;
  throttle: ReturnType<typeof frameThrottle<Buffer>>;
  /** Where the task last told its browser to go, so the view follows that page. */
  target: string | null;
}

const FPS_INTERVAL = 200; // about 5 frames a second: smooth enough to follow, light on the CPU

/**
 * The live view of a task's browser. The board's Playwright browser is launched with a debugging port
 * (browser.ts liveConfig); this connects to it over the Chrome DevTools Protocol, follows the page the
 * task is on, and streams screencast frames — only while someone is watching. The last picture and
 * where it was stay after the run, so a finished task still shows what it last saw.
 */
export class BrowserWatch {
  private watches = new Map<string, Watch>();

  constructor(private bus?: Bus) {}

  /** A run with a watchable browser started: look for its browser as soon as it opens one. */
  begin(taskId: string, runId: string, port: number): void {
    const prev = this.watches.get(taskId);
    if (prev) this.stop(prev);
    const w: Watch = {
      taskId, runId, port, ended: false, pageId: null, ws: null, msgId: 0, casting: false, poll: null,
      meta: { live: false, url: prev?.meta.url ?? null, title: prev?.meta.title ?? null, action: null, hasFrame: !!prev?.frame },
      frame: prev?.frame ?? null,
      frames: prev?.frames ?? new Set(),
      metas: prev?.metas ?? new Set(),
      throttle: frameThrottle<Buffer>(FPS_INTERVAL, (jpeg) => w.frames.forEach((f) => f(jpeg))),
      target: null,
    };
    this.watches.set(taskId, w);
    // The browser opens only when the task first uses it, maybe never: a cheap local poll finds it,
    // and keeps following navigation to other pages and tabs.
    w.poll = setInterval(() => void this.refresh(w), 1500);
    w.poll.unref?.();
  }

  /** The run ended: stop streaming, keep the last picture. */
  end(taskId: string, runId: string): void {
    const w = this.watches.get(taskId);
    if (!w || w.runId !== runId) return;
    this.stop(w);
    this.setMeta(w, { live: false });
  }

  /** What the task just did in its browser, shown under the picture; a navigation also says which page to follow. */
  action(taskId: string, text: string, url?: string): void {
    const w = this.watches.get(taskId);
    if (!w || w.ended) return;
    if (url) w.target = url;
    this.setMeta(w, { action: text });
  }

  status(taskId: string): LiveMeta | null {
    return this.watches.get(taskId)?.meta ?? null;
  }

  /** Tasks whose browser is live now (for the board's "watch" chips). */
  liveTasks(): string[] {
    return [...this.watches.values()].filter((w) => w.meta.live).map((w) => w.taskId);
  }

  /** Watch a task's browser. Screencasting runs only while at least one viewer is attached. */
  watch(taskId: string, onFrame: FrameFn, onMeta: MetaFn): { frame: Buffer | null; meta: LiveMeta; unwatch: () => void } {
    let w = this.watches.get(taskId);
    if (!w) {
      // Nothing yet: a placeholder the next run for this task will pick the viewers up from.
      w = {
        taskId, runId: "", port: 0, ended: true, pageId: null, ws: null, msgId: 0, casting: false, poll: null,
        meta: { live: false, url: null, title: null, action: null, hasFrame: false }, frame: null,
        frames: new Set(), metas: new Set(), throttle: frameThrottle<Buffer>(FPS_INTERVAL, () => {}), target: null,
      };
      const placeholder = w;
      w.throttle = frameThrottle<Buffer>(FPS_INTERVAL, (jpeg) => placeholder.frames.forEach((f) => f(jpeg)));
      this.watches.set(taskId, w);
    }
    const watch = w;
    watch.frames.add(onFrame);
    watch.metas.add(onMeta);
    this.cast(watch);
    return {
      frame: watch.frame,
      meta: watch.meta,
      unwatch: () => {
        watch.frames.delete(onFrame);
        watch.metas.delete(onMeta);
        this.cast(watch);
      },
    };
  }

  stopAll(): void {
    for (const w of this.watches.values()) this.stop(w);
  }

  // ---------------------------------------------------------------- internals

  private setMeta(w: Watch, patch: Partial<LiveMeta>): void {
    const wasLive = w.meta.live;
    w.meta = { ...w.meta, ...patch, hasFrame: !!w.frame };
    w.metas.forEach((m) => m(w.meta));
    if (wasLive !== w.meta.live) this.bus?.publish({ type: "browser.live", taskId: w.taskId, live: w.meta.live });
  }

  private stop(w: Watch): void {
    w.ended = true;
    if (w.poll) clearInterval(w.poll);
    w.poll = null;
    w.throttle.cancel();
    try {
      w.ws?.close();
    } catch {
      // already closed
    }
    w.ws = null;
    w.pageId = null;
    w.casting = false;
  }

  /** Find the page the task is on; connect to it if it changed. */
  private async refresh(w: Watch): Promise<void> {
    if (w.ended) return;
    let pages: PageInfo[];
    try {
      const res = await fetch(`http://127.0.0.1:${w.port}/json/list`, { signal: AbortSignal.timeout(1000) });
      pages = (await res.json()) as PageInfo[];
    } catch {
      if (w.meta.live) this.setMeta(w, { live: false });
      return; // no browser yet, or it closed
    }
    if (w.ended) return;
    const page = pickPage(pages, w.target);
    if (!page) {
      if (w.meta.live) this.setMeta(w, { live: false });
      return;
    }
    if (page.url !== w.meta.url || page.title !== w.meta.title || !w.meta.live) this.setMeta(w, { live: true, url: page.url, title: page.title });
    if (page.id !== w.pageId) this.connect(w, page.id, page.webSocketDebuggerUrl!);
  }

  private connect(w: Watch, pageId: string, url: string): void {
    try {
      w.ws?.close();
    } catch {
      // replaced
    }
    w.pageId = pageId;
    w.casting = false;
    const ws = new WebSocket(url);
    w.ws = ws;
    ws.addEventListener("open", () => this.cast(w));
    ws.addEventListener("message", (e) => {
      let m: { id?: number; method?: string; params?: { data: string; sessionId: number }; result?: { data?: string } };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const data = m.method === "Page.screencastFrame" ? m.params?.data : m.result?.data;
      if (m.method === "Page.screencastFrame") this.send(w, ws, "Page.screencastFrameAck", { sessionId: m.params!.sessionId });
      if (typeof data === "string" && data) {
        w.frame = Buffer.from(data, "base64");
        if (!w.meta.hasFrame) this.setMeta(w, {});
        w.throttle.push(w.frame);
      }
    });
    ws.addEventListener("close", () => {
      if (w.ws === ws) {
        w.ws = null;
        w.pageId = null;
        w.casting = false;
      }
    });
    ws.addEventListener("error", () => {});
  }

  /** Start or stop the screencast to match whether anyone is watching. */
  private cast(w: Watch): void {
    const ws = w.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const want = w.frames.size > 0;
    if (want && !w.casting) {
      w.casting = true;
      // A tab that is not in front is barely painted (seen: an extension's welcome tab in front of the
      // task's page gave one frame in three seconds). Bringing it forward and treating it as focused
      // keeps frames coming; Playwright drives pages by handle, not by which tab is in front.
      this.send(w, ws, "Emulation.setFocusEmulationEnabled", { enabled: true });
      this.send(w, ws, "Page.bringToFront", {});
      // A picture straight away: a headless page only sends frames when something changes.
      this.send(w, ws, "Page.captureScreenshot", { format: "jpeg", quality: 60 });
      this.send(w, ws, "Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
    } else if (!want && w.casting) {
      w.casting = false;
      this.send(w, ws, "Page.stopScreencast", {});
    }
  }

  private send(w: Watch, ws: WebSocket, method: string, params: unknown): void {
    try {
      ws.send(JSON.stringify({ id: ++w.msgId, method, params }));
    } catch {
      // the page went away mid-send
    }
  }
}
