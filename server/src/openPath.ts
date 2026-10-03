import { spawn } from "node:child_process";
import { dirname } from "node:path";

export type Reveal = "file" | "folder";

/**
 * How each OS opens a file with its default app, or shows it selected in its folder. One argument
 * per value and no shell, so a file name like `a&calc&b.pdf` can never become a command (D24).
 * Windows's `explorer.exe /select,<path>` is one token: Explorer parses the comma itself.
 */
export function revealCommand(platform: NodeJS.Platform, path: string, where: Reveal): { command: string; args: string[] } {
  if (platform === "win32") return where === "folder" ? { command: "explorer.exe", args: [`/select,${path}`] } : { command: "explorer.exe", args: [path] };
  if (platform === "darwin") return where === "folder" ? { command: "open", args: ["-R", path] } : { command: "open", args: [path] };
  return { command: "xdg-open", args: [where === "folder" ? dirname(path) : path] };
}

/** Opens or shows a file on this computer. Never throws: a file that will not open is a nuisance, not a crash. */
export function revealPath(path: string, where: Reveal): void {
  try {
    const { command, args } = revealCommand(process.platform, path, where);
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // nothing to open with: the browser link next to the button still downloads it
  }
}
