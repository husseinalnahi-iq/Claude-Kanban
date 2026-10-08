import { useState } from "react";
import { accessAsk, recommendedOption, supervisedFrom, type Run } from "../../../server/src/types.ts";
import { api, type TaskDetail } from "../lib/api.ts";
import { Markdown } from "../lib/markdown.tsx";
import { Button, ErrorLine, inputCls, useAction } from "./ui.tsx";
import { useAsk } from "./Ask.tsx";
import { useAppData } from "../lib/store.tsx";

type Verdict = "APPROVE" | "CHANGES_NEEDED" | "BLOCKED";

/** The same rule as the server's verdictOf: the last `VERDICT:` line counts. */
function verdictOf(text: string | null | undefined): { verdict: Verdict; reason: string } | null {
  const all = [...(text ?? "").matchAll(/^\s*\**VERDICT\**\s*:\s*\**\s*(APPROVE|CHANGES_NEEDED|BLOCKED)\**\s*[—:-]?\s*(.*)$/gim)];
  const last = all.at(-1);
  return last ? { verdict: last[1].toUpperCase() as Verdict, reason: last[2].trim() } : null;
}

const stageRuns = (d: TaskDetail) => d.runs.filter((r) => r.role !== "critic");
const lastOf = (runs: Run[], ok: (r: Run) => boolean) => [...runs].reverse().find(ok);

/**
 * Shown above the tabs while a stage's report of "I can't do this from here" stands. It replaces
 * the green Approve the old board offered on the same situation (docs/DECISIONS.md D184, D185).
 * A suggestion the run carried on past (D382) is shown in amber, with the switch as an offer.
 */
export function BlockedPanel({ d }: { d: TaskDetail }) {
  const t = d.task;
  const b = t.blocked!;
  const { busy, error, run } = useAction();
  const dialog = useAsk();
  const advisory = !!b.advisory;
  // A stop keeps the access it named too (D422): asking for exactly that is the way on, stopped or not.
  const access = accessAsk(b);
  const signIn = b.needs_access?.kind === "sign_in";
  const stage = t.pipeline[b.stage_index]?.stage ?? "stage";
  const report = lastOf(stageRuns(d), (r) => r.stage_index === b.stage_index)?.result_md;
  const hasWork = !!(t.branch || t.worktree_path);
  const { settings } = useAppData();
  // With full reach (D418) an autonomous task can already do what a supervised one could: no switch.
  const canSwitch = b.needs === "supervised" && t.mode === "autonomous" && settings?.autonomousReach === "sandbox";
  const n = b.stage_index + 1;
  // The same rule as the server's supervisedFrom: the plan is not made again, the stage that writes reruns.
  const from = advisory ? supervisedFrom(t.pipeline, b.stage_index) : b.stage_index;
  const fromStage = t.pipeline[from]?.stage ?? "stage";

  const switchAndRun = async () => {
    const ok = await dialog.confirm({
      title: "Switch to supervised and run again?",
      message: (
        <>
          {hasWork ? (
            <p className="mb-2">
              The sandboxed work on <span className="font-mono text-amber">{t.branch}</span> is discarded
              {advisory ? " — the supervised run does it again, with the access it was missing. To keep it instead, approve it and do the live steps yourself." : " — it was done without the access this task needs."}
            </p>
          ) : null}
          <p>The task runs again from stage #{from + 1} ({fromStage}) in your main checkout. Earlier stages are kept and handed on. Every write waits for your approval on the Approvals tab.</p>
        </>
      ),
      confirmLabel: "Switch and run",
    });
    if (ok) await run(() => api.escalate(t.id));
  };

  return (
    <div className={`border-b px-5 py-3 ${advisory ? "border-amber/30 bg-amber/5" : "border-rose/30 bg-rose/5"}`}>
      {dialog.element}
      <div className="mb-1 flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${advisory ? "bg-amber" : "pulse-rose bg-rose"}`} />
        {advisory ? (
          <span className="text-[12.5px] font-semibold text-amber">{access ? `${access} — then it finishes this on its own` : `Suggested at stage #${n} · ${stage}: part of this needs a supervised run`}</span>
        ) : (
          <span className="text-[12.5px] font-semibold text-rose">Blocked at stage #{n} · {stage} — needs you</span>
        )}
      </div>
      <div className="text-[13px] text-ink-100">{b.reason}</div>
      {b.ask ? <div className="mt-1 text-[13px] text-ink-200">{advisory ? <span className="text-amber">It suggests:</span> : <span className="text-rose">It asks:</span>} {b.ask}</div> : null}
      {access ? (
        <div className="mt-1.5 text-[12px] text-ink-400">
          {d.busy
            ? "It is still working on the rest. Sign in now and its next stage uses that sign-in."
            : `${advisory ? "It did everything else and is waiting only on this." : "Everything else is done; this is what it stopped for."} ${signIn ? "Sign in below; the moment you close that window the card runs this step again by itself." : "Give it that, then press Retry."}${advisory ? " You can also approve the work as it is." : ""}`}
        </div>
      ) : advisory ? (
        <div className="mt-1.5 text-[12px] text-ink-400">
          It did not stop: it carried on with everything its sandbox allows. Approve the work as it is, or
          switch — a supervised run works in your main checkout and asks you before every write.
        </div>
      ) : canSwitch ? (
        <div className="mt-1.5 text-[12px] text-ink-400">
          Autonomous runs are sandboxed: nothing outside their own folder, no live systems, no credentials from your main checkout. A supervised run works in your
          main checkout and asks you before every write.
        </div>
      ) : null}
      {b.source === "board" ? <div className="mt-1 text-[12px] text-ink-400">The board stopped it: it kept trying to reach outside its folder instead of saying so.</div> : null}
      {report ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] text-ink-400 hover:text-ink-200">What it found</summary>
          <div className="mt-1.5 max-h-72 overflow-auto rounded-md border border-ink-800 bg-ink-900 px-3 py-2"><Markdown text={report} /></div>
        </details>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {signIn && b.needs_access ? (
          <Button variant="primary" busy={busy} title="Opens the board's browser at that site; sign in and close the window, and the card picks this step up again" onClick={() => run(() => api.signInSite(b.needs_access!.target))}>Sign in to {b.needs_access.target}</Button>
        ) : null}
        {d.busy ? null : canSwitch ? (
          <Button variant={advisory ? "ghost" : "primary"} busy={busy} disabled={d.busy} onClick={() => void switchAndRun()}>Switch to supervised &amp; run from #{from + 1}</Button>
        ) : (
          <Button variant="primary" busy={busy} disabled={d.busy} onClick={() => run(() => api.retry(t.id, b.stage_index))}>↻ Retry from #{n}</Button>
        )}
        {advisory || d.busy ? null : <Button variant="ghost" busy={busy} disabled={d.busy} onClick={() => run(() => api.reject(t.id, `Blocked: ${b.reason}`))}>Back to backlog</Button>}
      </div>
      <div className="mt-2"><ErrorLine error={error} /></div>
    </div>
  );
}

/**
 * The deliverable, where the person looks first. The last stage's report is the review's, so the
 * answer to what they asked — "show me how to do it myself" — used to be one tab and one click
 * away, under a review saying "no action needed" (docs/DECISIONS.md D197).
 */
function resultOf(d: TaskDetail) {
  const runs = stageRuns(d).filter((r) => r.status === "success");
  const work = lastOf(runs, (r) => r.stage === "code" || r.stage === "custom") ?? lastOf(runs, (r) => r.stage !== "review");
  const review = lastOf(runs, (r) => r.stage === "review");
  return { work, v: verdictOf(review?.result_md) };
}

/** Whether a task in Review or Done has a report or a verdict to show: the Result tab is listed only then (D347). */
export function hasResult(d: TaskDetail): boolean {
  if (!["review", "done"].includes(d.task.status)) return false;
  const { work, v } = resultOf(d);
  return Boolean(work?.result_md?.trim() || v);
}

export function ResultPanel({ d }: { d: TaskDetail }) {
  const { work, v } = resultOf(d);
  if (!work?.result_md?.trim() && !v) return null;
  const tone = v?.verdict === "APPROVE" ? "border-lime/50 text-lime" : "border-rust/50 text-rust";
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-400">Result</span>
        {work ? <span className="font-mono text-[11px] text-ink-500">from #{work.stage_index + 1} {work.stage}</span> : null}
        {v ? (
          <span className={`ml-auto rounded border px-1.5 py-px font-mono text-[10.5px] ${tone}`} title={v.reason || undefined}>
            review: {v.verdict.toLowerCase().replace("_", " ")}
          </span>
        ) : null}
      </div>
      {work?.result_md?.trim() ? <div className="max-h-[420px] overflow-auto px-3 py-2"><Markdown text={work.result_md} /></div> : null}
      {v?.reason ? <div className="border-t border-ink-800 px-3 py-1.5 text-[12px] text-ink-400">Review: {v.reason}</div> : null}
      {(d.task.mode === "supervised" || d.task.in_folder) && d.task.checkout?.touched?.length ? (
        <details className="border-t border-ink-800 px-3 py-1.5 text-[12px] text-ink-400">
          <summary className="cursor-pointer hover:text-ink-200">
            {d.task.checkout.touched.length} file{d.task.checkout.touched.length === 1 ? "" : "s"} changed while this ran — uncommitted, in your checkout
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ink-300">
            {d.task.checkout.touched.map((f) => <li key={f}>{f}</li>)}
          </ul>
          <div className="mt-1 text-[11px] text-ink-500">
            {d.task.mode === "autonomous" ? "Approve commits these, and only these." : "Commit these, and only these, for this task."} Files that were already uncommitted before it started are left out.
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Questions a stage asked with `board_ask` while it carried on with a default. Before, they sat in a
 * plan's report under "needs you" and the pipeline ran past them (docs/DECISIONS.md D203).
 */
export function QuestionsPanel({ d }: { d: TaskDetail }) {
  const open = d.task.questions.filter((q) => !q.answer);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  if (!open.length) return null;
  const answer = (id: string, text: string) => run(() => api.answerQuestion(d.task.id, id, text));
  const running = d.busy;
  return (
    <div className="border-b border-cyan/30 bg-cyan/5 px-5 py-3">
      <div className="mb-1.5 text-[12.5px] font-semibold text-cyan">
        {open.length === 1 ? "A question for you" : `${open.length} questions for you`}
        <span className="ml-2 font-normal text-ink-400">
          {running ? "— it is carrying on with its default; your answer reaches the next stage" : "— the run went on with its default; answer to record your decision"}
        </span>
      </div>
      <div className="space-y-2.5">
        {open.map((q) => (
          <div key={q.id}>
            <div className="text-[13px] text-ink-100">{q.text}</div>
            {q.default ? <div className="text-[11.5px] text-ink-400">Meanwhile: {q.default}</div> : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {q.options.map((o) =>
                o === recommendedOption(q) ? (
                  <Button key={o} size="sm" busy={busy} onClick={() => answer(q.id, o)} className="border-moss! bg-moss/15! text-moss!" title="What Claude recommends, and what it carries on with">
                    {o}
                    <span className="rounded bg-moss/25 px-1 font-mono text-[9.5px] uppercase tracking-wide">Recommended</span>
                  </Button>
                ) : (
                  <Button key={o} size="sm" busy={busy} onClick={() => answer(q.id, o)}>{o}</Button>
                ),
              )}
              <input
                className={`${inputCls} h-7 min-w-[220px] flex-1 py-0 text-[12.5px]`}
                placeholder={q.options.length ? "…or your own answer" : "Your answer"}
                value={drafts[q.id] ?? ""}
                onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && (drafts[q.id] ?? "").trim() && void answer(q.id, drafts[q.id])}
              />
              <Button size="sm" variant="primary" busy={busy} disabled={!(drafts[q.id] ?? "").trim()} onClick={() => answer(q.id, drafts[q.id])}>Answer</Button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2"><ErrorLine error={error} /></div>
    </div>
  );
}

/** A run in the project folder shares your checkout: say what was already uncommitted when it started (D204, D398). */
export function CheckoutNote({ d }: { d: TaskDetail }) {
  const c = d.task.checkout;
  if ((d.task.mode !== "supervised" && !d.task.in_folder) || !c?.dirtyAtStart.length) return null;
  return (
    <details className="rounded-lg border border-slate/40 bg-slate/5 px-3 py-2 text-[12px] text-slate">
      <summary className="cursor-pointer">
        Your checkout already had {c.dirtyAtStart.length} uncommitted file{c.dirtyAtStart.length === 1 ? "" : "s"} when this started — not this task's.
        The run was told to leave them alone.
      </summary>
      <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto font-mono text-[11px] text-ink-300">
        {c.dirtyAtStart.map((f) => <li key={f}>{f}</li>)}
      </ul>
    </details>
  );
}
