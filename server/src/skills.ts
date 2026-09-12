import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

function readSkillDir(skillsDir: string, source: SkillInfo["source"], plugin?: string, pluginEnabled = true): SkillInfo[] {
  if (!existsSync(skillsDir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    let fm: Record<string, string> = {};
    try {
      fm = parseFrontmatter(readFileSync(path, "utf8"));
    } catch {
      // unreadable skill file: still list it by directory name
    }
    const base = fm.name || entry.name;
    out.push({ name: plugin ? `${plugin}:${base}` : base, description: fm.description ?? "", source, plugin, pluginEnabled, enabled: pluginEnabled, path });
  }
  return out;
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
    const plugin = key.split("@")[0];
    skills.push(...readSkillDir(join(installPath, "skills"), "plugin", plugin, enabledPlugins[key] === true));
  }

  if (opts.projectPath) skills.push(...readSkillDir(join(opts.projectPath, ".claude", "skills"), "project"));
  return skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}
