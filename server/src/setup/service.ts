import type { Bus } from "../bus.ts";
import type { Repo } from "../repo.ts";
import { ConflictError, NotFoundError, type TaskRunner } from "../engine/runner.ts";
import type { SetupCheckResult, Task } from "../types.ts";
import { buildChecks, type CheckCtx, type Detected, type SetupCheck } from "./checks.ts";
import { realProbe, type Probe } from "./probe.ts";

const LABEL = "setup:";
const CLOSED: Task["status"][] = ["done", "failed"];
const OS_NAME: Partial<Record<NodeJS.Platform, string>> = { win32: "Windows (PowerShell available; winget is the usual installer)", darwin: "macOS (Homebrew if installed)", linux: "Linux" };

/** The task a supervised Claude session works from. */
export function setupSpec(c: SetupCheck, d: Detected, platform: NodeJS.Platform): string {
  const goal = c.claude?.goal ?? `Make this setup check pass: ${c.title}.`;
  const usual = c.manual?.[platform] ?? c.run?.({}).map((x) => [x.command, ...x.args].join(" ")).join("\n");
  const doneWhen = c.claude?.doneWhen ?? "the check's own command";
  return [
    `## Goal\n\n${goal}`,
    `## This computer\n\n- OS: ${OS_NAME[platform] ?? platform}\n- What the board found: ${d.detail}`,
    usual ? `## The usual way\n\n\`\`\`\n${usual}\n\`\`\`` : "",
    "## Rules\n\n" +
      "- Install only this. Change nothing else on the computer.\n" +
      "- Prefer the OS package manager (winget on Windows, Homebrew on macOS, the distribution's on Linux).\n" +
      "- If it needs administrator rights, a restart, or a download you are unsure about, say so and stop.\n" +
      `- Finish by checking that ${doneWhen} works, and report what it printed.`,
  ].filter(Boolean).join("\n\n");
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`No answer after ${ms / 1000}s`)), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Detects what this machine has, runs the built-in fixes, and hands the rest to a supervised Claude
 * session. Results are cached briefly and never stored: the machine is the source of truth.
 */
export class SetupService {
  readonly probe: Probe;
  private cache = new Map<string, { at: number; d: Detected }>();
  private running = new Set<string>();

  constructor(private readonly deps: { repo: Repo; bus: Bus; runner: TaskRunner; stateDir: string; probe?: Probe }) {
    this.probe = deps.probe ?? realProbe;
    // A Claude session that stops (for review, done or failed) may have installed something: look again.
    deps.bus.subscribe((m) => {
      if (m.type !== "task.updated") return;
      const id = m.task.labels.find((l) => l.startsWith(LABEL))?.slice(LABEL.length);
      if (!id || !["review", "done", "failed"].includes(m.task.status)) return;
      void this.probe.refreshPath().then(() => this.recheck(id)).catch(() => {});
    });
  }

  settings() {
    return this.deps.repo.getSettings();
  }

  private ctx(): CheckCtx {
    return { probe: this.probe, settings: this.deps.repo.getSettings(), hasSecret: (n) => this.deps.runner.secrets.has(n) };
  }

  private find(id: string): SetupCheck {
    const c = buildChecks(this.deps.repo.getSettings()).find((x) => x.id === id);
    if (!c) throw new NotFoundError(`No setup check "${id}".`);
    return c;
  }

  private async detect(c: SetupCheck, fresh: boolean): Promise<Detected> {
    const hit = this.cache.get(c.id);
    if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.d;
    let d: Detected;
    try {
      d = await withTimeout(c.detect(this.ctx()), 20_000);
    } catch (e) {
      d = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    this.cache.set(c.id, { at: Date.now(), d });
    return d;
  }

  /** Claude can take on anything the board cannot do itself, except what Claude needs to run, and your own name. */
  private claudeCan(c: SetupCheck): boolean {
    return c.id !== "node" && !c.login && !c.form && Boolean(c.claude || c.run);
  }

  private openTask(id: string): Task | undefined {
    const p = this.deps.repo.findSetupProject();
    if (!p) return undefined;
    return this.deps.repo.listTasks({ project_id: p.id }).filter((t) => t.labels.includes(LABEL + id) && !CLOSED.includes(t.status)).at(-1);
  }

  private result(c: SetupCheck, d: Detected): SetupCheckResult {
    const fixes: SetupCheckResult["fixes"] = [];
    if (!d.ok && !d.blockedBy) {
      if (c.login) fixes.push("login");
      if (c.run) fixes.push("run");
      if (this.claudeCan(c)) fixes.push("claude");
    }
    return {
      id: c.id,
      title: c.title,
      level: c.level,
      why: c.why,
      ok: d.ok,
      detail: d.detail,
      fixes,
      runLabel: c.runLabel ?? null,
      form: c.form ? c.form.map(({ name, label, placeholder }) => ({ name, label, placeholder })) : null,
      manual: c.manual?.[this.probe.platform] ?? null,
      link: c.link ?? null,
      running: this.running.has(c.id),
      taskId: this.openTask(c.id)?.id ?? null,
    };
  }

  async all(fresh = false): Promise<SetupCheckResult[]> {
    const checks = buildChecks(this.deps.repo.getSettings());
    return Promise.all(checks.map(async (c) => this.result(c, await this.detect(c, fresh))));
  }

  async recheck(id: string): Promise<SetupCheckResult> {
    const c = this.find(id);
    const r = this.result(c, await this.detect(c, true));
    this.deps.bus.publish({ type: "setup.updated", check: r });
    return r;
  }

  /** Starts a built-in fix. Returns once it is running; output and the new result arrive over the bus. */
  startRun(id: string, input: Record<string, string>): void {
    const c = this.find(id);
    if (!c.run) throw new ConflictError(`${c.title} has no one-click fix.`);
    if (this.running.has(id)) throw new ConflictError(`${c.title} is already being fixed.`);
    const clean: Record<string, string> = {};
    for (const f of c.form ?? []) clean[f.name] = f.schema.parse(input[f.name] ?? ""); // ZodError → 400
    const commands = c.run(clean);
    this.running.add(id);
    const out = (chunk: string) => this.deps.bus.publish({ type: "setup.output", id, chunk });
    void (async () => {
      try {
        for (const cmd of commands) {
          out(`$ ${[cmd.command, ...cmd.args].join(" ")}\n`);
          const code = await this.probe.stream(cmd.command, cmd.args, { timeoutMs: cmd.timeoutMs ?? 2 * 60_000 }, out);
          if (code !== 0) {
            out(`\n[exited with ${code ?? "an error: the program could not start"}]\n`);
            break;
          }
        }
      } finally {
        this.running.delete(id);
        await this.probe.refreshPath().catch(() => {});
        await this.recheck(id).catch(() => {});
      }
    })();
  }

  /** Hands the fix to a supervised Claude session: every command it wants to run is an approval card. */
  async startClaude(id: string): Promise<Task> {
    const c = this.find(id);
    if (!this.claudeCan(c)) throw new ConflictError(`${c.title} can't be fixed by Claude from here.`);
    const open = this.openTask(id);
    if (open) return open;
    const d = await this.detect(c, true);
    if (d.ok) throw new ConflictError(`${c.title} is already fine.`);
    const { repo, bus, runner, stateDir } = this.deps;
    const project = repo.setupProject(stateDir);
    const settings = repo.getSettings();
    const task = repo.createTask({
      project_id: project.id,
      title: `Set up ${c.title}`,
      spec_md: setupSpec(c, d, this.probe.platform),
      type: "chore",
      mode: "supervised",
      labels: [LABEL + id],
      // It runs installers, which only a real Claude Code session can: always Claude, like /init.
      pipeline: [{ stage: "custom", model: settings.tiers.balanced.provider === "anthropic" ? settings.tiers.balanced.model : "claude-sonnet-5", effort: "medium", prompt: "Do the task below. Every command you run is shown to the user for approval first." }],
    });
    bus.publish({ type: "task.updated", task });
    // "Run now": you clicked it and are watching it, so it must not wait behind board work (serial mode).
    runner.queueTask(task.id, { fromStage: 0 }, true);
    return repo.getTask(task.id)!;
  }
}
