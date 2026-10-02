import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { Bus } from "../src/bus.ts";
import { openDb } from "../src/db.ts";
import { TaskRunner } from "../src/engine/runner.ts";
import { Repo } from "../src/repo.ts";
import type { Probe, RunResult } from "../src/setup/probe.ts";
import { buildChecks } from "../src/setup/checks.ts";
import { CATALOG } from "../src/skills/catalog.ts";
import { MARKER, SuggestedSkills } from "../src/skills/install.ts";
import type { WsMessage } from "../src/types.ts";
import { fakeQuery, until } from "./helpers.ts";

/**
 * A computer with git, npm and claude that do just enough: git "downloads" a repo holding the asked-for
 * skill and a sibling folder, and `claude plugin` keeps installed_plugins.json and settings.json.
 */
function machine(opts: { fail?: string; programs?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "khome-"));
  const claude = join(home, ".claude");
  mkdirSync(claude, { recursive: true });
  const calls: string[] = [];
  const plugins = () => join(claude, "plugins", "installed_plugins.json");
  const readPlugins = () => (existsSync(plugins()) ? JSON.parse(readFileSync(plugins(), "utf8")) : { version: 2, plugins: {} });
  const settings = () => (existsSync(join(claude, "settings.json")) ? JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")) : {});
  let repoDir = "";
  let sparse = "";
  const act = (c: string, a: string[]): number => {
    const k = [c, ...a].join(" ");
    calls.push(k);
    if (opts.fail && k.includes(opts.fail)) return 1;
    if (c === "git" && a[0] === "init") repoDir = a[2];
    if (c === "git" && a.includes("sparse-checkout")) sparse = a.at(-1)!;
    if (c === "git" && a.includes("checkout")) {
      for (const p of [sparse, "skills/some-other-skill"]) {
        mkdirSync(join(repoDir, p), { recursive: true });
        writeFileSync(join(repoDir, p, "SKILL.md"), `---\nname: ${p.split("/").at(-1)}\ndescription: d\n---\n`);
      }
    }
    if (c === "claude-bin" && a[1] === "install") {
      const p = readPlugins();
      p.plugins[a[2]] = [{ scope: "user", installPath: join(claude, "plugins", "cache", a[2]) }];
      mkdirSync(join(claude, "plugins"), { recursive: true });
      writeFileSync(plugins(), JSON.stringify(p));
      writeFileSync(join(claude, "settings.json"), JSON.stringify({ ...settings(), enabledPlugins: { ...settings().enabledPlugins, [a[2]]: true } }));
    }
    if (c === "claude-bin" && a[1] === "uninstall") {
      const p = readPlugins();
      delete p.plugins[a[2]];
      writeFileSync(plugins(), JSON.stringify(p));
    }
    if (c === "claude-bin" && (a[1] === "enable" || a[1] === "disable")) {
      writeFileSync(join(claude, "settings.json"), JSON.stringify({ ...settings(), enabledPlugins: { ...settings().enabledPlugins, [a[2]]: a[1] === "enable" } }));
    }
    return 0;
  };
  const probe: Probe = {
    platform: "linux",
    env: {},
    claudeBin: "claude-bin",
    run: async (c, a): Promise<RunResult> => {
      if (c === "claude-bin") return { code: act(c, a), stdout: "", stderr: "" };
      calls.push([c, ...a].join(" "));
      return (opts.programs ?? []).includes(c) ? { code: 0, stdout: "1.0", stderr: "" } : { code: null, stdout: "", stderr: "not found" };
    },
    stream: async (c, a, _o, on) => {
      on(`ran ${[c, ...a].join(" ")}\n`);
      return act(c, a);
    },
    exists: () => false,
    list: () => [],
    fetchJson: async () => {
      throw new Error("offline");
    },
    refreshPath: async () => {},
  };
  const bus = new Bus();
  const events: WsMessage[] = [];
  bus.subscribe((m) => events.push(m));
  const s = new SuggestedSkills({ bus, probe, home });
  const settled = () => until(() => s.busy().length === 0);
  const card = async (id: string) => (await s.list()).find((x) => x.id === id)!;
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  return { s, home, claude, calls, events, settled, card, cleanup };
}

test("every suggested skill has its tooltip, a pinned source, and the starter pack is the five essentials", () => {
  for (const e of CATALOG) {
    assert.ok(e.tooltip.watch.length > 20, `${e.id} needs its "watch out for" text`);
    if (e.kind === "skill") assert.match(e.commit, /^[0-9a-f]{40}$/, `${e.id} is copied from a commit that was read`);
    else if (e.kind === "plugin") assert.ok(e.marketplace && e.marketplaceRepo, `${e.id} names its marketplace`);
    else assert.match(e.check, /^tool:/, `${e.id} is installed by its Setup check`);
  }
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length);
  assert.deepEqual(
    CATALOG.filter((e) => e.starter).map((e) => e.id),
    ["verification-before-completion", "systematic-debugging", "test-driven-development", "ponytail", "code-simplifier"],
  );
  assert.ok(!CATALOG.some((e) => e.id.includes("graphify")), "graphify waits for a person on large folders (D317)");
});

test("a skill installs only its own folder, from the pinned commit, with the board's marker", async () => {
  const m = machine();
  try {
    m.s.install("systematic-debugging");
    await m.settled();
    const entry = CATALOG.find((e) => e.id === "systematic-debugging")!;
    assert.ok(m.calls.some((c) => c.includes(`fetch -q --depth 1 --filter=blob:none origin ${(entry as { commit: string }).commit}`)));
    assert.ok(m.calls.some((c) => c.endsWith("sparse-checkout set skills/systematic-debugging")));
    const dest = join(m.claude, "skills", "systematic-debugging");
    assert.ok(existsSync(join(dest, "SKILL.md")));
    assert.equal(JSON.parse(readFileSync(join(dest, MARKER), "utf8")).repo, "obra/superpowers");
    assert.ok(!existsSync(join(m.claude, "skills", "some-other-skill")), "nothing else from the repo is copied");
    assert.equal((await m.card("systematic-debugging")).status, "installed");
    assert.ok(m.events.some((e) => e.type === "skills.output" && e.id === "systematic-debugging"));

    m.s.remove("systematic-debugging");
    await m.settled();
    assert.ok(!existsSync(dest));
    assert.equal((await m.card("systematic-debugging")).status, "not-installed");
  } finally {
    m.cleanup();
  }
});

test("the board never removes or overwrites a skill folder it did not put there", async () => {
  const m = machine();
  try {
    const mine = join(m.claude, "skills", "test-driven-development");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "---\nname: test-driven-development\n---\nmy own edits\n");
    assert.equal((await m.card("test-driven-development")).status, "installed-elsewhere");
    assert.throws(() => m.s.remove("test-driven-development"), /not installed by the board/);
    assert.throws(() => m.s.install("test-driven-development"), /already installed/);
    assert.equal(readFileSync(join(mine, "SKILL.md"), "utf8").includes("my own edits"), true);
  } finally {
    m.cleanup();
  }
});

test("a skill that came inside another plugin shows as installed elsewhere", async () => {
  const m = machine();
  try {
    const at = join(m.claude, "plugins", "cache", "sp");
    mkdirSync(join(at, "skills", "verification-before-completion"), { recursive: true });
    writeFileSync(join(at, "skills", "verification-before-completion", "SKILL.md"), "---\nname: verification-before-completion\n---\n");
    writeFileSync(join(m.claude, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "superpowers@sp": [{ installPath: at }] } }));
    assert.equal((await m.card("verification-before-completion")).status, "installed-elsewhere");
  } finally {
    m.cleanup();
  }
});

test("a plugin installs from its marketplace for the user, and Remove uninstalls it", async () => {
  const m = machine();
  try {
    m.s.install("ponytail");
    await m.settled();
    assert.deepEqual(m.calls, [
      "claude-bin plugin marketplace add DietrichGebert/ponytail --scope user",
      "claude-bin plugin install ponytail@ponytail --scope user",
    ]);
    const c = await m.card("ponytail");
    assert.equal(c.status, "installed");
    assert.equal(c.enabled, null, "its skills are switched in the Skills list, not on the card");
    m.s.remove("ponytail");
    await m.settled();
    assert.equal(m.calls.at(-1), "claude-bin plugin uninstall ponytail@ponytail --scope user");
    assert.equal((await m.card("ponytail")).status, "not-installed");
  } finally {
    m.cleanup();
  }
});

test("a plugin with no skills is switched on and off from its card, in the user's settings", async () => {
  const m = machine();
  try {
    m.s.install("context7-plugin");
    await m.settled();
    assert.equal((await m.card("context7-plugin")).enabled, true);
    const off = await m.s.setEnabled("context7-plugin", false);
    assert.equal(off.enabled, false);
    assert.equal(m.calls.at(-1), "claude-bin plugin disable context7@claude-plugins-official --scope user");
    assert.equal((await m.s.setEnabled("context7-plugin", true)).enabled, true);
    await assert.rejects(m.s.setEnabled("ponytail", false), /Skills list/);
  } finally {
    m.cleanup();
  }
});

test("the starter pack installs what is missing, one after another, and skips what is there", async () => {
  const m = machine();
  try {
    const there = join(m.claude, "skills", "test-driven-development");
    mkdirSync(there, { recursive: true });
    writeFileSync(join(there, "SKILL.md"), "---\nname: test-driven-development\n---\n");
    const queued = m.s.installStarter();
    assert.deepEqual(queued, ["verification-before-completion", "systematic-debugging", "ponytail", "code-simplifier"]);
    assert.equal(m.s.busy().length, 4, "every card shows it is waiting its turn at once");
    await m.settled();
    for (const id of queued) assert.equal((await m.card(id)).status, "installed", id);
    assert.deepEqual(m.s.installStarter(), [], "a second click has nothing left to do");
  } finally {
    m.cleanup();
  }
});

test("a failed install shows the end of its output on the card and leaves nothing behind", async () => {
  const m = machine({ fail: "fetch" });
  try {
    m.s.install("react-best-practices");
    await m.settled();
    const c = await m.card("react-best-practices");
    assert.equal(c.status, "not-installed");
    assert.match(c.error ?? "", /exit code 1/);
    assert.ok(!existsSync(join(m.claude, "skills", "react-best-practices")));
  } finally {
    m.cleanup();
  }
});

test("playwright-cli installs its command first, and Remove leaves that command alone", async () => {
  const m = machine();
  try {
    m.s.install("playwright-cli");
    await m.settled();
    assert.equal(m.calls[0], "npm install -g @playwright/cli@latest");
    assert.ok(existsSync(join(m.claude, "skills", "playwright-cli", "SKILL.md")));
    m.s.remove("playwright-cli");
    await m.settled();
    assert.ok(!m.calls.some((c) => c.startsWith("npm uninstall")));
  } finally {
    m.cleanup();
  }
});

test("a card names the programs it needs that this computer lacks", async () => {
  const none = machine();
  const both = machine({ programs: ["python3", "soffice"] });
  try {
    assert.deepEqual((await none.card("document-skills")).missing, ["Python", "LibreOffice"]);
    assert.deepEqual((await both.card("document-skills")).missing, []);
    assert.deepEqual((await none.card("ponytail")).missing, []);
  } finally {
    none.cleanup();
    both.cleanup();
  }
});

test("the Suggested list says what kind of project is open, and its actions answer over the API", async () => {
  const m = machine();
  const proj = mkdtempSync(join(tmpdir(), "kproj-"));
  writeFileSync(join(proj, "package.json"), JSON.stringify({ dependencies: { react: "^19" } }));
  const repo = new Repo(openDb(":memory:"));
  const bus = new Bus();
  const project = repo.createProject({ name: "web", path: proj, policy: {} as never });
  const app = await buildApp({ repo, bus, runner: new TaskRunner({ repo, bus, queryFn: fakeQuery().fn }), suggested: m.s, allowedHosts: ["localhost:80"] });
  const post = (url: string, payload?: object) => app.inject({ method: "POST", url: `/api${url}`, payload: payload ?? {} });
  try {
    const r = (await app.inject({ method: "GET", url: `/api/skills/suggested?project=${project.id}` })).json();
    assert.deepEqual(r.project, { web: true, react: true });
    assert.equal(r.skills.length, CATALOG.length);
    assert.equal((await post("/skills/suggested/nope/install")).statusCode, 404);
    assert.equal((await post("/skills/suggested/ponytail/remove")).statusCode, 409, "nothing to remove yet");
    assert.equal((await post("/skills/suggested/ponytail/install")).statusCode, 200);
    await m.settled();
    assert.equal((await post("/skills/suggested/ponytail/enabled", { on: false })).statusCode, 409);
    assert.equal((await post("/skills/suggested/context7-plugin/enabled", { on: "no" })).statusCode, 400);
  } finally {
    await app.close();
    rmSync(proj, { recursive: true, force: true });
    m.cleanup();
  }
});

test("the Setup row counts the starter pack, says what is installing, and offers to install the rest", async () => {
  const m = machine();
  try {
    const repo = new Repo(openDb(":memory:"));
    const row = buildChecks(repo.getSettings()).find((c) => c.id === "starter-skills")!;
    assert.equal(row.level, "optional", "it never adds to the Setup badge");
    let busy: string[] = [];
    const detect = () => row.detect({ probe: {} as Probe, settings: repo.getSettings(), hasSecret: () => false, home: m.home, skillsBusy: () => busy });
    let d = await detect();
    assert.equal(d.ok, false);
    assert.match(d.detail, /^0 of 5 installed · missing: verification-before-completion/);
    assert.deepEqual(d.action, { label: "Install the starter pack", endpoint: "/skills/suggested/starter" });
    busy = ["ponytail"];
    d = await detect();
    assert.match(d.detail, /installing Ponytail…$/);
    assert.equal(d.action, undefined, "no second click while it installs");
    m.s.installStarter();
    await m.settled();
    busy = [];
    d = await detect();
    assert.equal(d.ok, true);
    assert.equal(d.detail, "5 of 5 installed");
  } finally {
    m.cleanup();
  }
});
