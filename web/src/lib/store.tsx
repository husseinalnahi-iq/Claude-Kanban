import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Approval, Settings } from "../../../server/src/types.ts";
import { api, type ProjectWithGit } from "./api.ts";
import { useWs, useWsReconnect } from "./ws.ts";

interface AppData {
  projects: ProjectWithGit[];
  settings: Settings | null;
  pending: Approval[];
  reloadProjects: () => Promise<void>;
  setSettings: (s: Settings) => void;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectWithGit[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState<Approval[]>([]);

  const reloadProjects = useCallback(async () => setProjects(await api.projects()), []);

  // A load that fails (the server is still starting) is tried again when the socket comes back.
  const load = useCallback(() => {
    reloadProjects().catch(() => {});
    api.settings().then(setSettings, () => {});
    api.pendingApprovals().then(setPending, () => {});
  }, [reloadProjects]);
  useEffect(load, [load]);
  useWsReconnect(load);

  useWs((m) => {
    if (m.type === "project.updated" || m.type === "project.deleted") reloadProjects().catch(() => {});
    else if (m.type === "settings.updated") setSettings(m.settings);
    else if (m.type === "approval.requested") setPending((p) => [...p.filter((a) => a.id !== m.approval.id), m.approval]);
    else if (m.type === "approval.decided") setPending((p) => p.filter((a) => a.id !== m.approval.id));
  });

  return <Ctx.Provider value={{ projects, settings, pending, reloadProjects, setSettings }}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppData outside provider");
  return v;
}
