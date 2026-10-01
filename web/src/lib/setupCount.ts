import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { useWs, useWsReconnect } from "./ws.ts";

/**
 * Required + recommended items still failing, for the nav badge. Lives apart from the Setup page
 * so the badge does not pull that page's code into the first load.
 */
export function useSetupCount(): number {
  const [n, setN] = useState(0);
  const load = () => void api.setup().then((r) => setN(r.summary.required + r.summary.recommended), () => {});
  useEffect(load, []);
  useWsReconnect(load);
  useWs((m) => {
    if (m.type === "setup.updated" || m.type === "health.updated" || m.type === "settings.updated") load();
  });
  return n;
}
