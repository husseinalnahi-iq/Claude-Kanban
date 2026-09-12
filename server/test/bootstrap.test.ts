import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorktreeInclude, runProjectCommand, seedWorktree, freePort } from "../src/git/bootstrap.ts";

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kboot-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("readWorktreeInclude merges the repo file with project settings and drops comments", () => {
  const dir = repoWith({ ".gitignore": ".env\n", ".worktreeinclude": "# secrets\n.env\n\n!keep-me\ncerts/**\n" });
  try {
    assert.deepEqual(readWorktreeInclude(dir, ["config/local.json", " "]), [".env", "certs/**", "config/local.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedWorktree copies gitignored files and never tracked ones", async () => {
  const dir = repoWith({ ".gitignore": ".env\ncerts/\n", "tracked.txt": "committed", ".worktreeinclude": ".env\n" });
  writeFileSync(join(dir, ".env"), "SECRET=1");
  mkdirSync(join(dir, "certs"), { recursive: true });
  writeFileSync(join(dir, "certs", "dev.pem"), "pem");
  const wt = mkdtempSync(join(tmpdir(), "kwt-"));
  try {
    const report = await seedWorktree(dir, wt, [".env", "certs/**", "tracked.txt", "missing.txt"]);
    assert.deepEqual(report.copied.sort(), [".env", "certs/dev.pem"].sort());
    assert.deepEqual(report.skippedTracked, ["tracked.txt"], "a tracked file is never duplicated into a worktree");
    assert.equal(readFileSync(join(wt, ".env"), "utf8"), "SECRET=1");
    assert.equal(existsSync(join(wt, "tracked.txt")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("seedWorktree refuses patterns that escape the project", async () => {
  const dir = repoWith({ ".gitignore": "secret.txt\n" });
  writeFileSync(join(dir, "..", "outside.txt"), "nope");
  const wt = mkdtempSync(join(tmpdir(), "kwt-"));
  try {
    const report = await seedWorktree(dir, wt, ["../outside.txt"]);
    assert.deepEqual(report.copied, []);
    assert.equal(existsSync(join(wt, "..", "outside.txt")) && existsSync(join(wt, "outside.txt")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("runProjectCommand reports success, failure and trims long output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kcmd-"));
  try {
    const ok = await runProjectCommand("node -e \"console.log('hello from verify')\"", dir);
    assert.equal(ok.ok, true);
    assert.match(ok.output, /hello from verify/);

    const bad = await runProjectCommand("node -e \"console.error('tests failed: 2 failing'); process.exit(1)\"", dir);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 1);
    assert.match(bad.output, /2 failing/);

    const long = await runProjectCommand("node -e \"console.log('x'.repeat(20000))\"", dir, { tailBytes: 500 });
    assert.ok(long.output.length < 2000);
    assert.match(long.output, /bytes trimmed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("freePort returns a usable port", async () => {
  const port = await freePort();
  assert.ok(port > 1024 && port < 65536);
});
