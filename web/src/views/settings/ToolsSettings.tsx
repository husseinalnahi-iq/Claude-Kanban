import { useEffect, useState } from "react";
import type { SessionTools } from "../../../../server/src/types.ts";
import { api } from "../../lib/api.ts";
import { ago } from "../../lib/format.ts";
import { Button, ErrorLine, useAction } from "../../components/ui.tsx";

/** Server names as Claude Code reports them, in words. */
function serverLabel(name: string): string {
  if (name === "board") return "Board";
  if (name === "playwright") return "Browser (the board's own)";
  if (name === "claude-in-chrome") return "Claude in Chrome";
  const plugin = /^plugin:([^:]+):/.exec(name);
  if (plugin) return `${plugin[1]} (plugin)`;
  return name.replace(/^claude\.ai /, "") + (name.startsWith("claude.ai ") ? " (claude.ai connector)" : "");
}

/**
 * What a run really receives — the plugins, tool servers, skills and commands — read from a
 * session's init message, never from guesses. Opening a session costs nothing (it is stopped before
 * the model is called), but it starts every tool server once, so the answer is cached.
 */
export function SessionToolsPanel() {
  const [data, setData] = useState<SessionTools | null>(null);
  const { busy, error, run } = useAction();
  const load = (force = false) => run(async () => setData(await api.sessionTools(force)));
  useEffect(() => void load(), []);

  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-5">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-ink-100">What runs get</h2>
          <p className="mt-0.5 text-[12px] text-ink-400">
            Read from a real session, the same way a task starts one, and stopped before Claude is called — so it costs nothing.
            Project-level plugins and <span className="font-mono">.mcp.json</span> servers are added on top when a task runs in that project.
          </p>
        </div>
        <Button className="ml-auto shrink-0" busy={busy} onClick={() => void load(true)}>Check again</Button>
      </div>
      <div className="mt-3"><ErrorLine error={error ?? data?.error ?? null} /></div>

      {!data ? (
        <div className="mt-3 text-[12px] text-ink-500">Starting a session to see what it loads… (a few seconds: each tool server starts once)</div>
      ) : (
        <div className="mt-3 space-y-4">
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
              Plugins · {data.plugins.length}
            </div>
            {data.userPlugins ? (
              <div className="flex flex-wrap gap-1.5">
                {data.plugins.map((p) => (
                  <span key={p.name} className="rounded-md border border-ink-700 px-2 py-0.5 font-mono text-[11.5px] text-ink-200" title={p.source ?? undefined}>
                    {p.name}
                    {p.version ? <span className="ml-1 text-ink-500">{p.version}</span> : null}
                  </span>
                ))}
                {!data.plugins.length ? <span className="text-[12px] text-ink-500">None enabled in Claude Code.</span> : null}
              </div>
            ) : (
              <div className="text-[12px] text-amber">
                Off — your global plugins are not loaded into runs. Turn on “Load your global plugins” in Runs &amp; limits.
              </div>
            )}
            <div className="mt-1.5 text-[11.5px] text-ink-400">
              A plugin brings everything it contains — skills, slash commands, subagents, hooks and tool servers — exactly as in
              Claude Code. {data.skills} skills and {data.commands} commands are available to runs.
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
              Tool servers · {data.servers.length}
            </div>
            <div className="space-y-1">
              {data.servers.map((s) => (
                <div key={s.name} className="grid grid-cols-[minmax(0,210px)_56px_minmax(0,1fr)] items-baseline gap-3 rounded-md border border-ink-800 px-3 py-1.5 text-[12px]">
                  <span className="flex min-w-0 items-center gap-1.5 text-ink-100">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.status === "connected" ? "bg-moss" : "bg-rust"}`} title={s.status} />
                    <span className="truncate" title={s.name}>{serverLabel(s.name)}</span>
                  </span>
                  <span className="font-mono text-[11px] text-ink-400">{s.status !== "connected" ? s.status : s.tools < 0 ? "built in" : `${s.tools} tools`}</span>
                  <span className="text-ink-400">{s.rule}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="text-[11px] text-ink-500">Checked {ago(data.checked_at)}.</div>
        </div>
      )}
    </section>
  );
}
