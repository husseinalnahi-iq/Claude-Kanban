import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "../../../server/src/routes/search.ts";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { ago } from "../lib/format.ts";
import { inputCls, Modal } from "./ui.tsx";

const KIND_TONE: Record<SearchHit["kind"], string> = {
  task: "text-ink-200",
  run: "text-amber",
  transcript: "text-cyan",
  message: "text-lime",
  memory: "text-moss",
};

/**
 * One place to answer "what did we do about X?". Searches task specs, run results, transcripts,
 * messages and project memory — so you can find the old work instead of reopening a stale session.
 */
export function SearchModal({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"project" | "all">(projectId ? "project" : "all");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      void api
        .search(q, scope === "project" ? projectId : undefined)
        .then((r) => {
          if (seq.current === mine) {
            setHits(r);
            setSel(0);
          }
        })
        .finally(() => seq.current === mine && setBusy(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q, scope, projectId]);

  const open = (h: SearchHit) => {
    if (!h.taskId) return;
    navigate({ view: "board", projectId: h.projectId, taskId: h.taskId });
    onClose();
  };

  return (
    <Modal title="Search everything" onClose={onClose} width="max-w-3xl">
      <div className="flex gap-2">
        <input
          autoFocus
          className={inputCls}
          placeholder="A word from a spec, a transcript, an error, a decision…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(hits.length - 1, s + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            if (e.key === "Enter" && hits[sel]) open(hits[sel]);
          }}
        />
        {projectId ? (
          <div className="flex overflow-hidden rounded-md border border-ink-700 font-mono text-[11px]">
            {(["project", "all"] as const).map((s) => (
              <button key={s} onClick={() => setScope(s)} className={`px-2.5 cursor-pointer ${scope === s ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"}`}>
                {s === "project" ? "this project" : "all"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-3 max-h-[55vh] space-y-1 overflow-y-auto">
        {busy && !hits.length ? <div className="py-6 text-center text-[12.5px] text-ink-500">Searching…</div> : null}
        {!busy && q.trim().length >= 2 && !hits.length ? (
          <div className="py-6 text-center text-[12.5px] text-ink-500">Nothing matched “{q}”.</div>
        ) : null}
        {hits.map((h, i) => (
          <button
            key={`${h.kind}-${h.taskId}-${h.runId ?? i}-${i}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => open(h)}
            className={`block w-full rounded-md border px-3 py-2 text-left transition-colors cursor-pointer ${i === sel ? "border-amber/50 bg-ink-800" : "border-ink-800 hover:border-ink-600"}`}
          >
            <div className="flex items-center gap-2 font-mono text-[10.5px]">
              <span className={KIND_TONE[h.kind]}>{h.where}</span>
              <span className="truncate text-ink-300">{h.taskTitle}</span>
              <span className="ml-auto shrink-0 text-ink-500">{h.projectName} · {ago(h.ts)}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-200">{h.snippet}</div>
          </button>
        ))}
      </div>
      {hits.length ? <div className="mt-2 font-mono text-[10.5px] text-ink-600">↑↓ to move · enter to open the task</div> : null}
    </Modal>
  );
}
