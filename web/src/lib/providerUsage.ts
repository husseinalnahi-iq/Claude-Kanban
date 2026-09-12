import { useEffect, useState } from "react";
import type { ProviderUsage } from "../../../server/src/types.ts";
import { api } from "./api.ts";
import { useWs } from "./ws.ts";

/** One request shared by every place that shows provider usage; the server caches each provider for five minutes. */
let pending: Promise<ProviderUsage[]> | null = null;
let last: ProviderUsage[] | null = null;
let lastAt = 0;
const listeners = new Set<(r: ProviderUsage[]) => void>();

function load(force = false): Promise<ProviderUsage[]> {
  if (pending && !force) return pending;
  const req = api.providerUsage(force).catch(() => last ?? []);
  pending = req;
  void req.then((r) => {
    last = r;
    lastAt = Date.now();
    if (pending === req) pending = null;
    for (const l of listeners) l(r);
  });
  return req;
}

/**
 * Every enabled provider's usage: what it says is left of its plan, what the board sent it, and
 * whether it is out. Refreshed when a provider runs out or comes back, and when settings change.
 */
export function useProviderUsage(active = true): { rows: ProviderUsage[] | null; loading: boolean; refresh: () => Promise<void> } {
  const [rows, setRows] = useState<ProviderUsage[] | null>(last);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) return;
    const on = (r: ProviderUsage[]) => setRows(r);
    listeners.add(on);
    if (!last || Date.now() - lastAt > 60_000) void load().then(on);
    return () => {
      listeners.delete(on);
    };
  }, [active]);
  useWs((m) => {
    if (active && (m.type === "providers.out" || m.type === "settings.updated")) void load();
  });
  const refresh = async () => {
    setLoading(true);
    try {
      setRows(await load(true));
    } finally {
      setLoading(false);
    }
  };
  return { rows, loading, refresh };
}
