import { spawn } from "node:child_process";

/**
 * How to open a URL in the default browser on each OS. On Windows, rundll32's URL handler: it takes
 * the URL as one argument, so nothing passes through cmd and its quoting.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Opens the board once the server is actually listening. The launcher used to open the browser
 * first and start the server after, so the first thing you saw was "This site can't be reached".
 * Never throws: a board without a browser tab is still a working board.
 */
export function openBrowser(url: string): void {
  try {
    const { command, args } = browserCommand(process.platform, url);
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser to open: the address is printed in the window anyway
  }
}
