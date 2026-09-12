import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { ChatService, CHAT_DISALLOWED, chatPrompt, describeTool } from "../src/engine/chat.ts";
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
    assert.equal(c.model, "claude-sonnet-5", "the balanced default");
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
  const p = chatPrompt({ name: "Shop", path: "/p" } as any, new Date(2026, 8, 14, 22, 0));
  assert.match(p, /cannot edit files/);
  assert.match(p, /Never queue or schedule a card the user did not ask to run/);
  assert.match(p, /UTC[+-]\d{2}:\d{2}/, "the local offset, so 'tonight at 3' can be scheduled correctly");
});
