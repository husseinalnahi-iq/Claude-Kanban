import { useEffect, useMemo, useState } from "react";
import type { Approval } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { useAppData } from "../lib/store.tsx";
import { navigate } from "../lib/router.ts";
import { ago } from "../lib/format.ts";
import { Button, Empty, ErrorLine, inputCls, useAction } from "../components/ui.tsx";
import { QuestionCard } from "../components/QuestionCard.tsx";
import { isQuestion } from "../lib/questions.ts";

function inputSummary(a: Approval): string {
  const i = (a.input ?? {}) as Record<string, unknown>;
  const first = (i.command ?? i.file_path ?? i.pattern ?? i.path ?? "") as string;
  return typeof first === "string" ? first : "";
}

function Row({ a, focused }: { a: Approval; focused: boolean }) {
  if (isQuestion(a)) return <QuestionCard a={a} focused={focused} />;
  return <ToolRow a={a} focused={focused} />;
}

function ToolRow({ a, focused }: { a: Approval; focused: boolean }) {
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  const i = (a.input ?? {}) as Record<string, unknown>;
  return (
    <div className={`rounded-lg border p-3 ${focused ? "border-rose/70 bg-rose/10" : "border-rose/40 bg-rose/5"}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="pulse-rose inline-block h-2 w-2 rounded-full bg-rose" />
        <span className="font-mono text-[12px] font-semibold text-rose">{a.tool_name}</span>
        <span className="truncate text-[12.5px] text-ink-200">{a.title && a.title !== a.tool_name ? a.title : inputSummary(a)}</span>
        <button className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline cursor-pointer" onClick={() => navigate({ taskId: a.task_id })}>
          open task
        </button>
        <span className="font-mono text-[10.5px] text-ink-500">{ago(a.created_at)}</span>
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-ink-950 px-2.5 py-2 font-mono text-[11.5px] text-ink-300 whitespace-pre-wrap">
        {typeof i.command === "string" ? `$ ${i.command}` : JSON.stringify(i, null, 2).slice(0, 2000)}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <input className={inputCls} placeholder="Note to Claude (sent with Deny)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="danger" busy={busy} onClick={() => run(() => api.decide(a.id, "deny", note))}>Deny</Button>
        <Button variant="go" busy={busy} onClick={() => run(() => api.decide(a.id, "allow", note))}>Allow</Button>
      </div>
      <div className="mt-2"><ErrorLine error={error} /></div>
    </div>
  );
}

/**
 * Every pending approval across every project. Unattended runs stall silently on permission
 * prompts, so this is the one place to clear them: `y` allows the top one, `n` denies it.
 */
export function Approvals() {
  const { pending, projects } = useAppData();
  const { run } = useAction();
  // The title and project come with the approval row, so this view makes no extra requests at all.
  const tasks = useMemo(() => {
    const m: Record<string, { title: string; project: string }> = {};
    for (const a of pending) {
      m[a.task_id] = { title: a.task_title ?? a.task_id, project: projects.find((p) => p.id === a.project_id)?.name ?? "Setup" }; // the hidden Setup project is the only unlisted one
    }
    return m;
  }, [pending, projects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const top = pending[0];
      // y / n are for approvals; a question is answered on its own card.
      if (!top || isQuestion(top)) return;
      if (e.key === "y") void run(() => api.decide(top.id, "allow"));
      if (e.key === "n") void run(() => api.decide(top.id, "deny"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, run]);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[17px] font-semibold tracking-tight text-ink-100">Approvals</h1>
          <span className="font-mono text-[12px] text-ink-400">{pending.length} waiting{pending.length ? " · y = allow, n = deny the top one" : ""}</span>
        </div>
        {!pending.length ? <Empty>Nothing waiting. Supervised runs stop here before every write, and questions Claude asks you land here too.</Empty> : null}
        {pending.map((a, i) => (
          <div key={a.id} className="space-y-1">
            <div className="px-1 font-mono text-[10.5px] text-ink-500">
              {tasks[a.task_id]?.project ? `${tasks[a.task_id].project} · ` : ""}{tasks[a.task_id]?.title ?? a.task_id}
            </div>
            <Row a={a} focused={i === 0} />
          </div>
        ))}
      </div>
    </div>
  );
}
