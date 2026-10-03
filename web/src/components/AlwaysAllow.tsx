import type { Approval } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { Button } from "./ui.tsx";
import { riskOf } from "./CredentialWarning.tsx";

/** A command, or a connector's tool: what the project's trusted list can hold. A file edit always asks. */
const canAlways = (a: Approval) => (a.tool_name === "Bash" || a.tool_name === "PowerShell" || a.tool_name.startsWith("mcp__")) && riskOf(a)?.level !== "prints";

/**
 * Allow, and stop asking for this command in this project (D353). The board decides what it remembers
 * (the program and the script it runs, so other arguments match) and says so in the transcript; when
 * there is nothing lasting to remember it answers with why, and the card stays for a plain Allow.
 */
export function AlwaysAllow({ a, busy, run, size }: { a: Approval; busy: boolean; run: (fn: () => Promise<unknown>) => void; size?: "sm" | "md" }) {
  if (!canAlways(a)) return null;
  return (
    <Button
      size={size}
      busy={busy}
      title="Allow it now, and never ask about this command again in this project. You can take it back in Settings → this project → Always allowed."
      onClick={() => run(() => api.decide(a.id, "allow", undefined, true))}
    >
      Always allow
    </Button>
  );
}
