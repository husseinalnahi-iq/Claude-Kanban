import { useSyncExternalStore } from "react";

export type View = "board" | "dashboard" | "roadmap" | "approvals" | "sessions" | "skills" | "settings" | "tour" | "setup";

export interface Route {
  view: View;
  projectId: string | null;
  taskId: string | null;
}

const VIEWS: View[] = ["board", "dashboard", "roadmap", "approvals", "sessions", "skills", "settings", "tour", "setup"];

/** Hash routes: #/<view>/<projectId>?task=<taskId> */
function parse(): Route {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [view, projectId] = path.split("/");
  const params = new URLSearchParams(query);
  return {
    view: VIEWS.includes(view as View) ? (view as View) : "board",
    projectId: projectId || null,
    taskId: params.get("task"),
  };
}

let current = parse();
const listeners = new Set<() => void>();
window.addEventListener("hashchange", () => {
  current = parse();
  listeners.forEach((l) => l());
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function navigate(patch: Partial<Route>) {
  const next = { ...current, ...patch };
  const q = next.taskId ? `?task=${next.taskId}` : "";
  location.hash = `#/${next.view}${next.projectId ? `/${next.projectId}` : ""}${q}`;
}
