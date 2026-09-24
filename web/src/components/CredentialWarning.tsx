import type { Approval } from "../../../server/src/types.ts";
import { credentialRisk } from "../../../server/src/engine/credentials.ts";

export const riskOf = (a: Approval) => credentialRisk(a.tool_name, (a.input ?? {}) as Record<string, unknown>);

/**
 * Said on the card, before Allow: a command that prints a credentials file writes its values into the
 * transcript, which the board stores. A review stage once asked for exactly that (docs/DECISIONS.md D201).
 */
export function CredentialWarning({ a }: { a: Approval }) {
  const risk = riskOf(a);
  if (!risk) return null;
  const files = risk.files.slice(0, 3).join(", ");
  return risk.level === "prints" ? (
    <div className="mb-2 rounded-md border border-rust/60 bg-rust/10 px-2.5 py-1.5 text-[12px] text-rust">
      ⚠ <b>This shows credentials.</b> The contents of <span className="font-mono">{files}</span> would go into the transcript, and the
      board keeps transcripts. Deny it unless you meant to — a script can load the file without printing it.
    </div>
  ) : (
    <div className="mb-2 rounded-md border border-amber/50 bg-amber/5 px-2.5 py-1.5 text-[12px] text-amber">
      Touches a credentials file (<span className="font-mono">{files}</span>). Fine when a script only loads it; deny if its output would
      show the values.
    </div>
  );
}
