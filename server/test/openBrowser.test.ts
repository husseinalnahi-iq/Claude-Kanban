import { test } from "node:test";
import assert from "node:assert/strict";
import { browserCommand } from "../src/openBrowser.ts";
import { revealCommand } from "../src/openPath.ts";

test("the browser is opened with each OS's own handler, the URL as a single argument", () => {
  const url = "http://127.0.0.1:4310";
  assert.deepEqual(browserCommand("win32", url), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
  assert.deepEqual(browserCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(browserCommand("linux", url), { command: "xdg-open", args: [url] });
});

test("a file is opened or shown in its folder with each OS's own command, the path as one argument (D351)", () => {
  const win = String.raw`C:\work\proj\.kanban\files\report a&b.pdf`;
  assert.deepEqual(revealCommand("win32", win, "file"), { command: "explorer.exe", args: [win] });
  assert.deepEqual(revealCommand("win32", win, "folder"), { command: "explorer.exe", args: [`/select,${win}`] }, "Explorer parses the comma itself; one token keeps the path out of any shell");
  assert.deepEqual(revealCommand("darwin", "/p/f.pdf", "file"), { command: "open", args: ["/p/f.pdf"] });
  assert.deepEqual(revealCommand("darwin", "/p/f.pdf", "folder"), { command: "open", args: ["-R", "/p/f.pdf"] });
  assert.deepEqual(revealCommand("linux", "/p/f.pdf", "file"), { command: "xdg-open", args: ["/p/f.pdf"] });
  assert.deepEqual(revealCommand("linux", "/p/f.pdf", "folder"), { command: "xdg-open", args: ["/p"] }, "no 'select' on Linux: the folder opens");
});
