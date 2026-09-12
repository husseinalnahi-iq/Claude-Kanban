import type { ProviderOut, ProviderUsage, QuotaWindow } from "../../../server/src/types.ts";
import { clock, cost, tokens, until } from "../lib/format.ts";

const pct = (w: QuotaWindow) => (w.used === null ? null : Math.min(100, Math.round(w.used * 100)));
const tone = (p: number | null) => (p === null ? "bg-ink-500" : p >= 90 ? "bg-rust" : p >= 70 ? "bg-amber" : "bg-moss");

/** "out until 18:45", "out of credit", "busy": the one-word state for a provider that ran out. */
export function OutChip({ out }: { out: ProviderOut | null }) {
  if (!out) return null;
  const text = out.kind === "credit" ? "out of credit" : out.kind === "busy" ? "busy" : "limit reached";
  return (
    <span
      className={`rounded border px-1 py-px font-mono text-[10px] ${out.kind === "credit" ? "border-rust/60 text-rust" : "border-iris/50 text-iris"}`}
      title={`${out.reason}${out.resets_at ? ` · back ${until(out.resets_at)} (${clock(out.resets_at)})` : ""}`}
    >
      {text}
      {out.resets_at ? ` · ${clock(out.resets_at)}` : ""}
    </span>
  );
}

function Window({ w }: { w: QuotaWindow }) {
  const p = pct(w);
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between text-[11.5px]">
        <span className="text-ink-300">{w.label}</span>
        <span className={`font-mono ${p !== null && p >= 100 ? "text-rust" : "text-ink-400"}`}>{p === null ? "ok" : p >= 100 ? "used up" : `${p}% used`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
        <div className={`h-full rounded-full transition-all ${tone(p)}`} style={{ width: `${p ?? 0}%` }} />
      </div>
      {w.resets_at ? <div className="mt-0.5 font-mono text-[10px] text-ink-500">resets {until(w.resets_at)} · {clock(w.resets_at)}</div> : null}
    </div>
  );
}

/** What the board itself sent there this week: always known, whatever the provider will tell. */
function boardLine(u: ProviderUsage): string {
  const w = u.board.d7;
  if (!w.runs) return "Not used by the board this week.";
  const money = w.cost_usd > 0 ? ` · ≈${cost(w.cost_usd)}` : "";
  const five = u.board.h5.runs ? ` (${u.board.h5.runs} in the last 5 hours)` : "";
  return `This week the board sent ${w.runs} run${w.runs === 1 ? "" : "s"}${five}: ${tokens(w.input_tokens)} tokens in, ${tokens(w.output_tokens)} out${money}.`;
}

/** One provider: its own windows or balance when it reports them, what the board sent, and whether it is out. */
export function ProviderUsageCard({ u, compact }: { u: ProviderUsage; compact?: boolean }) {
  const ollama = /ollama/i.test(u.provider_id);
  return (
    <div className={compact ? "" : "rounded-lg border border-ink-800 bg-ink-850/50 px-3 py-2"}>
      {compact ? null : (
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[12.5px] text-ink-100">{u.label}</span>
          <OutChip out={u.out} />
          {u.plan ? <span className="ml-auto font-mono text-[10.5px] text-ink-500">{u.plan}</span> : null}
        </div>
      )}
      {u.out ? <div className={`mb-1.5 text-[11.5px] ${u.out.kind === "credit" ? "text-rust" : "text-iris"}`}>{u.out.reason}</div> : null}
      {u.windows.length ? <div className={compact ? "grid gap-2 sm:grid-cols-2" : "space-y-2"}>{u.windows.map((w) => <Window key={w.label} w={w} />)}</div> : null}
      {u.balance ? (
        <div className="text-[12px] text-ink-200">
          <span className={`font-mono ${u.balance.amount <= 0 ? "text-rust" : "text-moss"}`}>
            {u.balance.currency === "USD" ? "$" : ""}
            {u.balance.amount.toFixed(2)}
            {u.balance.currency === "USD" ? "" : ` ${u.balance.currency}`}
          </span>{" "}
          {u.balance.label}
        </div>
      ) : null}
      {!u.windows.length && !u.balance && !u.error ? (
        <div className="text-[11px] text-ink-500">
          {u.local && ollama
            ? "Local models are free. Cloud models count against your Ollama plan, which only ollama.com/settings shows."
            : u.local
              ? "Runs on this computer: nothing to run out of."
              : "This provider has no way to ask for its usage, so the board counts what it sent."}
        </div>
      ) : null}
      {u.error ? <div className="text-[11px] text-amber">Could not read its usage: {u.error}</div> : null}
      <div className="mt-1 text-[11px] text-ink-500">{boardLine(u)}</div>
    </div>
  );
}
