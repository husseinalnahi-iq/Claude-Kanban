import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeQuery, setup } from "./helpers.ts";
import { cardsLine, ChatService, CHAT_DISALLOWED, chatPrompt, describeTool, turnContext } from "../src/engine/chat.ts";
import { chatBoardHandlers } from "../src/engine/chatBoard.ts";
import { Scheduler } from "../src/engine/scheduler.ts";
import type { QueryFn } from "../src/engine/runner.ts";
import type { Stage, WsMessage } from "../src/types.ts";

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
    for (const t of ["Edit", "Write", "Bash", "AskUserQuestion"]) assert.ok(CHAT_DISALLOWED.includes(t) && opts.disallowedTools.includes(t), `${t} is not offered`);
    assert.equal(q.denied[0].behavior, "deny", "and refused if tried anyway");
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
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner, scheduler }, s.project.id, (c) => cards.push(c));
  try {
    const made = JSON.parse(h.createTask({ title: "Add a dark mode", spec_md: "Done when…", mode: "autonomous" }).content[0].text).created;
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
  const p = chatPrompt({ name: "Shop", path: "/p" } as any);
  assert.match(p, /cannot edit files/);
  assert.match(p, /Never queue or schedule a card the user did not ask to run/);
  assert.doesNotMatch(p, /UTC[+-]\d{2}/, "no clock in the system prompt: it would re-bill the whole conversation every minute");
  assert.match(turnContext(new Date(2026, 8, 14, 22, 0)), /^\[Local time: .*22:00 \(UTC[+-]\d{2}:\d{2}\)\]$/, "the local offset rides on each message, so 'tonight at 3' can be scheduled correctly");
});

test("chat board tools: the chat can follow a card, tell it something, answer its question, and re-run a failed one", async () => {
  const q = fakeQuery({ byCall: (i) => (i === 2 ? { fail: true } : undefined) });
  const s = setup(q.fn);
  const cards: any[] = [];
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, (c) => cards.push(c));
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
    assert.match(q.calls[0].prompt, /^\[Local time: .*\]\n\nhello$/, "the clock rides on the message, not the cached system prompt");
  } finally {
    s.cleanup();
  }
});

test("chat board tools: the list counts every status and hides Done; queueing never restarts reviewed or failed work", async () => {
  const q = fakeQuery({ byCall: (i) => (i === 1 ? { fail: true } : undefined) });
  const s = setup(q.fn);
  const h = chatBoardHandlers({ repo: s.repo, bus: s.bus, runner: s.runner }, s.project.id, () => {});
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
