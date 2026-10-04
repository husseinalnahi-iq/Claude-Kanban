import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fakeQuery, setup } from "./helpers.ts";
import { cardsLine, ChatService, CHAT_COMMAND_REFUSED, CHAT_COMMANDS_OFF, CHAT_DISALLOWED, chatPrompt, describeTool, turnContext } from "../src/engine/chat.ts";
import { chatBoardHandlers } from "../src/engine/chatBoard.ts";
import { connectedSystemIn } from "../src/engine/connected.ts";
import { isAnswerStage } from "../src/engine/answer.ts";
import { Scheduler } from "../src/engine/scheduler.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import type { ChatUpdate, Stage, Task, WsMessage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "low" }];

async function until(cond: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A chat reply that streams two words, reads a file, then answers; records options and permissions. */
function replying(sessionId = "chat-s1") {
  const calls: { prompt: string; options: any }[] = [];
  const denied: any[] = [];
  const fn: QueryFn = (params) =>
    (async function* () {
      let prompt = "";
      for await (const m of params.prompt) prompt += String(m.message.content);
      calls.push({ prompt, options: params.options });
      yield { type: "system", subtype: "init", session_id: sessionId } as any;
      denied.push(await params.options.canUseTool!("Write", { file_path: "x" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" } as any));
      yield { type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "The board " } } } as any;
      yield { type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "stores tasks." } } } as any;
      yield { type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `${params.options.cwd}/src/db.ts` } }] } } as any;
      yield { type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "The board stores tasks in SQLite." }] } } as any;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.012, session_id: sessionId, modelUsage: {} } as any;
    })();
  return { fn, calls, denied };
}

test("a chat reply streams, is stored with its tool lines, costs what it cost, and resumes next time", async () => {
  const q = replying();
  const s = setup(q.fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id);
    assert.equal(c.title, "New chat");
    assert.equal(c.model, "claude-sonnet-5-5", "the balanced default");
    assert.equal(c.effort, "medium");

    chat.send(c.id, "How does the board store tasks?");
    await until(() => !chat.isBusy(c.id));
    const msgs = s.repo.chatMessages(c.id);
    assert.deepEqual(msgs.map((m) => m.role), ["user", "tool", "assistant"]);
    assert.equal(msgs[1].text, "read src/db.ts", "tool calls read as plain words, paths relative to the project");
    assert.equal(msgs[2].text, "The board stores tasks in SQLite.");
    const after = s.repo.getChat(c.id)!;
    assert.equal(after.title, "How does the board store tasks?", "named after your first message");
    assert.equal(after.session_id, "chat-s1");
    assert.equal(after.cost_usd, 0.012);
    const deltas = s.seen.filter((m: WsMessage) => m.type === "chat.delta").map((m: any) => m.text);
    assert.ok(deltas.includes("The board stores tasks."), "words streamed as they came");
    assert.equal(deltas.at(-1), "", "and the stream is cleared when the reply is stored");

    const opts = q.calls[0].options;
    assert.equal(opts.cwd, s.project.path);
    assert.equal(opts.includePartialMessages, true);
    assert.deepEqual(opts.settingSources, ["project"]);
    for (const t of ["Edit", "Write", "AskUserQuestion"]) assert.ok(CHAT_DISALLOWED.includes(t) && opts.disallowedTools.includes(t), `${t} is not offered`);
    assert.equal(q.denied[0].behavior, "deny", "and refused if tried anyway");
    assert.ok(!opts.disallowedTools.includes("Bash"), "the shell is offered, for read-only commands (D350)");
    assert.equal(opts.hooks.PreToolUse.length, 1, "and a settings file's allow rule cannot take a command past canUseTool");
    assert.equal(opts.resume, undefined);

    chat.send(c.id, "And where are the costs?");
    await until(() => q.calls.length === 2 && !chat.isBusy(c.id));
    assert.equal(q.calls[1].options.resume, "chat-s1", "the second message continues the same session");
    assert.equal(s.repo.getChat(c.id)!.cost_usd, 0.024);
  } finally {
    s.cleanup();
  }
});

test("one reply at a time per chat; stop keeps what was written", async () => {
  let release!: () => void;
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) void _;
      yield { type: "stream_event", session_id: "x", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Half an ans" } } } as any;
      await new Promise<void>((r) => {
        release = r;
        params.options.abortController!.signal.addEventListener("abort", () => r());
      });
      if (params.options.abortController!.signal.aborted) return;
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, session_id: "x", modelUsage: {} } as any;
    })();
  const s = setup(fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id, "Mine");
    chat.send(c.id, "hi");
    await until(() => !!release);
    assert.throws(() => chat.send(c.id, "again"), /Still answering/);
    assert.equal(chat.stop(c.id), true);
    await until(() => !chat.isBusy(c.id));
    const last = s.repo.chatMessages(c.id).at(-1)!;
    assert.equal(last.role, "assistant");
    assert.match(last.text, /^Half an ans …\(stopped\)$/);
  } finally {
    s.cleanup();
  }
});

test("archive, restore, rename and delete", () => {
  const s = setup(replying().fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id);
    assert.ok(chat.update(c.id, { archived: true }).archived_at);
    assert.equal(chat.update(c.id, { archived: false }).archived_at, null);
    assert.equal(chat.update(c.id, { title: "Pricing ideas" }).title, "Pricing ideas");
    chat.delete(c.id);
    assert.equal(s.repo.getChat(c.id), undefined);
    assert.ok(s.seen.some((m: WsMessage) => m.type === "chat.deleted"));
  } finally {
    s.cleanup();
  }
});

test("chat board tools: cards land in Backlog under the project's rules; queue and schedule work; other projects are off-limits", () => {
  const s = setup(replying().fn, { autonomous: "forbidden" });
  const scheduler = new Scheduler({ repo: s.repo, bus: s.bus, runner: s.runner });
  const cards: any[] = [];
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner, scheduler }, s.project.id, null, (c) => cards.push(c));
  try {
    const made = JSON.parse(h.createTask({ title: "Add a dark mode", spec_md: "Done when…", mode: "autonomous", stages: [{ stage: "code" }] }).content[0].text).created;
    const t = s.repo.getTask(made.id)!;
    assert.equal(t.status, "backlog");
    assert.equal(t.mode, "supervised", "the project forbids autonomous, so the chat cannot ask for it");
    assert.ok(t.pipeline.length, "the project's default pipeline");

    const later = new Date(Date.now() + 3_600_000).toISOString();
    h.scheduleTask({ task_id: t.id, start_at: later });
    assert.equal(s.repo.getTask(t.id)!.start_at, later);
    assert.equal((h.scheduleTask({ task_id: t.id, start_at: "tonight" }) as any).isError, true, "a vague time is refused with the format to use");
    h.scheduleTask({ task_id: t.id, start_at: null });

    s.repo.updateTask(t.id, { pipeline: ONE });
    h.queueTask({ task_id: t.id });
    assert.notEqual(s.repo.getTask(t.id)!.status, "backlog");
    assert.equal((h.updateTask({ task_id: t.id, title: "x" }) as any).isError, true, "a running card is not edited from chat");
    assert.deepEqual(cards.map((c) => c.action), ["created", "scheduled", "scheduled", "queued"]);

    const other = s.repo.createProject({ name: "other", path: s.dir + "-other", policy: { worktrees: "allowed", autonomous: "allowed", maxConcurrent: 1 } });
    const foreign = s.repo.createTask({ project_id: other.id, title: "not yours" });
    assert.equal((h.getTask({ task_id: foreign.id }) as any).isError, true);
  } finally {
    s.cleanup();
  }
});

test("tool lines and the chat's instructions read plainly", () => {
  assert.equal(describeTool("Grep", { pattern: "useWs" }, "/p"), "searched the code for “useWs”");
  assert.equal(describeTool("mcp__board__board_create_task", { title: "Dark mode" }, "/p"), "created the card “Dark mode”");
  assert.equal(describeTool("Bash", { command: "git log --oneline -5" }, "/p"), "ran “git log --oneline -5”: git shows the history of commits", "a command is explained in plain words (D336)");
  assert.equal(describeTool("Bash", { command: "frobnicate --all" }, "/p"), "ran “frobnicate --all”", "one the table does not know is just shown");
  const p = chatPrompt({ name: "Shop", path: "/p" } as any, {
    models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }],
    defaults: [{ stage: "plan", model: "claude-opus-5-5", effort: "high" }],
  });
  assert.doesNotMatch(p, /cannot edit files|should not offer/, "it never opens with what it cannot do (D283)");
  assert.match(p, /say what you will do/);
  assert.match(p, /stages \[\{stage:"answer"\}\]/, "a lookup is an answer card");
  assert.match(p, /git log, git status, git diff/, "it knows it may run read-only commands itself (D350)");
  assert.match(p, /Opus 5\.5 \(claude-opus-5-5\)/, "it knows the board's models by name");
  assert.match(p, /Default stages: plan · claude-opus-5-5 · high/);
  assert.match(p, /Never queue or schedule a change card the user did not ask to run/);
  assert.doesNotMatch(p, /UTC[+-]\d{2}/, "no clock in the system prompt: it would re-bill the whole conversation every minute");
  assert.match(turnContext(new Date(2026, 8, 14, 22, 0)), /^\[Local time: .*22:00 \(UTC[+-]\d{2}:\d{2}\)\]$/, "the local offset rides on each message, so 'tonight at 3' can be scheduled correctly");
});

test("chat board tools: the chat can follow a card, tell it something, answer its question, and re-run a failed one", async () => {
  const q = fakeQuery({ byCall: (i) => (i === 2 ? { fail: true } : undefined) });
  const s = setup(q.fn);
  const cards: any[] = [];
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, (c) => cards.push(c));
  const read = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  try {
    const t = s.repo.createTask({ project_id: s.project.id, title: "Add a dark mode", mode: "supervised", pipeline: ONE });
    assert.equal((h.messageTask({ task_id: t.id, text: "use blue" }) as any).isError, true, "a card that never ran has no session to talk to");
    assert.match(h.messageTask({ task_id: t.id, text: "use blue" }).content[0].text, /has not run yet/);

    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "review");
    const p = read(h.taskProgress({ task_id: t.id }));
    assert.equal(p.status, "review");
    assert.equal(p.stages[0].status, "success");
    assert.match(p.stages[0].stage, /^1\. code · m · low$/);
    assert.equal(p.stages[0].result, "DONE");
    assert.equal(p.cost_usd, 0.01);
    assert.deepEqual(p.recent_activity.slice(-2), ["Claude: working", "Stage finished: DONE"], "its steps as plain lines, newest last");

    assert.equal(read(h.messageTask({ task_id: t.id, text: "Also make the buttons blue." })).sent, true);
    await until(() => q.calls.length === 2 && !s.runner.isBusy(t.id));
    assert.equal(q.calls[1].prompt, "Also make the buttons blue.", "the card's own session gets the user's words");
    assert.equal(q.calls[1].options.resume, "s1", "and continues where it was");
    assert.ok(read(h.taskProgress({ task_id: t.id })).recent_activity.includes("Message to the task: Also make the buttons blue."));

    s.repo.updateTask(t.id, { questions: [{ id: "q1", stage_index: 0, text: "Which blue?", options: ["navy", "sky"], default: "navy", answer: null, created_at: new Date().toISOString(), answered_at: null }] });
    assert.equal(read(h.listTasks({})).tasks[0].open_questions, 1, "the list says which cards are waiting on the user");
    assert.deepEqual(read(h.taskProgress({ task_id: t.id })).open_questions, [{ question_id: "q1", text: "Which blue?", options: ["navy", "sky"] }]);
    assert.equal(read(h.answerQuestion({ task_id: t.id, answer: "sky" })).with, "sky");
    assert.equal(s.repo.getTask(t.id)!.questions[0].answer, "sky");
    assert.equal((h.answerQuestion({ task_id: t.id, answer: "navy" }) as any).isError, true, "nothing left to answer");

    assert.equal((h.stopTask({ task_id: t.id }) as any).isError, true, "a card that is not queued or running cannot be stopped");
    assert.equal((h.retryTask({ task_id: t.id }) as any).isError, true, "only a failed card is retried");

    const bad = s.repo.createTask({ project_id: s.project.id, title: "Breaks", mode: "supervised", pipeline: ONE });
    s.runner.queueTask(bad.id);
    await until(() => s.repo.getTask(bad.id)!.status === "failed");
    assert.equal(read(h.taskProgress({ task_id: bad.id })).stages[0].status, "failed");
    assert.equal(read(h.retryTask({ task_id: bad.id })).retried.id, bad.id);
    await until(() => s.repo.getTask(bad.id)!.status === "review");
    assert.deepEqual(cards.map((c) => c.action), ["messaged", "answered", "retried"]);
  } finally {
    s.cleanup();
  }
});

test("the chat's own words for its new tools, and what it must leave to the user", () => {
  assert.equal(describeTool("mcp__board__board_task_progress", {}, "/p"), "checked how a card is going");
  assert.equal(describeTool("mcp__board__board_message_task", { text: "use blue" }, "/p"), "told a card: “use blue”");
  const p = chatPrompt({ name: "Shop", path: "/p" } as any);
  assert.match(p, /board_task_progress/);
  assert.match(p, /Approving, landing or discarding a card's work is the user's own decision/);
});

test("the chat reads only inside its project, and never a file that holds keys", async () => {
  const q = replying();
  const s = setup(q.fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id);
    chat.send(c.id, "hello");
    await until(() => !chat.isBusy(c.id));
    const can = (name: string, input: Record<string, unknown>) =>
      q.calls[0].options.canUseTool(name, input, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    assert.equal((await can("Read", { file_path: `${s.dir}/src/app.ts` })).behavior, "allow");
    assert.equal((await can("Grep", { pattern: "useWs" })).behavior, "allow", "a search with no path runs in the project");
    const outside = await can("Read", { file_path: `${s.dir}-elsewhere/notes.txt` });
    assert.equal(outside.behavior, "deny");
    assert.match(outside.message, /only reads files inside this project/);
    const keys = await can("Read", { file_path: `${s.dir}/.env` });
    assert.equal(keys.behavior, "deny", "a page it read could ask for your keys, and no card would show it");
    assert.match(keys.message, /passwords or keys/);
    // Read-only commands run here under the supervised rule (D350); anything else is a card's job.
    assert.equal((await can("Bash", { command: "git log --oneline -5" })).behavior, "allow", "git history answers 'what changed last' without a card");
    assert.equal((await can("Bash", { command: "git status && git diff --stat" })).behavior, "allow");
    assert.equal((await can("Bash", { command: "ls src" })).behavior, "allow");
    for (const cmd of ["npm test", "git push", "git log > out.txt", "cat .env", "cat ../secrets.json", "echo hi | sh", "rm -rf src"]) {
      const r = await can("Bash", { command: cmd });
      assert.equal(r.behavior, "deny", `${cmd} is not read-only`);
      assert.ok(r.message === CHAT_COMMAND_REFUSED || /passwords or keys/.test(r.message), `${cmd} is sent to a card, never apologised for`);
    }
    s.repo.updateSettings({ autoAllowReadOnly: false });
    chat.send(c.id, "again");
    await until(() => !chat.isBusy(c.id));
    const off = await q.calls[1].options.canUseTool("Bash", { command: "git log" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    assert.equal(off.behavior, "deny", "the setting that keeps read-only commands on a card covers the chat too");
    assert.equal(off.message, CHAT_COMMANDS_OFF);
    assert.match(q.calls[0].prompt, /^\[Local time: .*\]\n\nhello$/, "the clock rides on the message, not the cached system prompt");
  } finally {
    s.cleanup();
  }
});

test("chat board tools: the list counts every status and hides Done; queueing never restarts reviewed or failed work", async () => {
  const q = fakeQuery({ byCall: (i) => (i === 1 ? { fail: true } : undefined) });
  const s = setup(q.fn);
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
  const read = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  try {
    assert.equal(read(h.listTasks({})).note, "No cards on this board yet.");
    const reviewed = s.repo.createTask({ project_id: s.project.id, title: "Reviewed", mode: "supervised", pipeline: ONE });
    s.runner.queueTask(reviewed.id);
    await until(() => s.repo.getTask(reviewed.id)!.status === "review");
    const failed = s.repo.createTask({ project_id: s.project.id, title: "Failed", mode: "supervised", pipeline: ONE });
    s.runner.queueTask(failed.id);
    await until(() => s.repo.getTask(failed.id)!.status === "failed");
    const done = s.repo.createTask({ project_id: s.project.id, title: "Old work", pipeline: ONE });
    s.repo.updateTask(done.id, { status: "done" });

    const list = read(h.listTasks({}));
    assert.deepEqual(list.counts, { review: 1, failed: 1, done: 1 });
    assert.deepEqual(list.tasks.map((t: any) => t.title).sort(), ["Failed", "Reviewed"], "finished cards are counted, not listed");
    assert.match(list.note, /1 done card/);
    assert.deepEqual(read(h.listTasks({ status: "done" })).tasks.map((t: any) => t.title), ["Old work"]);
    assert.equal(read(h.listTasks({ status: "running" })).note, "No card is running right now.", "an empty filter is not an empty board");

    const again = h.queueTask({ task_id: reviewed.id }) as any;
    assert.equal(again.isError, true, "queueing would redo work that is waiting for review");
    assert.match((h.queueTask({ task_id: failed.id }) as any).content[0].text, /board_retry_task/);
    assert.equal(s.repo.getTask(reviewed.id)!.status, "review");
  } finally {
    s.cleanup();
  }
});

test("a card the chat made and started is counted once under the reply", () => {
  const made = { id: "t_1", title: "Game", action: "created" as const };
  assert.equal(cardsLine([made, { ...made, action: "queued" }]), "1 card");
  assert.equal(cardsLine([made, { id: "t_2", title: "Docs", action: "created" }]), "2 cards");
});

const read = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

test("the chat sets each stage's model and effort in words, and an unknown model comes back with the board's list", () => {
  const s = setup(fakeQuery().fn);
  s.repo.updateSettings({ autoTriage: false });
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
  try {
    const made = read(h.createTask({
      title: "Fix the header", spec_md: "Done when…",
      stages: [{ stage: "plan", model: "opus", effort: "high" }, { stage: "code", model: "Sonnet 5.5", effort: "medium" }, { stage: "review", model: "haiku" }],
    })).created;
    const reviewEffort = s.repo.getSettings().defaultPipeline.find((x) => x.stage === "review")!.effort;
    assert.deepEqual(
      s.repo.getTask(made.id)!.pipeline.map((x) => [x.stage, x.model, x.effort]),
      [["plan", "claude-opus-5-5", "high"], ["code", "claude-sonnet-5-5", "medium"], ["review", "claude-haiku-4-5-20251001", reviewEffort]],
      "names in words become full ids; an effort left out is the board's own for that stage",
    );
    assert.match(made.pipeline, /^plan · claude-opus-5-5 · high → code/, "and the chat reads back how it will run");

    const bad = h.createTask({ title: "x", spec_md: "", stages: [{ stage: "code", model: "gpt-9" }] }) as any;
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /no model called "gpt-9"[\s\S]*Opus 5\.5 \(claude-opus-5-5\)/);

    assert.equal(read(h.updateTask({ task_id: made.id, stages: [{ stage: "code", model: "opus", effort: "low" }] })).updated.pipeline, "code · claude-opus-5-5 · low");
  } finally {
    s.cleanup();
  }
});

test("a lookup is one answer stage that runs supervised on the main checkout and lands in Done with its answer", async () => {
  const q = fakeQuery({ result: "The latest PO is PUR-ORD-0001 (ACME, $120)." });
  const s = setup(q.fn);
  s.repo.updateSettings({ autoTriage: false });
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
  try {
    const made = read(h.createTask({ title: "Latest PO", spec_md: "The newest purchase order.", stages: [{ stage: "answer" }], own_branch: true, live: true }));
    const t = s.repo.getTask(made.created.id)!;
    assert.equal(t.pipeline.length, 1);
    assert.ok(isAnswerStage(t.pipeline[0]));
    assert.deepEqual([t.pipeline[0].model, t.pipeline[0].effort], ["claude-sonnet-5-5", "medium"], "the everyday model: reading is not where Opus earns its price");
    assert.deepEqual([t.mode, t.own_branch, t.live], ["supervised", false, false], "a read needs no branch, and a sandbox could not reach a live system");
    assert.match(made.note, /answer card/);
    assert.match(made.created.pipeline, /^answer · /);
    assert.equal((h.createTask({ title: "x", spec_md: "", stages: [{ stage: "answer" }, { stage: "code" }] }) as any).isError, true, "an answer card is one stage on its own");

    h.queueTask({ task_id: t.id });
    await until(() => s.repo.getTask(t.id)!.status === "done");
    assert.ok(s.repo.getTask(t.id)!.done_at, "nothing to approve or land: it is done");
    assert.match(q.calls[0].prompt, /Answer the request below/);
  } finally {
    s.cleanup();
  }
});

test("a card the chat made reports into that chat when it finishes, fails, has a plan ready or asks something, once each and once after a restart", async () => {
  const q = fakeQuery({ result: "The latest PO is PUR-1.", byCall: (i) => (i === 1 ? { fail: true } : undefined) });
  const s = setup(q.fn);
  s.repo.updateSettings({ autoTriage: false });
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  const updates = (chatId: string) => s.repo.chatMessages(chatId).filter((m) => m.role === "update").map((m) => m.meta.update!);
  const touch = (id: string, patch: Partial<Task>) => s.bus.publish({ type: "task.updated", task: s.repo.updateTask(id, patch) });
  try {
    const c = chat.create(s.project.id);
    const ok = s.repo.createTask({ project_id: s.project.id, title: "Latest PO", mode: "supervised", pipeline: ONE, chat_id: c.id });
    s.runner.queueTask(ok.id);
    await until(() => updates(c.id).length === 1);
    assert.deepEqual(
      (({ id, kind, status, text }: ChatUpdate) => ({ id, kind, status, text }))(updates(c.id)[0]),
      { id: ok.id, kind: "finished", status: "review", text: "The latest PO is PUR-1." },
      "its answer, posted by the board with no model call",
    );
    touch(ok.id, { summary: "tidied" });
    assert.equal(updates(c.id).length, 1, "the same state is not said twice");

    const bad = s.repo.createTask({ project_id: s.project.id, title: "Breaks", mode: "supervised", pipeline: ONE, chat_id: c.id });
    s.runner.queueTask(bad.id);
    await until(() => updates(c.id).length === 2);
    assert.equal(updates(c.id)[1].kind, "failed");
    assert.ok(updates(c.id)[1].text.trim(), "with the reason it stopped");

    const question = { id: "q1", stage_index: 0, text: "Which warehouse?", options: ["Main", "Spare"], default: "Main", answer: null, created_at: new Date().toISOString(), answered_at: null };
    touch(ok.id, { questions: [question] });
    touch(ok.id, { questions: [question] });
    const asked = updates(c.id).filter((u) => u.kind === "question");
    assert.equal(asked.length, 1, "a question is asked in the chat once");
    assert.deepEqual([asked[0].text, asked[0].options, asked[0].question_id], ["Which warehouse?", ["Main", "Spare"], "q1"]);

    touch(ok.id, { status: "approval", plan_gate: { kind: "approval", stage_index: 0, created_at: new Date().toISOString(), original: "1. Read the PO table.\n2. Report it." } });
    assert.equal(updates(c.id).at(-1)!.kind, "plan");
    assert.match(updates(c.id).at(-1)!.text, /Read the PO table/);

    // A restart: the board has not seen this card since it started, but the chat was already told.
    const earlier = s.repo.createTask({ project_id: s.project.id, title: "Earlier", mode: "supervised", pipeline: ONE, chat_id: c.id, status: "review" });
    s.repo.addChatMessage({ chat_id: c.id, role: "update", text: "“Earlier” finished", meta: { update: { id: earlier.id, title: "Earlier", kind: "finished", status: "review", text: "x" } } });
    const before = updates(c.id).length;
    touch(earlier.id, { summary: "seen again" });
    assert.equal(updates(c.id).length, before, "what the chat was told before a restart is not said again");

    const other = chat.create(s.project.id);
    assert.equal(updates(other.id).length, 0, "only the chat that made a card hears about it");
  } finally {
    s.cleanup();
  }
});

test("the next message carries what the chat's cards did since, so Claude can talk about the result", async () => {
  const q = replying();
  const s = setup(q.fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id);
    chat.send(c.id, "get me the latest PO");
    await until(() => !chat.isBusy(c.id));
    s.repo.addChatMessage({ chat_id: c.id, role: "update", text: "“Latest PO” finished", meta: { update: { id: "t_1", title: "Latest PO", kind: "finished", status: "done", text: "The latest PO is PUR-1." } } });
    chat.send(c.id, "who made it?");
    await until(() => q.calls.length === 2 && !chat.isBusy(c.id));
    assert.match(q.calls[1].prompt, /^\[Local time: .*\]\n\n\[Board news since your last message\]\n- "Latest PO" \(t_1\) finished: The latest PO is PUR-1\.\n\nwho made it\?$/);
    chat.send(c.id, "thanks");
    await until(() => q.calls.length === 3 && !chat.isBusy(c.id));
    assert.match(q.calls[2].prompt, /^\[Local time: .*\]\n\nthanks$/, "news is told once");
  } finally {
    s.cleanup();
  }
});

test("the chat can change a Backlog card's mode, branch and stages, and what it settles replaces triage's offer — but not a card with work on a branch", () => {
  const s = setup(fakeQuery().fn);
  s.repo.updateSettings({ autoTriage: false });
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, null, () => {});
  try {
    const t = s.repo.createTask({ project_id: s.project.id, title: "x", mode: "supervised", pipeline: ONE });
    assert.equal(read(h.updateTask({ task_id: t.id, mode: "autonomous" })).updated.mode, "autonomous");
    assert.equal(read(h.updateTask({ task_id: t.id, mode: "supervised", own_branch: true })).updated.own_branch, true);

    s.repo.updateTask(t.id, { suggestion: { priority: "p1", pipeline: [{ stage: "code", model: "claude-opus-5-5", effort: "high" }], sizing_reason: "big" } });
    h.updateTask({ task_id: t.id, stages: [{ stage: "code", model: "sonnet" }] });
    const after = s.repo.getTask(t.id)!;
    assert.equal(after.pipeline[0].model, "claude-sonnet-5-5");
    assert.equal(after.suggestion?.pipeline, undefined, "the user's choice in the chat replaces the sizing on offer");
    assert.equal(after.suggestion?.priority, "p1", "the rest of the suggestion stays");

    s.repo.updateTask(t.id, { branch: "kanban/x" });
    const refused = h.updateTask({ task_id: t.id, own_branch: false }) as any;
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /approve or discard it/);
  } finally {
    s.cleanup();
  }
});

test("a chat on a Claude-compatible provider runs through Claude Code with the provider's address on top of the computer's environment, its cost priced and capped (D301)", async () => {
  const q = replying("glm-s1");
  const s = setup(q.fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    s.repo.updateSettings({
      providers: [{ id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic", authRef: "ZAI_API_KEY", models: [{ id: "glm-5.3", label: "GLM 5.3", inputPer1M: 1, outputPer1M: 2 }], mayEditFiles: true }],
    });
    s.secrets.set("ZAI_API_KEY", "zai-key-1234567890");
    const c = chat.create(s.project.id);
    chat.update(c.id, { provider: "zai", model: "glm-5.3" });
    chat.send(c.id, "what does this project do?");
    await until(() => !chat.isBusy(c.id));
    const o = q.calls[0].options;
    assert.equal(o.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(o.env.ANTHROPIC_MODEL, "glm-5.3");
    assert.ok(o.env.PATH, "the computer's environment is kept: Claude Code would not start without PATH");
    assert.equal(o.effort, undefined, "effort is Claude's alone");
    assert.ok(o.mcpServers.board, "the board's tools are still there");
    assert.notEqual(s.repo.getChat(c.id)!.cost_usd, 0.012, "the SDK's Claude price is not what GLM costs");
  } finally {
    s.cleanup();
  }
});

test("switching a chat to another provider starts a fresh session that carries the conversation; a CLI provider is refused (D301)", async () => {
  const q = replying("claude-s1");
  const s = setup(q.fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    s.repo.updateSettings({
      providers: [
        { id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic", authRef: "ZAI_API_KEY", models: [{ id: "glm-5.3", label: "GLM 5.3" }], mayEditFiles: true },
        { id: "codex", label: "Codex", kind: "cli", enabled: true, authRef: "", models: [{ id: "gpt-6-luna", label: "Luna" }], cli: { preset: "codex", auth: "login" }, mayEditFiles: false },
      ],
    });
    const c = chat.create(s.project.id);
    chat.send(c.id, "remember the word teal");
    await until(() => !chat.isBusy(c.id));
    assert.equal(s.repo.getChat(c.id)!.session_id, "claude-s1");

    chat.update(c.id, { provider: "zai", model: "glm-5.3" });
    assert.equal(s.repo.getChat(c.id)!.session_id, null, "another endpoint cannot continue this session");
    chat.send(c.id, "which word?");
    await until(() => q.calls.length === 2 && !chat.isBusy(c.id));
    assert.equal(q.calls[1].options.resume, undefined);
    assert.match(q.calls[1].prompt, /\[Earlier in this chat\]\nUser: remember the word teal\nYou: The board stores tasks in SQLite\.\n\n/);

    assert.throws(() => chat.update(c.id, { provider: "codex", model: "gpt-6-luna" }), /cannot run the side chat/);
  } finally {
    s.cleanup();
  }
});

test("a card made by a chat set to autonomous runs autonomous unless the message says otherwise (D344)", () => {
  const s = setup(replying().fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id);
    assert.equal(c.mode, "ask", "a new chat starts on the board's default, Autonomous + asks me (D365)");
    const before = c.updated_at;
    assert.equal(chat.update(c.id, { mode: "autonomous" }).mode, "autonomous");
    assert.equal(s.repo.getChat(c.id)!.updated_at, before, "flipping the switch is not activity");

    const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, c.id, () => {});
    const made = (args: Record<string, unknown>) => s.repo.getTask(JSON.parse(h.createTask(args as never).content[0].text).created.id)!;
    assert.equal(made({ title: "Dark mode", spec_md: "x" }).mode, "autonomous", "the chat's switch is the default");
    assert.equal(made({ title: "Dark mode", spec_md: "x", mode: "supervised" }).mode, "supervised", "a mode named in the message wins");
    assert.equal(made({ title: "Latest PO", spec_md: "x", stages: [{ stage: "answer" }] }).mode, "autonomous", "a lookup follows the switch too: the project's own folder, nothing asked (D352)");
    assert.match(chatPrompt(s.project, { models: [], defaults: [], mode: "autonomous" }), /mode switch applies \(it is set to autonomous now\)/);
  } finally {
    s.cleanup();
  }
});

test("a new folder gets a colour nobody else has, and it can be changed or taken away", async () => {
  const s = setup(replying().fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const a = chat.createFolder(s.project.id, "Billing");
    const b = chat.createFolder(s.project.id, "Ideas");
    assert.ok(a.color && b.color, "every new folder has a colour");
    assert.notEqual(a.color, b.color, "neighbours never look alike by accident");
    assert.equal(chat.updateFolder(b.id, { color: "rose" }).color, "rose");
    assert.equal(chat.updateFolder(b.id, { color: null }).color, null, "a folder can go back to neutral");
    assert.equal(chat.updateFolder(b.id, { color: a.color }).name, "Ideas", "changing the colour leaves the name alone");
    const pushed = s.seen.filter((m: WsMessage) => m.type === "chat.folders") as Extract<WsMessage, { type: "chat.folders" }>[];
    assert.equal(pushed.at(-1)!.folders.find((f) => f.id === b.id)!.color, a.color, "the colour rides on the folder list every open page gets");
  } finally {
    s.cleanup();
  }
});

test("a reply that fails with a 'success' result shows the real error, not the word success", async () => {
  const session_id = "s_fail";
  const query: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) { /* read it through, as the SDK would */ }
      yield { type: "system", subtype: "init", session_id, model: "m" } as any;
      yield { type: "result", subtype: "success", is_error: true, result: "API Error: 500 the inference gateway is down", total_cost_usd: 0, session_id, modelUsage: {} } as any;
    })();
  const s = setup(query);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id);
    chat.send(c.id, "hi");
    await until(() => !chat.isBusy(c.id));
    const errors = s.repo.chatMessages(c.id).filter((m) => m.role === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.text, /inference gateway is down/);
    assert.doesNotMatch(errors[0]!.text, /: success/);
  } finally {
    s.cleanup();
  }
});

test("a chat can be filed in a folder, renamed with it, and deleting the folder keeps the chat (D328)", async () => {
  const s = setup(replying().fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    const c = chat.create(s.project.id);
    const f = chat.createFolder(s.project.id, "  Billing  ");
    assert.equal(f.name, "Billing", "names are trimmed");
    assert.deepEqual(chat.folders(s.project.id).map((x) => x.id), [f.id]);

    const before = s.repo.getChat(c.id)!.updated_at;
    const filed = chat.update(c.id, { folder_id: f.id });
    assert.equal(filed.folder_id, f.id);
    assert.equal(filed.updated_at, before, "filing a chat is not activity: it keeps its place in the list");
    assert.throws(() => chat.update(c.id, { folder_id: "cf_missing" }), /folder is gone/);

    assert.equal(chat.updateFolder(f.id, { name: "Invoices" }).name, "Invoices");
    const pushed = s.seen.filter((m: WsMessage) => m.type === "chat.folders") as Extract<WsMessage, { type: "chat.folders" }>[];
    assert.equal(pushed.at(-1)!.folders[0]!.name, "Invoices", "every change pushes the project's whole folder list");

    chat.deleteFolder(f.id);
    assert.equal(chat.folders(s.project.id).length, 0);
    const after = s.repo.getChat(c.id)!;
    assert.ok(after, "the chat is still there");
    assert.equal(after.folder_id, null, "just unfiled");
    const republished = s.seen.filter((m: WsMessage) => m.type === "chat.updated" && m.chat.id === c.id) as Extract<WsMessage, { type: "chat.updated" }>[];
    assert.equal(republished.at(-1)!.chat.folder_id, null, "and the board hears that it moved out");
  } finally {
    s.cleanup();
  }
});

test("the cache window: a reply warms the chat, a warning goes out 15 minutes before it ends, a keep-alive is sent 5 minutes before, and archived or switched-off chats are left alone (D331, D332)", async () => {
  const q = replying();
  const s = setup(q.fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  const min = 60_000;
  try {
    const c = chat.create(s.project.id);
    assert.equal(c.warm_at, null, "no reply yet, no window");
    assert.equal(c.keep_alive, true, "on by default");
    chat.send(c.id, "Hello there");
    await until(() => !chat.isBusy(c.id));
    const warm = s.repo.getChat(c.id)!.warm_at!;
    assert.ok(warm, "a reply starts the window");
    const t0 = Date.parse(warm);

    chat.tick(new Date(t0 + 30 * min));
    assert.equal(s.seen.filter((m: WsMessage) => m.type === "chat.expiring").length, 0, "nothing to say with half an hour left");

    chat.tick(new Date(t0 + 46 * min));
    chat.tick(new Date(t0 + 47 * min));
    const warnings = s.seen.filter((m: WsMessage) => m.type === "chat.expiring") as Extract<WsMessage, { type: "chat.expiring" }>[];
    assert.equal(warnings.length, 1, "warned once per window, not on every tick");
    assert.equal(warnings[0].chat.id, c.id);
    assert.equal(warnings[0].minutes, 14);
    assert.equal(q.calls.length, 1, "a warning sends nothing to Claude");

    chat.tick(new Date(t0 + 56 * min));
    await until(() => !chat.isBusy(c.id));
    assert.equal(q.calls.length, 2, "five minutes before the end, the keep-alive went");
    assert.ok(q.calls[1].prompt.includes("Automatic keep-alive"), "with the note asking for one line");
    assert.ok(q.calls[1].prompt.includes("keeping this chat warm"), "and the message from Settings");
    const msgs = s.repo.chatMessages(c.id);
    const sent = msgs.filter((m) => m.role === "user");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].meta.keepalive, true, "stored as the board's own message");
    assert.equal(s.repo.getChat(c.id)!.title, "Hello there", "a keep-alive never names the chat");
    assert.notEqual(s.repo.getChat(c.id)!.warm_at, warm, "its reply opened a new window");
    assert.equal(s.repo.lastOwnChatMessage(c.id)!.text, "Hello there", "and does not count as your activity");

    // Switched off on the chat: the window closes quietly.
    chat.update(c.id, { keep_alive: false });
    const t1 = Date.parse(s.repo.getChat(c.id)!.warm_at!);
    chat.tick(new Date(t1 + 56 * min));
    assert.equal(q.calls.length, 2, "no keep-alive for a chat that said no");
    chat.tick(new Date(t1 + 61 * min));
    assert.equal(s.repo.getChat(c.id)!.warm_at, null, "a window that has passed is forgotten");

    // On again, but archived: nothing is sent to a chat nobody can see.
    chat.update(c.id, { keep_alive: true, archived: true });
    s.repo.updateChat(c.id, { warm_at: new Date(t1).toISOString() });
    chat.tick(new Date(t1 + 56 * min));
    assert.equal(q.calls.length, 2, "archived chats are left alone");

    // Reopened, but your last own message is older than the ceiling in Settings.
    chat.update(c.id, { archived: false });
    s.repo.updateChat(c.id, { warm_at: new Date(t1).toISOString() });
    chat.tick(new Date(t1 + 56 * min + 8 * 60 * min));
    assert.equal(q.calls.length, 2, "not kept warm for ever: it stops hours after your last message");

    // Off in Settings: no chat gets one, whatever its own switch says.
    s.repo.updateSettings({ chatKeepAlive: false } as never);
    s.repo.updateChat(c.id, { warm_at: new Date(t1).toISOString() });
    chat.tick(new Date(t1 + 56 * min));
    assert.equal(q.calls.length, 2, "the Settings switch wins");
  } finally {
    chat.stopWatch();
    s.cleanup();
  }
});

test("files attached to a chat ride with the next message, are readable by the chat, and ✦ What next? is the board's own marked message (D334, D338)", async () => {
  const q = replying();
  const s = setup(q.fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    s.repo.setStateDir(s.dir);
    const c = chat.create(s.project.id);
    const f = chat.addFile(c.id, { name: "orders.csv", data: Buffer.from("a,b\n1,2\n") });
    assert.equal(f.media_type, "text/csv");
    assert.equal(f.message_id, null, "waits for the next message");
    assert.throws(() => chat.addFile(c.id, { name: "virus.exe", data: Buffer.from("x") }), /does not handle/);

    chat.send(c.id, "What is in this file?");
    await until(() => !chat.isBusy(c.id));
    const sent = s.repo.chatMessages(c.id).find((m) => m.role === "user")!;
    assert.equal(sent.meta.files?.[0]?.name, "orders.csv", "the message remembers its files");
    assert.equal(s.repo.getChatFile(f.id)!.message_id, sent.id, "and the file remembers its message");
    assert.ok(q.calls[0].prompt.includes("[Attached files]") && q.calls[0].prompt.includes(f.path), "Claude is told where the file is");
    assert.ok(q.calls[0].prompt.includes("open with Read"));
    const can = q.calls[0].options.canUseTool as (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
    assert.equal((await can("Read", { file_path: f.path })).behavior, "allow", "the chat may read its own files, outside the project");
    assert.equal((await can("mcp__slack__send", {})).behavior, "deny", "other servers are not offered without my connectors and skills");
    assert.equal(q.calls[0].options.strictMcpConfig, true);
    assert.throws(() => chat.removeFile(f.id), /went with a message/);

    chat.update(c.id, { use_tools: true });
    chat.send(c.id, "Check Slack");
    await until(() => !chat.isBusy(c.id));
    const o = q.calls[1].options;
    assert.equal(o.strictMcpConfig, undefined, "your MCP servers load");
    assert.deepEqual(o.settingSources, ["user", "project"], "with your user settings, plugins and skills");
    assert.equal(o.skills, undefined);
    const can2 = o.canUseTool as (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
    assert.equal((await can2("mcp__slack__send", {})).behavior, "allow", "a connector's tool is allowed");
    assert.equal((await can2("Skill", { skill: "pdf" })).behavior, "allow");
    assert.equal((await can2("Bash", { command: "rm -rf /" })).behavior, "deny", "but never a command or an edit");
    assert.ok(q.calls[1].prompt.includes("Check Slack") && !q.calls[1].prompt.includes("[Attached files]"), "a sent file does not ride twice");

    chat.suggest(c.id);
    await until(() => !chat.isBusy(c.id));
    const ask = s.repo.chatMessages(c.id).filter((m) => m.role === "user").at(-1)!;
    assert.equal(ask.meta.suggest, true, "marked as the board's own question");
    assert.ok(q.calls[2].prompt.includes("suggest the next 5 things"));
    assert.equal(s.repo.getChat(c.id)!.title, "What is in this file?", "never retitles the chat");
    assert.ok(s.repo.lastOwnChatMessage(c.id)!.meta.suggest, "but you pressed it, so it counts as your activity for Keep warm");
  } finally {
    chat.stopWatch();
    s.cleanup();
  }
});

test("the chat offers its connectors switch only when a message names a system people connect to Claude (D349)", () => {
  assert.equal(connectedSystemIn("What did the team say in Slack today?"), "Slack");
  assert.equal(connectedSystemIn("check my inbox for the invoice"), "your email");
  assert.equal(connectedSystemIn("the numbers are in a Google Sheet"), "Google Sheets");
  assert.equal(connectedSystemIn("Where would I change the page title?"), null, "a project question is not one");
  assert.equal(connectedSystemIn("what is in this spreadsheet?"), null, "an attached spreadsheet is read here or by a card, not a connector");
  assert.equal(connectedSystemIn("fit a linear regression to the sales"), null, "Linear the tracker, not the maths");
  assert.equal(connectedSystemIn("zoom in on the chart"), null);
});

test("the chat shows how full its context is after each reply, not counting a helper's own, and starts again at zero on a fresh session (D360)", async () => {
  const usage = (input: number, read: number, out: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: out });
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) void _;
      yield { type: "system", subtype: "init", session_id: "ctx-s1" } as any;
      yield { type: "assistant", session_id: "ctx-s1", message: { id: "a1", content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }], usage: usage(2_000, 18_000, 100) } } as any;
      yield { type: "assistant", session_id: "ctx-s1", message: { id: "a2", content: [{ type: "text", text: "Here it is." }], usage: usage(1_000, 23_000, 900) } } as any;
      yield { type: "assistant", session_id: "ctx-s1", parent_tool_use_id: "t1", message: { id: "h1", content: [{ type: "text", text: "helper" }], usage: usage(90_000, 0, 10) } } as any;
      yield {
        type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "ctx-s1",
        modelUsage: { "claude-sonnet-5-5": { inputTokens: 3_000, outputTokens: 1_000, contextWindow: 1_000_000 }, "claude-haiku-4-5": { inputTokens: 500, outputTokens: 50, contextWindow: 200_000 } },
      } as any;
    })();
  const s = setup(fn);
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  try {
    s.repo.updateSettings({
      providers: [{ id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", enabled: true, baseUrl: "https://api.z.ai/api/anthropic", authRef: "ZAI_API_KEY", models: [{ id: "glm-5.3", label: "GLM 5.3" }], mayEditFiles: true }],
    });
    const c = chat.create(s.project.id);
    assert.equal(c.context_tokens, 0, "nothing to show before the first reply");

    chat.send(c.id, "Where is the login page?");
    await until(() => !chat.isBusy(c.id));
    const after = s.repo.getChat(c.id)!;
    assert.equal(after.context_tokens, 24_900, "the latest answer: what it read plus what it wrote");
    assert.equal(after.context_window, 1_000_000, "the chat's own model's window, not a helper model's");
    const pushed = s.seen.filter((m: WsMessage) => m.type === "chat.updated").map((m: any) => m.chat.context_tokens);
    assert.ok(pushed.includes(24_900), "the open page is told");

    chat.update(c.id, { provider: "zai", model: "glm-5.3" });
    const moved = s.repo.getChat(c.id)!;
    assert.deepEqual([moved.context_tokens, moved.context_window], [0, 0], "a fresh session is measured again by its first reply");
  } finally {
    s.cleanup();
  }
});

test("an \"Autonomous + asks me\" card from a chat puts its question in the chat, and an answer typed there reaches the waiting run (D361)", async () => {
  const results: any[] = [];
  const TWO = {
    questions: [
      { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Blue" }, { label: "Green" }] },
      { question: "Which pages?", header: "Pages", multiSelect: true, options: [{ label: "Home" }, { label: "Shop" }] },
    ],
  };
  const fn: QueryFn = (params) =>
    (async function* () {
      for await (const _ of params.prompt) void _;
      yield { type: "system", subtype: "init", session_id: "s1", model: "m" } as any;
      results.push(await params.options.canUseTool!("AskUserQuestion", TWO, { signal: new AbortController().signal, toolUseID: "tu", requestId: "rq" } as any));
      yield { type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0, session_id: "s1", modelUsage: {} } as any;
    })();
  const s = setup(fn);
  s.repo.updateSettings({ autoTriage: false });
  const chat = new ChatService({ repo: s.repo, bus: s.bus, runner: s.runner });
  const read = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
  try {
    // autonomous runs work in a git worktree, so the project must be a repository with a commit
    const git = (...a: string[]) => execFileSync("git", a, { cwd: s.dir });
    git("init", "-q", "-b", "main");
    writeFileSync(join(s.dir, "a.txt"), "a");
    git("add", "-A");
    git("-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "init");

    const c = chat.create(s.project.id);
    assert.equal(chat.update(c.id, { mode: "ask" }).mode, "ask", "a chat's own switch can be set to asks me");
    const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, c.id, () => {});
    const made = read(h.createTask({ title: "Restyle", spec_md: "make it nicer", stages: [{ stage: "code" }] }));
    assert.equal(made.created.asks_user, true, "the chat's switch made it Autonomous + asks me");
    const t = s.repo.getTask(made.created.id)!;
    assert.deepEqual([t.mode, t.may_ask], ["autonomous", true]);

    s.runner.queueTask(t.id);
    await until(() => s.repo.chatMessages(c.id).some((m) => m.meta.update?.kind === "asks"));
    const asks = s.repo.chatMessages(c.id).find((m) => m.meta.update?.kind === "asks")!.meta.update!;
    const card = s.repo.pendingApprovals(t.id)[0];
    assert.equal(asks.approval_id, card.id, "the chat shows the very card the run waits on");
    assert.match(asks.text, /Which colour\? \(Blue \/ Green\)\nWhich pages\? \(Home \/ Shop\)/);
    assert.deepEqual(read(h.taskProgress({ task_id: t.id })).waiting_on_question[0].questions.map((q: any) => q.question), ["Which colour?", "Which pages?"]);

    const partly = h.answerQuestion({ task_id: t.id, answer: "Blue", answers: { "Which colour?": "Blue" } }) as any;
    assert.equal(partly.isError, true, "two questions need two answers");
    assert.match(partly.content[0].text, /Which pages\?/);
    assert.equal(results.length, 0, "still waiting");

    read(h.answerQuestion({ task_id: t.id, answer: "-", answers: { "Which colour?": "Blue", "Which pages?": "Home, Shop" } }));
    await until(() => results.length === 1);
    assert.equal(results[0].behavior, "allow");
    assert.deepEqual(results[0].updatedInput.answers, { "Which colour?": "Blue", "Which pages?": "Home, Shop" });
  } finally {
    s.cleanup();
  }
});
