import { EventEmitter } from "node:events";
import type { WsMessage } from "./types.ts";

/** In-process fan-out of board changes; the WS route forwards everything to browsers. */
export class Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  publish(msg: WsMessage): void {
    // Every open tab sends the same text, so it is written once however many are listening — and not
    // at all when nobody wants this message (a transcript event with no drawer open on it).
    let text: string | undefined;
    this.ee.emit("msg", msg, () => (text ??= JSON.stringify(msg)));
  }

  /** `wire` is the message as the JSON a browser receives. */
  subscribe(fn: (msg: WsMessage, wire: () => string) => void): () => void {
    this.ee.on("msg", fn);
    return () => this.ee.off("msg", fn);
  }
}
