import { useEffect, useRef, useSyncExternalStore } from "react";
import type { WsMessage } from "../../../server/src/types.ts";

type Handler = (m: WsMessage) => void;

const handlers = new Set<Handler>();
const statusListeners = new Set<() => void>();
let connected = false;
let socket: WebSocket | null = null;
/** The task whose transcript this client wants; the server sends `event` messages for no other. */
let watching: string | null = null;
let retry = 0;

function sendWatch() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ watch: watching }));
}

/** Ask the server for one task's transcript events, and for no others. */
export function watchTask(taskId: string | null) {
  if (watching === taskId) return;
  watching = taskId;
  sendWatch();
}

function setConnected(v: boolean) {
  connected = v;
  statusListeners.forEach((l) => l());
}

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.onopen = () => {
    retry = 0;
    setConnected(true);
    sendWatch();
  };
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as WsMessage;
    handlers.forEach((h) => h(msg));
  };
  socket.onclose = () => {
    setConnected(false);
    // Back off instead of hammering a server that is down, with a ceiling so recovery stays quick.
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, Math.min(15_000, 600 * 2 ** retry) + Math.random() * 400);
  };
}
connect();

/** Subscribe to every server push; the latest handler is always used without re-subscribing. */
export function useWs(handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const h: Handler = (m) => ref.current(m);
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  }, []);
}

export function useWsConnected(): boolean {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => connected,
  );
}
