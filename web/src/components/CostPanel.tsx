import type { Run } from "../../../server/src/types.ts";
import { cost, costLabel, duration, modelLabel, tokens } from "../lib/format.ts";

/**
 * What this task actually cost, per stage.
 *
 * Two different currencies are shown on purpose. The dollar figure is the SDK's estimate of the
 * equivalent API price — useful for comparing stages, but it is not a bill, because runs go through
 * the Claude subscription. The share of the five-hour window is the one that can actually stop you
 * working, measured from what the CLI reported before and after each stage.
 */
export function CostPanel({ runs }: { runs: Run[] }) {
  const usd = runs.reduce((s, r) => s + r.cost_usd, 0);
  const estimated = runs.some((r) => r.cost_source === "estimated");
  const subscription = runs.some((r) => r.cost_source === "subscription");
  const inTok = runs.reduce((s, r) => s + r.input_tokens, 0);
  const outTok = runs.reduce((s, r) => s + r.output_tokens, 0);
  const ms = runs.reduce((s, r) => s + Math.max(0, (r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.started_at)), 0);
  // Only stages where the CLI reported the window on both sides can be counted.
  const measured = runs.filter((r) => r.limit_before !== null && r.limit_after !== null && r.limit_after >= r.limit_before);
  const windowShare = measured.reduce((s, r) => s + (r.limit_after! - r.limit_before!), 0);

  if (!runs.length) return <div className="px-4 py-3 text-[12px] text-ink-500">Nothing has run yet, so nothing has been spent.</div>;

  return (
    <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-950/50 px-4 py-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: "Est. cost", value: cost(usd),
            hint: estimated
              ? "SDK estimate for Claude stages plus tokens × the prices you entered for other providers — not a bill"
              : "SDK estimate of the equivalent API price — not a bill",
          },
          { label: "Input", value: tokens(inTok), hint: "Prompt + cache reads across every stage" },
          { label: "Output", value: tokens(outTok), hint: "Tokens the models wrote" },
          { label: "Time", value: duration(ms), hint: "Time actually spent running" },
        ].map((s) => (
          <div key={s.label} title={s.hint}>
            <div className="text-[10.5px] uppercase tracking-wider text-ink-500">{s.label}</div>
            <div className="font-mono text-[15px] text-ink-100">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-wider text-ink-500">Five-hour window</span>
          <span className="font-mono text-[13.5px] text-amber">
            {measured.length ? `≈ ${(windowShare * 100).toFixed(1)}%` : "not measured"}
          </span>
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-400">
          {measured.length
            ? `Measured from the usage the CLI reported before and after ${measured.length} of ${runs.length} stage${runs.length === 1 ? "" : "s"}. Approximate: anything else you ran in the same window counts towards it too.`
            : "The CLI only reports subscription usage once a run gets close to a limit, so short runs often have nothing to measure."}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10.5px] uppercase tracking-wider text-ink-500">
              <th className="py-1 pr-2 font-medium">Stage</th>
              <th className="py-1 pr-2 font-medium">Model</th>
              <th className="py-1 pr-2 font-medium">Effort</th>
              <th className="py-1 pr-2 text-right font-medium">In</th>
              <th className="py-1 pr-2 text-right font-medium">Out</th>
              <th className="py-1 pr-2 text-right font-medium">Cost</th>
              <th className="py-1 text-right font-medium">Window</th>
            </tr>
          </thead>
          <tbody className="font-mono text-ink-300">
            {runs.map((r) => {
              const share = r.limit_before !== null && r.limit_after !== null && r.limit_after >= r.limit_before ? r.limit_after - r.limit_before : null;
              return (
                <tr key={r.id} className="border-t border-ink-800">
                  <td className="py-1 pr-2 text-ink-100">{r.stage}</td>
                  <td className="py-1 pr-2">{modelLabel(r)}{r.role === "critic" ? <span className="ml-1 text-iris">critic</span> : null}</td>
                  <td className="py-1 pr-2 text-ink-400">{r.effort}</td>
                  <td className="py-1 pr-2 text-right">{tokens(r.input_tokens)}</td>
                  <td className="py-1 pr-2 text-right">{tokens(r.output_tokens)}</td>
                  <td className={`py-1 pr-2 text-right ${r.cost_source === "subscription" ? "text-ink-500" : ""}`}>{costLabel(r)}</td>
                  <td className="py-1 text-right text-ink-400">{share === null ? "—" : `${(share * 100).toFixed(1)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {subscription ? (
        <p className="text-[11.5px] text-ink-500">
          Stages marked <span className="text-ink-400">subscription</span> ran on a provider with no price entered: $0 here, tokens still counted.
        </p>
      ) : null}
      <p className="text-[11.5px] text-ink-500">
        Cheaper next time: drop a stage the task does not need, move a stage to a smaller model, or lower its effort — the
        board proposes exactly that for each new task, and you accept or keep the default.
      </p>
    </div>
  );
}
