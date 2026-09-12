import { useEffect, useState } from "react";
import type { MergePolicy, MergeStrategy } from "../../../../server/src/types.ts";
import { api, type ProjectWithGit } from "../../lib/api.ts";
import { useAppData } from "../../lib/store.tsx";
import { Button, ErrorLine, Field, Help, inputCls, useAction } from "../../components/ui.tsx";

const STRATEGY: { value: MergeStrategy; label: string; blurb: string }[] = [
  { value: "merge", label: "Merge commit", blurb: "Keeps the task's commits and records a merge. The safest default and the easiest to undo." },
  { value: "rebase", label: "Rebase", blurb: "Replays the task's commits on top of the base for a straight line of history. Rewrites the task branch — fine here, because only the board uses it." },
  { value: "squash", label: "Squash", blurb: "Lands the whole task as one commit. Tidiest history, but the individual steps are lost." },
];

/**
 * How finished work reaches the base branch. The ordering is the safety property: the base is pulled
 * into the task's worktree first, so conflicts happen there rather than in the user's checkout.
 */
export function GitSettings({ project }: { project: ProjectWithGit }) {
  const { reloadProjects } = useAppData();
  const [m, setM] = useState<MergePolicy>(project.merge);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => setM(project.merge), [project]);
  const set = (patch: Partial<MergePolicy>) => setM({ ...m, ...patch });

  return (
    <section className="space-y-5">
      <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-5">
        <h2 className="text-[13px] font-semibold text-ink-100">How work lands on {m.baseBranch || "your branch"}</h2>
        <p className="mt-0.5 mb-4 text-[12px] text-ink-400">
          Two tasks running at once each have their own copy of the repo, so they never overwrite each other while
          they work — the risk is at the moment they land. These settings decide how that moment is handled.
        </p>

        <ol className="mb-5 space-y-2 rounded-lg border border-ink-800 bg-ink-950/60 p-4 text-[12.5px] text-ink-300">
          <li><span className="mr-2 font-mono text-[11px] text-amber">1</span>The board refuses to land anything while your own checkout has uncommitted changes.</li>
          <li>
            <span className="mr-2 font-mono text-[11px] text-amber">2</span>
            {m.updateBeforeMerge ? <>Whatever landed since this task started is pulled <b>into the task's worktree</b> — so a conflict appears there, where Claude can fix it, and your checkout is never left in a conflicted state.</> : <span className="text-ink-400">Skipped — the task branch is merged as-is, so a conflict surfaces in your checkout instead.</span>}
          </li>
          <li>
            <span className="mr-2 font-mono text-[11px] text-amber">3</span>
            {m.verifyBeforeMerge ? <>The project's verify command runs again on the combined result, because "it passed before the other task landed" is not the same as "it passes now".</> : <span className="text-ink-400">Skipped — the task is landed on the strength of its earlier run.</span>}
          </li>
          <li><span className="mr-2 font-mono text-[11px] text-amber">4</span>Only then is it landed ({STRATEGY.find((s) => s.value === m.strategy)!.label.toLowerCase()}), one task at a time per project.</li>
        </ol>

        <div className="space-y-3">
          <Field
            label="Base branch"
            hint="Leave empty to use whichever branch the project folder currently has checked out. Naming it means the board refuses to land work when you are on the wrong branch."
          >
            <input
              className={`${inputCls} font-mono`}
              placeholder="(the branch the checkout is on)"
              value={m.baseBranch ?? ""}
              onChange={(e) => set({ baseBranch: e.target.value.trim() || null })}
            />
          </Field>

          <Field label="When landing" group>
            <div className="space-y-1.5">
              {STRATEGY.map((s) => (
                <label
                  key={s.value}
                  className={`flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 transition-colors ${m.strategy === s.value ? "border-amber/50 bg-amber/5" : "border-ink-700 hover:border-ink-600"}`}
                >
                  <input type="radio" className="mt-1 accent-amber" checked={m.strategy === s.value} onChange={() => set({ strategy: s.value })} />
                  <span>
                    <span className="text-[12.5px] text-ink-100">{s.label}</span>
                    <span className="block text-[11.5px] text-ink-400">{s.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>

          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={m.updateBeforeMerge} onChange={(e) => set({ updateBeforeMerge: e.target.checked })} />
            <span>
              Update the task's branch from the base before landing it{" "}
              <Help width="w-[320px]">
                This is what stops one task's work from being clobbered by another's. Without it, the second task to
                finish merges code that was written against an older version of the repo — git will happily merge it if
                the lines differ, and you get a silently broken combination.
              </Help>
              <span className="block text-[11.5px] text-ink-400">Strongly recommended. Conflicts then happen in the task's own worktree, not in your checkout.</span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" className="mt-1 accent-amber" checked={m.verifyBeforeMerge} onChange={(e) => set({ verifyBeforeMerge: e.target.checked })} />
            <span>
              Re-run the verify command after that update
              <span className="block text-[11.5px] text-ink-400">
                Only runs when the update actually brought in new commits. Needs a verify command in Project → Workspace.
              </span>
            </span>
          </label>

          <Field label="If the base conflicts with the task" group>
            <div className="space-y-1.5">
              {([
                { v: "ask", label: "Stop and tell me", blurb: "Nothing is merged, the worktree is left exactly as it was, and the message names the conflicting files." },
                { v: "claude", label: "Give it back to Claude", blurb: "Adds a stage to the same task that merges the base and resolves the conflict in the worktree, then re-verifies. You still approve the result." },
              ] as const).map((o) => (
                <label
                  key={o.v}
                  className={`flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 transition-colors ${m.onConflict === o.v ? "border-amber/50 bg-amber/5" : "border-ink-700 hover:border-ink-600"}`}
                >
                  <input type="radio" className="mt-1 accent-amber" checked={m.onConflict === o.v} onChange={() => set({ onConflict: o.v })} />
                  <span>
                    <span className="text-[12.5px] text-ink-100">{o.label}</span>
                    <span className="block text-[11.5px] text-ink-400">{o.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        </div>

        <div className="mt-4"><ErrorLine error={error} /></div>
        <div className="mt-4 flex items-center justify-end gap-3">
          {saved ? <span className="text-[12px] text-moss">Saved</span> : null}
          <Button
            variant="primary"
            busy={busy}
            onClick={() =>
              run(async () => {
                await api.patchProject(project.id, { merge: m });
                await reloadProjects();
                setSaved(true);
                setTimeout(() => setSaved(false), 1500);
              })
            }
          >
            Save for {project.name}
          </Button>
        </div>
      </div>

      {project.policy.worktrees === "forbidden" ? (
        <div className="rounded-xl border border-cyan/30 bg-cyan/5 p-4 text-[12.5px] text-ink-300">
          <b className="text-cyan">This project never uses worktrees.</b> Supervised tasks edit the checkout directly and
          every write is an approval card, so nothing here applies until worktrees are allowed in Project settings.
        </div>
      ) : null}
    </section>
  );
}
