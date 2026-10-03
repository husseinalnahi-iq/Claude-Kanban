/**
 * The side chat's cache window. Pure numbers, in their own file: the web shows the bar from them, and
 * `chat.ts` has Node-only imports the browser cannot load.
 *
 * How long Claude keeps a conversation cached on a subscription: an hour, refreshed by every request
 * (Claude Code's docs on costs, read 2026-10-03; five minutes on an API key, or once usage credits are
 * being drawn on). The board counts from the end of the last reply. D331.
 */
export const CACHE_WINDOW_MIN = 60;
/** The chat is told, once, this many minutes before its window ends. */
export const CACHE_WARN_MIN = 15;
/** The keep-alive message goes this many minutes before the window ends: late enough to be worth it, early enough to land (D332). */
export const KEEP_ALIVE_LEAD_MIN = 5;
