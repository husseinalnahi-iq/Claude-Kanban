import { useEffect, useState } from "react";

/**
 * The first-run welcome. Per machine, like the view and alert preferences: it is about this person
 * seeing it once on this screen, not about the board. Bump VERSION to show it again after a release
 * big enough to deserve a second introduction.
 */
const KEY = "kanban.welcome";
const VERSION = 1;

function seenVersion(): number {
  try {
    return Number(localStorage.getItem(KEY) ?? 0) || 0;
  } catch {
    // Storage blocked: treat as seen, or the welcome would open on every single load.
    return VERSION;
  }
}

let open = seenVersion() < VERSION;
const listeners = new Set<(v: boolean) => void>();

function set(v: boolean) {
  open = v;
  for (const l of listeners) l(v);
}

/** Closes the welcome and remembers it was seen. */
export function closeWelcome() {
  try {
    localStorage.setItem(KEY, String(VERSION));
  } catch {
    // a private window just sees it again next time
  }
  set(false);
}

/** Opens it again on request (the Tour tab's "Replay the welcome"). */
export const openWelcome = () => set(true);

export function useWelcomeOpen(): boolean {
  const [v, setV] = useState(open);
  useEffect(() => {
    listeners.add(setV);
    setV(open);
    return () => void listeners.delete(setV);
  }, []);
  return v;
}

/** A light line for the top of the welcome and the tour. The repo's weather, never the real one. */
const FORECASTS = [
  "☀️ Forecast for your repo: mostly green checks, light scattered approvals.",
  "🌤️ Today: sunny with a 100% chance of merges that don't conflict.",
  "🌈 Outlook: a few failing tests early, clearing to all-green by review.",
  "⛅ Expect a warm front of pull requests and a gentle breeze of confetti.",
  "🌦️ Brief showers of approval cards, then long sunny stretches of autonomy.",
];

export const forecast = () => FORECASTS[Math.floor(Math.random() * FORECASTS.length)]!;
