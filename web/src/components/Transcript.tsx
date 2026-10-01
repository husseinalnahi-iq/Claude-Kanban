import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EventRow } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useWs, useWsReconnect } from "../lib/ws.ts";
import { Markdown } from "../lib/markdown.tsx";
import { cost, costLabel, modelLabel, shortModel, tokens } from "../lib/format.ts";
import { ContextBar } from "./UsageMeters.tsx";

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean; id?: string; tool_use_id?: string; thinking?: string };

function blocks(payload: any): Block[] {
  const c = payload?.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n");
  return JSON.stringify(content, null, 2);
}

function inputSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (input.command) return String(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.path) return String(input.path);
  if (input.prompt && name.startsWith("mcp__images__")) return String(input.prompt);
  if (name.startsWith("mcp__board__")) return Object.values(input).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" · ").slice(0, 140);
  return "";
}

/** `body` is only worked out, and only put on the page, once the row is opened: a long run has hundreds of these, each up to 24k characters. */
function Collapsible({ head, body, tone = "text-ink-300" }: { head: React.ReactNode; body: () => string; tone?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group rounded-md border border-ink-700/80 bg-ink-900/60" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={`flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 font-mono text-[11.5px] ${tone}`}>
        <span className="text-ink-500 transition-transform group-open:rotate-90">▸</span>
        {head}
      </summary>
      {open ? <pre className="max-h-80 overflow-auto border-t border-ink-700/80 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink-300 whitespace-pre-wrap">{body()}</pre> : null}
    </details>
  );
}

/** Memoised: an event never changes once stored, so a new one arriving must not redraw the rest. */
const EventView = memo(function EventView({ ev }: { ev: EventRow }) {
  const p = ev.payload as any;
  if (ev.type === "user:chat") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg rounded-br-sm border border-amber/30 bg-amber/10 px-3 py-2 text-[13px] text-ink-100 whitespace-pre-wrap">{p.text}</div>
    );
  }
  if (ev.type === "user:prompt") {
    return <Collapsible head={<span className="text-ink-300">stage prompt sent to this session</span>} body={() => p.text} />;
  }
  if (ev.type.startsWith("verify:")) {
    const ok = ev.type === "verify:passed";
    return (
      <div className={`rounded-md border px-3 py-2 ${ok ? "border-moss/40 bg-moss/5" : "border-rust/40 bg-rust/5"}`}>
        <div className={`font-mono text-[11.5px] ${ok ? "text-moss" : "text-rust"}`}>
          {ok ? "✓ verification passed" : "✕ verification failed"} · <span className="text-ink-400">{p.command}</span>
        </div>
        {!ok && p.output ? <pre className="mt-1 max-h-56 overflow-auto font-mono text-[11px] text-ink-300 whitespace-pre-wrap">{p.output}</pre> : null}
      </div>
    );
  }
  if (ev.type === "board:auto-allowed") {
    return (
      <div className="font-mono text-[11px] text-ink-500" title="Supervised: a command that can only read runs without a card (Settings → Browser & tools)">
        allowed by the board · read-only · <span className="text-ink-400">{String(p.command ?? "").slice(0, 300)}</span>
      </div>
    );
  }
  if (ev.type === "board:workspace") {
    return <div className="font-mono text-[11px] text-ink-500">workspace · {p.text}</div>;
  }
  if (ev.type === "delegate:command") {
    const line = p.kind === "http" ? `→ ${p.method} ${p.url} (${p.model})` : `$ ${[p.command, ...(p.args ?? [])].join(" ")}${p.readOnly ? "  (read-only)" : ""}`;
    return <div className="font-mono text-[11px] text-iris break-all">{line}</div>;
  }
  if (ev.type === "delegate:stderr") {
    return (
      <details className="font-mono text-[11px] text-ink-500">
        <summary className="cursor-pointer">stderr from the provider</summary>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-ink-400">{p.text}</pre>
      </details>
    );
  }
  if (ev.type === "delegate:raw") return null;
  if (ev.type === "debate:skipped") return <div className="font-mono text-[11px] text-ink-500">debate skipped · {p.reason}</div>;
  if (ev.type === "debate:decision") return <div className="font-mono text-[11px] text-iris">plan chosen: {p.choice}</div>;
  if (ev.type === "plan:approved") return <div className="font-mono text-[11px] text-iris">plan approved{p.edited ? " (edited by you)" : ""}</div>;
  if (ev.type === "turns:continued") return <div className="font-mono text-[11px] text-amber">turn limit reached — continued in the same session ({p.n})</div>;
  if (ev.type === "system:init") {
    return (
      <div className="font-mono text-[11px] text-ink-500">
        session {String(p.session_id).slice(0, 8)} · {shortModel(p.model ?? "")} · {p.permissionMode} · {(p.tools ?? []).length} tools · cwd {p.cwd}
      </div>
    );
  }
  if (ev.type.startsWith("system:hook") || ev.type === "system:status" || ev.type === "rate_limit_event") return null;
  if (ev.type === "assistant") {
    return (
      <div className="space-y-1.5">
        {blocks(p).map((b, i) => {
          if (b.type === "text" && b.text?.trim()) return <Markdown key={i} text={b.text} className="text-[13px]" />;
          if (b.type === "thinking" && b.thinking?.trim()) return <Collapsible key={i} head={<span className="italic text-ink-400">thinking</span>} body={() => b.thinking ?? ""} />;
          if (b.type === "tool_use") {
            const name = b.name ?? "tool";
            return (
              <Collapsible
                key={i}
                tone={name.startsWith("mcp__board__") || name.startsWith("mcp__images__") ? "text-cyan" : "text-amber"}
                head={
                  <>
                    <span className="font-semibold">{name.replace("mcp__board__", "board.").replace("mcp__images__", "images.")}</span>
                    <span className="truncate text-ink-400">{inputSummary(name, b.input)}</span>
                  </>
                }
                body={() => JSON.stringify(b.input, null, 2)}
              />
            );
          }
          return null;
        })}
      </div>
    );
  }
  if (ev.type === "user") {
    const results = blocks(p).filter((b) => b.type === "tool_result");
    if (!results.length) return null;
    return (
      <div className="space-y-1.5 pl-4">
        {results.map((b, i) => {
          const text = toolResultText(b.content);
          return (
            <Collapsible
              key={i}
              tone={b.is_error ? "text-rust" : "text-ink-400"}
              head={<span className="truncate">{b.is_error ? "✕ " : "↳ "}{text.split("\n")[0].slice(0, 120) || "(empty result)"}</span>}
              body={() => text}
            />
          );
        })}
      </div>
    );
  }
  if (ev.type.startsWith("result")) {
    const ok = p.subtype === "success" && !p.is_error;
    return (
      <div className={`rounded-md border px-3 py-2 font-mono text-[11.5px] ${ok ? "border-moss/40 bg-moss/10 text-moss" : "border-rust/40 bg-rust/10 text-rust"}`}>
        {ok ? "✓ finished" : `✕ ${p.subtype === "success" ? "error" : p.subtype}`} ·{p.num_turns ?? "?"} turns · {cost(p.total_cost_usd ?? 0)} ·{" "}
        {((p.duration_ms ?? 0) / 1000).toFixed(1)}s
        {!ok && (p.errors?.length || p.result) ? <div className="mt-1 whitespace-pre-wrap">{p.errors?.join("\n") || p.result}</div> : null}
      </div>
    );
  }
  return null;
});

/** How many rows are drawn at once. Older ones stay a click away; drawing thousands made every new event stutter. */
const WINDOW = 300;

/** Adds events to the list by id, in order: a page from the server and a push can arrive in either order, and overlap. */
function merged(have: EventRow[], more: EventRow[]): EventRow[] {
  const seen = new Set(have.map((e) => e.id));
  const fresh = more.filter((e) => !seen.has(e.id));
  if (!fresh.length) return have;
  const last = have[have.length - 1];
  const all = [...have, ...fresh];
  return !last || fresh[0].id > last.id ? all : all.sort((a, b) => a.id - b.id);
}

/** Live transcript of one run: loads stored events, then appends WS events for that run. */
export function Transcript({ runId, meta }: { runId: string; meta?: { model: string; cost_usd: number; input_tokens: number; output_tokens: number; context_tokens: number; context_window: number } }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  /** Index of the first row drawn. */
  const [start, setStart] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** The run being shown, so a slow answer for the previous one is dropped. */
  const showing = useRef(runId);
  const newest = useRef(0);

  // The server hands out a run's events a page at a time, oldest first, so keep asking until a page
  // comes back empty: one request used to show a long run's beginning and silently leave out its end.
  const load = useCallback(async (run: string, after: number) => {
    for (;;) {
      const page = await api.events(run, after);
      if (showing.current !== run || !page.length) return;
      // Added to what is there, never put in its place: events pushed while this was on its way stay.
      setEvents((prev) => merged(prev, page));
      after = page[page.length - 1].id;
    }
  }, []);

  useEffect(() => {
    showing.current = runId;
    newest.current = 0;
    stick.current = true;
    setEvents([]);
    setStart(0);
    load(runId, 0).catch(() => {});
    return () => {
      showing.current = "";
    };
  }, [runId, load]);

  useWs((m) => {
    if (m.type === "event" && m.runId === runId) setEvents((prev) => merged(prev, [m.event]));
  });
  // What was pushed while the socket was down is asked for again, from the last event seen.
  useWsReconnect(() => void load(runId, newest.current).catch(() => {}));

  // While you follow the run the window follows it too; once you scroll up it holds still, so rows
  // are not taken away from under what you are reading.
  const from = stick.current ? Math.max(start, events.length - WINDOW) : start;
  // Before the browser paints, not after: dropping rows off the top moves the scroll position, and
  // a scroll seen before this has gone back to the bottom would read as "you scrolled up".
  useLayoutEffect(() => {
    newest.current = events.length ? events[events.length - 1].id : 0;
    if (!stick.current) return;
    setStart((s) => Math.max(s, events.length - WINDOW));
    bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  /** Distance from the bottom before earlier rows were added, to put the view back where it was. */
  const keep = useRef<number | null>(null);
  const showEarlier = () => {
    const el = box.current;
    keep.current = el ? el.scrollHeight - el.scrollTop : null;
    stick.current = false;
    setStart(Math.max(0, from - WINDOW));
  };
  useLayoutEffect(() => {
    const el = box.current;
    if (el && keep.current !== null) el.scrollTop = el.scrollHeight - keep.current;
    keep.current = null;
  }, [start]);

  return (
    <div
      ref={box}
      className="h-full space-y-2.5 overflow-y-auto pr-1"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {meta ? (
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-400">
          <span>{modelLabel(meta)} · {costLabel(meta)} · in {tokens(meta.input_tokens)} · out {tokens(meta.output_tokens)}</span>
          <span className="text-ink-600">·</span>
          <span className="text-ink-500">context</span>
          <ContextBar used={meta.context_tokens} window={meta.context_window} />
        </div>
      ) : null}
      {events.length === 0 ? <div className="text-[12px] text-ink-500">No events yet.</div> : null}
      {from > 0 ? (
        <button className="w-full cursor-pointer rounded-md border border-dashed border-ink-700 py-1.5 font-mono text-[11px] text-ink-400 hover:border-ink-500 hover:text-ink-200" onClick={showEarlier}>
          Show earlier · {from} more above
        </button>
      ) : null}
      {events.slice(from).map((ev) => (
        <EventView key={ev.id} ev={ev} />
      ))}
      <div ref={bottom} />
    </div>
  );
}
