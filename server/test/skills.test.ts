import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, scanSkills } from "../src/skills.ts";

test("parseFrontmatter handles plain, quoted and block values", () => {
  const fm = parseFrontmatter(
    [
      "---",
      "name: pdf",
      'description: "Use when: reading PDFs"',
      "long: >",
      "  folded line one",
      "  line two",
      "lit: |",
      "  a",
      "  b",
      "---",
      "# body",
    ].join("\n"),
  );
  assert.equal(fm.name, "pdf");
  assert.equal(fm.description, "Use when: reading PDFs");
  assert.equal(fm.long, "folded line one line two");
  assert.equal(fm.lit, "a\nb");
  assert.deepEqual(parseFrontmatter("# no frontmatter"), {});
});

function skill(dir: string, name: string, description: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
}

test("scanSkills groups user, plugin and project skills", () => {
  const home = mkdtempSync(join(tmpdir(), "khome-"));
  const proj = mkdtempSync(join(tmpdir(), "kproj-"));
  try {
    skill(join(home, ".claude", "skills", "gemini-image"), "gemini-image", "Generate images");
    const active = join(home, ".claude", "plugins", "cache", "mk", "superpowers", "5.0.7");
    const stale = join(home, ".claude", "plugins", "cache", "mk", "superpowers", "4.0.0");
    skill(join(active, "skills", "brainstorming"), "brainstorming", "Explore intent");
    skill(join(stale, "skills", "old-skill"), "old-skill", "stale version");
    const off = join(home, ".claude", "plugins", "cache", "mk", "disabled-plugin", "1.0.0");
    skill(join(off, "skills", "thing"), "thing", "Disabled plugin skill");
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "superpowers@mk": [{ installPath: active }], "disabled-plugin@mk": [{ installPath: off }] } }),
    );
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@mk": true, "disabled-plugin@mk": false } }));
    skill(join(proj, ".claude", "skills", "deploy"), "deploy", "Ship it");

    const skills = scanSkills({ home, projectPath: proj });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    assert.equal(byName["gemini-image"].source, "user");
    assert.equal(byName["superpowers:brainstorming"].source, "plugin");
    assert.equal(byName["superpowers:brainstorming"].enabled, true);
    assert.equal(byName["disabled-plugin:thing"].enabled, false);
    assert.equal(byName["deploy"].source, "project");
    assert.equal(byName["superpowers:old-skill"], undefined, "stale plugin versions are ignored");
    assert.equal(byName["gemini-image"].description, "Generate images");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("a plugin's skills are found where its plugin.json says, as well as in skills/, and never outside the plugin", () => {
  const home = mkdtempSync(join(tmpdir(), "khome-"));
  try {
    const plugins = join(home, ".claude", "plugins");
    // ui-ux-pro-max's layout: its skills live in .claude/skills/, named by plugin.json.
    const pro = join(plugins, "cache", "m", "pro", "2.0.0");
    skill(join(pro, ".claude", "skills", "ui-ux-pro-max"), "ui-ux-pro-max", "Design search");
    skill(join(pro, ".claude", "skills", "brand"), "brand", "Brand");
    skill(join(pro, "skills", "also"), "also", "Default folder still read");
    skill(join(home, "outside", "evil"), "evil", "Not the plugin's");
    mkdirSync(join(pro, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pro, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "pro", skills: ["./.claude/skills/", "../../../../../outside"] }));
    // One folder holding SKILL.md, named directly.
    const single = join(plugins, "cache", "m", "single", "1.0.0");
    skill(join(single, "tool"), "one-tool", "Named directly");
    mkdirSync(join(single, ".claude-plugin"), { recursive: true });
    writeFileSync(join(single, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "single", skills: "./tool" }));
    // No skills/ and no manifest key: the SKILL.md at the root is the plugin's one skill.
    const bare = join(plugins, "cache", "m", "bare", "1.0.0");
    skill(bare, "bare-skill", "At the root");
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "pro@m": [{ installPath: pro }], "single@m": [{ installPath: single }], "bare@m": [{ installPath: bare }] } }),
    );
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "pro@m": true, "single@m": true, "bare@m": true } }));

    const names = scanSkills({ home }).map((s) => s.name).sort();
    assert.deepEqual(names, ["bare:bare-skill", "pro:also", "pro:brand", "pro:ui-ux-pro-max", "single:one-tool"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
