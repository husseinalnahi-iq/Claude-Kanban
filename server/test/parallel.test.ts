import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { chatBoardHandlers } from "../src/engine/chatBoard.ts";
import { clash, mayConflict, planFootprint } from "../src/engine/footprint.ts";
import type { Footprint, Stage, Task } from "../src/types.ts";
import { removeTemp, until } from "./helpers.ts";

const ONE_STAGE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];
const fp = (files: string[] = [], systems: string[] = []): Footprint => ({ files, systems, touched: [] });

test("two tasks in one folder clash on shared files, not on separate ones, and an unknown footprint clashes with everything", () => {
  const folder = (files: string[]) => ({ mode: "autonomous" as const, in_folder: true, live: false, footprint: fp(files) });
  assert.deepEqual(clash(folder(["src/pay.ts"]), folder(["src/pay.ts", "README.md"]))?.files, ["src/pay.ts"]);
  assert.equal(clash(folder(["src/pay.ts"]), folder(["src/other.ts"])), null);
  assert.deepEqual(clash(folder(["src/"]), folder(["src/pay.ts"]))?.files, ["src/"], "a folder covers what is under it");
  assert.equal(clash(folder([]), folder(["src/other.ts"]))?.unknown, true);
  const supervised = { mode: "supervised" as const, live: false, footprint: fp(["src/pay.ts"]) };
  assert.ok(clash(folder(["src/pay.ts"]), supervised), "a supervised task works in the same folder");
  const worktree = { mode: "autonomous" as const, live: false, footprint: fp(["src/pay.ts"]) };
  assert.equal(clash(worktree, { ...worktree }), null, "each worktree is its own copy");
  assert.deepEqual(mayConflict(worktree, { ...worktree }), ["src/pay.ts"], "but landing both may conflict");
});

test("a card that says it changes no files runs beside others in the folder, until it writes one (D426)", () => {
  const none: Footprint = { ...fp(), none: true };
  const sup = (footprint: Footprint) => ({ mode: "supervised" as const, live: false, footprint });
  assert.equal(clash(sup(none), sup(none)), null, "two live-only cards share the folder without waiting");
  assert.equal(clash(sup(none), sup(fp(["src/pay.ts"])))?.files.length ?? 0, 0);
  assert.equal(clash(sup(none), sup(fp()))?.unknown, true, "the other one still could be changing anything");
  assert.deepEqual(clash(sup({ ...none, touched: ["src/pay.ts"] }), sup(fp(["src/pay.ts"])))?.files, ["src/pay.ts"], "what it wrote counts");
});

test("two live tasks writing the same live system clash in worktrees too; a lookup does not", () => {
  const live = (systems: string[], pipeline?: Stage[]) => ({ mode: "autonomous" as const, live: true, pipeline, footprint: fp([], systems) });
  assert.deepEqual(clash(live(["The ERP"]), live(["the erp"]))?.systems, ["The ERP"]);
  assert.equal(clash(live(["the ERP"]), live(["the payments API"])), null);
  assert.equal(clash(live([]), live(["the payments API"]))?.unknown, true, "a live task that names nothing could write anywhere");
  const lookup = [{ stage: "custom", model: "m", effort: "low", prompt: "Answer the request below: find what it asks for and report it." }] as Stage[];
  assert.equal(clash(live(["the ERP"], lookup), live(["the ERP"])), null, "reading is not writing");
});

test("a plan's files and live systems are read from its own headings", () => {
  const md = "## Plan\n1. change the fee\n## Files to change\n- `src/pay.ts` — the fee\n- web/src/\n- None\n## Live systems\n- the ERP\n## Facts established\n- x";
  assert.deepEqual(planFootprint(md), { files: ["src/pay.ts", "web/src/"], systems: ["the ERP"] });
  assert.deepEqual(planFootprint("no headings here"), { files: [], systems: [] });
});

function gitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "kpar-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

type Step = { tool: string; input: Record<string, unknown> };
/**
 * A board whose stages wait to be released, one gate per task title, so a test can hold one task in
 * its stage while it looks at what the queue does with another.
 */
function board(settings: Record<string, unknown>, steps: Record<string, Step[]> = {}) {
  const dir = gitProject();
  const repo = new Repo(openDb(":memory:"));
  const state = mkdtempSync(join(tmpdir(), "kparstate-"));
  repo.setStateDir(state);
  repo.updateSettings({ autoTriage: false, serial: false, globalCap: 8, ...settings } as never);
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const decisions: Record<string, string[]> = {};
  const runner = new TaskRunner({
    repo,
    bus: new Bus(),
    queryFn: ((params) =>
      (async function* () {
        const o = params.options as Options;
        // The task's id is in its prompt's first stage line; the title is what the test knows.
        const running = repo.listTasks({}).find((t) => t.status === "running" && !started.includes(t.title));
        const title = running?.title ?? "?";
        started.push(title);
        const hook = o.hooks!.PreToolUse![0].hooks[0];
        for (const s of steps[title] ?? []) {
          const out = (await hook({ tool_name: s.tool, tool_input: s.input } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
          (decisions[title] ??= []).push(out.hookSpecificOutput?.permissionDecision === "deny" ? `deny: ${out.hookSpecificOutput.permissionDecisionReason}` : "allow");
        }
        await new Promise<void>((r) => gates.set(title, r));
        yield { type: "system", subtype: "init", session_id: `s-${title}` } as never;
        yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: `s-${title}`, modelUsage: {} } as never;
      })()) as QueryFn,
  });
  const project = repo.createProject({ name: "app", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 5 } });
  const make = (title: string, footprint: Footprint, over: Partial<Task> = {}) => {
    const t = repo.createTask({ project_id: project.id, title, mode: "autonomous", pipeline: ONE_STAGE, ...(over as object) });
    return repo.updateTask(t.id, { footprint });
  };
  const release = async (title: string) => {
    await until(() => gates.has(title));
    gates.get(title)!();
  };
  return {
    repo, runner, project, dir, started, decisions, make, release,
    cleanup: async () => {
      for (const r of gates.values()) r();
      for (const d of [dir, state]) {
        try {
          await removeTemp(d);
        } catch {
          // a temp folder; Windows may still hold it
        }
      }
    },
  };
}

test("in the project folder, a task that would change the same files waits with the reason on its card, and starts when the other finishes; a separate one runs alongside", async () => {
  const b = board({ autonomousWorktree: false });
  try {
    const first = b.make("Fee on invoices", fp(["src/pay.ts"]));
    const same = b.make("Fee rounding", fp(["src/pay.ts"]));
    const apart = b.make("Footer text", fp(["web/footer.html"]));
    b.runner.queueTask(first.id);
    await until(() => b.started.includes("Fee on invoices"));
    b.runner.queueTask(same.id);
    b.runner.queueTask(apart.id);
    await until(() => b.started.includes("Footer text"));
    await until(() => b.repo.getTask(same.id)!.hold !== null);
    const held = b.repo.getTask(same.id)!;
    assert.equal(held.status, "queued");
    assert.equal(held.hold!.with, first.id);
    assert.deepEqual(held.hold!.files, ["src/pay.ts"]);
    assert.equal(b.started.includes("Fee rounding"), false);
    await b.release("Fee on invoices");
    await until(() => b.started.includes("Fee rounding"));
    assert.equal(b.repo.getTask(same.id)!.hold, null, "the reason goes when it starts");
    await b.release("Footer text");
    await b.release("Fee rounding");
  } finally {
    await b.cleanup();
  }
});

test("in the project folder, a finished task's files stay its own until it is approved: the next task on them waits for that", async () => {
  // Seen on the test board, 2026-10-06: the second README task ran once the first reached Review, and the
  // first one's Changes (and so its Approve and Discard) took in the second one's line too.
  const dir = { current: "" };
  const b = board({ autonomousWorktree: false }, {
    "Features list": [{ tool: "Write", input: { get file_path() { return join(dir.current, "README.md"); }, content: "a" } }],
  });
  dir.current = b.dir;
  try {
    const first = b.make("Features list", fp(["README.md"]));
    const second = b.make("Licence line", fp(["README.md"]));
    b.runner.queueTask(first.id);
    await b.release("Features list");
    await until(() => b.repo.getTask(first.id)!.status === "review");
    b.runner.queueTask(second.id);
    await until(() => b.repo.getTask(second.id)!.hold !== null);
    const hold = b.repo.getTask(second.id)!.hold!;
    assert.equal(hold.with, first.id);
    assert.equal(hold.landing, true, "it waits for an Approve or a Discard, not for a run");
    assert.equal(b.started.includes("Licence line"), false);
    await b.runner.approveTask(first.id);
    await until(() => b.started.includes("Licence line"));
    await b.release("Licence line");
  } finally {
    await b.cleanup();
  }
});

test("without a known footprint, tasks in one folder take turns", async () => {
  const b = board({ autonomousWorktree: false });
  try {
    const first = b.make("One", fp());
    const second = b.make("Two", fp(["b.txt"]));
    b.runner.queueTask(first.id);
    await until(() => b.started.includes("One"));
    b.runner.queueTask(second.id);
    await until(() => b.repo.getTask(second.id)!.hold !== null);
    assert.equal(b.repo.getTask(second.id)!.hold!.unknown, true);
    await b.release("One");
    await b.release("Two");
  } finally {
    await b.cleanup();
  }
});

test("two live tasks writing the same live system take turns even in their own worktrees", async () => {
  const b = board({ autonomousWorktree: true });
  try {
    const first = b.make("Post the fees", fp([], ["the ERP"]), { live: true });
    const second = b.make("Fix the accounts", fp([], ["the ERP"]), { live: true });
    b.runner.queueTask(first.id);
    await until(() => b.started.includes("Post the fees"));
    b.runner.queueTask(second.id);
    await until(() => b.repo.getTask(second.id)!.hold !== null);
    assert.deepEqual(b.repo.getTask(second.id)!.hold!.systems, ["the ERP"]);
    await b.release("Post the fees");
    await b.release("Fix the accounts");
  } finally {
    await b.cleanup();
  }
});

test("a write to a file another running folder task changed is refused with its name, and is not a sandbox strike", async () => {
  const dir = { current: "" };
  const b = board({ autonomousWorktree: false }, {
    First: [{ tool: "Write", input: { get file_path() { return join(dir.current, "shared.txt"); }, content: "a" } }],
    Second: [{ tool: "Write", input: { get file_path() { return join(dir.current, "shared.txt"); }, content: "b" } }],
  });
  dir.current = b.dir;
  try {
    const first = b.make("First", fp(["a.txt"]));
    const second = b.make("Second", fp(["b.txt"])); // predicted apart, so both run
    b.runner.queueTask(first.id);
    await until(() => (b.decisions.First ?? []).length === 1);
    b.runner.queueTask(second.id);
    await until(() => (b.decisions.Second ?? []).length === 1);
    assert.equal(b.decisions.First[0], "allow");
    assert.match(b.decisions.Second[0], /^deny: "First" is changing shared\.txt in the same folder/);
    assert.ok(b.repo.getTask(first.id)!.footprint.touched.includes("shared.txt"), "what it wrote is on its footprint");
    assert.equal(b.repo.getTask(second.id)!.blocked, null, "no strike toward the stop after five");
    await b.release("First");
    await b.release("Second");
  } finally {
    await b.cleanup();
  }
});

test("the chat sees which working card a new card would wait for, and the card it makes says so", async () => {
  const b = board({ autonomousWorktree: false, defaultRunStyle: "autonomous" });
  try {
    const first = b.make("Fee on invoices", fp(["src/pay.ts"]));
    b.runner.queueTask(first.id);
    await until(() => b.started.includes("Fee on invoices"));
    const h = chatBoardHandlers({ repo: b.repo, bus: new Bus(), runner: b.runner }, b.project.id, null, () => {});
    const found = JSON.parse(h.overlaps({ files: ["src/pay.ts"] }).content[0].text);
    assert.equal(found.overlaps[0].id, first.id);
    assert.equal(found.overlaps[0].waits, true);
    const made = JSON.parse(h.createTask({ title: "Fee rounding", spec_md: "x", files: ["src/pay.ts"], mode: "autonomous" } as never).content[0].text);
    assert.match(made.note, /it will wait for “Fee on invoices”: both change src\/pay\.ts/);
    assert.deepEqual(made.created.files, ["src/pay.ts"]);
    await b.release("Fee on invoices");
  } finally {
    await b.cleanup();
  }
});

test("two cards made in one chat are told they will take turns, and run together when both say they change no files (D426)", async () => {
  const b = board({ autonomousWorktree: false, confirmSetup: false });
  try {
    const chat = b.repo.createChat({ project_id: b.project.id, title: "c", model: "m", effort: "low", mode: "supervised" });
    const h = chatBoardHandlers({ repo: b.repo, bus: new Bus(), runner: b.runner }, b.project.id, chat.id, () => {});
    const make = (title: string, extra: object) => JSON.parse(h.createTask({ title, spec_md: "x", mode: "supervised", ...extra } as never).content[0].text);
    make("Move reports", { live_systems: ["BizApp"] });
    const second = make("Move invoices", { live_systems: ["BizApp"] });
    assert.match(second.note, /cannot run at the same time as “Move reports”.*take turns/);

    const other = chatBoardHandlers({ repo: b.repo, bus: new Bus(), runner: b.runner }, b.project.id, null, () => {});
    const elsewhere = JSON.parse(other.createTask({ title: "Unrelated", spec_md: "x", mode: "supervised" } as never).content[0].text);
    assert.doesNotMatch(elsewhere.note, /at the same time/, "another chat's Backlog is not this one's business");

    const chat2 = b.repo.createChat({ project_id: b.project.id, title: "c2", model: "m", effort: "low", mode: "supervised" });
    const h2 = chatBoardHandlers({ repo: b.repo, bus: new Bus(), runner: b.runner }, b.project.id, chat2.id, () => {});
    const make2 = (title: string) => JSON.parse(h2.createTask({ title, spec_md: "x", mode: "supervised", stages: [{ stage: "code" }], live_systems: ["BizApp sidebar"], no_files: true } as never).content[0].text);
    const a = make2("Rename reports");
    const c = make2("Rename invoices");
    assert.doesNotMatch(c.note, /at the same time/);
    b.runner.queueTask(a.created.id);
    b.runner.queueTask(c.created.id);
    await until(() => b.started.includes("Rename reports") && b.started.includes("Rename invoices"));
    assert.equal(b.repo.getTask(c.created.id)!.hold, null);
    await b.release("Rename reports");
    await b.release("Rename invoices");
  } finally {
    await b.cleanup();
  }
});
