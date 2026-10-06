import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStartWithWindows, startsWithWindows } from "../src/startWithWindows.ts";
import { removeTemp } from "./helpers.ts";

test("Start with Windows puts a quiet shortcut in the Startup folder and takes it out again (D401)", async (t) => {
  if (process.platform !== "win32") return t.skip("a Startup-folder shortcut is a Windows thing");
  const startup = mkdtempSync(join(tmpdir(), "kstartup-"));
  const install = mkdtempSync(join(tmpdir(), "kinstall-"));
  writeFileSync(join(install, "Claude Kanban.exe"), ""); // only its presence is read
  mkdirSync(join(install, "assets"));
  process.env.KANBAN_STARTUP_DIR = startup;
  try {
    assert.deepEqual(startsWithWindows(), { supported: true, on: false });
    assert.deepEqual(await setStartWithWindows(true, install), { supported: true, on: true });
    const link = join(startup, "Claude Kanban.lnk");
    const read = execFileSync("powershell.exe", ["-NoProfile", "-Command", `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${link}'); $s.TargetPath + '|' + $s.Arguments`], { encoding: "utf8" }).trim();
    assert.equal(read, `${join(install, "Claude Kanban.exe")}|--at-login`, "it opens the app, quietly");
    assert.deepEqual(await setStartWithWindows(false, install), { supported: true, on: false });
    assert.equal(existsSync(link), false);
  } finally {
    delete process.env.KANBAN_STARTUP_DIR;
    await removeTemp(startup);
    await removeTemp(install);
  }
});
