import { useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { openTask, resolveNeed, type Alert, type Outcome } from "../lib/alerts.ts";
import { isQuestion, questionsOf } from "../lib/questions.ts";
import { riskOf } from "./CredentialWarning.tsx";

export const OUTCOME_TEXT: Record<Outcome, { text: string; color: string }> = {
  allowed: { text: "✓ Allowed", color: "var(--color-moss)" },
  denied: { text: "✕ Denied", color: "var(--color-rust)" },
  answered: { text: "✓ Answered", color: "var(--color-moss)" },
  expired: { text: "No longer waiting — the run moved on", color: "var(--color-ink-400)" },
  handled: { text: "Dealt with elsewhere", color: "var(--color-ink-400)" },
};

const btn = "rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-50";

/**
 * What you can do about a "needs you" alert without leaving where you are: Allow or Deny a tool
 * card, pick the answer to a one-question card, or open the task for anything that needs more than a
 * click (several questions, ticking several options, your own words, a cost pause). A card
 * that would print credentials is never allowed from here — it needs a look at the full card first,
 * the same rule as the Approvals tab's `y` key (D280).
 */
export function NeedsYouActions({ a }: { a: Alert }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = a.approval && !isQuestion(a.approval) ? a.approval : null;
  // One question with one answer to pick is a click from here; anything more is the full card (D361).
  const qs = a.approval && isQuestion(a.approval) ? questionsOf(a.approval) : [];
  const quick = qs.length === 1 && !qs[0].multiSelect && qs[0].options.length ? qs[0] : null;

  const answer = async (label: string) => {
    if (!a.approval || !quick || !a.key) return;
    setBusy(true);
    setError(null);
    try {
      await api.answer(a.approval.id, { [quick.question]: label });
      resolveNeed(a.key, "answered");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) resolveNeed(a.key, "handled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "allow" | "deny") => {
    if (!card || !a.key) return;
    setBusy(true);
    setError(null);
    try {
      await api.decide(card.id, decision);
      // The board's own event follows; closing now means the click is felt at once.
      resolveNeed(a.key, decision === "allow" ? "allowed" : "denied");
    } catch (e) {
      // Already decided somewhere else, or its run is gone: either way it no longer waits on you.
      if (e instanceof ApiError && e.status === 409) resolveNeed(a.key, "handled");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const open = (
    <button className={`${btn} border border-ink-600 text-ink-200 hover:border-ink-400 hover:text-ink-100`} onClick={stop(() => openTask(a))}>
      {card ? "Review" : quick ? "Type an answer…" : a.approval || a.key?.startsWith("question:") ? "Answer" : "Open"}
    </button>
  );

  return (
    <span className="mt-2 flex flex-wrap items-center gap-1.5">
      {card ? (
        <>
          <button className={`${btn} border border-rust/50 text-rust hover:bg-rust/10`} disabled={busy} onClick={stop(() => void decide("deny"))}>
            Deny
          </button>
          {riskOf(card)?.level === "prints" ? (
            <>
              {open}
              <span className="text-[10.5px] text-rust">shows credentials — check it first</span>
            </>
          ) : (
            <button className={`${btn} bg-lime text-ink-950 hover:bg-[var(--kb-lime-hover)]`} disabled={busy} onClick={stop(() => void decide("allow"))}>
              Allow
            </button>
          )}
        </>
      ) : quick ? (
        <>
          {quick.options.slice(0, 4).map((o) => (
            <button
              key={o.label}
              className={`${btn} border border-iris/50 text-iris hover:bg-iris/10`}
              disabled={busy}
              title={o.description ? `${o.label}: ${o.description}` : o.label}
              onClick={stop(() => void answer(o.label))}
            >
              {o.label}
            </button>
          ))}
          {open}
        </>
      ) : (
        open
      )}
      {error ? <span className="basis-full text-[11px] text-rust">{error}</span> : null}
    </span>
  );
}
