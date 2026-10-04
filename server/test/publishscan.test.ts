import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error a plain .mjs script, without types
import { loadNames, nameMatchers, scanAdded, wordsOf } from "../../scripts/publish-scan.mjs";

const PUBLIC = "The board runs tasks in a store of cards. A golden path, smart defaults, a test for each, and Slack or Google connectors.";
const diffOf = (file: string, ...lines: string[]) => `+++ b/${file}\n${lines.map((l) => `+${l}`).join("\n")}`;
type Found = { level: string; why: string };
// Put together at run time, so this file never holds an address the publish scan would refuse.
const MAILBOX = ["jane.doe", "corp-mail.co"].join("@");

test("a person's name from the private data is refused whole and on its own, but the project's own words pass (D369)", () => {
  const names = nameMatchers(new Set(["Jane Qorvan Trading", "Golden Sample Store", "Slack", "test"]), wordsOf(PUBLIC));
  const found: Found[] = scanAdded(
    diffOf("docs/DECISIONS.md", "One task (Qorvan 512,000 fix) raised 68 cards", "Paid Jane Qorvan Trading in full", "A golden path through the store", "Slack and Google connectors", "run the test"),
    { blocklist: [], names },
  );
  const blocked = found.filter((f) => f.level === "block").map((f) => f.why);
  assert.ok(blocked.some((w) => w.includes('"qorvan"')), "the given name alone is caught: that is how the last leak looked");
  assert.ok(blocked.some((w) => w.includes("Jane Qorvan Trading")), "and the whole name");
  assert.ok(!blocked.some((w) => /golden|store|slack|google|"test"/i.test(w)), `words the project already uses are not private: ${blocked.join("; ")}`);
  assert.ok(found.some((f) => f.level === "review" && f.why.includes("512,000")) === false, "a 6-digit figure without a currency is not flagged on its own");
});

test("ids from your own board, email addresses, your home folder and key shapes are refused; made-up ones pass (D369)", () => {
  const found: Found[] = scanAdded(
    diffOf(
      "README.md",
      "see t_0123456789abcdef for the run",
      "fixture id t_0000a1b2 is invented",
      `mail ${MAILBOX} or ada@x.io`,
      "cd C:\\Users\\someone\\proj",
      'const key = "sk-ant-api03-' + "A".repeat(60) + '"',
      'process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";',
    ),
    { blocklist: [], boardIds: new Set(["t_0123456789abcdef"]), homes: ["c:\\users\\someone"] },
  );
  const why = found.filter((f) => f.level === "block").map((f) => f.why);
  assert.ok(why.some((w) => w.includes("t_0123456789abcdef")), "a real board id");
  assert.ok(!why.some((w) => w.includes("t_0000a1b2")), "an id the board never handed out is just text");
  assert.ok(why.some((w) => w.includes(MAILBOX)), "a real-looking address");
  assert.ok(!why.some((w) => w.includes("ada@x.io")), "a two-letter test domain is not a mailbox");
  assert.ok(why.some((w) => w.includes("home folder")));
  assert.equal(why.filter((w) => w.includes("Anthropic key")).length, 1, "a real-length key, not a test's placeholder");
});

test("big amounts and unknown web addresses are shown for reading, not refused (D369)", () => {
  const found: Found[] = scanAdded(diffOf("docs/x.md", "It ties to 123,456,789 in the report", "see https://erp.acme-internal.co/app and https://github.com/x/y"), { blocklist: [] });
  assert.deepEqual(found.map((f) => f.level), ["review", "review"]);
  assert.match(found[0].why, /123,456,789/);
  assert.match(found[1].why, /erp\.acme-internal\.co/);
});

test("names are read fresh from the private files a publish points at: JSON, CSV and one file per month (D369)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kpub-"));
  try {
    writeFileSync(join(dir, "pay.json"), JSON.stringify({ data: [{ party_name: "[Consignment] Velmora Shop" }, { party_name: "Tarsel Al-Brook" }] }));
    writeFileSync(join(dir, "staff.csv"), '\uFEFFname,department\n"Doe, Jane",Ops\nZed Person,Ops\n');
    mkdirSync(join(dir, "2026", "01"), { recursive: true });
    writeFileSync(join(dir, "2026", "01", "departments.csv"), "name,department\nMonth Person,Ops\n");
    const names: Set<string> = loadNames([
      { file: join(dir, "pay.json"), json: ["party_name"] },
      { file: "staff.csv", csv: "name" },
      { dir: join(dir, "2026"), each: "departments.csv", csv: "name" },
      { file: join(dir, "missing.csv"), csv: "name" },
    ], dir);
    assert.deepEqual([...names].sort(), ["Doe, Jane", "Month Person", "Tarsel Al-Brook", "Velmora Shop", "Zed Person"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
