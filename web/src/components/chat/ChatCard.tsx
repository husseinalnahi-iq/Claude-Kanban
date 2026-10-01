import { createContext, useContext, useState } from "react";
import type { Approval, ChatMessage, Mode, Stage, TaskCard } from "../../../../server/src/types.ts";
import { isAnswerPipeline } from "../../../../server/src/engine/answer.ts";
import { api, type ProjectWithGit } from "../../lib/api.ts";
import { useAppData } from "../../lib/store.tsx";
import { navigate } from "../../lib/router.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { cost, modelLabel, STATUS_META } from "../../lib/format.ts";
import { phase, waitingOn, waitLine } from "../../lib/phase.ts";
import { isQuestion } from "../../lib/questions.ts";
import { inputSummary } from "../../lib/approvals.ts";
import { Button, Chip, ErrorLine, useAction } from "../ui.tsx";
import { PipelineEditor, pipelineLine } from "../PipelineEditor.tsx";
import { RunSuggestions } from "../Suggestions.tsx";
import { QuestionCard } from "../QuestionCard.tsx";
import { CredentialWarning, riskOf } from "../CredentialWarning.tsx";
import { ChecklistLine } from "../Checklist.tsx";
import { autonomousBlocked, branchBlocked } from "../forms.tsx";
import { openTaskOn } from "../../views/TaskDrawer.tsx";

type CardAction = NonNullable<ChatMessage["meta"]["cards"]>[number]["action"];
/** The chip's word for what the chat did with a card. */
const ACTION_LABEL: Record<CardAction, string> = {
  created: "created", updated: "edited", queued: "queued", scheduled: "scheduled",
  messaged: "told", answered: "answered", stopped: "stopped", retried: "run again",
};

/**
 * The board's live cards, for every card shown in the chat. Stored chat messages never change; the
 * cards they name do, so a card read its status from here — never from the message — and a Start
 * pressed on the board or in the task shows here at once (D288).
 */
export const ChatBoard = createContext<{ project: ProjectWithGit; cards: Map<string, TaskCard>; latest: Map<string, number> } | null>(null);

const IN_PROGRESS = new Set(["approval", "planning", "running", "paused"]);
const small = "cursor-pointer rounded border px-1.5 py-px font-mono text-[10.5px] disabled:cursor-default disabled:opacity-40";

/** Where a card stands, in the board's own words and colours. */
function StatusPill({ card, asking, waits }: { card: TaskCard; asking: boolean; waits?: boolean }) {
  if (card.status === "queued" && waits) return <Chip className="border-slate/60 text-slate" title="It starts by itself once the tasks it waits for are done">waiting</Chip>;
  if (IN_PROGRESS.has(card.status)) {
    const p = phase(card, asking);
    return <Chip className={`${p.tone} font-semibold`} title={p.title}>{p.text}</Chip>;
  }
  const m = STATUS_META[card.status];
  return <Chip className={`${m.color} ${m.text}`}>{card.status === "review" ? "ready for review" : m.label}</Chip>;
}

function OpenButton({ id }: { id: string }) {
  return (
    <button className={`${small} border-ink-600 text-ink-300 hover:border-ink-400 hover:text-ink-100`} onClick={() => navigate({ taskId: id })}>
      open
    </button>
  );
}

/** A command or a change waiting on you, compact: what it is, then Allow or Deny. */
function ToolApproval({ a }: { a: Approval }) {
  const { busy, error, run } = useAction();
  const i = (a.input ?? {}) as Record<string, unknown>;
  // A card that would print credentials is never allowed without a look at the whole card (D280).
  const prints = riskOf(a)?.level === "prints";
  return (
    <div className="rounded-md border border-rose/40 bg-rose/5 px-2.5 py-1.5">
      <div className="text-[11.5px] text-rose">Waiting for you: {a.title && a.title !== a.tool_name ? a.title : a.tool_name}</div>
      <pre className="mt-1 max-h-28 overflow-auto rounded bg-ink-950 px-2 py-1 font-mono text-[11px] text-ink-300 whitespace-pre-wrap">
        {typeof i.command === "string" ? `$ ${i.command}` : inputSummary(a) || a.tool_name}
      </pre>
      <CredentialWarning a={a} />
      <div className="mt-1.5 flex justify-end gap-2">
        <Button size="sm" variant="danger" busy={busy} onClick={() => run(() => api.decide(a.id, "deny"))}>Deny</Button>
        {prints ? (
          <Button size="sm" onClick={() => navigate({ taskId: a.task_id })}>Review</Button>
        ) : (
          <Button size="sm" variant="go" busy={busy} onClick={() => run(() => api.decide(a.id, "allow"))}>Allow</Button>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** How a Backlog card will run, changeable here: mode, its own branch, and the model and effort per stage. */
function RunSetup({ card, project }: { card: TaskCard; project: ProjectWithGit }) {
  const { settings } = useAppData();
  const [editing, setEditing] = useState<Stage[] | null>(null);
  const { busy, error, run } = useAction();
  const answer = isAnswerPipeline(card.pipeline);
  const noAuto = answer ? "An answer card only reads, so it runs supervised." : autonomousBlocked(project);
  const noBranch = branchBlocked(project);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["supervised", "autonomous"] as Mode[]).map((m) => (
          <button
            key={m}
            disabled={busy || card.mode === m || (m === "autonomous" && !!noAuto)}
            title={m === "autonomous" ? noAuto ?? "Works on its own branch without asking; lands when you approve" : "Works in the project's folder and asks you before each change"}
            onClick={() => run(() => api.patchTask(card.id, { mode: m }))}
            className={`${small} ${card.mode === m ? (m === "autonomous" ? "border-amber/60 bg-amber/10 text-amber" : "border-cyan/60 bg-cyan/10 text-cyan") : "border-ink-700 text-ink-400 hover:text-ink-200"}`}
          >
            {m}
          </button>
        ))}
        {card.mode === "supervised" && !answer ? (
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-300" title={noBranch ?? "Its own copy of the project; lands only when you approve"}>
            <input
              type="checkbox"
              className="accent-cyan"
              checked={card.own_branch}
              disabled={busy || !!noBranch || !!card.branch}
              onChange={(e) => run(() => api.patchTask(card.id, { own_branch: e.target.checked }))}
            />
            own branch
          </label>
        ) : null}
        {answer ? <span className="text-[11px] text-ink-500">reads only · lands in Done with its answer</span> : null}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <PipelineEditor value={editing} onChange={setEditing} models={settings?.models ?? []} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="go" busy={busy} disabled={!editing.length} onClick={() => run(async () => { await api.patchTask(card.id, { pipeline: editing }); setEditing(null); })}>
              Use these
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug text-ink-400">{pipelineLine(card.pipeline, modelLabel)}</span>
          <button className={`${small} shrink-0 border-ink-600 text-ink-300 hover:text-ink-100`} title="Change the model or effort of a stage" onClick={() => setEditing(card.pipeline.map((s) => ({ ...s })))}>
            change
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * A card the chat made or touched, as it is now. Only the newest mention of a card carries its
 * controls, so a long chat does not offer the same Start three times.
 */
export function ChatCard({ id, title, actions, messageId }: { id: string; title: string; actions: CardAction[]; messageId: number }) {
  const ctx = useContext(ChatBoard);
  const { pending } = useAppData();
  const { busy, error, run } = useAction();
  const card = ctx?.cards.get(id);
  const latest = ctx?.latest.get(id) === messageId;
  const waiting = card ? pending.filter((a) => a.task_id === card.id) : [];
  const asking = waiting.some(isQuestion);
  const blockers = card && ctx ? waitingOn(card, ctx.cards) : [];
  // Retrying a sandbox block in the same mode would only hit the same wall: that is decided in the task.
  const needsSwitch = card?.status === "failed" && card.blocked?.needs === "supervised" && card.mode === "autonomous";
  return (
    <div data-chat-card={id} data-latest={latest ? "1" : undefined} className="rounded-lg border border-amber/40 bg-amber/5 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-amber/80">{actions.map((a) => ACTION_LABEL[a] ?? a).join(" · ")}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{card?.title ?? title}</span>
        {card ? <StatusPill card={card} asking={asking} waits={blockers.length > 0} /> : null}
        <OpenButton id={id} />
      </div>
      {card && blockers.length && (card.status === "queued" || card.status === "backlog") ? (
        <div className={`mt-1 text-[11.5px] ${blockers.some((b) => b.status === "failed") ? "text-rust" : "text-ink-400"}`}>⏳ {waitLine(blockers)}</div>
      ) : null}
      {card && latest ? (
        <div className="mt-1.5 space-y-1.5">
          {card.status === "backlog" && ctx ? (
            <>
              <RunSetup card={card} project={ctx.project} />
              <div className="space-y-1.5">
                <RunSuggestions t={card} busy={false} compact />
              </div>
              <div className="flex justify-end">
                <Button size="sm" variant="go" busy={busy} title="Queue it now" onClick={() => run(() => api.queue(card.id))}>▶ Start</Button>
              </div>
            </>
          ) : null}
          {IN_PROGRESS.has(card.status) || card.status === "queued" ? (
            <>
              <ChecklistLine list={card.checklist} live={card.status !== "paused"} />
              {card.status === "approval" && card.plan_gate ? (
                <div className="flex items-center gap-2 text-[12px] text-iris">
                  <span className="flex-1">Its plan is ready for your OK.</span>
                  <Button size="sm" onClick={() => openTaskOn(card.id, "plan")}>Read the plan</Button>
                </div>
              ) : null}
              {waiting.map((a) => (isQuestion(a) ? <QuestionCard key={a.id} a={a} focused /> : <ToolApproval key={a.id} a={a} />))}
              <div className="flex justify-end">
                <button className={`${small} border-ink-600 text-ink-400 hover:border-rust hover:text-rust`} disabled={busy} onClick={() => run(() => api.stop(card.id))}>
                  stop
                </button>
              </div>
            </>
          ) : null}
          {card.status === "failed" ? (
            <div className="flex items-start gap-2">
              <span className="line-clamp-2 min-w-0 flex-1 font-mono text-[11px] text-rust">{card.blocked?.reason ?? card.error ?? "It stopped."}</span>
              {needsSwitch ? null : (
                <Button size="sm" busy={busy} title="Carry on from the stage that failed" onClick={() => run(() => api.retry(card.id))}>Retry</Button>
              )}
            </div>
          ) : null}
          {card.status === "review" ? <div className="text-[11.5px] text-ink-400">Ready for your review: open it to look at the work and approve it.</div> : null}
          {card.status === "done" && card.cost_usd > 0 ? <div className="font-mono text-[10.5px] text-ink-500">done · {cost(card.cost_usd)}</div> : null}
          <ErrorLine error={error} />
        </div>
      ) : null}
    </div>
  );
}

/** Every card one reply touched, one card each, naming everything it did to it ("created · queued"). */
export function ChatCards({ m }: { m: ChatMessage }) {
  const byCard = new Map<string, { id: string; title: string; actions: CardAction[] }>();
  for (const c of m.meta.cards!) {
    const seen = byCard.get(c.id) ?? { id: c.id, title: c.title, actions: [] };
    if (!seen.actions.includes(c.action)) seen.actions.push(c.action);
    seen.title = c.title;
    byCard.set(c.id, seen);
  }
  return (
    <div className="rise space-y-1.5">
      {[...byCard.values()].map((c) => <ChatCard key={c.id} {...c} messageId={m.id} />)}
    </div>
  );
}

const UPDATE_LOOK = {
  finished: { tone: "border-moss/40 bg-moss/5", word: "text-moss" },
  failed: { tone: "border-rust/40 bg-rust/5", word: "text-rust" },
  plan: { tone: "border-iris/40 bg-iris/5", word: "text-iris" },
  question: { tone: "border-cyan/40 bg-cyan/5", word: "text-cyan" },
} as const;

/**
 * What a card from this chat did by itself — its answer, why it failed, its plan, its question —
 * posted by the board (D285). Its buttons follow the card's live state: Retry only while it is still
 * failed, the options only while the question is still open.
 */
export function ChatUpdateRow({ m }: { m: ChatMessage }) {
  const u = m.meta.update!;
  const ctx = useContext(ChatBoard);
  const card = ctx?.cards.get(u.id);
  const { busy, error, run } = useAction();
  const look = UPDATE_LOOK[u.kind];
  const word =
    u.kind === "finished" ? (u.status === "done" ? (card && isAnswerPipeline(card.pipeline) ? "answer" : "done") : "ready for review")
    : u.kind === "failed" ? "failed"
    : u.kind === "plan" ? "plan ready"
    : "question";
  const open = u.kind === "question" && card?.questions.find((q) => q.id === u.question_id && !q.answer);
  const answered = u.kind === "question" ? card?.questions.find((q) => q.id === u.question_id)?.answer : null;
  return (
    <div className={`rise rounded-lg border px-3 py-2 ${look.tone}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className={`font-mono text-[10px] uppercase tracking-wide ${look.word}`}>{word}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-300">{u.title}</span>
        {u.kind === "finished" && u.cost_usd ? <span className="font-mono text-[10.5px] text-ink-500">{cost(u.cost_usd)}</span> : null}
        <OpenButton id={u.id} />
      </div>
      {u.kind === "failed" ? (
        <div className="line-clamp-4 font-mono text-[11.5px] text-rust">{u.text}</div>
      ) : (
        <Markdown text={u.text} className="text-[13px]" />
      )}
      {u.kind === "failed" && card?.status === "failed" && !(card.blocked?.needs === "supervised" && card.mode === "autonomous") ? (
        <div className="mt-1.5 flex justify-end">
          <Button size="sm" busy={busy} onClick={() => run(() => api.retry(u.id))}>Retry</Button>
        </div>
      ) : null}
      {u.kind === "plan" && card?.status === "approval" && card.plan_gate ? (
        <div className="mt-1.5 flex justify-end">
          <Button size="sm" onClick={() => openTaskOn(u.id, "plan")}>Read the plan</Button>
        </div>
      ) : null}
      {open ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {(u.options ?? []).map((o) => (
            <Button key={o} size="sm" busy={busy} onClick={() => run(() => api.answerQuestion(u.id, u.question_id!, o))}>{o}</Button>
          ))}
          <span className="text-[11px] text-ink-500">{u.options?.length ? "or type your answer below" : "type your answer below"}</span>
        </div>
      ) : answered ? (
        <div className="mt-1 text-[11.5px] text-ink-400">Answered: {answered}</div>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * This chat's cards that are still going, above the message box: a card waiting on you is never
 * scrolled out of sight. A row jumps to the card's newest mention, where its controls are.
 */
export function ChatTray({ chatId }: { chatId: string | null }) {
  const ctx = useContext(ChatBoard);
  const { pending } = useAppData();
  const [open, setOpen] = useState(true);
  if (!ctx || !chatId) return null;
  const mine = [...ctx.cards.values()].filter((c) => c.chat_id === chatId && c.status !== "done" && !c.archived_at);
  if (!mine.length) return null;
  const jump = (id: string) => document.querySelector(`[data-chat-card="${id}"][data-latest="1"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <div className="mb-2 rounded-lg border border-ink-700 bg-ink-850/80">
      <button className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-500 hover:text-ink-300" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Cards from this chat · {mine.length}
      </button>
      {open ? (
        <div className="max-h-32 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
          {mine.map((c) => {
            const waiting = pending.filter((a) => a.task_id === c.id);
            return (
              <div key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-ink-800" onClick={() => jump(c.id)} title="Show it in the chat">
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-200">{c.title}</span>
                {waiting.length ? <span className="font-mono text-[10.5px] text-rose">{waiting.length} waiting on you</span> : null}
                <StatusPill card={c} asking={waiting.some(isQuestion)} waits={waitingOn(c, ctx.cards).length > 0} />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
