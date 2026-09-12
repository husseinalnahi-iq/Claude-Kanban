import { useState } from "react";
import type { Approval } from "../../../server/src/types.ts";
import { questionsOf, questionTitle } from "../lib/questions.ts";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { Button, ErrorLine, inputCls, useAction } from "./ui.tsx";

/**
 * Claude stopped to ask you something. Pick an option (or several, where it allows), or type your
 * own answer; "Let Claude decide" hands the choice back and the task carries on.
 */
export function QuestionCard({ a, focused = false }: { a: Approval; focused?: boolean }) {
  const qs = questionsOf(a);
  const [picks, setPicks] = useState<string[][]>(() => qs.map(() => []));
  const [other, setOther] = useState<string[]>(() => qs.map(() => ""));
  const { busy, error, run } = useAction();

  const answerOf = (i: number) => other[i].trim() || picks[i].join(", ");
  const ready = qs.length > 0 && qs.every((_, i) => answerOf(i));
  const toggle = (i: number, label: string) => {
    setOther((o) => o.map((v, j) => (j === i ? "" : v)));
    setPicks((p) =>
      p.map((sel, j) => (j !== i ? sel : qs[i].multiSelect ? (sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]) : [label])),
    );
  };
  const send = () => run(() => api.answer(a.id, Object.fromEntries(qs.map((q, i) => [q.question, answerOf(i)]))));

  return (
    <div
      className={`rise rounded-xl border p-4 outline-none transition-colors ${focused ? "border-iris/70 bg-iris/10" : "border-iris/45 bg-iris/5"}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        // 1–4 pick an option of the first question that has no answer yet; Enter sends.
        const n = Number(e.key);
        const i = qs.findIndex((_, j) => !answerOf(j));
        if (n >= 1 && n <= 4 && qs[i === -1 ? 0 : i]?.options[n - 1]) toggle(i === -1 ? 0 : i, qs[i === -1 ? 0 : i].options[n - 1].label);
        if (e.key === "Enter" && ready) void send();
      }}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="breathe inline-block h-2 w-2 rounded-full bg-iris" />
        <span className="text-[12.5px] font-semibold text-iris">Claude asks you</span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-500">{ago(a.created_at)}</span>
      </div>
      <div className="space-y-4">
        {qs.map((q, i) => (
          <div key={i}>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              {q.header ? <span className="rounded-full border border-iris/40 px-2 py-px font-mono text-[10px] uppercase tracking-wide text-iris">{q.header}</span> : null}
              <span className="text-[13.5px] font-medium leading-snug text-ink-100">{q.question}</span>
              {q.multiSelect ? <span className="text-[11px] text-ink-500">pick any</span> : null}
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {q.options.map((o, k) => {
                const on = picks[i].includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => toggle(i, o.label)}
                    className={`group flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-all duration-150 cursor-pointer active:scale-[0.99] ${
                      on ? "border-iris bg-iris/15 shadow-[0_0_0_3px_rgb(150_130_240/0.15)]" : "border-ink-700 bg-ink-900/60 hover:border-ink-500"
                    }`}
                  >
                    <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] ${q.multiSelect ? "rounded" : "rounded-full"} ${on ? "border-iris bg-iris text-ink-950" : "border-ink-500 text-transparent"}`}>
                      ✓
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-ink-100">
                        {o.label} <span className="ml-1 font-mono text-[10px] text-ink-600">{k < 4 ? k + 1 : ""}</span>
                      </span>
                      {o.description ? <span className="block text-[11.5px] leading-snug text-ink-400">{o.description}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <input
              className={`${inputCls} mt-1.5`}
              placeholder="Or type your own answer…"
              value={other[i]}
              onChange={(e) => {
                const v = e.target.value;
                setOther((o) => o.map((x, j) => (j === i ? v : x)));
                if (v) setPicks((p) => p.map((sel, j) => (j === i ? [] : sel)));
              }}
              onKeyDown={(e) => e.key === "Enter" && ready && void send()}
            />
          </div>
        ))}
        {!qs.length ? <pre className="rounded bg-ink-950 px-2.5 py-2 font-mono text-[11.5px] text-ink-300 whitespace-pre-wrap">{JSON.stringify(a.input, null, 2)}</pre> : null}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="ghost" busy={busy} onClick={() => run(() => api.decide(a.id, "deny", "you decide"))} title="Claude picks the most sensible option itself and says which in its summary">
          Let Claude decide
        </Button>
        <Button className="ml-auto border-iris/60 text-iris hover:bg-iris/10" busy={busy} disabled={!ready} onClick={() => void send()}>
          Send answer
        </Button>
      </div>
      <div className="mt-2"><ErrorLine error={error} /></div>
    </div>
  );
}

/** One line for the drawer's history: what was asked, and what you said. */
export function QuestionHistory({ a }: { a: Approval }) {
  const answered = a.answers && Object.values(a.answers).join(" · ");
  return (
    <span className="min-w-0 truncate text-ink-300" title={questionTitle(a)}>
      {questionTitle(a)} <span className={answered ? "text-iris" : "text-ink-500"}>→ {answered || (a.decision === "deny" ? "you let Claude decide" : a.note ?? "no answer")}</span>
    </span>
  );
}
