import { EventEmitter } from "node:events";
import type { WsMessage } from "./types.ts";

/** In-process fan-out of board changes; the WS route forwards everything to browsers. */
export class Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  publish(msg: WsMessage): void {
    this.ee.emit("msg", msg);
  }

  subscribe(fn: (msg: WsMessage) => void): () => void {
    this.ee.on("msg", fn);
    return () => this.ee.off("msg", fn);
  }
}
