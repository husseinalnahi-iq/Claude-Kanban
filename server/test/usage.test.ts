import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";

/** A session that answers the /usage request and never sends a message (so nothing is billed). */
function usageSession(rateLimits: unknown, seen: { messages: number }): QueryFn {
  return (params) => {
    const it = (async function* () {
      for await (const _ of params.prompt) seen.messages++;
    })();
    return Object.assign(it, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true, rate_limits: rateLimits }) }) as never;
  };
}

test("usage is read from the account like Claude's /usage — every app on the subscription, for free", async () => {
  const repo = new Repo(openDb(":memory:"));
  // What the board used to show: an hour-old figure from its own last run.
  repo.upsertUsageLimit({ type: "five_hour", status: "allowed", utilization: 0.4, resets_at: 1 });
  const seen = { messages: 0 };
  const runner = new TaskRunner({
    repo, bus: new Bus(),
    queryFn: usageSession({
      five_hour: { utilization: 88, resets_at: "2026-09-11T20:50:00.371698+00:00" },
      seven_day: { utilization: 19, resets_at: "2026-09-17T15:00:00+00:00" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 100, resets_at: "2026-09-17T15:00:00+00:00", locked_reason: null },
      model_scoped: [{ display_name: "Fable", utilization: 7, resets_at: null }],
    }, seen),
  });
  const limits = await runner.refreshLimits();
  const by = (t: string) => limits.find((l) => l.type === t);
  assert.equal(by("five_hour")?.utilization, 0.88, "the real figure replaces the stale one");
  assert.equal(by("five_hour")?.resets_at, Math.round(Date.parse("2026-09-11T20:50:00.371Z") / 1000));
  assert.equal(by("seven_day")?.utilization, 0.19);
  assert.equal(by("seven_day_opus"), undefined, "a window the plan does not have is not invented");
  assert.equal(by("seven_day_sonnet")?.status, "rejected", "a full window reads as reached, so auto-resume can wait for it");
  assert.equal(by("seven_day_model:Fable")?.utilization, 0.07);
  assert.equal(seen.messages, 0, "no message was sent — nothing is billed");
});

test("without the free read, Check now falls back to the one tiny paid call", async () => {
  const repo = new Repo(openDb(":memory:"));
  let calls = 0;
  const q: QueryFn = () => {
    calls++;
    return (async function* () {
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 2 } } } } as never;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.018, session_id: "s", modelUsage: {} } as never;
    })();
  };
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: q });
  const limits = await runner.refreshLimits();
  assert.equal(calls, 2, "one attempt at the free read, then the probe");
  assert.equal(limits.find((l) => l.type === "five_hour")?.utilization, 0.5);
});
