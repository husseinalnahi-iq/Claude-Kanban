import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pickBrowser, type Probe } from "../setup/probe.ts";
import { BOARD_PROFILE } from "./browser.ts";

/**
 * The program that opens the board browser's saved profile for you to sign in (D389): the same Chrome or
 * Edge the runs use, so the cookies it saves are ones that browser can read again. Chrome encrypts its
 * cookies for itself (app-bound), which is why this signs in here rather than copying your own Chrome.
 */
export function signInCommand(stateDir: string, url: string, probe: Probe): { command: string; args: string[]; profile: string } | null {
  const choice = pickBrowser(probe);
  if (!choice) return null;
  const exe = choice.browser === "chromium" ? chromiumExe(choice.path, probe) : choice.path;
  if (!exe) return null;
  const profile = join(stateDir, BOARD_PROFILE);
  return { command: exe, args: [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--new-window", url], profile };
}

/** Shorter than this and the browser only handed the window to one already open: nobody signed in yet. */
const SIGN_IN_MIN_MS = 5_000;

/** Playwright's own Chromium keeps its program one folder down, under a name that depends on the system. */
function chromiumExe(folder: string, probe: Probe): string | null {
  const names = probe.platform === "win32"
    ? [join("chrome-win64", "chrome.exe"), join("chrome-win", "chrome.exe")]
    : probe.platform === "darwin"
      ? [join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")]
      : [join("chrome-linux64", "chrome"), join("chrome-linux", "chrome")];
  return names.map((n) => join(folder, n)).find((p) => probe.exists(p)) ?? null;
}

/**
 * Opens the window and leaves it with you; closing it is what saves the sign-in for the next run.
 * `onClosed` runs when the window you signed in with is closed (D410: the card that waited for this
 * sign-in runs its stage again). A browser already open on that profile takes the window and exits at
 * once; that early exit is not a sign-in, so nothing is called.
 */
export function openSignIn(stateDir: string, url: string, probe: Probe, onClosed?: () => void): { ok: true } | { ok: false; error: string } {
  const cmd = signInCommand(stateDir, url, probe);
  if (!cmd) return { ok: false, error: "No Chrome or Edge on this computer to sign in with. Install one, or open Setup." };
  try {
    if (!existsSync(cmd.profile)) mkdirSync(cmd.profile, { recursive: true });
    const child = spawn(cmd.command, cmd.args, { detached: true, stdio: "ignore", windowsHide: false });
    const opened = Date.now();
    child.on("error", () => {});
    if (onClosed) child.on("exit", () => {
      if (Date.now() - opened > SIGN_IN_MIN_MS) onClosed();
    });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `The browser did not open: ${e instanceof Error ? e.message : String(e)}` };
  }
}
