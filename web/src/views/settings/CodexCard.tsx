import { useEffect, useState } from "react";
import { api, type CodexView } from "../../lib/api.ts";
import { useWs } from "../../lib/ws.ts";
import { Button, ErrorLine, useAction } from "../../components/ui.tsx";

/**
 * Codex on this computer, at the top of Settings → Providers (D296): whether it is there and which
 * account it is signed in to, with the one thing to do next — sign in, or put it on the board.
 */
export function CodexCard() {
  const [st, setSt] = useState<CodexView | null>(null);
  const [changed, setChanged] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  const load = (fresh = false) => void api.codexStatus(fresh).then(setSt, () => setSt(null));
  useEffect(() => load(), []);
  useWs((m) => {
    if (m.type === "codex.updated") setSt(m.status);
    else if (m.type === "settings.updated") load();
  });
  if (!st) return null;

  const tone = st.signedIn === "api-key" ? "border-amber/40 bg-amber/5" : st.linked ? "border-moss/30 bg-moss/5" : "border-cyan/30 bg-cyan/5";
  const line = !st.found
    ? "Not on this computer. Setup → Codex installs it, or install the Codex app."
    : !st.signedIn
      ? `${st.version ?? "Codex"} is here, but not signed in.`
      : st.signedIn === "api-key"
        ? `${st.version ?? "Codex"} is signed in with an API key, so “Codex · ChatGPT subscription” would bill your API account. Sign in with ChatGPT to use your plan.`
        : st.linked
          ? `${st.version ?? "Codex"} · signed in with ChatGPT · on the board. Stages, the plan-debate critic and pictures can use your plan.`
          : `${st.version ?? "Codex"} · signed in with ChatGPT. One click puts it on the board: a provider for stages, the plan-debate critic at high effort, and pictures.`;

  return (
    <div className={`mb-4 rounded-lg border px-3 py-2.5 ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink-100">Codex on your ChatGPT plan</span>
        <span className="min-w-0 flex-1 text-[12px] text-ink-300">{line}</span>
        {st.found && st.signedIn !== "chatgpt" ? (
          <Button size="sm" variant="primary" busy={busy} onClick={() => run(() => api.codexLogin())} title="Opens Codex's own sign-in in a terminal; it opens your browser">
            {st.signedIn === "api-key" ? "Sign in with ChatGPT" : "Sign in"}
          </Button>
        ) : null}
        {st.signedIn === "chatgpt" && !st.linked ? (
          <Button size="sm" variant="primary" busy={busy} onClick={() => run(async () => { const r = await api.codexLink(); setChanged(r.changed); setSt(r.status); })}>
            Use it
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => load(true)}>Re-check</Button>
      </div>
      {changed.length ? <ul className="mt-1.5 list-disc pl-5 text-[11.5px] text-moss">{changed.map((c) => <li key={c}>{c}</li>)}</ul> : null}
      <ErrorLine error={error} />
    </div>
  );
}
