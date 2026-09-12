import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { newId, nowIso } from "./db.ts";

/** Scrollback kept per terminal, so a reopened panel shows what happened. */
const SCROLLBACK_CHARS = 200_000;

export interface TerminalInfo {
  id: string;
  project_id: string;
  task_id: string | null;
  cwd: string;
  title: string;
  /** full: a real terminal (node-pty). basic: pipes; commands work, full-screen programs don't. */
  mode: "full" | "basic";
  alive: boolean;
  created_at: string;
}

interface Proc {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface Session {
  info: TerminalInfo;
  proc: Proc;
  buffer: string;
  listeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number | null) => void>;
}

/** PowerShell 7, where its installer puts it, or null. */
export function pwshPath(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string | null {
  return [env.ProgramFiles, env["ProgramW6432"]].filter(Boolean).map((p) => join(p!, "PowerShell", "7", "pwsh.exe")).find(exists) ?? null;
}

/**
 * On a fresh Windows, PowerShell refuses to run scripts — and `npm`, `npx` and most tools are
 * scripts there ("npm.ps1 cannot be loaded because running scripts is disabled"). The terminal's own
 * shell is started allowing local scripts (and signed downloaded ones), for that shell only: no
 * system setting changes. Windows PowerShell also gets UTF-8, so accented letters and symbols from
 * git and npm show as they should; PowerShell 7 already uses it.
 */
const PS_POLICY = ["-ExecutionPolicy", "RemoteSigned"];
const PS_UTF8 = "[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)";

/** Which shell to open: PowerShell 7 if installed, else Windows PowerShell; elsewhere your login shell. */
export function shellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): { command: string; args: string[] } {
  if (platform === "win32") {
    const pwsh = pwshPath(env, exists);
    if (pwsh) return { command: pwsh, args: ["-NoLogo", ...PS_POLICY] };
    return { command: "powershell.exe", args: ["-NoLogo", ...PS_POLICY, "-NoExit", "-Command", PS_UTF8] };
  }
  return { command: env.SHELL || (exists("/bin/bash") ? "/bin/bash" : "/bin/sh"), args: ["-l"] };
}

type PtyModule = typeof import("node-pty");
let ptyLoad: Promise<PtyModule | null> | null = null;
/** node-pty is optional: a failed native install must never stop the board from starting. */
export function loadPty(): Promise<PtyModule | null> {
  // Only success is remembered: after Setup's Repair installs it, the next terminal picks it up.
  ptyLoad ??= import("node-pty").then(
    (m) => ((m as { default?: PtyModule }).default ?? m) as PtyModule,
    () => ((ptyLoad = null), null),
  );
  return ptyLoad;
}

/**
 * The shells behind the Terminal dock: your own terminal, opened in a project (or a task's worktree).
 * Shells keep running when the dock is closed and are all ended when the board stops.
 */
export class TerminalManager {
  private sessions = new Map<string, Session>();

  constructor(private opts: { forceBasic?: boolean; shell?: { command: string; args: string[] } } = {}) {}

  /** Whether a full terminal is available on this computer (the Setup page asks). */
  async fullMode(): Promise<boolean> {
    return !this.opts.forceBasic && (await loadPty()) !== null;
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(id: string): TerminalInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  async create(o: { project_id: string; task_id?: string | null; cwd: string; title: string; cols?: number; rows?: number }): Promise<TerminalInfo> {
    const shell = this.opts.shell ?? shellFor(process.platform, process.env);
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", KANBAN_TERMINAL: "1" } as Record<string, string>;
    const pty = this.opts.forceBasic ? null : await loadPty();
    const info: TerminalInfo = {
      id: newId("term"), project_id: o.project_id, task_id: o.task_id ?? null, cwd: o.cwd, title: o.title,
      mode: pty ? "full" : "basic", alive: true, created_at: nowIso(),
    };
    const session: Session = { info, proc: null as unknown as Proc, buffer: "", listeners: new Set(), exitListeners: new Set() };
    const out = (data: string) => {
      session.buffer = (session.buffer + data).slice(-SCROLLBACK_CHARS);
      for (const l of session.listeners) l(data);
    };
    const exit = (code: number | null) => {
      info.alive = false;
      out(`\r\n\x1b[2m[shell ended${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`);
      for (const l of session.exitListeners) l(code);
    };

    if (pty) {
      const p = pty.spawn(shell.command, shell.args, { name: "xterm-256color", cols: o.cols ?? 100, rows: o.rows ?? 28, cwd: o.cwd, env });
      p.onData(out);
      p.onExit(({ exitCode }) => exit(exitCode));
      session.proc = { write: (d) => p.write(d), resize: (c, r) => p.resize(Math.max(2, c), Math.max(1, r)), kill: () => p.kill() };
    } else {
      session.proc = basicShell(shell, o.cwd, env, out, exit);
      out("\x1b[2mBasic terminal: commands work, but full-screen programs (editors, pickers) don't. See Setup.\x1b[0m\r\n");
    }
    this.sessions.set(info.id, session);
    return info;
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (s?.info.alive) s.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (s?.info.alive && Number.isFinite(cols) && Number.isFinite(rows)) s.proc.resize(Math.floor(cols), Math.floor(rows));
  }

  /** Follow a terminal: what it printed so far, then everything new. */
  attach(id: string, onData: (d: string) => void, onExit: (code: number | null) => void): { replay: string; detach: () => void } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.listeners.add(onData);
    s.exitListeners.add(onExit);
    return { replay: s.buffer, detach: () => (s.listeners.delete(onData), s.exitListeners.delete(onExit)) };
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      if (s.info.alive) s.proc.kill();
    } catch {
      // already gone
    }
    this.sessions.delete(id);
    return true;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

/**
 * Pipes instead of a terminal. The shell does not echo or edit lines here, so this does: characters
 * are echoed, Backspace works, and Enter sends the line.
 */
function basicShell(
  shell: { command: string; args: string[] }, cwd: string, env: Record<string, string>,
  out: (d: string) => void, exit: (code: number | null) => void,
): Proc {
  const child = spawn(shell.command, shell.args.filter((a) => a !== "-l"), { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const text = (b: Buffer) => out(b.toString("utf8").replace(/\r?\n/g, "\r\n"));
  child.stdout.on("data", text);
  child.stderr.on("data", text);
  child.on("exit", (code) => exit(code));
  child.on("error", (err) => (out(`\r\n${err.message}\r\n`), exit(null)));
  let line = "";
  return {
    write: (data) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          out("\r\n");
          child.stdin.write(`${line}\n`);
          line = "";
        } else if (ch === "\x7f" || ch === "\b") {
          if (line) (line = line.slice(0, -1), out("\b \b"));
        } else if (ch === "\x03") {
          line = "";
          out("^C\r\n");
        } else if (ch >= " ") {
          line += ch;
          out(ch);
        }
      }
    },
    resize: () => {},
    kill: () => child.kill(),
  };
}
