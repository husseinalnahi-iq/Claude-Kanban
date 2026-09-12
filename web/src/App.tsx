import { useEffect, useState } from "react";
import { api } from "./lib/api.ts";
import { navigate, useRoute, type View } from "./lib/router.ts";
import { useAppData } from "./lib/store.tsx";
import { useWs, useWsConnected } from "./lib/ws.ts";
import { getViewPrefs, setViewPrefs, useViewPrefs, ZOOMS } from "./lib/view.ts";
import { seedAlerts, watchAlerts } from "./lib/alerts.ts";
import { armSounds } from "./lib/sounds.ts";
import { useTabBadge } from "./lib/badge.ts";
import { BellControl } from "./components/BellControl.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { ZoomControl } from "./components/ZoomControl.tsx";
import { UsageMeters } from "./components/UsageMeters.tsx";
import { SearchModal } from "./components/SearchModal.tsx";
import { NewProjectForm } from "./components/forms.tsx";
import { Board } from "./views/Board.tsx";
import { TaskDrawer } from "./views/TaskDrawer.tsx";
import { Roadmap } from "./views/Roadmap.tsx";
import { Approvals } from "./views/Approvals.tsx";
import { Dashboard } from "./views/Dashboard.tsx";
import { Sessions } from "./views/Sessions.tsx";
import { Skills } from "./views/Skills.tsx";
import { Settings } from "./views/Settings.tsx";
import { Tour } from "./views/Tour.tsx";
import { Welcome } from "./components/Welcome.tsx";
import { closeWelcome, useWelcomeOpen } from "./lib/welcome.ts";
import { Setup, useSetupCount } from "./views/Setup.tsx";
import { ChatPanel } from "./components/chat/ChatPanel.tsx";
import { TerminalDock } from "./components/TerminalDock.tsx";
import { ErrorBoundary, StaleServerBanner } from "./components/ErrorBoundary.tsx";
import { Button, Empty } from "./components/ui.tsx";

const NAV: { view: View; label: string; key: string }[] = [
  { view: "board", label: "Board", key: "1" },
  { view: "dashboard", label: "Dashboard", key: "2" },
  { view: "roadmap", label: "Roadmap", key: "3" },
  { view: "approvals", label: "Approvals", key: "4" },
  { view: "sessions", label: "Sessions", key: "5" },
  { view: "skills", label: "Skills", key: "6" },
  { view: "settings", label: "Settings", key: "7" },
  { view: "tour", label: "✦ Tour", key: "8" },
  { view: "setup", label: "Setup", key: "9" },
];

const initials = (name: string) =>
  name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export function App() {
  const route = useRoute();
  const view = useViewPrefs();
  const { projects, pending } = useAppData();
  const connected = useWsConnected();
  const [adding, setAdding] = useState(false);
  const [searching, setSearching] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const welcome = useWelcomeOpen();
  const project = projects.find((p) => p.id === route.projectId) ?? null;
  const setupCount = useSetupCount();

  // First launch (no route yet) with something required missing: start on Setup, not an empty board.
  useEffect(() => {
    if (location.hash.replace(/^#\/?/, "")) return;
    void api.setup().then((r) => {
      if (r.summary.required) navigate({ view: "setup" });
    }, () => {});
  }, []);

  // Default to the first project once projects load.
  useEffect(() => {
    if (!route.projectId && projects.length) navigate({ projectId: projects[0].id });
  }, [route.projectId, projects]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Before the typing guard: the terminal itself is a text box, and this must still close it.
      if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        setTerminal((v) => !v);
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n && !e.ctrlKey && !e.metaKey && !e.altKey) navigate({ view: n.view });
      if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) navigate({ view: "approvals" });
      if (e.key === "c" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); // or the "c" lands in the chat box that just took focus
        setChatting((v) => !v);
      }
      if ((e.key === "/" || (e.key === "k" && (e.ctrlKey || e.metaKey))) && !e.altKey) {
        e.preventDefault();
        setSearching(true);
      }
      // The browser's own zoom is unavailable in the desktop app, so the board provides its own.
      if ((e.ctrlKey || e.metaKey) && ["-", "=", "+", "0"].includes(e.key)) {
        e.preventDefault();
        const z = getViewPrefs().zoom;
        const i = ZOOMS.indexOf(z);
        setViewPrefs({ zoom: e.key === "0" ? 100 : ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + (e.key === "-" ? -1 : 1)))] });
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // "Open terminal here" on a task: show the dock (the dock itself opens the shell).
  useEffect(() => {
    const show = () => setTerminal(true);
    window.addEventListener("kanban:terminal", show);
    return () => window.removeEventListener("kanban:terminal", show);
  }, []);

  // Zoom goes on <html>: there, 100% heights resolve against the scaled viewport, so the app still
  // fills exactly one screen. On any inner element the layout box scales too and the page overflows.
  useEffect(() => {
    document.documentElement.style.zoom = view.zoom === 100 ? "" : String(view.zoom / 100);
  }, [view.zoom]);

  // Sounds, pop-ups and desktop notifications. Seeded first, so opening the board replays nothing.
  useEffect(() => {
    armSounds();
    void seedAlerts();
  }, []);
  useWs(watchAlerts);

  // A run waiting on you, or anything you missed, shows on the browser tab itself.
  useTabBadge(pending.length);

  const needsProject = route.view === "board" || route.view === "roadmap";

  return (
    <div className="flex h-full">
      {/* project rail */}
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-ink-800 bg-ink-900/80">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-5">
          <div className="flex h-7 w-7 items-end gap-[3px] rounded-md bg-ink-800 p-[5px]">
            <span className="h-full w-1.5 rounded-sm bg-amber" />
            <span className="h-2/3 w-1.5 rounded-sm bg-ink-200" />
            <span className="h-1/3 w-1.5 rounded-sm bg-ink-500" />
          </div>
          <div>
            <div className="text-[13.5px] font-semibold leading-none text-ink-100">Claude Kanban</div>
            <div className="mt-1 flex items-center gap-1 font-mono text-[10px] text-ink-500">
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-moss" : "bg-rust breathe"}`} />
              {connected ? "live" : "reconnecting"}
            </div>
          </div>
        </div>
        <div className="px-4 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-500">Projects</div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
          {projects.map((p) => {
            const active = p.id === route.projectId;
            return (
              <button
                key={p.id}
                onClick={() => navigate({ projectId: p.id, taskId: null, view: needsProject || route.view === "settings" || route.view === "skills" ? route.view : "board" })}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer ${active ? "bg-ink-800 text-ink-100" : "text-ink-300 hover:bg-ink-850 hover:text-ink-100"}`}
                title={p.path}
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold ${active ? "bg-amber text-ink-950" : "bg-ink-800 text-ink-300"}`}>
                  {initials(p.name)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.name}</span>
                {p.policy.autonomous === "forbidden" ? <span className="font-mono text-[9.5px] text-cyan/80" title="Supervised only">SUP</span> : null}
              </button>
            );
          })}
          <button className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12px] text-ink-400 hover:bg-ink-850 hover:text-amber cursor-pointer" onClick={() => setAdding(true)}>
            + Add project
          </button>
        </nav>
        {pending.length ? (
          <div className="mx-3 mb-3 rounded-md border border-rose/40 bg-rose/10 px-3 py-2 text-[11.5px] text-rose">
            <span className="pulse-rose mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-rose" />
            {pending.length} waiting for you
          </div>
        ) : null}
      </aside>

      {/* main */}
      {/* With the chat open on a wide screen, the board makes room for it instead of hiding under it. */}
      <div className={`flex min-w-0 flex-1 flex-col transition-[margin] duration-300 ${chatting && project ? "xl:mr-[460px]" : ""}`}>
        <div className="flex items-center gap-1 no-scrollbar overflow-x-auto border-b border-ink-800 px-4">
          {NAV.map((n) => (
            <button
              key={n.view}
              onClick={() => navigate({ view: n.view, taskId: null })}
              className={`relative shrink-0 whitespace-nowrap px-3 py-3 text-[12.5px] transition-colors cursor-pointer ${route.view === n.view ? "text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
            >
              {n.label}
              {n.view === "setup" && setupCount ? (
                <span className="ml-1.5 rounded-full bg-amber px-1.5 font-mono text-[10px] text-ink-950" title="Things to fix on this computer">{setupCount}</span>
              ) : n.view === "approvals" && pending.length ? (
                <span className="pulse-rose ml-1.5 rounded-full bg-rose px-1.5 font-mono text-[10px] text-ink-950">{pending.length}</span>
              ) : (
                <span className="ml-1.5 font-mono text-[9.5px] text-ink-600">{n.key}</span>
              )}
              {route.view === n.view ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-amber" /> : null}
            </button>
          ))}
          <button
            className={`ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[12px] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
              chatting ? "border-amber/60 bg-amber/10 text-amber" : "border-ink-700 text-ink-300 hover:border-amber/50 hover:text-amber"
            }`}
            onClick={() => setChatting((v) => !v)}
            disabled={!project}
            title={project ? "Talk to Claude about this project, and have it write task cards" : "Pick a project first"}
          >
            ✦ Chat <span className="font-mono text-[10px] text-ink-600">c</span>
          </button>
          <button
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[12px] transition-colors cursor-pointer ${
              terminal ? "border-amber/60 bg-amber/10 text-amber" : "border-ink-700 text-ink-400 hover:border-ink-500 hover:text-ink-200"
            }`}
            onClick={() => setTerminal((v) => !v)}
            title="Your own terminal, in the project's folder (Ctrl + `)"
          >
            <span className="font-mono">&gt;_</span> Terminal
          </button>
          <button
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-ink-700 px-2.5 py-1 text-[12px] text-ink-400 transition-colors hover:border-ink-500 hover:text-ink-200 cursor-pointer"
            onClick={() => setSearching(true)}
            title="Search specs, transcripts, results and memory"
          >
            Search <span className="font-mono text-[10px] text-ink-600">/</span>
          </button>
          <BellControl />
          <ZoomControl />
          <div className="pr-1">
            <UsageMeters />
          </div>
        </div>
        <StaleServerBanner />
        <main className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary key={`${route.view}:${route.projectId ?? ""}`}>
          {needsProject && !project ? (
            <div className="mx-auto mt-24 max-w-md space-y-4 text-center">
              <Empty>
                {projects.length ? "Pick a project on the left." : "No projects yet. Register a folder to start a board for it."}
              </Empty>
              {!projects.length ? <Button variant="primary" onClick={() => setAdding(true)}>+ Add project</Button> : null}
            </div>
          ) : route.view === "board" && project ? (
            <Board project={project} />
          ) : route.view === "roadmap" && project ? (
            <Roadmap project={project} />
          ) : route.view === "dashboard" ? (
            <Dashboard project={project} />
          ) : route.view === "approvals" ? (
            <Approvals />
          ) : route.view === "sessions" ? (
            <Sessions />
          ) : route.view === "skills" ? (
            <Skills project={project} />
          ) : route.view === "setup" ? (
            <Setup />
          ) : route.view === "settings" ? (
            <Settings project={project} />
          ) : route.view === "tour" ? (
            <Tour hasProjects={projects.length > 0} onAddProject={() => setAdding(true)} />
          ) : null}
          </ErrorBoundary>
        </main>
        <ErrorBoundary onClose={() => setTerminal(false)}>
          <TerminalDock project={project} open={terminal} onClose={() => setTerminal(false)} />
        </ErrorBoundary>
      </div>

      {route.taskId ? (
        <ErrorBoundary key={route.taskId} onClose={() => navigate({ taskId: null })}>
          <TaskDrawer taskId={route.taskId} onClose={() => navigate({ taskId: null })} />
        </ErrorBoundary>
      ) : null}
      {adding ? <ErrorBoundary onClose={() => setAdding(false)}><NewProjectForm onClose={() => setAdding(false)} /></ErrorBoundary> : null}
      {searching ? <ErrorBoundary onClose={() => setSearching(false)}><SearchModal projectId={project?.id} onClose={() => setSearching(false)} /></ErrorBoundary> : null}
      {chatting && project ? (
        <ErrorBoundary key={project.id} onClose={() => setChatting(false)}>
          <ChatPanel project={project} onClose={() => setChatting(false)} />
        </ErrorBoundary>
      ) : null}
      {welcome ? <ErrorBoundary onClose={closeWelcome}><Welcome hasProjects={projects.length > 0} onAddProject={() => setAdding(true)} /></ErrorBoundary> : null}
      <Toasts />
    </div>
  );
}
