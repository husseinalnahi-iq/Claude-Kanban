import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * Letting a run look at what it built, the way Claude Code does with a browser.
 *
 * The board runs its own Playwright server per session rather than reusing the Playwright plugin's:
 *  - `--isolated` keeps the profile in memory. The plugin's shared on-disk profile is locked by the
 *    first browser that opens it, so a second task running in parallel would fail to start one.
 *  - `--headless`, so a background run never opens windows over whatever you are doing.
 *  - `--output-dir` outside the worktree, so page snapshots and logs are never committed.
 * Screenshots come back inside the tool result, which the runner already saves to the task.
 */
export const BROWSER_SERVER = "playwright";
const PREFIX = `mcp__${BROWSER_SERVER}__`;
/** The Playwright plugin's own copy, hidden so a run sees one browser, not two. */
export const PLAYWRIGHT_PLUGIN_TOOLS = "mcp__plugin_playwright_playwright";
/** Claude in Chrome: your own Chrome, signed in to your accounts. */
export const CHROME_PREFIX = "mcp__claude-in-chrome__";

/** `browser` is whichever one this machine has (setup/probe.ts pickBrowser); unset, the server's default is Chrome. */
export function browserServer(outputDir: string, browser?: "chrome" | "msedge" | "chromium"): McpServerConfig {
  return { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated", ...(browser ? ["--browser", browser] : []), "--output-dir", outputDir] };
}

/** Looking only: reading the page, screenshots, console, network, waiting, resizing, tabs. */
const LOOK = new Set([
  "browser_snapshot", "browser_take_screenshot", "browser_console_messages", "browser_network_requests",
  "browser_network_request", "browser_wait_for", "browser_resize", "browser_tabs", "browser_close",
  "browser_navigate_back", "browser_find", "browser_hover",
]);
/** Using the page like a person would. In a supervised task each one is an approval card. */
const ACT = new Set([
  "browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_press_key",
  "browser_drag", "browser_drop", "browser_handle_dialog", "browser_evaluate",
]);
// Everything else — browser_run_code_unsafe (arbitrary code, any site, the file system),
// browser_file_upload (reads any local file), and tools a later version adds — is never automatic.

/**
 * An address a run may open without asking: this machine, or a file inside the task's own folder.
 * The point is to check the app being built, not to browse the internet on your behalf.
 */
export function isLocalUrl(raw: string, cwd: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol === "about:") return url.href === "about:blank";
  if (url.protocol === "file:") {
    try {
      const rel = relative(resolve(cwd), resolve(fileURLToPath(url)));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
      return false;
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127(\.\d{1,3}){3}$/.test(host);
}

export type BrowserDecision =
  | { behavior: "allow"; input: Record<string, unknown> }
  | { behavior: "ask"; input: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * Keeps browser output out of the project. Seen in a real run: given `filename: "header.png"`,
 * Playwright wrote the screenshot into the worktree — and returned no image, so the session had to
 * read the file back, one more turn. Without a file name, the screenshot is saved in the board's
 * temp folder and comes back inline. Any other file a tool writes goes to that folder too.
 */
export function confineOutput(tool: string, input: Record<string, unknown>, outputDir: string): Record<string, unknown> {
  if (typeof input.filename !== "string") return input;
  const { filename, ...rest } = input;
  if (tool === "browser_take_screenshot") return rest;
  return { ...rest, filename: join(outputDir, basename(String(filename).replace(/\\/g, "/"))) };
}

/**
 * What happens to a browser tool call. `null` means it is not a browser tool.
 *
 *                     autonomous                 supervised
 *   look              allowed                    allowed (nothing changes)
 *   open local page   allowed                    allowed
 *   open other site   refused                    approval card
 *   click / type      allowed (local pages)      approval card
 *   run code, upload  refused                    approval card
 *   Claude in Chrome  refused                    approval card, every call
 */
export function browserDecision(
  toolName: string, raw: Record<string, unknown>, autonomous: boolean, cwd: string, outputDir: string,
): BrowserDecision | null {
  if (toolName.startsWith(CHROME_PREFIX)) {
    return autonomous
      ? { behavior: "deny", message: "Autonomous runs never use Claude in Chrome: it is your own browser, signed in to your accounts. Use the board's browser (the browser_* tools) to check local pages." }
      : { behavior: "ask", input: raw };
  }
  if (!toolName.startsWith(PREFIX)) return null;
  const tool = toolName.slice(PREFIX.length);
  const input = confineOutput(tool, raw, outputDir);
  const url = typeof input.url === "string" ? input.url : null;
  if (url !== null && !isLocalUrl(url, cwd)) {
    return autonomous
      ? { behavior: "deny", message: `Refused ${url}: autonomous runs may only open local pages (localhost, 127.0.0.1, or files in the task's folder). Check the app you are building there.` }
      : { behavior: "ask", input };
  }
  if (tool === "browser_navigate" || LOOK.has(tool)) return { behavior: "allow", input };
  if (ACT.has(tool)) return { behavior: autonomous ? "allow" : "ask", input };
  return autonomous
    ? { behavior: "deny", message: `Autonomous runs can't use ${tool}: it can reach beyond the page being checked. Ask for a supervised task if this is needed.` }
    : { behavior: "ask", input };
}
