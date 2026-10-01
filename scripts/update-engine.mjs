// Keeps Claude's engine current: the Agent SDK and the Claude Code binary inside it. The list of
// models your login can use comes from that binary, so an old one never shows a model that shipped
// after it. The launcher runs this before the server starts; it never stops the board from starting.
//
//   node scripts/update-engine.mjs            check and update (every start, D266)
//   node scripts/update-engine.mjs --force    the same, and says so when there is nothing to do
//   node scripts/update-engine.mjs --check    only say what it would do
//
// The version in server/package.json is the floor this was tested on. A newer patch of the same
// minor is installed over it without touching package.json or the lockfile (so a board update never
// conflicts with it); a new minor or major waits for a board update, because its API may differ.
// A version that does not start is put back and not tried again.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The rule for which version may replace which lives with the server, so the Setup page agrees with it.
// Node 24 loads the .ts file as it is.
import { ENGINE_LATEST_URL, ENGINE_PACKAGE as PKG, parseVersion, shouldInstall } from "../server/src/setup/engine.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = process.env.KANBAN_STATE_DIR ?? join(homedir(), ".claude-kanban");
const STATE_FILE = join(STATE_DIR, "engine-update.json");
const args = new Set(process.argv.slice(2));

const say = (m) => console.log(`Claude's engine: ${m}`);
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

/**
 * Where the server finds the engine. npm puts a version that differs from the lockfile's inside
 * server/node_modules, and the lockfile's own at the top. Looked up on disk each time: Node's own
 * resolver remembers the first answer, which is the wrong one right after an install moves it.
 */
function engineDir() {
  for (const base of [join(ROOT, "server", "node_modules"), join(ROOT, "node_modules")]) {
    const dir = join(base, ...PKG.split("/"));
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}
const installedVersion = () => {
  const dir = engineDir();
  return dir ? (readJson(join(dir, "package.json"), {}).version ?? null) : null;
};

/** Settings → Models & pipeline can switch this off; so can KANBAN_NO_ENGINE_UPDATE=1. */
async function switchedOff() {
  if (process.env.KANBAN_NO_ENGINE_UPDATE === "1") return true;
  const db = join(STATE_DIR, "kanban.db");
  if (!existsSync(db)) return false;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const conn = new DatabaseSync(db, { readOnly: true });
    const row = conn.prepare("SELECT value FROM settings WHERE key = 'autoUpdateEngine'").get();
    conn.close();
    return row?.value === "false";
  } catch {
    return false;
  }
}

function npmInstall(version) {
  // npm is a .cmd shim on Windows and needs a shell, so only a plain x.y.z ever reaches it.
  if (!parseVersion(version)) return "not a version";
  const r = spawnSync(`npm install --no-save --no-audit --no-fund ${PKG}@${version} -w server`, { cwd: ROOT, shell: true, stdio: ["ignore", "ignore", "pipe"], timeout: 10 * 60_000 });
  return r.status === 0 ? null : String(r.stderr ?? r.error ?? "npm failed").trim().split(/\r?\n/).slice(-3).join(" ");
}

/** The new engine loads and its binary answers — without needing a login or sending anything. */
function starts(version) {
  try {
    const bin = join(engineDir() ?? "", "..", `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(bin)) execFileSync(bin, ["--version"], { timeout: 30_000, windowsHide: true, stdio: "pipe" });
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(PKG)}); process.stdout.write(typeof m.query);`], {
      cwd: join(ROOT, "server"), timeout: 30_000, windowsHide: true, stdio: "pipe",
    });
    return String(out) === "function" && installedVersion() === version;
  } catch {
    return false;
  }
}

async function main() {
  const state = readJson(STATE_FILE, {});
  const save = (patch) => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, ...patch }, null, 2));
  };
  // Checked on every start, not twice a day (D266): the Setup row asks npm live, so a skipped check
  // left it saying "start it again to get it" through restarts that then did nothing — after a
  // release newer than the last check, or after a board update's npm install put the old one back.
  if (await switchedOff()) return;

  const installed = installedVersion();
  const floor = readJson(join(ROOT, "server", "package.json"), {}).dependencies?.[PKG];
  if (!installed || !floor) return;

  let latest;
  try {
    const res = await fetch(ENGINE_LATEST_URL, { signal: AbortSignal.timeout(6000) });
    latest = res.ok ? (await res.json()).version : null;
  } catch {
    return; // offline: the board starts on what it has
  }
  if (!latest) return;
  if (!shouldInstall({ installed, latest, floor, skipped: state.skipped })) {
    if (args.has("--force") || args.has("--check")) say(`${installed} is the newest this board can use.`);
    return save({ checkedAt: new Date().toISOString(), latest });
  }
  if (args.has("--check")) return say(`${installed} installed, ${latest} is out.`);

  say(`${latest} is out (this board has ${installed}). Getting it - a minute...`);
  const failed = npmInstall(latest);
  if (!failed && starts(latest)) {
    say(`now ${latest}. New Claude models show up in the pickers by themselves.`);
    return save({ checkedAt: new Date().toISOString(), latest, installed: latest });
  }
  say(`${latest} did not start${failed ? ` (${failed})` : ""}. Putting ${installed} back.`);
  npmInstall(installed);
  save({ checkedAt: new Date().toISOString(), latest, skipped: [...new Set([...(state.skipped ?? []), latest])] });
}

try {
  await main();
} catch (err) {
  say(`could not check for a newer one (${err instanceof Error ? err.message : err}).`);
} finally {
  // Not process.exit(): on Windows it can abort while fetch's sockets are still closing, and the
  // launcher would see a crash. The exit code is set and the process ends by itself.
  process.exitCode = 0;
}
