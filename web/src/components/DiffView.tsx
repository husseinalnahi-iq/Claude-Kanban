import { useEffect, useState } from "react";
import type { DiffFile } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { Empty } from "./ui.tsx";

const STATUS_TONE: Record<string, string> = { A: "text-moss", M: "text-amber", D: "text-rust" };

function Patch({ patch }: { patch: string }) {
  const lines = patch.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  return (
    <pre className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith("+") ? "bg-moss/10 text-[#b9dcb0]" : l.startsWith("-") ? "bg-rust/10 text-[#f0a58c]" : l.startsWith("@@") ? "text-cyan/80 pt-1" : "text-ink-400"
          }
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

export function DiffView({ taskId, refreshKey }: { taskId: string; refreshKey: unknown }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.diff(taskId).then((f) => {
      setFiles(f);
      setError(null);
    }, (e: Error) => setError(e.message));
  }, [taskId, refreshKey]);

  if (error) return <Empty>{error}</Empty>;
  if (!files) return <div className="text-[12px] text-ink-500">Loading diff…</div>;
  if (!files.length) return <Empty>No committed changes on this task's branch yet. Diffs exist for autonomous tasks after a stage finishes.</Empty>;
  return (
    <div className="space-y-2">
      {files.map((f) => {
        const adds = f.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const dels = f.patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        const isOpen = open === f.file || files.length === 1;
        return (
          <div key={f.file} className="overflow-hidden rounded-lg border border-ink-700 bg-ink-900/60">
            <button className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[12px] hover:bg-ink-800 cursor-pointer" onClick={() => setOpen(isOpen ? null : f.file)}>
              <span className={`w-3 font-semibold ${STATUS_TONE[f.status] ?? "text-ink-300"}`}>{f.status}</span>
              <span className="flex-1 truncate text-ink-100">{f.file}</span>
              <span className="text-moss">+{adds}</span>
              <span className="text-rust">−{dels}</span>
            </button>
            {isOpen ? (
              <div className="border-t border-ink-700 px-1 py-1">
                <Patch patch={f.patch} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
