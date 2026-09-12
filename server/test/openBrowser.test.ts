import { test } from "node:test";
import assert from "node:assert/strict";
import { browserCommand } from "../src/openBrowser.ts";

test("the browser is opened with each OS's own handler, the URL as a single argument", () => {
  const url = "http://127.0.0.1:4310";
  assert.deepEqual(browserCommand("win32", url), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
  assert.deepEqual(browserCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(browserCommand("linux", url), { command: "xdg-open", args: [url] });
});
