import { useEffect, useState } from "react";
import type { LiveMeta } from "../../../server/src/engine/browserWatch.ts";

/** Which tasks' browsers are open right now: the board's "live" chips. */
export async function liveTasks(): Promise<string[]> {
  const r = await fetch("/api/browser/live");
  return r.ok ? ((await r.json()) as string[]) : [];
}

/**
 * Watch a task use its browser: the page as it is right now, where it is, and what the task just did.
 * The picture streams only while this is on screen. After the run, the last picture stays.
 */
export function LiveBrowser({ taskId, running, onShowFiles }: { taskId: string; running: boolean; onShowFiles: () => void }) {
  const [meta, setMeta] = useState<LiveMeta | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/browser/${taskId}`);
      ws.binaryType = "blob";
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          setMeta(JSON.parse(e.data) as LiveMeta);
          return;
        }
        const next = URL.createObjectURL(e.data as Blob);
        setSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return next;
        });
        url = next;
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(open, 2000);
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      if (url) URL.revokeObjectURL(url);
    };
  }, [taskId]);

  const live = !!meta?.live;
  return (
    <div className="flex h-full flex-col gap-2.5">
      <div className="overflow-hidden rounded-xl border border-ink-700 bg-ink-950 shadow-lg shadow-black/30">
        {/* a quiet browser frame: dots, the address, and whether this is live */}
        <div className="flex items-center gap-2 border-b border-ink-800 bg-ink-900 px-3 py-2">
          <span className="flex gap-1">
            <span className="h-2 w-2 rounded-full bg-ink-600" />
            <span className="h-2 w-2 rounded-full bg-ink-600" />
            <span className="h-2 w-2 rounded-full bg-ink-600" />
          </span>
          <span className="min-w-0 flex-1 truncate rounded-md bg-ink-850 px-2.5 py-0.5 font-mono text-[11px] text-ink-300" title={meta?.url ?? ""}>
            {meta?.url ?? "no page open"}
          </span>
          {live ? (
            <span className="flex items-center gap-1.5 rounded-full border border-rose/50 bg-rose/10 px-2 py-px font-mono text-[10px] font-semibold tracking-wider text-rose">
              <span className="pulse-rose h-1.5 w-1.5 rounded-full bg-rose" /> LIVE
            </span>
          ) : src ? (
            <span className="rounded-full border border-ink-700 px-2 py-px font-mono text-[10px] text-ink-500">last seen</span>
          ) : null}
        </div>
        <div className="relative flex aspect-[16/10] items-center justify-center bg-[radial-gradient(ellipse_at_center,var(--color-ink-900),var(--color-ink-950))]">
          {src ? (
            <img key="frame" src={src} alt={meta?.title ?? "The task's browser"} className={`fade-in h-full w-full object-contain transition-[filter] duration-500 ${live ? "" : "grayscale-[35%]"}`} />
          ) : (
            <div className="max-w-sm px-6 text-center text-[12.5px] leading-relaxed text-ink-500">
              {running ? (
                <>
                  <div className="breathe mx-auto mb-2 h-2 w-2 rounded-full bg-amber" />
                  No page open yet. When this task opens its app in the browser to check its work, you will see it here, live.
                </>
              ) : (
                "This task did not open a browser. Tasks that change something you can see check it in a browser, and it shows here while they do."
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[12px]">
        {meta?.action ? (
          <span key={meta.action} className="rise min-w-0 truncate text-ink-200">
            <span className="mr-1.5 text-amber">▸</span>
            {meta.action}
          </span>
        ) : (
          <span className="text-ink-500">{connected ? (live ? "Watching…" : " ") : "Connecting…"}</span>
        )}
        <button className="ml-auto shrink-0 cursor-pointer font-mono text-[11px] text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline" onClick={onShowFiles}>
          screenshots in Files →
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-500">
        This is the task's own browser, running in the background with no window. The picture is streamed only while this tab is open.
      </p>
    </div>
  );
}
