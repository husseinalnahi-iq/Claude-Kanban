import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { buildChecks } from "../src/setup/checks.ts";
import { sdkVersion, type Probe } from "../src/setup/probe.ts";
import { parseVersion, shouldInstall } from "../src/setup/engine.ts";

test("a newer patch of the tested minor replaces the installed engine; nothing else does", () => {
  const floor = "0.3.268";
  assert.equal(shouldInstall({ installed: "0.3.268", latest: "0.3.285", floor }), true);
  assert.equal(shouldInstall({ installed: "0.3.285", latest: "0.3.285", floor }), false, "already the newest");
  assert.equal(shouldInstall({ installed: "0.3.290", latest: "0.3.285", floor }), false, "never a downgrade");
  assert.equal(shouldInstall({ installed: "0.3.268", latest: "0.4.0", floor }), false, "a new minor may change the API: it waits for a board update");
  assert.equal(shouldInstall({ installed: "0.3.268", latest: "1.0.0", floor }), false);
  assert.equal(shouldInstall({ installed: "0.3.268", latest: "0.3.285", floor, skipped: ["0.3.285"] }), false, "a version that did not start is not tried again");
  assert.equal(shouldInstall({ installed: "0.3.268", latest: "0.3.286-beta.1", floor }), false, "only plain releases");
  assert.equal(shouldInstall({ installed: "unknown", latest: "0.3.285", floor }), false);
  assert.equal(parseVersion("0.3.285; rm -rf"), null, "nothing but a version ever reaches npm");
});

test("Setup says when a newer engine is out, and how to get it", async () => {
  const repo = new Repo(openDb(":memory:"));
  const installed = sdkVersion();
  const [major, minor, patch] = parseVersion(installed)!;
  const detect = (latest: string | Error, settings = repo.getSettings()) =>
    buildChecks(settings).find((c) => c.id === "claude-engine")!.detect({
      settings,
      hasSecret: () => false,
      probe: {
        fetchJson: async () => {
          if (latest instanceof Error) throw latest;
          return { version: latest };
        },
      } as unknown as Probe,
    });

  const current = await detect(installed);
  assert.equal(current.ok, true, current.detail);
  assert.match(current.detail, /newest/);

  const newer = `${major}.${minor}.${patch + 1}`;
  const behind = await detect(newer);
  assert.equal(behind.ok, false);
  assert.match(behind.detail, new RegExp(`${newer.replaceAll(".", "\\.")} is out — quit Claude Kanban .* and open it again`));

  const off = await detect(newer, repo.updateSettings({ autoUpdateEngine: false }));
  assert.match(off.detail, /switched off/);

  const offline = await detect(new Error("offline"));
  assert.equal(offline.ok, true, "no network is not a problem to fix");
});
