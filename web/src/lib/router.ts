import { useSyncExternalStore } from "react";

export type View = "board" | "dashboard" | "roadmap" | "approvals" | "sessions" | "skills" | "settings" | "tour" | "setup" | "ai-manager";

export interface Route {
  view: View;
  projectId: string | null;
  taskId: string | null;
}

const VIEWS: View[] = ["board", "dashboard", "roadmap", "approvals", "sessions", "skills", "settings", "tour", "setup", "ai-manager"];

/** Hash routes: #/<view>/<projectId>?task=<taskId> */
function parse(): Route {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [raw, projectId] = path.split("/");
  // The AI Manager was the Studio until D371: links and bookmarks to #/studio still open it.
  const view = raw === "studio" ? "ai-manager" : raw;
  // Rewritten in place (no hashchange, no history entry) so a bookmark made now gets the new name.
  if (raw === "studio") history.replaceState(null, "", location.href.replace("#/studio", "#/ai-manager"));
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

/** The route right now, outside React (keyboard handlers). */
export const getRoute = (): Route => current;

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
