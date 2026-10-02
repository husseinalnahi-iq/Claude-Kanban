import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Bus } from "../bus.ts";
import { ConflictError, NotFoundError } from "../engine/runner.ts";
import { realProbe, type Probe } from "../setup/probe.ts";
import { scanSkills } from "../skills.ts";
import type { SuggestedSkill } from "../types.ts";
import { CATALOG, checkOf, fromOf, linkOf, pluginKey, skillDir, type CatalogEntry, type CatalogPlugin, type CatalogSkill } from "./catalog.ts";

/** Written into every skill folder the board installs: Remove deletes a folder only when it is there. */
export const MARKER = ".kanban-installed.json";

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** What kind of project this is, for "Good for this project" on a card. */
export function projectFits(projectPath: string | undefined): { web: boolean; react: boolean } {
  if (!projectPath) return { web: false, react: false };
  const pkg = readJson(join(projectPath, "package.json"));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies } as Record<string, string>;
  const react = "react" in deps;
  const web = react || ["vue", "svelte", "next", "vite", "@angular/core", "astro", "solid-js"].some((d) => d in deps) || existsSync(join(projectPath, "index.html"));
  return { web, react };
}

/** Whether a catalog entry is on this computer, and whether the board put it there. Reads files only. */
export function entryStatus(e: CatalogEntry, home: string = homedir()): SuggestedSkill["status"] {
  const claudeDir = join(home, ".claude");
  if (e.kind === "tool") return "unknown";
  const named = (want: string) => scanSkills({ home }).some((s) => s.name.split(":").at(-1) === want);
  if (e.kind === "plugin") {
    const installs = readJson(join(claudeDir, "plugins", "installed_plugins.json"))?.plugins?.[pluginKey(e)];
    if (Array.isArray(installs) && installs.length) return "installed";
    return e.skillName && named(e.skillName) ? "installed-elsewhere" : "not-installed";
  }
  const dir = join(claudeDir, "skills", skillDir(e));
  if (existsSync(join(dir, "SKILL.md"))) return existsSync(join(dir, MARKER)) ? "installed" : "installed-elsewhere";
  // The same skill can arrive another way: the whole superpowers plugin, or a copy under another folder name.
  return named(e.skillName ?? skillDir(e)) ? "installed-elsewhere" : "not-installed";
}

/**
 * The Skills tab's Suggested section: installs, removes and switches the catalog's skills and plugins,
 * one at a time — two `claude plugin` commands at once would both rewrite installed_plugins.json.
 * Progress goes out on the bus, like the Setup page's fixes.
 */
export class SuggestedSkills {
  private readonly probe: Probe;
  private readonly home: string;
  private readonly catalog: CatalogEntry[];
  private running = new Map<string, "install" | "remove">();
  private errors = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private found: { at: number; has: Record<string, boolean> } | null = null;

  constructor(private readonly deps: { bus: Bus; probe?: Probe; home?: string; catalog?: CatalogEntry[] }) {
    this.probe = deps.probe ?? realProbe;
    this.home = deps.home ?? homedir();
    this.catalog = deps.catalog ?? CATALOG;
  }

  private get claudeDir(): string {
    return join(this.home, ".claude");
  }

  /** Installs or removals queued or under way, so the launcher does not restart the board over one. */
  busy(): string[] {
    return [...this.running.keys()];
  }

  private find(id: string): CatalogEntry {
    const e = this.catalog.find((x) => x.id === id);
    if (!e) throw new NotFoundError(`No suggested skill "${id}".`);
    return e;
  }

  private skillFolder(e: CatalogSkill): string {
    return join(this.claudeDir, "skills", skillDir(e));
  }

  private status(e: CatalogEntry): SuggestedSkill["status"] {
    return entryStatus(e, this.home);
  }

  private pluginEnabled(e: CatalogPlugin): boolean {
    return readJson(join(this.claudeDir, "settings.json"))?.enabledPlugins?.[pluginKey(e)] === true;
  }

  /** Whether python and LibreOffice are on this computer. Asked at most once a minute: each is a process. */
  private async programs(): Promise<Record<string, boolean>> {
    if (this.found && Date.now() - this.found.at < 60_000) return this.found.has;
    const answers = async (cmds: [string, string[]][]) => {
      for (const [c, a] of cmds) if ((await this.probe.run(c, a, { timeoutMs: 10_000 })).code === 0) return true;
      return false;
    };
    const win = this.probe.platform === "win32";
    const sofficePaths = win
      ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"]
      : ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
    const [python, libreoffice] = await Promise.all([
      answers(win ? [["python", ["--version"]], ["py", ["--version"]]] : [["python3", ["--version"]], ["python", ["--version"]]]),
      sofficePaths.some((p) => this.probe.exists(p)) ? Promise.resolve(true) : answers([["soffice", ["--version"]]]),
    ]);
    this.found = { at: Date.now(), has: { python, libreoffice } };
    return this.found.has;
  }

  private view(e: CatalogEntry, has: Record<string, boolean>): SuggestedSkill {
    const status = this.status(e);
    const label = { python: "Python", libreoffice: "LibreOffice" } as const;
    return {
      id: e.id,
      name: e.name,
      what: e.what,
      kind: e.kind,
      link: linkOf(e),
      check: checkOf(e),
      from: fromOf(e),
      starter: Boolean(e.starter),
      fits: e.fits ?? null,
      needsPython: Boolean(e.needsPython),
      tooltip: e.tooltip,
      status,
      enabled: e.kind === "plugin" && e.noSkills && status === "installed" ? this.pluginEnabled(e) : null,
      missing: (e.needs ?? []).filter((n) => has[n] === false).map((n) => label[n]),
      running: this.running.get(e.id) ?? null,
      error: this.errors.get(e.id) ?? null,
    };
  }

  async list(): Promise<SuggestedSkill[]> {
    const has = this.catalog.some((e) => e.needs?.length) ? await this.programs() : {};
    return this.catalog.map((e) => this.view(e, has));
  }

  async get(id: string): Promise<SuggestedSkill> {
    const e = this.find(id);
    return this.view(e, e.needs?.length ? await this.programs() : {});
  }

  private publish(id: string): Promise<void> {
    return this.get(id).then((skill) => this.deps.bus.publish({ type: "skills.suggested", skill }));
  }

  /** Queues one job; the card shows it as running from now, not from when its turn comes. */
  private enqueue(id: string, what: "install" | "remove", job: (out: (s: string) => void) => Promise<void>): void {
    this.running.set(id, what);
    this.errors.delete(id);
    void this.publish(id).catch(() => {});
    this.queue = this.queue.then(async () => {
      let log = "";
      const out = (chunk: string) => {
        log = (log + chunk).slice(-4000);
        this.deps.bus.publish({ type: "skills.output", id, chunk });
      };
      try {
        await job(out);
      } catch (err) {
        out(`\n${err instanceof Error ? err.message : String(err)}\n`);
        this.errors.set(id, log.trim().split("\n").slice(-12).join("\n"));
      } finally {
        this.running.delete(id);
        this.found = null; // an install may have brought a program with it
        await this.publish(id).catch(() => {});
      }
    });
  }

  /** Runs one command and fails the job when it does; the user sees each command before its output. */
  private async step(out: (s: string) => void, command: string, args: string[], timeoutMs = 5 * 60_000): Promise<void> {
    out(`$ ${[command, ...args].join(" ")}\n`);
    const code = await this.probe.stream(command, args, { timeoutMs, cwd: this.home }, out);
    if (code !== 0) throw new Error(code === null ? `${command} could not start. Is it installed?` : `It stopped with exit code ${code}.`);
  }

  /** A tool installs through its Setup check (`POST /setup/:check/fix`), not here. */
  private notTool(e: CatalogEntry): asserts e is CatalogSkill | CatalogPlugin {
    if (e.kind === "tool") throw new ConflictError(`${e.name} is installed from its own card, through Setup.`);
  }

  install(id: string): void {
    const e = this.find(id);
    this.notTool(e);
    if (this.running.has(id)) throw new ConflictError(`${e.name} is already being changed.`);
    const status = this.status(e);
    if (status !== "not-installed") throw new ConflictError(`${e.name} is already installed.`);
    this.enqueue(id, "install", (out) => (e.kind === "skill" ? this.installSkill(e, out) : this.installPlugin(e, out)));
  }

  /** Every starter-pack entry not on this computer yet, one after another. Returns the ones queued. */
  installStarter(): string[] {
    const ids = this.catalog.filter((e) => e.starter && !this.running.has(e.id) && this.status(e) === "not-installed").map((e) => e.id);
    for (const id of ids) this.install(id);
    return ids;
  }

  remove(id: string): void {
    const e = this.find(id);
    this.notTool(e);
    if (this.running.has(id)) throw new ConflictError(`${e.name} is already being changed.`);
    const status = this.status(e);
    if (status === "not-installed") throw new ConflictError(`${e.name} is not installed.`);
    if (e.kind === "skill" && status !== "installed") {
      throw new ConflictError(`${e.name} was not installed by the board, so the board leaves it alone.`);
    }
    this.enqueue(id, "remove", async (out) => {
      if (e.kind === "plugin") return this.step(out, this.probe.claudeBin, ["plugin", "uninstall", pluginKey(e), "--scope", "user"]);
      // Checked again at its turn: the folder may have changed while the job waited.
      const dir = this.skillFolder(e);
      if (!existsSync(join(dir, MARKER))) throw new Error(`${dir} has no board marker any more, so it was left alone.`);
      rmSync(dir, { recursive: true, force: true });
      out(`Removed ${dir}\n`);
      // The global npm tool stays: the user may use it outside the board.
    });
  }

  /** The card switch of a plugin with no skills (D319). */
  async setEnabled(id: string, on: boolean): Promise<SuggestedSkill> {
    const e = this.find(id);
    if (e.kind !== "plugin" || !e.noSkills) throw new ConflictError(`${e.name} is switched on and off in the Skills list.`);
    if (this.status(e) !== "installed") throw new ConflictError(`${e.name} is not installed.`);
    if (this.running.has(id)) throw new ConflictError(`${e.name} is already being changed.`);
    // --scope user: left to guess, the CLI writes to the project settings of whatever folder it runs in.
    const r = await this.probe.run(this.probe.claudeBin, ["plugin", on ? "enable" : "disable", pluginKey(e), "--scope", "user"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new ConflictError(`Could not turn ${e.name} ${on ? "on" : "off"}: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? "no answer"}`);
    await this.publish(id);
    return this.get(id);
  }

  private async installPlugin(e: CatalogPlugin, out: (s: string) => void): Promise<void> {
    // Adding a marketplace that is already there succeeds and changes nothing.
    await this.step(out, this.probe.claudeBin, ["plugin", "marketplace", "add", e.marketplaceRepo, "--scope", "user"]);
    await this.step(out, this.probe.claudeBin, ["plugin", "install", pluginKey(e), "--scope", "user"]);
  }

  private async installSkill(e: CatalogSkill, out: (s: string) => void): Promise<void> {
    const dest = this.skillFolder(e);
    const clash = () => existsSync(dest) && !existsSync(join(dest, MARKER));
    if (clash()) throw new Error(`There is already a folder at ${dest} that the board did not put there, so it was left alone.`);
    if (e.npmTool) await this.step(out, "npm", ["install", "-g", e.npmTool]);
    const tmp = mkdtempSync(join(tmpdir(), "kanban-skill-"));
    try {
      // Only the skill's folder, at the commit that was read: a skill is instructions an unattended run follows.
      await this.step(out, "git", ["init", "-q", tmp]);
      await this.step(out, "git", ["-C", tmp, "remote", "add", "origin", `https://github.com/${e.repo}.git`]);
      await this.step(out, "git", ["-C", tmp, "sparse-checkout", "set", e.path]);
      await this.step(out, "git", ["-C", tmp, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", e.commit]);
      await this.step(out, "git", ["-C", tmp, "checkout", "-q", "FETCH_HEAD"]);
      const src = join(tmp, ...e.path.split("/"));
      if (!existsSync(join(src, "SKILL.md"))) throw new Error(`${e.repo} has no SKILL.md at ${e.path} in commit ${e.commit.slice(0, 7)}.`);
      if (clash()) throw new Error(`A folder appeared at ${dest} while downloading, so it was left alone.`);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(join(this.claudeDir, "skills"), { recursive: true });
      cpSync(src, dest, { recursive: true });
      writeFileSync(join(dest, MARKER), JSON.stringify({ by: "claude-kanban", repo: e.repo, path: e.path, commit: e.commit, installedAt: new Date().toISOString() }, null, 2));
      out(`Installed to ${dest}\n`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
