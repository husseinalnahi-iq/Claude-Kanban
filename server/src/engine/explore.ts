/**
 * What a run spent finding its way before its first edit, in input-token equivalents. A fresh card asked to
 * do more work in the same place would have to find the same files again, so this is what continuing the
 * card saves (D374). Pure, and shared with `scripts/measure-chat-handoff.ts` so the board and the
 * measurement count the same way.
 */

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Prices relative to one input token. Every Claude model bills output at 5x input and a cache read at a
// tenth or less, so a share of these weights is a fair share of the real cost whichever model ran.
// A cache write is 1.25x for the 5-minute cache and 2x for the hour one.
export const WEIGHT = { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 };

type Row = Record<string, unknown>;

/** One assistant turn's usage, weighted. */
export function usageWeight(u: Row | undefined | null): number {
  if (!u) return 0;
  const n = (k: string) => Number(u[k] ?? 0) || 0;
  const split = u.cache_creation as Row | undefined;
  const w1h = Number(split?.ephemeral_1h_input_tokens ?? 0) || 0;
  const w5m = split ? Number(split.ephemeral_5m_input_tokens ?? 0) || 0 : n("cache_creation_input_tokens");
  return n("input_tokens") * WEIGHT.input + w5m * WEIGHT.write5m + w1h * WEIGHT.write1h + n("cache_read_input_tokens") * WEIGHT.read + n("output_tokens") * WEIGHT.output;
}

/**
 * Weighted tokens before the first edit, and in all, over a run's SDK messages (assistant ones; anything
 * else is skipped). The turn that makes the first edit counts as writing. Parallel tool calls arrive as
 * several messages sharing one id and one usage, counted once. A turn cut short in storage has no usage
 * and adds nothing.
 */
export function splitAtFirstEdit(messages: unknown[]): { beforeEdit: number; total: number; edited: boolean } {
  const seen = new Set<string>();
  let total = 0, beforeEdit = 0, edited = false;
  for (const raw of messages) {
    const ev = raw as Row;
    if (!ev || ev.type !== "assistant") continue;
    const msg = ev.message as Row | undefined;
    const blocks = (Array.isArray(msg?.content) ? msg!.content : []) as Row[];
    if (blocks.some((b) => b?.type === "tool_use" && EDIT_TOOLS.has(String(b.name)))) edited = true;
    const id = String(msg?.id ?? "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const w = usageWeight(msg?.usage as Row | undefined);
    total += w;
    if (!edited) beforeEdit += w;
  }
  return { beforeEdit, total, edited };
}

/**
 * A run's stored totals, weighted the same way. `input_tokens` on a run already includes what was read
 * from and written to the cache (D276), so plain input is what is left. Writes are counted at the hour
 * cache's price, the one a subscription uses (D331).
 */
export function runWeight(r: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }): number {
  const plain = Math.max(0, r.input_tokens - r.cache_read_tokens - r.cache_write_tokens);
  return plain * WEIGHT.input + r.cache_write_tokens * WEIGHT.write1h + r.cache_read_tokens * WEIGHT.read + r.output_tokens * WEIGHT.output;
}
