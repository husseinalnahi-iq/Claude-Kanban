import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, type ProjectWithGit, type TerminalInfo } from "../lib/api.ts";

/** The board's ink palette, as xterm wants it (plain hex). */
const THEME = {
  background: "#0c0d0b", foreground: "#d4d1c6", cursor: "#f2a93b", cursorAccent: "#0c0d0b", selectionBackground: "#f2a93b55",
  black: "#1d1e1a", red: "#e0643c", green: "#6fa872", yellow: "#f2a93b", blue: "#8d93a8", magenta: "#a394f0", cyan: "#5ec8d8", white: "#d4d1c6",
  brightBlack: "#57574e", brightRed: "#f0567a", brightGreen: "#b5d95b", brightYellow: "#f7c56e", brightBlue: "#aeb3c6", brightMagenta: "#c2b8f5", brightCyan: "#8fdce7", brightWhite: "#ebe8de",
};
const HEIGHT_KEY = "kanban.terminal.height";
const readHeight = () => {
  try {
    return Math.max(140, Number(localStorage.getItem(HEIGHT_KEY)) || 280);
  } catch {
    return 280;
  }
};

/** Opens a terminal from anywhere (a task's "Open terminal here"): the dock listens for this. */
export function openTerminal(detail: { projectId: string; taskId?: string | null }) {
  window.dispatchEvent(new CustomEvent("kanban:terminal", { detail }));
}

/** One live terminal: xterm on screen, a socket to the shell behind it. Remounting replays the scrollback. */
function TerminalView({ term, onExit }: { term: TerminalInfo; onExit: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const xterm = new Terminal({
      theme: THEME, fontFamily: '"IBM Plex Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.2,
      cursorBlink: true, scrollback: 5000, allowProposedApi: false,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(box.current!);
    // Ctrl + ` belongs to the board (show / hide the dock), not to the shell.
    xterm.attachCustomKeyEventHandler((e) => !(e.ctrlKey && e.key === "`"));
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/terminal/${term.id}`);
    const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const resize = () => {
      try {
        fit.fit();
        send({ t: "r", cols: xterm.cols, rows: xterm.rows });
      } catch {
        // not laid out yet
      }
    };
    ws.onopen = () => resize();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { t: string; d?: string; code?: number | null };
      if (m.t === "d" && m.d) xterm.write(m.d);
      else if (m.t === "x") onExit();
    };
    const input = xterm.onData((d) => send({ t: "i", d }));
    const ro = new ResizeObserver(() => resize());
    ro.observe(box.current!);
    xterm.focus();
    return () => {
      ro.disconnect();
      input.dispose();
      ws.close();
      xterm.dispose();
    };
  }, [term.id]);
  return <div ref={box} className="h-full w-full px-2 pt-1.5" />;
}

/**
 * Your own terminal, in a dock under the board: tabs for several shells, opened in the current
 * project's folder or a task's worktree. Closing the dock keeps them running; × on a tab ends one.
 */
export function TerminalDock({ project, open, onClose }: { project: ProjectWithGit | null; open: boolean; onClose: () => void }) {
  const [terms, setTerms] = useState<TerminalInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [height, setHeight] = useState(readHeight);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<Set<string>>(new Set());
  /** A shell is already on its way (from "Terminal here"): don't also open the automatic one. */
  const requested = useRef(false);

  const create = useCallback(async (projectId: string, taskId?: string | null) => {
    setError(null);
    try {
      const t = await api.createTerminal({ project_id: projectId, task_id: taskId ?? null });
      setTerms((prev) => [...prev, t]);
      setActive(t.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => void api.terminals().then((list) => {
    setTerms(list);
    setActive((a) => a ?? list.at(-1)?.id ?? null);
  }, () => {}), []);

  // First time the dock opens with nothing in it: start a shell in the current project.
  useEffect(() => {
    if (open && !terms.length && project && !requested.current) void create(project.id);
  }, [open]);

  useEffect(() => {
    const h = (e: Event) => {
      requested.current = true;
      void create((e as CustomEvent).detail.projectId, (e as CustomEvent).detail.taskId).finally(() => (requested.current = false));
    };
    window.addEventListener("kanban:terminal", h);
    return () => window.removeEventListener("kanban:terminal", h);
  }, [create]);

  const kill = async (id: string) => {
    await api.deleteTerminal(id).catch(() => {});
    setTerms((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (active === id) setActive(next.at(-1)?.id ?? null);
      return next;
    });
  };

  const drag = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = height;
    const move = (m: PointerEvent) => setHeight(Math.min(Math.round(window.innerHeight * 0.75), Math.max(140, startH + (startY - m.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setHeight((h) => {
        try {
          localStorage.setItem(HEIGHT_KEY, String(h));
        } catch {
          // per-computer nicety only
        }
        return h;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!open) return null;
  const current = terms.find((t) => t.id === active) ?? null;
  return (
    <section className="dock-in relative flex shrink-0 flex-col border-t border-ink-700 bg-ink-950" style={{ height }} aria-label="Terminal">
      <div className="absolute inset-x-0 -top-1 h-2 cursor-row-resize" onPointerDown={drag} title="Drag to resize" />
      <div className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-ink-800 bg-ink-900 px-2">
        <span className="shrink-0 px-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-500">Terminal</span>
        {terms.map((t) => (
          <div
            key={t.id}
            className={`group flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[12px] transition-colors ${
              t.id === active ? "border-amber text-ink-100" : "border-transparent text-ink-400 hover:text-ink-200"
            }`}
          >
            <button className="max-w-[180px] cursor-pointer truncate" onClick={() => setActive(t.id)} title={t.cwd}>
              <span className={ended.has(t.id) || !t.alive ? "text-ink-500 line-through" : ""}>{t.title}</span>
              {t.task_id ? <span className="ml-1 font-mono text-[10px] text-cyan">task</span> : null}
            </button>
            <button className="cursor-pointer text-ink-500 opacity-60 hover:text-rust group-hover:opacity-100" onClick={() => void kill(t.id)} title="End this shell">×</button>
          </div>
        ))}
        <button
          className="shrink-0 cursor-pointer rounded px-2 py-1 text-[13px] text-ink-400 hover:bg-ink-800 hover:text-amber disabled:opacity-40"
          disabled={!project}
          onClick={() => project && void create(project.id)}
          title={project ? `New terminal in ${project.name}` : "Pick a project first"}
        >
          +
        </button>
        {current?.mode === "basic" ? (
          <span className="ml-2 shrink-0 font-mono text-[10.5px] text-amber" title="The full terminal part is not installed; see the Setup tab">basic mode</span>
        ) : null}
        <span className="ml-auto shrink-0 truncate pl-3 font-mono text-[10.5px] text-ink-600" title={current?.cwd}>{current?.cwd}</span>
        <button className="shrink-0 cursor-pointer px-2 text-[16px] leading-none text-ink-400 hover:text-ink-100" onClick={onClose} title="Hide (Ctrl + `). Shells keep running.">
          ⌄
        </button>
      </div>
      {error ? <div className="px-3 py-1.5 text-[12px] text-rust">{error}</div> : null}
      <div className="min-h-0 flex-1">
        {current ? (
          <TerminalView key={current.id} term={current} onExit={() => setEnded((s) => new Set(s).add(current.id))} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12.5px] text-ink-500">
            {project ? <button className="cursor-pointer text-amber hover:underline" onClick={() => void create(project.id)}>Open a terminal in {project.name}</button> : "Pick a project to open a terminal in it."}
          </div>
        )}
      </div>
    </section>
  );
}
