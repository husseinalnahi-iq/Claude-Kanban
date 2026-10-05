/**
 * A card's memory: whether the session that did its work can still be continued, how much that would cost
 * against a fresh card, and where a follow-up should go (D374, D375). Pure numbers and rules, no Node
 * imports: the server hands them to the chat and the web draws the same answer, ticking as the cache cools.
 */
import { CACHE_WINDOW_MIN } from "./cacheWindow.ts";
import { WEIGHT } from "./explore.ts";
import type { TaskStatus } from "../types.ts";

/** Warm while the hour cache still holds, with a margin for the time a turn takes to start. */
export const MEMORY_WARM_MIN = CACHE_WINDOW_MIN - 5;
/** Claude Code deletes session transcripts after this many days by default (`cleanupPeriodDays`). */
export const MEMORY_KEEP_DAYS = 30;
/** Past this share of the window a session is slow and dear to carry on; a fresh card with a handoff is sharper. */
export const MEMORY_FULL_PCT = 60;
/** What a stage holds before it does anything: Claude Code and the board's tools (D272). */
export const STAGE_START_TOKENS = 40_700;
/** The turns a small follow-up takes; each re-reads the memory. A starting value, tuned by measurement. */
export const ROUND_TURNS = 4;
/** When a window size was not reported. */
const DEFAULT_WINDOW = 200_000;

export type MemoryState = "warm" | "cool" | "gone";
/**
 * Where a follow-up can go. steer: the card is running and takes it at its next step. add_to_round: it waits
 * in Review, so the change joins the work not yet approved. new_round: it is done, so its coder starts
 * round N+1. fork: a new card that starts with a copy of its coder's memory. fresh: a new card told what
 * this one did (D56's follow-up).
 */
export type FollowUpRoute = "steer" | "add_to_round" | "new_round" | "fork" | "fresh";

export interface MemoryInput {
  status: TaskStatus;
  /** The session that did the work (`repo.workRun`), or null when it never ran. */
  session: {
    id: string | null;
    model: string;
    /** When its last turn ended; null while it runs. */
    endedAt: string | null;
    running: boolean;
    contextTokens: number;
    contextWindow: number;
    /** Measured spend before its first edit (`runs.explore_weight`), or null when not known. */
    exploreWeight: number | null;
    /** False for a provider that cannot continue a session (another agent's CLI). */
    canResume: boolean;
  } | null;
  /** The model's cost per weighted token on your own runs, or null with no history. */
  usdPerWeight?: number | null;
}

export interface MemoryFacts {
  memory: MemoryState;
  /** When the cache runs out (warm only). */
  warmUntil: string | null;
  /** When Claude Code will delete the session. */
  keptUntil: string | null;
  model: string | null;
  contextTokens: number;
  contextPct: number;
  /** Estimated cost of each route, in weighted tokens and, when your history allows, dollars. */
  continueWeight: number;
  freshWeight: number;
  continueUsd: number | null;
  freshUsd: number | null;
  /** The routes open right now, the board's pick, and why in one plain sentence. */
  can: FollowUpRoute[];
  recommendation: FollowUpRoute | null;
  why: string;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function memoryFacts(i: MemoryInput, now = Date.now()): MemoryFacts {
  const s = i.session;
  const ctx = s?.contextTokens ?? 0;
  const window = s?.contextWindow || DEFAULT_WINDOW;
  const contextPct = Math.round((100 * ctx) / window);
  const ended = s?.endedAt ? Date.parse(s.endedAt) : NaN;
  const ageMin = Number.isFinite(ended) ? (now - ended) / MIN : null;

  const gone = !s?.id ? "it has no session to continue"
    : !s.canResume ? "it ran on a model that cannot continue a session"
    : !s.running && ageMin !== null && ageMin > MEMORY_KEEP_DAYS * 24 * 60 ? `its memory was deleted after ${MEMORY_KEEP_DAYS} days`
    : "";
  const memory: MemoryState = gone ? "gone" : s!.running || (ageMin !== null && ageMin <= MEMORY_WARM_MIN) ? "warm" : "cool";

  // Continuing re-reads the memory every turn: from the cache while warm, re-written once when cool.
  const continueWeight = memory === "gone" ? Infinity
    : memory === "warm" ? ROUND_TURNS * WEIGHT.read * ctx
    : WEIGHT.write1h * ctx + (ROUND_TURNS - 1) * WEIGHT.read * ctx;
  // A fresh card pays its own start and finds the same files again: measured when known, else half of
  // what the coder held beyond its start, written once.
  const freshWeight = s?.exploreWeight ?? WEIGHT.write1h * (STAGE_START_TOKENS + 0.5 * Math.max(0, ctx - STAGE_START_TOKENS));
  const rate = i.usdPerWeight ?? null;
  const usd = (w: number) => (rate && Number.isFinite(w) ? Math.round(w * rate * 100) / 100 : null);

  const can: FollowUpRoute[] = [];
  let recommendation: FollowUpRoute | null = null;
  let why = "";
  const st = i.status;
  if (st === "running" || st === "planning") {
    can.push("steer");
    recommendation = "steer";
    why = "It is working now: it takes your message at its next step.";
  } else if (st === "review" || st === "failed") {
    if (memory !== "gone") can.push("add_to_round", "fork");
    can.push("fresh");
    recommendation = memory === "gone" ? "fresh" : "add_to_round";
    why = memory === "gone"
      ? `A new card is told what it did: ${gone}.`
      : "Its work is not approved yet, so the change joins it and you approve both together.";
  } else if (st === "done") {
    if (memory !== "gone") can.push("new_round", "fork");
    can.push("fresh");
    if (memory === "gone") {
      recommendation = "fresh";
      why = `A new card is told what it did: ${gone}.`;
    } else if (contextPct >= MEMORY_FULL_PCT) {
      recommendation = "fresh";
      why = `Its memory is ${contextPct}% full, so a new card told what it did is quicker and cheaper.`;
    } else if (memory === "warm") {
      recommendation = "new_round";
      why = "Its memory is still warm: continuing it costs about a tenth of reading it again.";
    } else if (continueWeight <= freshWeight) {
      recommendation = "new_round";
      why = "Its memory has cooled, but reading it once again still costs less than a new card finding the same files.";
    } else {
      recommendation = "fresh";
      why = "Its memory has cooled and is big: a new card told what it did costs less.";
    }
  } else {
    why = st === "approval" || st === "paused"
      ? "It is waiting for you first: answer it, then send the follow-up."
      : "It has not run yet: change its card instead.";
  }

  return {
    memory,
    warmUntil: memory === "warm" && Number.isFinite(ended) ? new Date(ended + MEMORY_WARM_MIN * MIN).toISOString() : null,
    keptUntil: memory !== "gone" && Number.isFinite(ended) ? new Date(ended + MEMORY_KEEP_DAYS * DAY).toISOString() : null,
    model: s?.model ?? null,
    contextTokens: ctx,
    contextPct,
    continueWeight: Number.isFinite(continueWeight) ? Math.round(continueWeight) : 0,
    freshWeight: Math.round(freshWeight),
    continueUsd: usd(continueWeight),
    freshUsd: usd(freshWeight),
    can,
    recommendation,
    why,
  };
}
