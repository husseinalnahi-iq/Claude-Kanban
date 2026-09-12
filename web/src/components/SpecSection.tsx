import { useEffect, useState } from "react";
import type { Effort, SpecVersion, Task } from "../../../server/src/types.ts";
import { findClaudeModel } from "../../../server/src/engine/claudeModels.ts";
import { api } from "../lib/api.ts";
import { useWs } from "../lib/ws.ts";
import { useAppData } from "../lib/store.tsx";
import { Markdown } from "../lib/markdown.tsx";
import { ago, cost, shortModel } from "../lib/format.ts";
import { useClaudeModels } from "../lib/claudeModels.ts";
import { Button, Empty, ErrorLine, inputCls, useAction } from "./ui.tsx";
import { ClaudeModelPicker, EffortSelect } from "./ClaudeModelPicker.tsx";

/** "Opus 5" from your login's list, else the short id. */
function useModelName() {
  const { result } = useClaudeModels();
  return (id: string | null) => (id ? findClaudeModel(id, result)?.label ?? shortModel(id) : "");
}

/** The spec's versions and the rewrite in progress, kept current by `spec.rewrite` events. */
function useSpecVersions(taskId: string) {
  const [versions, setVersions] = useState<SpecVersion[]>([]);
  const [rewriting, setRewriting] = useState<{ model: string; note: string; since: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = () =>
    api.specStatus(taskId).then((r) => {
      setVersions(r.versions);
      setRewriting((cur) => (r.rewriting ? { ...r.rewriting, since: cur?.since ?? Date.now() } : null));
    }, () => undefined);
  useEffect(() => {
    setFailed(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  useWs((m) => {
    if (m.type !== "spec.rewrite" || m.taskId !== taskId) return;
    if (m.state === "running") {
      setFailed(null);
      setRewriting((cur) => ({ model: cur?.model ?? "", note: m.note ?? cur?.note ?? "", since: cur?.since ?? Date.now() }));
      return;
    }
    setRewriting(null);
    if (m.state === "failed") setFailed(m.error ?? "The rewrite failed.");
    void load();
  });
  return { versions, rewriting, setRewriting, failed, setFailed, reload: load };
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return <span className="font-mono tabular-nums">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>;
}

/**
 * The Spec section of a task: read, edit, or ✦ Rewrite — a strong model reads the code the request
 * is about and rewrites it into a spec a coding agent can start from. Every version is kept: go back
 * to your own words, or try another model on them.
 */
export function SpecSection({ task, busy }: { task: Task; busy: boolean }) {
  const { settings } = useAppData();
  const name = useModelName();
  const [editing, setEditing] = useState(false);
  const [spec, setSpec] = useState(task.spec_md);
  const [panel, setPanel] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [model, setModel] = useState(settings?.specModel ?? "claude-opus-5");
  const [effort, setEffort] = useState<Effort>(settings?.specEffort ?? "high");
  const [instruction, setInstruction] = useState("");
  const [fresh, setFresh] = useState(0);
  const { busy: saving, error, run } = useAction();
  const sv = useSpecVersions(task.id);

  // Never overwrite what you are typing: a change arriving mid-edit would throw your work away.
  useEffect(() => {
    if (!editing) setSpec(task.spec_md);
  }, [task.spec_md, editing]);
  useEffect(() => {
    if (settings) {
      setModel(settings.specModel);
      setEffort(settings.specEffort);
    }
  }, [settings?.specModel, settings?.specEffort]);
  // A rewrite that just landed settles in, instead of the text jumping.
  useEffect(() => setFresh((n) => n + 1), [task.spec_md]);

  const current = sv.versions.findLast((v) => v.spec_md === task.spec_md) ?? null;
  const source = current?.kind === "ai" ? sv.versions.find((v) => v.id === current.source_id) ?? null : null;
  const yours = sv.versions.filter((v) => v.kind === "yours");
  const label = (v: SpecVersion) =>
    v.kind === "ai" ? `✦ ${name(v.model)}${v.effort ? ` · ${v.effort}` : ""}` : v.id === yours[0]?.id ? "Your original" : "Your edit";
  const locked = busy ? "Stop the task first: its stages read this spec." : undefined;

  const start = () =>
    run(async () => {
      sv.setFailed(null);
      const r = await api.rewriteSpec(task.id, { model, effort, instruction: instruction.trim() || undefined });
      sv.setRewriting({ model: r.model, note: "reading the request", since: Date.now() });
      setPanel(false);
      setInstruction("");
    });
  const restore = (id: string) => run(async () => (await api.restoreSpec(task.id, id), await sv.reload()));

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <div className="text-[11px] uppercase tracking-wider text-ink-500">Spec</div>
        {current?.kind === "ai" && !sv.rewriting ? (
          <span className="rounded-full border border-iris/40 bg-iris/10 px-1.5 text-[10px] text-iris" title={`Rewritten by ${name(current.model)} ${ago(current.created_at)}`}>
            ✦ rewritten
          </span>
        ) : null}
        <div className="ml-auto flex gap-1.5">
          {editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => (setSpec(task.spec_md), setEditing(false))}>Cancel</Button>
              <Button size="sm" variant="primary" busy={saving} onClick={() => run(async () => (await api.patchTask(task.id, { spec_md: spec }), setEditing(false)))}>Save</Button>
            </>
          ) : (
            <>
              {sv.versions.length > 1 ? (
                <Button size="sm" variant="ghost" onClick={() => setShowVersions((s) => !s)} title="Every version of this spec: yours and each rewrite">
                  Versions · {sv.versions.length}
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={Boolean(sv.rewriting) || busy}
                title={locked ?? "A strong model reads the code this is about and rewrites it into a clear spec. Your text is kept."}
                onClick={() => setPanel((p) => !p)}
                className={panel ? "border-iris/60! text-iris!" : "hover:border-iris/60! hover:text-iris!"}
              >
                ✦ Rewrite
              </Button>
              <Button size="sm" variant="ghost" disabled={Boolean(sv.rewriting)} onClick={() => setEditing(true)}>Edit</Button>
            </>
          )}
        </div>
      </div>

      {panel && !editing ? (
        <div className="fade-in mb-3 rounded-lg border border-iris/40 bg-iris/5 p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
            <ClaudeModelPicker value={model} onChange={setModel} models={settings?.models ?? []} />
            <EffortSelect model={model} value={effort} onChange={setEffort} />
          </div>
          <input
            className={`${inputCls} mt-2`}
            placeholder="Anything to focus on? (optional) — e.g. “keep it short”, “cover the mobile layout”"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11.5px] text-ink-400">
              It reads the code this is about (it cannot change anything), then rewrites {source || yours.length > 1 ? "your latest words" : "your text"}. Your text is kept — you can go back any time.
            </span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPanel(false)}>Cancel</Button>
            <Button size="sm" variant="primary" busy={saving} disabled={Boolean(locked)} title={locked} onClick={start}>
              ✦ Rewrite with {name(model) || "Claude"}
            </Button>
          </div>
        </div>
      ) : null}

      {sv.rewriting ? (
        <div className="sweep fade-in mb-3 flex items-center gap-2.5 rounded-lg border border-iris/40 px-3 py-2 text-[12.5px]">
          <span className="breathe text-iris">✦</span>
          <span className="min-w-0 flex-1 truncate text-ink-200">
            {name(sv.rewriting.model) || "Claude"} is reading the project
            {sv.rewriting.note && sv.rewriting.note !== "reading the request" ? <span className="text-ink-400"> · {sv.rewriting.note}</span> : "…"}
          </span>
          <span className="text-[11px] text-ink-500"><Elapsed since={sv.rewriting.since} /></span>
          <Button size="sm" variant="ghost" onClick={() => void api.stopSpecRewrite(task.id)}>Stop</Button>
        </div>
      ) : null}

      {sv.failed ? (
        <div className="fade-in mb-3 flex items-center gap-2 rounded-lg border border-rust/40 bg-rust/5 px-3 py-2 text-[12px] text-rust">
          <span className="min-w-0 flex-1">Rewrite failed: {sv.failed}. Your spec is unchanged.</span>
          <Button size="sm" variant="ghost" onClick={() => (sv.setFailed(null), setPanel(true))}>Try again</Button>
        </div>
      ) : null}

      {current?.kind === "ai" && !sv.rewriting && !editing ? (
        <div className="fade-in mb-3 rounded-lg border border-iris/30 bg-iris/5 px-3 py-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-iris">✦ Rewritten by {name(current.model)}{current.effort ? ` · ${current.effort}` : ""}</span>
            <span className="text-ink-500">{ago(current.created_at)}{current.cost_usd ? ` · ${cost(current.cost_usd)}` : ""}</span>
            <span className="ml-auto flex gap-1.5">
              {source ? (
                <Button size="sm" variant="ghost" busy={saving} disabled={Boolean(locked)} title={locked ?? "Put your own text back (this rewrite stays in Versions)"} onClick={() => restore(source.id)}>
                  ↩ Back to yours
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={Boolean(locked)} title={locked ?? "Rewrite your text again, with another model or a different focus"} onClick={() => setPanel(true)}>
                Try another model
              </Button>
            </span>
          </div>
          {current.summary ? <div className="mt-1 text-ink-300">{current.summary}</div> : null}
          {current.instruction ? <div className="mt-0.5 text-[11.5px] text-ink-500">You asked: “{current.instruction}”</div> : null}
        </div>
      ) : null}

      {showVersions && !editing ? (
        <div className="fade-in mb-3 overflow-hidden rounded-lg border border-ink-700">
          {!current ? (
            <div className="flex items-center gap-2 border-b border-ink-800 bg-ink-850/60 px-3 py-1.5 text-[12px]">
              <span className="text-ink-200">Now — your edit</span>
              <span className="text-ink-500">kept as a version the next time you rewrite or go back</span>
              <span className="ml-auto rounded border border-moss/50 px-1.5 text-[10.5px] text-moss">current</span>
            </div>
          ) : null}
          {[...sv.versions].reverse().map((v) => {
            const isCurrent = v.id === current?.id;
            const open = preview === v.id;
            return (
              <div key={v.id} className="border-b border-ink-800 last:border-b-0">
                <div
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-ink-850 ${isCurrent ? "bg-ink-850/60" : ""}`}
                  onClick={() => setPreview(open ? null : v.id)}
                  title="Click to preview"
                >
                  <span className={`text-[10px] text-ink-500 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
                  <span className={v.kind === "ai" ? "text-iris" : "text-ink-100"}>{label(v)}</span>
                  <span className="text-ink-500">{ago(v.created_at)}{v.cost_usd ? ` · ${cost(v.cost_usd)}` : ""}</span>
                  {v.instruction ? <span className="truncate text-[11px] text-ink-500">“{v.instruction}”</span> : null}
                  <span className="ml-auto">
                    {isCurrent ? (
                      <span className="rounded border border-moss/50 px-1.5 text-[10.5px] text-moss">current</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={Boolean(locked) || Boolean(sv.rewriting)}
                        title={locked ?? "Make this the spec (what is there now is kept)"}
                        onClick={(e) => (e.stopPropagation(), restore(v.id))}
                      >
                        Use this
                      </Button>
                    )}
                  </span>
                </div>
                {open ? (
                  <div className="fade-in max-h-72 overflow-y-auto border-t border-ink-800 bg-ink-900/60 px-3 py-2">
                    {v.spec_md.trim() ? <Markdown text={v.spec_md} className="text-[12.5px]" /> : <span className="text-[12px] text-ink-500">(empty — the title only)</span>}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {editing ? (
        <textarea className={`${inputCls} min-h-[260px] font-mono text-[12.5px]`} value={spec} onChange={(e) => setSpec(e.target.value)} autoFocus />
      ) : task.spec_md.trim() ? (
        <div key={fresh} className={`transition-opacity ${sv.rewriting ? "opacity-50" : ""} ${fresh > 1 ? "settle" : ""}`}>
          <Markdown text={task.spec_md} />
        </div>
      ) : (
        <Empty>No spec yet — the title is all Claude gets. Click Edit, or ✦ Rewrite to have Claude write one from the title and the code.</Empty>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
