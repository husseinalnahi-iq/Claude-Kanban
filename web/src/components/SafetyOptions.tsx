/**
 * Two per-task safety switches (docs/DECISIONS.md D200, D202): wait for the human after the plan,
 * and "touches a live system", which forces that wait and runs the review stage on the live review model.
 */
export function SafetyOptions({ live, planApproval, settingOn, liveModel, onChange, disabled }: {
  live: boolean;
  /** null follows Settings. */
  planApproval: boolean | null;
  settingOn: boolean;
  liveModel: string;
  onChange: (v: { live?: boolean; plan_approval?: boolean | null }) => void;
  disabled?: boolean;
}) {
  const choice = planApproval === null ? "default" : planApproval ? "on" : "off";
  return (
    <div className="space-y-2.5">
      <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
        <input type="checkbox" className="mt-1 accent-rose" checked={live} disabled={disabled} onChange={(e) => onChange({ live: e.target.checked })} />
        <span>
          Touches a live system
          <span className="block text-[11.5px] text-ink-400">
            Real data or real users — a production database, a live business app, a deployed site. The plan waits for your approval, every stage
            is told to dry-run and read back each live change, and the review runs on <span className="font-mono">{liveModel}</span>{" "}
            and checks the live system itself.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-200">
        <span>After the plan</span>
        <select
          className="rounded-md border border-ink-700 bg-ink-950/50 px-2 py-1 text-[12.5px] text-ink-100 disabled:opacity-50"
          value={live ? "on" : choice}
          disabled={disabled || live}
          title={live ? "A live task always waits for your approval" : undefined}
          onChange={(e) => onChange({ plan_approval: e.target.value === "default" ? null : e.target.value === "on" })}
        >
          <option value="default">Follow Settings ({settingOn ? "wait for me" : "carry on"})</option>
          <option value="on">Wait for my approval</option>
          <option value="off">Carry on without me</option>
        </select>
        <span className="text-[11.5px] text-ink-400">Waiting lets you read, edit or reject the plan before any code is written.</span>
      </div>
    </div>
  );
}
