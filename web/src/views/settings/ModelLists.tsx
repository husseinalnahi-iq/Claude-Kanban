import { useMemo, useState } from "react";
import { ANTHROPIC_PROVIDER_ID, MODEL_SURFACES, modelKey, type ModelEntry, type ModelSurface, type Provider } from "../../../../server/src/types.ts";
import { claudeOptions, useClaudeModels } from "../../lib/claudeModels.ts";
import { useCatalogs } from "../../lib/catalog.ts";
import { inputCls } from "../../components/ui.tsx";

const COLUMNS: { id: ModelSurface; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "The side chat's model picker. Only Claude and Claude-compatible providers can run the chat." },
  { id: "stages", label: "Task stages", hint: "Each stage's model in New task, a task's Pipeline tab and the default pipeline." },
  { id: "helpers", label: "Debate & helpers", hint: "The plan-debate critic, right-sizing tiers, triage, spec rewrite, vision, live review and the Claude fallback." },
  { id: "pictures", label: "Pictures", hint: "Who makes pictures (Settings → Images), and which Codex models can make them." },
];

/** A row of the table: one model (or a whole provider, or a picture maker) and the pickers it may appear in. */
interface Row {
  key: string;
  label: string;
  sub: string;
  group: string;
  /** The pickers this row can be in at all: a CLI cannot run the chat, Claude cannot draw. */
  in: ModelSurface[];
}

const PICTURE_MAKERS: { id: string; label: string }[] = [
  { id: "codex", label: "Codex · your ChatGPT plan" },
  { id: "pollinations", label: "Pollinations.ai · with your key" },
  { id: "cloudflare", label: "Cloudflare Workers AI" },
];

/**
 * Settings → Model lists (D300): which models each picker lists. Everything shows unless you untick it,
 * so a model new to a provider appears by itself; a pick already made keeps showing where it is used.
 */
export function ModelLists({ hidden, setHidden, models, providers }: {
  hidden: Record<ModelSurface, string[]>;
  setHidden: (h: Record<ModelSurface, string[]>) => void;
  models: ModelEntry[];
  providers: Provider[];
}) {
  const [q, setQ] = useState("");
  const claude = useClaudeModels();
  const enabled = providers.filter((p) => p.enabled);
  const lists = useCatalogs(enabled);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = claudeOptions(models, claude.result).map((o) => ({
      key: modelKey(ANTHROPIC_PROVIDER_ID, o.id), label: o.id, sub: o.label, group: "Claude", in: ["chat", "stages", "helpers"] as ModelSurface[],
    }));
    for (const p of enabled) {
      const codex = p.kind === "cli" && p.cli?.preset === "codex";
      const surfaces: ModelSurface[] = [...(p.kind === "anthropic-compatible" ? ["chat" as const] : []), "stages", "helpers", ...(codex ? ["pictures" as const] : [])];
      out.push({ key: modelKey(p.id, "*"), label: `All of ${p.label}`, sub: "the whole provider", group: p.label, in: surfaces });
      const listed = lists.get(p.id)?.models ?? p.models.map((m) => ({ id: m.id, label: m.label || m.id }));
      for (const m of listed) out.push({ key: modelKey(p.id, m.id), label: m.id, sub: m.label && m.label !== m.id ? m.label : "", group: p.label, in: surfaces });
    }
    for (const m of PICTURE_MAKERS) out.push({ key: modelKey("pictures", m.id), label: m.label, sub: "picture maker", group: "Picture makers", in: ["pictures"] });
    return out;
  }, [models, claude.result, enabled.map((p) => p.id).join(","), lists]);

  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => `${r.label} ${r.sub} ${r.group}`.toLowerCase().includes(needle)) : rows;
  const isShown = (surface: ModelSurface, key: string) => !hidden[surface].includes(key);
  const toggle = (surface: ModelSurface, key: string, on: boolean) =>
    setHidden({ ...hidden, [surface]: on ? hidden[surface].filter((k) => k !== key) : [...new Set([...hidden[surface], key])] });
  const all = (surface: ModelSurface, on: boolean) => {
    const keys = new Set(shown.filter((r) => r.in.includes(surface)).map((r) => r.key));
    setHidden({ ...hidden, [surface]: on ? hidden[surface].filter((k) => !keys.has(k)) : [...new Set([...hidden[surface], ...keys])] });
  };
  const groups = [...new Set(shown.map((r) => r.group))];

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-400">
        Untick a model to keep it out of a picker. New models appear on their own unless you hide them, and a model already picked somewhere keeps showing there.
        Every model list also has a search box: type part of a name.
      </p>
      <input className={inputCls} placeholder="Search models and providers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
      <div className="overflow-x-auto rounded-lg border border-ink-800">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-ink-900/80 text-ink-400">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              {COLUMNS.map((c) => (
                <th key={c.id} className="px-2 py-2 text-center font-medium" title={c.hint}>
                  <div>{c.label}</div>
                  <div className="mt-0.5 flex justify-center gap-1.5 font-mono text-[10px] font-normal">
                    <button type="button" className="cursor-pointer text-ink-500 hover:text-moss" onClick={() => all(c.id, true)}>all</button>
                    <button type="button" className="cursor-pointer text-ink-500 hover:text-rust" onClick={() => all(c.id, false)}>none</button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <GroupRows key={g} title={g} rows={shown.filter((r) => r.group === g)} isShown={isShown} toggle={toggle} />
            ))}
            {!shown.length ? (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-ink-500">Nothing matches “{q}”.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ title, rows, isShown, toggle }: { title: string; rows: Row[]; isShown: (s: ModelSurface, key: string) => boolean; toggle: (s: ModelSurface, key: string, on: boolean) => void }) {
  return (
    <>
      <tr className="border-t border-ink-800 bg-ink-900/40">
        <td colSpan={5} className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-500">{title}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.key} className="border-t border-ink-800/60 hover:bg-ink-850/60">
          <td className="px-3 py-1.5">
            <span className={`font-mono ${r.key.endsWith(":*") ? "text-ink-300" : "text-ink-100"}`}>{r.label}</span>
            {r.sub ? <span className="ml-2 text-[11px] text-ink-500">{r.sub}</span> : null}
          </td>
          {COLUMNS.map((c) => (
            <td key={c.id} className="px-2 py-1.5 text-center">
              {r.in.includes(c.id) ? (
                <input
                  type="checkbox"
                  className="accent-amber"
                  checked={isShown(c.id, r.key)}
                  onChange={(e) => toggle(c.id, r.key, e.target.checked)}
                  aria-label={`${r.label} in ${c.label}`}
                />
              ) : (
                <span className="text-ink-700">—</span>
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
