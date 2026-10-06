// Settings → "Start with Windows" (D401): a "Claude Kanban" shortcut in your Windows Startup folder, the
// same one `create-shortcut.ps1 -Startup` makes. The shortcut is the setting: Windows reads it at sign-in,
// so the board keeps no copy of the answer that could disagree with what Windows will do.

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The install folder: the one holding Claude Kanban.exe and "Start Claude Kanban.cmd". */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Your Startup folder, or null away from Windows. KANBAN_STARTUP_DIR stands in for it in tests. */
export function startupDir(): string | null {
  if (process.env.KANBAN_STARTUP_DIR) return process.env.KANBAN_STARTUP_DIR;
  if (process.platform !== "win32" || !process.env.APPDATA) return null;
  return join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

const linkIn = (dir: string) => join(dir, "Claude Kanban.lnk");

export function startsWithWindows(): { supported: boolean; on: boolean } {
  const dir = startupDir();
  return { supported: dir !== null, on: dir !== null && existsSync(linkIn(dir)) };
}

/** PowerShell's own quoting: inside '…' only a ' needs doubling. */
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function setStartWithWindows(on: boolean, root = ROOT): Promise<{ supported: boolean; on: boolean }> {
  const dir = startupDir();
  if (!dir) throw new Error("Starting with the computer is only set up on Windows.");
  const link = linkIn(dir);
  if (!on) {
    rmSync(link, { force: true });
    return startsWithWindows();
  }
  // The app opens quietly by the clock at sign-in (--at-login): no startup screen, no browser. Where it was
  // never built, the .cmd launcher runs instead, minimised, as create-shortcut.ps1 does.
  const app = join(root, "Claude Kanban.exe");
  const useApp = existsSync(app);
  const script = [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" + ps(link) + ")",
    "$s.TargetPath = " + ps(useApp ? app : join(root, "Start Claude Kanban.cmd")),
    useApp ? "$s.Arguments = '--at-login'" : "",
    "$s.WorkingDirectory = " + ps(root),
    existsSync(join(root, "assets", "claude-kanban.ico")) ? "$s.IconLocation = " + ps(join(root, "assets", "claude-kanban.ico") + ",0") : "",
    "$s.Description = 'Claude Kanban - run Claude sessions from a board'",
    `$s.WindowStyle = ${useApp ? 1 : 7}`,
    "$s.Save()",
  ].filter(Boolean).join("; ");
  await new Promise<void>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new Error(`Could not add Claude Kanban to your Startup folder: ${(stderr || err.message).trim()}`)) : resolve(),
    );
  });
  return startsWithWindows();
}
