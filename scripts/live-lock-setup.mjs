// Share a project's live lock between the board and your own Claude Code sessions there (D432).
//
//   node scripts/live-lock-setup.mjs "C:\path\to\project"            turn it on
//   node scripts/live-lock-setup.mjs "C:\path\to\project" --remove   turn it off
//
// Makes `.kanban/locks/` (which turns the board's side on) and adds two hooks to the project's
// `.claude/settings.local.json` — your own settings, which the board's runs never load. Running it
// again replaces the hooks it added before, so it is safe after moving the board's folder.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = process.argv[2] && resolve(process.argv[2]);
const remove = process.argv.includes("--remove");
if (!project || !existsSync(join(project, ".git"))) {
  console.error("Give the project's folder (a git repository): node scripts/live-lock-setup.mjs <folder> [--remove]");
  process.exit(1);
}

const hookFile = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "src", "engine", "liveLockHook.ts").replace(/\\/g, "/");
const command = (event) => `node --disable-warning=ExperimentalWarning "${hookFile}" ${event}`;
const ours = (entry) => JSON.stringify(entry).includes("liveLockHook.ts");

const settingsFile = join(project, ".claude", "settings.local.json");
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
settings.hooks ??= {};
for (const event of ["PreToolUse", "Stop"]) {
  settings.hooks[event] = (settings.hooks[event] ?? []).filter((e) => !ours(e));
  if (!settings.hooks[event].length) delete settings.hooks[event];
}
if (!remove) {
  (settings.hooks.PreToolUse ??= []).push({ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: command("pre"), timeout: 15 }] });
  (settings.hooks.Stop ??= []).push({ hooks: [{ type: "command", command: command("stop"), timeout: 15 }] });
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
mkdirSync(dirname(settingsFile), { recursive: true });
writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

const locks = join(project, ".kanban", "locks");
if (remove) {
  rmSync(locks, { recursive: true, force: true });
} else {
  mkdirSync(locks, { recursive: true });
  // `.kanban/` is the board's: keep it out of the project's git, as worktrees do.
  const exclude = join(project, ".git", "info", "exclude");
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!/^\.kanban\/$/m.test(text)) appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}.kanban/\n`);
}
console.log(remove ? `Live lock turned off for ${project}.` : `Live lock on for ${project}: board cards and your Claude Code sessions there now take turns on its live systems.`);
