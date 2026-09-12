import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../src/secrets.ts";

test("secrets round-trip through the file, fall back to the environment, and redact", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksec-"));
  const file = join(dir, "secrets.json");
  try {
    const s = new SecretStore(file);
    assert.equal(s.has("ZAI_API_KEY"), false);
    s.set("ZAI_API_KEY", "sk-zai-0123456789");
    assert.equal(s.get("ZAI_API_KEY"), "sk-zai-0123456789");
    assert.deepEqual(new SecretStore(file).names(), ["ZAI_API_KEY"], "persisted");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readFileSync(file, "utf8").includes("sk-zai-0123456789"));

    process.env.KTEST_ENV_KEY = "from-environment";
    assert.equal(s.get("KTEST_ENV_KEY"), "from-environment", "environment fallback");
    assert.equal(s.has("KTEST_ENV_KEY"), true);
    delete process.env.KTEST_ENV_KEY;

    assert.equal(s.redact("token sk-zai-0123456789 here"), "token ••• here");
    s.delete("ZAI_API_KEY");
    assert.equal(s.has("ZAI_API_KEY"), false);
    assert.equal(s.get(""), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an in-memory store never touches disk", () => {
  const s = new SecretStore(":memory:");
  s.set("A_KEY", "value-value-value");
  assert.equal(s.get("A_KEY"), "value-value-value");
  assert.equal(s.redact("x value-value-value y"), "x ••• y");
});
