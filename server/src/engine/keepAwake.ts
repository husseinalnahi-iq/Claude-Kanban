import { spawn, type ChildProcess } from "node:child_process";

/**
 * The OS's own "don't sleep" request, held by a small child process. Each one watches the server's
 * pid and exits with it, so a crashed server can never leave the computer unable to sleep.
 * System sleep only: the screen may still turn off.
 */
export function keepAwakeCommand(platform: NodeJS.Platform, pid: number): { command: string; args: string[] } | null {
  if (platform === "win32") {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this thread for as long as it lives.
    const script = [
      `$k = Add-Type -Name P -Namespace KanbanAwake -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
      `[void]$k::SetThreadExecutionState([uint32]"0x80000001")`,
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
    ].join("; ");
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
  }
  if (platform === "darwin") return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: ["--what=sleep", "--who=Claude Kanban", "--why=Tasks are queued, running or scheduled", "tail", `--pid=${pid}`, "-f", "/dev/null"],
    };
  }
  return null;
}

/** On while it is asked to be; never throws — a board that cannot hold the PC awake still works. */
export class KeepAwake {
  private child: ChildProcess | null = null;

  get on(): boolean {
    return this.child !== null;
  }

  set(on: boolean): void {
    if (on === this.on) return;
    if (!on) return this.stop();
    const cmd = keepAwakeCommand(process.platform, process.pid);
    if (!cmd) return;
    try {
      const child = spawn(cmd.command, cmd.args, { stdio: "ignore", windowsHide: true });
      child.on("error", () => {
        if (this.child === child) this.child = null;
      });
      child.on("exit", () => {
        if (this.child === child) this.child = null;
      });
      this.child = child;
    } catch {
      this.child = null;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    try {
      child?.kill();
    } catch {
      // already gone
    }
  }
}
