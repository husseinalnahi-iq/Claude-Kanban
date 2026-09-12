/**
 * Did a delegated provider run out, rather than the work go wrong? (docs/DECISIONS.md D194)
 *
 * Three answers, because each wants a different next step:
 * - window: a usage window is used up (5-hour, weekly…). It comes back by itself, often at a time the
 *   error names, so the task waits and carries on in the same session.
 * - credit: the money or the plan ran out (insufficient balance, plan expired). Nothing comes back
 *   by itself: someone has to top up or pick another provider.
 * - busy: too many requests or an overloaded server. Claude Code already retried; try again soon.
 *
 * Pure, so the tests and the web share it.
 */
export type OutKind = "window" | "credit" | "busy";

export interface OutHit {
  kind: OutKind;
  /** When it comes back (epoch ms), when the error says so. */
  resetsAt: number | null;
  /** The provider's own words, trimmed, for the card. */
  reason: string;
}

/** Context-length and request-size errors say "limit" too, but no amount of waiting fixes them. */
const NOT_USAGE = /context (length|window)|token limit|too long|maximum context|max_tokens|message size|exceeds limit \d/i;
const CREDIT = /insufficient[ _-]?(balance|credits?|funds|quota)|no resource package|recharge|top[ -]?up|payment required|\b402\b|arrearage|overdue payment|exceeded_current_quota|(package|plan|membership|subscription) (has )?expired|unable to verify your membership|out of credits?|credit balance is too low/i;
const CONCURRENCY = /concurren|parallel (session|request)s? limit|high concurrency/i;
const WINDOW = /usage limit|limit (reached|exhausted|exceeded)|reached your .{0,40}limit|\b(5|five)[- ]hour|weekly|7-day|monthly (usage )?limit|session usage|hourly usage|quota (exceeded|exhausted|reached)|resets? (at|in)|will reset/i;
const BUSY = /rate[ _-]?limit|too many requests|overloaded|\b429\b|\b529\b|\b503\b|temporarily unavailable|try again later/i;

/**
 * A reset time in the error: an ISO time with a zone, a bare "2026-09-12 18:43:01" (read in
 * `naiveOffsetMin`, the provider's own zone), or "in 2h 13m". Times already past, or more than eight
 * days out, are not believed.
 */
export function resetFrom(text: string, now: number, naiveOffsetMin = 0): number | null {
  const plausible = (ms: number) => (Number.isFinite(ms) && ms > now && ms < now + 8 * 86_400_000 ? ms : null);
  const zoned = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})\b/);
  if (zoned) return plausible(Date.parse(zoned[0].replace(" ", "T").replace(/\s+/g, "")));
  const naive = text.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive.map(Number);
    return plausible(Date.UTC(y, mo - 1, d, h, mi, s || 0) - naiveOffsetMin * 60_000);
  }
  const rel = text.match(/\b(?:in|after)\s+((?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\s*)+)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const u = unit.toLowerCase();
      ms += Number(n) * (u.startsWith("d") ? 86_400_000 : u.startsWith("h") ? 3_600_000 : u.startsWith("s") ? 1000 : 60_000);
    }
    return ms ? plausible(now + ms) : null;
  }
  return null;
}

/** The provider's message without the JSON around it, short enough for a card. */
export function plainReason(error: string): string {
  const msg = error.match(/"message"\s*:\s*"([^"]{3,300})"/)?.[1];
  const text = (msg ?? error).replace(/^API Error:\s*/i, "").replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

export function classifyProviderError(error: string | null | undefined, now = Date.now(), naiveOffsetMin = 0): OutHit | null {
  const text = error ?? "";
  if (!text.trim()) return null;
  const hasUsageWord = /usage|quota|balance|credit|limit reached/i.test(text);
  if (NOT_USAGE.test(text) && !hasUsageWord) return null;
  const resetsAt = resetFrom(text, now, naiveOffsetMin);
  const reason = plainReason(text);
  // "Insufficient balance for the past 5 hours, resets at…" (z.ai 1316) comes back by itself: a window.
  if (CREDIT.test(text) && !resetsAt) return { kind: "credit", resetsAt: null, reason };
  if (CONCURRENCY.test(text)) return { kind: "busy", resetsAt, reason };
  if (WINDOW.test(text) || (CREDIT.test(text) && resetsAt)) return { kind: "window", resetsAt, reason };
  if (BUSY.test(text)) return { kind: "busy", resetsAt, reason };
  return null;
}

/** Which zone a provider writes bare times in: z.ai and Zhipu are in Beijing (UTC+8). */
export function naiveOffsetFor(baseUrl: string | undefined): number {
  return /(^|\.)z\.ai|bigmodel\.cn/i.test(safeHost(baseUrl)) ? 480 : 0;
}

export function safeHost(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

/**
 * When to try again with no reset time to go on: half an hour, then doubling up to four hours, so a
 * provider that stays out for days is not knocked on every thirty minutes. Busy starts at ten minutes.
 */
export function retryDelayMs(kind: OutKind, streak: number): number {
  const first = kind === "busy" ? 10 : 30;
  return Math.min(first * 2 ** Math.max(0, streak), 240) * 60_000;
}
