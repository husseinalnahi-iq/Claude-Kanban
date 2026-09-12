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
