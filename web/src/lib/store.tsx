import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Approval, Settings } from "../../../server/src/types.ts";
import { api, type ProjectWithGit } from "./api.ts";
import { useWs } from "./ws.ts";

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

  useEffect(() => {
    void reloadProjects();
    void api.settings().then(setSettings);
    void api.pendingApprovals().then(setPending);
  }, [reloadProjects]);

  useWs((m) => {
    if (m.type === "project.updated") void reloadProjects();
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
