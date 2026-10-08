import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fakeQuery, setup, until, type Call } from "./helpers.ts";
import { openDb } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { Bus } from "../src/bus.ts";
import { TaskRunner, type QueryFn } from "../src/engine/runner.ts";
import { worktreePathFor } from "../src/git/worktree.ts";
import { saveAttachment } from "../src/routes/attachments.ts";
import { chatBoardHandlers } from "../src/engine/chatBoard.ts";
import { chatPrompt } from "../src/engine/chat.ts";
import type { Stage } from "../src/types.ts";

const CODE_REVIEW: Stage[] = [
  { stage: "code", model: "m", effort: "low" },
  { stage: "review", model: "m", effort: "low" },
];
const CODE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];

test("a message to a card in review continues the coder's session, not the reviewer's", async () => {
  const f = fakeQuery({ byCall: (i) => ({ sessionId: i === 0 ? "s-code" : i === 1 ? "s-review" : "s-code" }) });
  const s = setup(f.fn);
  try {
    const t = s.repo.createTask({ project_id: s.project.id, title: "Main page", mode: "supervised", pipeline: CODE_REVIEW });
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "review" && !s.runner.isBusy(t.id));
    assert.equal(f.calls.length, 2);

    s.runner.chat(t.id, "Change the heading text.");
    await until(() => f.calls.length === 3 && !s.runner.isBusy(t.id));
    assert.equal(f.calls[2]!.options.resume, "s-code");
    assert.equal(s.repo.getTask(t.id)!.status, "review");
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- rounds on a done card

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kround-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/**
 * A model that writes one file per call into the folder it was started in, the way a coder would. Each
 * call's session id and an optional failure are scripted.
 */
function writer(script: { file?: string; session: string; fail?: string }[]) {
  const calls: Call[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += typeof m.message.content === "string" ? m.message.content : "";
      const i = calls.length;
      calls.push({ prompt, options: params.options as Record<string, any> });
      const step = script[i] ?? script.at(-1)!;
      yield { type: "system", subtype: "init", session_id: step.session } as never;
      if (step.fail) {
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [step.fail], total_cost_usd: 0, session_id: step.session, modelUsage: {} } as never;
        throw new Error("Claude Code process exited with code 1");
      }
      if (step.file) writeFileSync(join(String(params.options.cwd), step.file), `written in call ${i}\n`);
      yield { type: "assistant", session_id: step.session, message: { content: [{ type: "text", text: "done" }] } } as never;
      yield { type: "result", subtype: "success", is_error: false, result: "Changed it.", total_cost_usd: 0.01, session_id: step.session, modelUsage: {} } as never;
    })();
  return { fn, calls };
}

function board(fn: QueryFn) {
  const dir = makeRepo();
  const repo = new Repo(openDb(":memory:"));
  repo.updateSettings({ autoTriage: false });
  const runner = new TaskRunner({ repo, bus: new Bus(), queryFn: fn });
  const project = repo.createProject({ name: "p", path: dir, policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* temp dir */
    }
  };
  return { dir, repo, runner, project, cleanup };
}

async function doneCard(b: ReturnType<typeof board>, pipeline = CODE) {
  const t = b.repo.createTask({ project_id: b.project.id, title: "Main page", mode: "autonomous", pipeline });
  b.runner.queueTask(t.id);
  await until(() => b.repo.getTask(t.id)!.status === "review" && !b.runner.isBusy(t.id));
  await b.runner.approveTask(t.id);
  return b.repo.getTask(t.id)!;
}

test("a done card's follow-up runs as round 2 in its coder's own session, in a fresh copy at the same path, and lands on its own approval", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }, { file: "style.css", session: "s-coder" }]);
  const b = board(w.fn);
  try {
    const first = await doneCard(b);
    assert.equal(first.status, "done");
    assert.deepEqual(first.files, ["page.html"]);
    assert.ok(first.landed_sha);

    // Someone else changes the card's file after it landed.
    writeFileSync(join(b.dir, "page.html"), "changed by another card\n");
    git(b.dir, "commit", "-qam", "another card landed");

    await b.runner.startRound(first.id, "Make the button blue");
    await until(() => b.repo.getTask(first.id)!.status === "review" && !b.runner.isBusy(first.id));
    const t = b.repo.getTask(first.id)!;
    assert.equal(t.round, 2);
    assert.equal(w.calls[1]!.options.resume, "s-coder", "it continued the coder's session");
    assert.equal(w.calls[1]!.options.cwd, worktreePathFor(b.dir, t.id), "at the path the coder remembers");
    assert.match(w.calls[1]!.prompt, /## Round 2: Make the button blue/);
    assert.match(w.calls[1]!.prompt, /`page\.html`/, "told that its file changed since");
    assert.deepEqual((await b.runner.diff(t.id)).map((f) => f.file), ["style.css"], "the round's changes only");
    assert.deepEqual(b.repo.runsForTask(t.id).map((r) => r.round), [1, 2]);

    await b.runner.approveTask(t.id);
    const landed = b.repo.getTask(t.id)!;
    assert.equal(landed.status, "done");
    assert.deepEqual(landed.files.sort(), ["page.html", "style.css"]);
    assert.ok(b.repo.roundsFor(t.id)[0]!.landed_at);
    assert.equal(readFileSync(join(b.dir, "style.css"), "utf8"), "written in call 1\n");
  } finally {
    await b.cleanup();
  }
});

test("a round whose session cannot be reopened starts fresh, told what the card did", async () => {
  const w = writer([
    { file: "page.html", session: "s-coder" },
    { session: "s-coder", fail: "No conversation found with session ID: s-coder" },
    { file: "style.css", session: "s-fresh" },
  ]);
  const b = board(w.fn);
  try {
    const first = await doneCard(b);
    await b.runner.startRound(first.id, "Make the button blue");
    await until(() => b.repo.getTask(first.id)!.status === "review" && !b.runner.isBusy(first.id));
    assert.equal(w.calls[2]!.options.resume, undefined);
    assert.match(w.calls[2]!.prompt, /could not be reopened/);
    assert.match(w.calls[2]!.prompt, /page\.html/, "the handoff names the files it changed");
    assert.equal(b.repo.roundsFor(first.id)[0]!.fell_back, true);
  } finally {
    await b.cleanup();
  }
});

test("a round is refused on a card still waiting for review, and on one whose memory is gone", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }]);
  const b = board(w.fn);
  try {
    const t = b.repo.createTask({ project_id: b.project.id, title: "Main page", mode: "autonomous", pipeline: CODE });
    b.runner.queueTask(t.id);
    await until(() => b.repo.getTask(t.id)!.status === "review" && !b.runner.isBusy(t.id));
    await assert.rejects(b.runner.startRound(t.id, "Blue"), /not approved yet: send the change to it as a message/);

    await b.runner.approveTask(t.id);
    const run = b.repo.workRun(t.id)!;
    b.repo.updateRun(run.id, { ended_at: new Date(Date.now() - 40 * 24 * 3_600_000).toISOString() });
    await assert.rejects(b.runner.startRound(t.id, "Blue"), /memory cannot be continued.*Make a new card that follows it instead/);
    assert.equal(b.repo.getTask(t.id)!.round, 1, "a refused round leaves the card as it was");
  } finally {
    await b.cleanup();
  }
});

test("the cost ceiling counts a round on its own, not the card's whole history", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }, { file: "style.css", session: "s-coder" }]);
  const b = board(w.fn);
  try {
    const first = await doneCard(b);
    // The first round cost more than one round may: a ceiling over the card's whole life would stop round 2.
    b.repo.updateRun(b.repo.workRun(first.id)!.id, { cost_usd: 5 });
    b.repo.updateSettings({ maxCostPerTaskUsd: 1 });
    await b.runner.startRound(first.id, "Make the button blue");
    await until(() => ["review", "paused", "failed"].includes(b.repo.getTask(first.id)!.status) && !b.runner.isBusy(first.id));
    assert.equal(b.repo.getTask(first.id)!.status, "review");
  } finally {
    await b.cleanup();
  }
});

test("a round with a review asked for runs the review after the coder, and skips the plan", async () => {
  const pipeline: Stage[] = [{ stage: "plan", model: "m", effort: "low" }, ...CODE_REVIEW];
  const w = writer([{ session: "s-plan" }, { file: "page.html", session: "s-coder" }, { session: "s-review" }, { file: "style.css", session: "s-coder" }, { session: "s-review2" }]);
  const b = board(w.fn);
  try {
    b.repo.updateSettings({ planApproval: false });
    const first = await doneCard(b, pipeline);
    assert.equal(w.calls.length, 3);
    await b.runner.startRound(first.id, "Make the button blue", { review: true });
    await until(() => b.repo.getTask(first.id)!.status === "review" && !b.runner.isBusy(first.id));
    assert.equal(w.calls.length, 5, "coder and review, no plan");
    assert.equal(w.calls[3]!.options.resume, "s-coder");
    assert.equal(w.calls[4]!.options.resume, undefined, "the review reads this round fresh");
    assert.deepEqual(b.repo.runsForTask(first.id).filter((r) => r.round === 2).map((r) => r.stage), ["code", "review"]);
  } finally {
    await b.cleanup();
  }
});

test("a fork starts a new card with a copy of the coder's memory, in its own folder, leaving the original card as it was", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }, { file: "contact.html", session: "s-fork" }]);
  const b = board(w.fn);
  try {
    const source = await doneCard(b);
    const fork = await b.runner.forkTask(source.id, { title: "Contact page", request: "Add a contact page in the same style" });
    await until(() => b.repo.getTask(fork.id)!.status === "review" && !b.runner.isBusy(fork.id));
    assert.equal(w.calls[1]!.options.resume, "s-coder");
    assert.equal(w.calls[1]!.options.forkSession, true, "a copy: the original session stays as it was");
    assert.equal(w.calls[1]!.options.cwd, worktreePathFor(b.dir, fork.id), "its own folder");
    assert.match(w.calls[1]!.prompt, /branched from the work you did earlier in this session on "Main page"/);
    assert.deepEqual(b.repo.getTask(fork.id)!.related_to, [source.id]);
    assert.equal(b.repo.getTask(source.id)!.round, 1);
    assert.equal(b.repo.getTask(source.id)!.status, "done");
  } finally {
    await b.cleanup();
  }
});

// ---------------------------------------------------------------- the chat sends follow-ups where the memory is

test("the chat is told to look for the card that remembers a request before making a new one, unless the setting says always new", () => {
  const project = { id: "p", name: "p", path: "/p" } as never;
  const base = { models: [], defaults: [] };
  assert.match(chatPrompt(project, { ...base, followUps: "memory" }), /call board_related_cards[\s\S]*take the route it recommends[\s\S]*say in one line where it went and why/);
  assert.match(chatPrompt(project, { ...base, followUps: "ask" }), /wait for the user's yes before acting/);
  const always = chatPrompt(project, { ...base, followUps: "new" });
  assert.doesNotMatch(always, /call board_related_cards/);
  assert.match(always, /pass follows/);
});

test("related cards are found by the files the chat looked at and the request's words, each with what it remembers and a recommended route", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }]);
  const b = board(w.fn);
  try {
    const page = await doneCard(b);
    b.repo.createTask({ project_id: b.project.id, title: "Invoice export", mode: "autonomous", pipeline: CODE, status: "done" });
    const h = chatBoardHandlers({ repo: b.repo, bus: new Bus(), runner: b.runner }, b.project.id, null, () => {});
    const out = JSON.parse((await h.relatedCards({ request: "Make the button on the main page blue", files: ["page.html"] })).content[0]!.text);
    assert.equal(out.cards.length, 1, "the unrelated card is left out");
    const c = out.cards[0];
    assert.equal(c.id, page.id);
    assert.deepEqual(c.files, ["page.html"]);
    assert.equal(c.memory, "warm");
    assert.equal(c.recommended, "new_round");
    assert.ok(c.routes.includes("fork"));
    assert.match(c.why, /still warm/);
  } finally {
    await b.cleanup();
  }
});

test("the chat continues a done card as a new round, and a route the card cannot take is refused with the ones it can", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }, { file: "style.css", session: "s-coder" }, { file: "x.txt", session: "s-other" }]);
  const b = board(w.fn);
  try {
    const page = await doneCard(b);
    const cards: { id: string; action: string }[] = [];
    const h = chatBoardHandlers({ repo: b.repo, bus: new Bus(), runner: b.runner }, b.project.id, "c1", (c) => cards.push(c));
    const res = JSON.parse((await h.continueTask({ task_id: page.id, how: "new_round", request: "Make the button blue" })).content[0]!.text);
    assert.equal(res.round, 2);
    assert.match(res.note, /Round 2 is queued on "Main page".*its memory is warm/);
    assert.deepEqual(cards.map((c) => c.action), ["continued"]);
    await until(() => b.repo.getTask(page.id)!.status === "review" && !b.runner.isBusy(page.id));

    const refused = (await h.continueTask({ task_id: page.id, how: "new_round", request: "And bigger" })).content[0]!.text;
    assert.match(refused, /cannot take new round now: Its work is not approved yet.*Routes open: add_to_round, fork, fresh/);
  } finally {
    await b.cleanup();
  }
});

test("a fresh card that follows an earlier one is told what that card did and which files it changed", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }]);
  const b = board(w.fn);
  try {
    const page = await doneCard(b);
    const h = chatBoardHandlers({ repo: b.repo, bus: new Bus(), runner: b.runner }, b.project.id, null, () => {});
    const made = JSON.parse(h.createTask({ title: "Footer", spec_md: "Add a footer.", stages: [{ stage: "code" }], follows: page.id }).content[0]!.text).created;
    const t = b.repo.getTask(made.id)!;
    assert.match(t.spec_md, /^Add a footer\.\n\n## Context: follows up on "Main page"/);
    assert.match(t.spec_md, /- M page\.html/);
    assert.deepEqual(t.related_to, [page.id]);
  } finally {
    await b.cleanup();
  }
});

test("the chat saves a lesson the user asked it to remember, and later cards start with it", async () => {
  const s = setup(fakeQuery().fn);
  try {
    const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
    const out = JSON.parse(h.remember({ text: "Buttons use the brand blue, #1d4ed8." }).content[0]!.text);
    assert.equal(out.remembered, "Buttons use the brand blue, #1d4ed8.");
    const note = s.repo.notes(s.project.id).find((n) => n.text.startsWith("Buttons use"))!;
    assert.deepEqual({ kind: note.kind, source: note.source }, { kind: "lesson", source: "user" });
    assert.ok(s.repo.notesFor(s.project.id, "Add a pricing page").some((n) => n.id === note.id), "an unrelated later card still gets it");
    assert.match(h.remember({ text: "blue" }).content[0]!.text, /too short/);
    assert.match(chatPrompt({ id: "p", name: "p", path: "/p" } as never), /save it with board_remember/);
  } finally {
    await s.cleanup();
  }
});

test("files sent with a round reach its prompt by path, and a fork gets its own copies it can open (D424)", async () => {
  const w = writer([{ file: "page.html", session: "s-coder" }, { file: "style.css", session: "s-coder" }, { file: "contact.html", session: "s-fork" }]);
  const b = board(w.fn);
  try {
    const first = await doneCard(b);
    const shot = saveAttachment(b.repo, { task_id: first.id, source: "user", name: "shot.png", data: Buffer.from("png"), note: null });
    await b.runner.startRound(first.id, "Match this screenshot", { attachmentIds: [shot.id] });
    await until(() => b.repo.getTask(first.id)!.status === "review" && !b.runner.isBusy(first.id));
    assert.ok(w.calls[1]!.prompt.includes(`- shot.png: ${shot.path}`));
    assert.equal(b.repo.roundsFor(first.id).at(-1)!.request, "Match this screenshot", "the round's list keeps the request short");
    await b.runner.approveTask(first.id);

    const fork = await b.runner.forkTask(first.id, { title: "Contact page", request: "Same look as this", attachmentIds: [shot.id] });
    await until(() => b.repo.getTask(fork.id)!.status === "review" && !b.runner.isBusy(fork.id));
    const copy = b.repo.listAttachments(fork.id).find((a) => a.name === "shot.png");
    assert.ok(copy, "the new card has its own copy");
    assert.notEqual(copy!.path, shot.path);
    assert.ok(w.calls[2]!.prompt.includes(`- shot.png: ${copy!.path}`), "and is pointed at the copy its sandbox may read");
  } finally {
    await b.cleanup();
  }
});
