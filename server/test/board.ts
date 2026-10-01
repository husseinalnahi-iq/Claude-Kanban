import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import { setup } from "./helpers.ts";

/** An SDK call that answers at once. */
export const okQuery: QueryFn = () =>
  (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as any;
  })();

/**
 * An SDK call that waits until it is released (or stopped), so a test can look at the board while
 * something is in flight. `waiting` grows by one for every call that has started.
 */
export function holding() {
  const waiting: (() => void)[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) void _;
      await new Promise<void>((r) => {
        waiting.push(r);
        params.options.abortController?.signal.addEventListener("abort", () => r());
      });
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s", modelUsage: {} } as any;
    })();
  return { fn, waiting };
}

/** A whole board behind its HTTP routes, keeping its files in a throwaway folder. */
export async function board(queryFn: QueryFn = okQuery) {
  const s = setup(queryFn);
  const state = mkdtempSync(join(tmpdir(), "kstate-"));
  s.repo.setStateDir(state);
  const app = await buildApp({ repo: s.repo, bus: s.bus, runner: s.runner, allowedHosts: ["localhost:80"] });
  const get = async (url: string) => (await app.inject({ method: "GET", url })).json();
  const close = async () => {
    await app.close();
    s.cleanup();
    rmSync(state, { recursive: true, force: true });
  };
  return { ...s, app, state, get, close };
}
