import { useState } from "react";
import type { ClaudeModelStatus, ClaudeModelsResult, ModelEntry, Provider } from "../../../../server/src/types.ts";
import { claudeModelStatus, CLAUDE_STATUS_TEXT, findClaudeModel } from "../../../../server/src/engine/claudeModels.ts";
import { Button, inputCls } from "../../components/ui.tsx";
import { ModelCombobox } from "../../components/ModelCombobox.tsx";
import { useClaudeModels } from "../../lib/claudeModels.ts";
import { useCatalog } from "../../lib/catalog.ts";
import { ago } from "../../lib/format.ts";

const MARK: Record<ClaudeModelStatus, { sign: string; cls: string }> = {
  ok: { sign: "✓", cls: "text-moss" },
  unlisted: { sign: "!", cls: "text-amber" },
  invalid: { sign: "✕", cls: "text-rust" },
  unchecked: { sign: "·", cls: "text-ink-500" },
};

/** Edit distance, for "did you mean". Ids are short, so the plain table is fine. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** The model on your login an unlisted id was probably meant to be. */
function suggestion(id: string, r: ClaudeModelsResult | null): string | null {
  const want = id.trim().toLowerCase();
  let best: { id: string; d: number } | null = null;
  for (const m of r?.models ?? []) {
    const d = distance(want, m.id.toLowerCase());
    if (d <= 3 && (!best || d < best.d)) best = { id: m.id, d };
  }
  return best?.id ?? null;
}

/** What another provider has right now, in one line. */
function ProviderLine({ p, onOpen }: { p: Provider; onOpen: () => void }) {
  const { result, loading } = useCatalog(p);
  const ready = result?.source === "live" ? result.models.filter((m) => m.group !== "saved" && m.installed !== false).length : null;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-28 shrink-0 truncate font-mono text-iris">{p.id}</span>
      <span className={`min-w-0 flex-1 truncate ${result?.error ? "text-amber" : "text-ink-300"}`} title={result?.error}>
        {loading
          ? "asking what it has…"
          : result?.error
            ? result.error
            : ready !== null
              ? `${ready} model${ready === 1 ? "" : "s"} ready — read live`
              : `${p.models.length} model${p.models.length === 1 ? "" : "s"} in its list`}
      </span>
      <button type="button" className="shrink-0 cursor-pointer text-[11.5px] text-ink-400 hover:text-ink-100" onClick={onOpen}>
        Manage →
      </button>
    </div>
  );
}

/**
 * Settings → Models & pipeline → Claude models: filled from your Claude login, each row checked
 * against it, so a typo shows here in red instead of failing a run later.
 */
export function ClaudeModelList({
  models, onChange, providers, onOpenProviders,
}: {
  models: ModelEntry[];
  onChange: (m: ModelEntry[]) => void;
  providers: Provider[];
  onOpenProviders: () => void;
}) {
  const { result, loading, refresh } = useClaudeModels();
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const live = result?.source === "live";

  const listed = new Set(models.map((m) => findClaudeModel(m.id, result)?.id ?? m.id));
  const missing = (result?.models ?? []).filter((m) => !listed.has(m.id));
  const set = (i: number, patch: Partial<ModelEntry>) => onChange(models.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = (entry: ModelEntry) => onChange([...models, entry]);

  const typed = newId.trim();
  const typedStatus = typed ? claudeModelStatus(typed, result) : null;
  const duplicate = typed !== "" && models.some((m) => m.id === typed);
  const addNew = () => {
    if (!typed || typedStatus === "invalid" || duplicate) return;
    const info = findClaudeModel(typed, result);
    add({ id: typed, label: newLabel.trim() || info?.label || typed, ...(info ? { note: info.blurb } : {}) });
    setNewId("");
    setNewLabel("");
  };
  const enabled = providers.filter((p) => p.enabled);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-md border border-ink-800 bg-ink-850/60 px-2.5 py-1.5 text-[12px]">
        {loading ? (
          <span className="flex items-center gap-2 text-ink-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" /> Asking Claude Code which models your login has…
          </span>
        ) : live ? (
          <span className="text-ink-300">
            <span className="text-moss">●</span> Checked with your Claude login · {result.models.length} models · {ago(result.checked_at)}
          </span>
        ) : (
          <span className="text-amber" title={result?.error}>
            ⚠ Could not ask Claude Code{result?.error ? ` (${result.error})` : ""}. Ids are only checked for shape.
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={loading} onClick={() => void refresh()} title="Ask again — after Claude ships a model, or your plan changes">
          {live ? "Refresh" : "Try again"}
        </Button>
      </div>

      <div className="space-y-1.5">
        {models.map((m, i) => {
          const status = claudeModelStatus(m.id, result);
          const info = findClaudeModel(m.id, result);
          const bad = status === "invalid" || status === "unlisted";
          const fix = status === "unlisted" ? suggestion(m.id, result) : null;
          return (
            <div key={`${i}|${m.id}`} className="fade-in">
              <div className="grid grid-cols-[16px_minmax(0,1fr)_140px_minmax(0,1fr)_auto] items-center gap-2">
                <span className={`text-center text-[13px] font-semibold ${MARK[status].cls}`} title={CLAUDE_STATUS_TEXT[status]} aria-label={CLAUDE_STATUS_TEXT[status]}>
                  {MARK[status].sign}
                </span>
                <div
                  className={`truncate rounded-md border bg-ink-900 px-2.5 py-1.5 font-mono text-[13px] ${
                    status === "invalid" ? "border-rust/60 text-rust" : status === "unlisted" ? "border-amber/50 text-amber" : "border-ink-800 text-ink-200"
                  }`}
                  title={info ? `${m.id} — ${info.label}: ${info.blurb}` : m.id}
                >
                  {m.id}
                </div>
                <input className={inputCls} value={m.label} aria-label={`Label for ${m.id}`} onChange={(e) => set(i, { label: e.target.value })} />
                <input className={inputCls} value={m.note ?? ""} placeholder={info?.blurb ?? "use for…"} aria-label={`Note for ${m.id}`} onChange={(e) => set(i, { note: e.target.value })} />
                <button className="cursor-pointer px-1.5 text-ink-400 hover:text-rust" onClick={() => onChange(models.filter((_, j) => j !== i))} title="Remove">×</button>
              </div>
              {bad ? (
                <div className={`mt-1 ml-6 flex flex-wrap items-center gap-2 text-[11.5px] ${status === "invalid" ? "text-rust" : "text-amber"}`}>
                  <span>{CLAUDE_STATUS_TEXT[status]}</span>
                  {fix ? (
                    <button type="button" className="cursor-pointer rounded border border-amber/50 px-1.5 py-0.5 font-mono text-amber hover:bg-amber/10" onClick={() =>
                        // Already listed: the typo row just goes, rather than becoming a duplicate.
                        models.some((x, j) => j !== i && x.id === fix) ? onChange(models.filter((_, j) => j !== i)) : set(i, { id: fix })
                      }>
                      {models.some((x, j) => j !== i && x.id === fix) ? `meant ${fix}? It's listed — remove this` : `use ${fix}`}
                    </button>
                  ) : null}
                  {status === "invalid" ? (
                    <button type="button" className="cursor-pointer rounded border border-rust/50 px-1.5 py-0.5 text-rust hover:bg-rust/10" onClick={() => onChange(models.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {missing.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-ink-400">On your Claude login, not on this list:</span>
          {missing.map((m) => (
            <button
              key={m.id}
              type="button"
              className="cursor-pointer rounded-full border border-ink-700 px-2 py-0.5 text-ink-200 transition-colors hover:border-amber/60 hover:text-amber"
              title={`${m.id} — ${m.blurb}`}
              onClick={() => add({ id: m.id, label: m.label, note: m.blurb })}
            >
              + {m.label}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="grid grid-cols-[minmax(0,1fr)_140px_auto] gap-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          addNew();
        }}
      >
        <ModelCombobox
          value={newId}
          placeholder="pick a model, or type a new id…"
          onChange={(id) => {
            setNewId(id);
            if (!newLabel.trim()) setNewLabel(findClaudeModel(id, result)?.label ?? "");
          }}
          options={(result?.models ?? []).map((m) => ({ id: m.id, label: `${m.label} — ${m.blurb}`, group: "On your Claude login" }))}
          loading={loading && !result}
        />
        <input className={inputCls} placeholder="label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        <Button type="submit" disabled={!typed || typedStatus === "invalid" || duplicate}>
          {typedStatus === "unlisted" ? "Add anyway" : "Add"}
        </Button>
      </form>
      {typed && (duplicate || typedStatus === "invalid" || typedStatus === "unlisted") ? (
        <p className={`-mt-1 text-[11.5px] ${typedStatus === "invalid" ? "text-rust" : "text-amber"}`}>
          {duplicate ? "Already on the list." : CLAUDE_STATUS_TEXT[typedStatus!]}
          {typedStatus === "unlisted" && suggestion(typed, result) ? ` Did you mean ${suggestion(typed, result)}?` : ""}
        </p>
      ) : null}

      <div className="border-t border-ink-800 pt-3">
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-400">Other providers</div>
        {enabled.length ? (
          <div className="space-y-1">
            {enabled.map((p) => <ProviderLine key={p.id} p={p} onOpen={onOpenProviders} />)}
          </div>
        ) : null}
        <p className="mt-1.5 text-[11.5px] text-ink-500">
          Ollama, LM Studio, OpenRouter and the rest need no list here: switch a picker's first box from <span className="font-mono">claude</span> to the
          provider and it shows what that provider has right now.{" "}
          {enabled.length ? null : (
            <button type="button" className="cursor-pointer text-ink-300 underline-offset-2 hover:text-ink-100 hover:underline" onClick={onOpenProviders}>
              Add a provider
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
