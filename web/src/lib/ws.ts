import { useEffect, useRef, useSyncExternalStore } from "react";
import type { WsMessage } from "../../../server/src/types.ts";

type Handler = (m: WsMessage) => void;

const handlers = new Set<Handler>();
const statusListeners = new Set<() => void>();
let connected = false;
let socket: WebSocket | null = null;
/** The task whose transcript this client wants; the server sends `event` messages for no other. */
let watching: string | null = null;
/** The side chat whose reply this client is showing; streamed words go to no one else. */
let watchingChat: string | null = null;
let retry = 0;
/**
 * Called each time the socket comes back after a drop. Nothing pushed during the gap is ever re-sent
 * (a restarted server has already failed its runs and expired its approvals by then), so whoever
 * keeps state from pushes has to ask for it again.
 */
const reconnectListeners = new Set<() => void>();
let openedBefore = false;

function sendWatch() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ watch: watching, watchChat: watchingChat }));
}

/** Ask the server for one task's transcript events, and for no others. */
export function watchTask(taskId: string | null) {
  if (watching === taskId) return;
  watching = taskId;
  sendWatch();
}

/** Ask for one side chat's streamed words (`chat.delta`). */
export function watchChat(chatId: string | null) {
  if (watchingChat === chatId) return;
  watchingChat = chatId;
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
    // Before any message on the new socket, so a reload asks from where the old one stopped.
    if (openedBefore) reconnectListeners.forEach((l) => l());
    openedBefore = true;
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

/** Reload what you keep from pushes when the socket comes back; the latest callback is always used. */
export function useWsReconnect(reload: () => void) {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    const l = () => ref.current();
    reconnectListeners.add(l);
    return () => {
      reconnectListeners.delete(l);
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
