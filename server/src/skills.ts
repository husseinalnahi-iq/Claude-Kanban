import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { SkillInfo } from "./types.ts";

/** Minimal YAML frontmatter reader: `key: value`, quoted values, and `>` / `|` block scalars. */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    const block = /^([>|])[+-]?$/.exec(raw.trim());
    if (block) {
      const body: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) body.push(lines[++i].trim());
      while (body.length && body.at(-1) === "") body.pop();
      out[key] = block[1] === ">" ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n");
    } else {
      out[key] = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return out;
}

/** One skill folder (the one holding SKILL.md). */
function readSkill(dir: string, source: SkillInfo["source"], plugin?: string, pluginEnabled = true): SkillInfo {
  const path = join(dir, "SKILL.md");
  let fm: Record<string, string> = {};
  try {
    fm = parseFrontmatter(readFileSync(path, "utf8"));
  } catch {
    // unreadable skill file: still list it by directory name
  }
  const base = fm.name || basename(dir);
  return { name: plugin ? `${plugin}:${base}` : base, description: fm.description ?? "", source, plugin, pluginEnabled, enabled: pluginEnabled, path };
}

function readSkillDir(skillsDir: string, source: SkillInfo["source"], plugin?: string, pluginEnabled = true): SkillInfo[] {
  if (!existsSync(skillsDir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(skillsDir, entry.name, "SKILL.md"))) continue;
    out.push(readSkill(join(skillsDir, entry.name), source, plugin, pluginEnabled));
  }
  return out;
}

/**
 * Where a plugin keeps its skills, as Claude Code reads them: `skills/`, plus whatever its plugin.json
 * `skills` names (a folder of skill folders, or one skill folder), kept inside the plugin. Without
 * either, a SKILL.md at the plugin's root is the one skill. Reading only `skills/` missed plugins such
 * as ui-ux-pro-max, which keep theirs in `.claude/skills/`: no card, and no switch that worked.
 */
function readPlugin(installPath: string, plugin: string, enabled: boolean): SkillInfo[] {
  const declared: unknown = readJson(join(installPath, ".claude-plugin", "plugin.json"))?.skills;
  const extra = (typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : []).filter((p): p is string => typeof p === "string");
  const root = resolve(installPath);
  // On another drive `relative` gives an absolute path; `..` is outside. Claude Code refuses both.
  const inside = (d: string) => !relative(root, d).startsWith("..") && !isAbsolute(relative(root, d));
  const dirs = [resolve(root, "skills"), ...extra.map((p) => resolve(root, p))].filter(inside);
  if (!extra.length && !existsSync(dirs[0]) && existsSync(join(root, "SKILL.md"))) return [readSkill(root, "plugin", plugin, enabled)];
  const byPath = new Map<string, SkillInfo>();
  for (const d of new Set(dirs)) {
    const found = existsSync(join(d, "SKILL.md")) ? [readSkill(d, "plugin", plugin, enabled)] : readSkillDir(d, "plugin", plugin, enabled);
    for (const s of found) byPath.set(s.path, s);
  }
  return [...byPath.values()];
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function scanSkills(opts: { home?: string; projectPath?: string } = {}): SkillInfo[] {
  const claudeDir = join(opts.home ?? homedir(), ".claude");
  const skills: SkillInfo[] = [...readSkillDir(join(claudeDir, "skills"), "user")];

  const installed = readJson(join(claudeDir, "plugins", "installed_plugins.json"))?.plugins ?? {};
  const enabledPlugins: Record<string, boolean> = readJson(join(claudeDir, "settings.json"))?.enabledPlugins ?? {};
  for (const [key, installs] of Object.entries(installed) as [string, { installPath?: string }[]][]) {
    const installPath = installs?.at(-1)?.installPath;
    if (!installPath) continue;
    skills.push(...readPlugin(installPath, key.split("@")[0], enabledPlugins[key] === true));
  }

  if (opts.projectPath) skills.push(...readSkillDir(join(opts.projectPath, ".claude", "skills"), "project"));
  return skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}
