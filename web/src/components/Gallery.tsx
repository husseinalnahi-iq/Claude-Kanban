import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../../server/src/types.ts";
import { ATTACHMENT_TYPES, attachmentKind } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { Button, ErrorLine, useAction } from "./ui.tsx";

const MAX_BYTES = 10 * 1024 * 1024;
const EXTS = Object.keys(ATTACHMENT_TYPES);

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const extOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();

/** A word, not an icon: the file type has to be readable without interpreting a glyph. */
const TYPE_LABEL: Record<string, string> = {
  ".xlsx": "excel", ".xls": "excel", ".csv": "csv", ".tsv": "tsv",
  ".docx": "word", ".doc": "word", ".pptx": "slides", ".pdf": "pdf",
  ".html": "html", ".htm": "html", ".svg": "svg", ".json": "json",
  ".md": "markdown", ".txt": "text", ".log": "log", ".yaml": "yaml", ".yml": "yaml", ".xml": "xml",
};

/** File → base64 without the `data:…;base64,` prefix, which is what the upload route expects. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.readAsDataURL(file);
  });
}

/** CSV/TSV split well enough for a preview table: quoted separators work, exotic escapes do not. */
function parseRows(text: string, sep: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 30)
    .map((line) => {
      const cells: string[] = [];
      let cur = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (quoted && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else quoted = !quoted;
        } else if (c === sep && !quoted) {
          cells.push(cur);
          cur = "";
        } else cur += c;
      }
      cells.push(cur);
      return cells.slice(0, 12);
    });
}

/** What a file looks like when opened: a table, a rendered page, its text, or a download. */
function Preview({ a, onClose }: { a: Attachment; onClose: () => void }) {
  const kind = attachmentKind(a.media_type);
  const ext = extOf(a.name);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (kind !== "text") return;
    let live = true;
    void api.attachmentText(a.id).then(
      (t) => live && setText(t),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [a.id, kind]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const body = () => {
    if (kind === "image") {
      return <img src={api.attachmentUrl(a.id)} alt={a.name} className="mx-auto max-h-[74vh] max-w-full rounded-lg border border-ink-700 object-contain" />;
    }
    if (kind === "document") {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-ink-700 bg-ink-900 px-10 py-12 text-center">
          <div className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-500">{TYPE_LABEL[ext] ?? ext.slice(1)}</div>
          <div className="text-[13px] text-ink-200">{a.name}</div>
          <div className="text-[12px] text-ink-500">{kb(a.bytes)} — this format opens in its own application.</div>
          <a href={api.attachmentUrl(a.id)} download={a.name} className="rounded-md bg-amber px-3 py-1.5 text-[13px] font-semibold text-ink-950 hover:bg-[#ffbb55]">
            Download
          </a>
        </div>
      );
    }
    if (failed) return <div className="text-[12.5px] text-rust">That file could not be read.</div>;
    if (text === null) return <div className="text-[12.5px] text-ink-400">Loading…</div>;
    if (ext === ".csv" || ext === ".tsv") {
      const rows = parseRows(text, ext === ".csv" ? "," : "\t");
      const [head, ...rest] = rows;
      return (
        <div className="max-h-[74vh] w-full overflow-auto rounded-lg border border-ink-700 bg-ink-900">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-ink-850">
              <tr>
                {(head ?? []).map((c, i) => (
                  <th key={i} className="whitespace-nowrap border-b border-ink-700 px-2.5 py-1.5 text-left font-medium text-ink-200">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-ink-300">
              {rest.map((r, i) => (
                <tr key={i} className="border-b border-ink-800/70">
                  {r.map((c, j) => <td key={j} className="whitespace-nowrap px-2.5 py-1">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-2.5 py-1.5 text-[11px] text-ink-500">First {rows.length} rows — download for the whole file.</div>
        </div>
      );
    }
    if (ext === ".html" || ext === ".htm" || ext === ".svg") {
      // Sandboxed with neither allow-scripts nor allow-same-origin: it renders, but it cannot run
      // anything or reach the board's API.
      return (
        <div className="w-full">
          <iframe title={a.name} srcDoc={text} sandbox="" className="h-[70vh] w-full rounded-lg border border-ink-700 bg-white" />
          <div className="mt-1 text-[11px] text-ink-500">Rendered in a sandbox: scripts are off and it cannot reach the board.</div>
        </div>
      );
    }
    return <pre className="max-h-[74vh] w-full overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[12px] whitespace-pre-wrap text-ink-200">{text}</pre>;
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-ink-950/90 p-6" onClick={onClose}>
      <div className="w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>{body()}</div>
      <div className="flex items-center gap-3 font-mono text-[11.5px] text-ink-400">
        <span>{a.name} · {kb(a.bytes)}{a.note ? ` · ${a.note}` : ""}</span>
        <a href={api.attachmentUrl(a.id)} download={a.name} className="text-amber hover:underline" onClick={(e) => e.stopPropagation()}>download</a>
        <span className="text-ink-600">click outside or press Escape</span>
      </div>
    </div>
  );
}

/**
 * A task's files: ones you attached (which runs are given as a description or a preview) and ones
 * the sessions produced — screenshots, reports, spreadsheets, pages.
 */
export function Gallery({ taskId, attachments, onChange }: { taskId: string; attachments: Attachment[]; onChange: () => void }) {
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { busy, error, setError, run } = useAction();

  const upload = (files: FileList | File[] | null) => {
    const list = [...(files ?? [])].filter(Boolean);
    if (!list.length) return;
    const bad = list.find((f) => !EXTS.includes(extOf(f.name)));
    if (bad) return setError(`The board does not handle "${extOf(bad.name) || bad.name}" files. Images, PDF, Word, Excel, PowerPoint, CSV and text all work.`);
    const big = list.find((f) => f.size > MAX_BYTES);
    if (big) return setError(`${big.name} is ${kb(big.size)} — the limit is 10 MB.`);
    void run(async () => {
      for (const f of list) await api.addAttachment(taskId, { name: f.name || "pasted image.png", media_type: f.type, data: await toBase64(f) });
      onChange();
    });
  };

  // Paste anywhere in the tab while this is open — the usual way a screenshot arrives.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
      if (files.length) {
        e.preventDefault();
        upload(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const mine = attachments.filter((a) => a.source === "user");
  const theirs = attachments.filter((a) => a.source === "run");

  const tile = (a: Attachment) => {
    const kind = attachmentKind(a.media_type);
    const ext = extOf(a.name);
    return (
      <figure key={a.id} className="group relative overflow-hidden rounded-lg border border-ink-700 bg-ink-850">
        <button className="block h-28 w-full cursor-zoom-in" onClick={() => setOpen(a)} title={`${a.name} · ${kb(a.bytes)}`}>
          {kind === "image" ? (
            <img src={api.attachmentUrl(a.id)} alt={a.name} loading="lazy" className="h-28 w-full object-cover transition-transform group-hover:scale-[1.03]" />
          ) : (
            <div className="flex h-28 w-full flex-col justify-between bg-ink-900/70 p-2 text-left">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber">{TYPE_LABEL[ext] ?? (ext.slice(1) || "file")}</span>
              <span className="line-clamp-3 font-mono text-[9.5px] leading-snug text-ink-500">
                {a.description ? a.description.slice(0, 180) : kind === "document" ? "opens in its own application" : ""}
              </span>
            </div>
          )}
        </button>
        <figcaption className="px-2 py-1 text-[10.5px] text-ink-400">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate" title={a.note ?? a.name}>{a.name}</span>
            <span className="font-mono text-ink-600">{kb(a.bytes)}</span>
            <a
              href={api.attachmentUrl(a.id)}
              download={a.name}
              title="Download"
              className="cursor-pointer text-ink-500 opacity-0 transition-opacity hover:text-amber group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              ↓
            </a>
            <button
              className="cursor-pointer text-ink-500 opacity-0 transition-opacity hover:text-rust group-hover:opacity-100"
              title="Delete this file"
              onClick={() => run(async () => { await api.deleteAttachment(a.id); onChange(); })}
            >
              ×
            </button>
          </div>
          {a.source === "user" && kind === "image" ? (
            <>
              <div className={`mt-0.5 line-clamp-2 leading-snug ${a.description ? "text-ink-500" : "text-ink-600 italic"}`} title={a.description ?? undefined}>
                {a.description ?? "describing…"}
              </div>
              {a.described_by ? (
                <div className={`mt-0.5 truncate font-mono text-[10px] ${a.described_by.includes("fallback") ? "text-amber" : "text-ink-600"}`} title={`Described by ${a.described_by}`}>
                  seen by {a.described_by}
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-0.5 text-ink-600">{ago(a.created_at)}</div>
          )}
        </figcaption>
      </figure>
    );
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-lg border border-dashed px-4 py-6 text-center text-[12.5px] transition-colors ${
          over ? "border-amber bg-amber/5 text-amber" : "border-ink-700 text-ink-400 hover:border-ink-500"
        }`}
      >
        {busy ? "Uploading…" : <>Drop a file here, <span className="text-ink-200">paste</span> a screenshot, or click to choose.</>}
        <div className="mt-1 text-[11px] text-ink-500">
          Images, PDF, Word, Excel, PowerPoint, CSV and text — up to 10 MB. An image is described once by the cheap vision
          model (Settings → Models &amp; pipeline → Intake models); text and spreadsheets go into the prompt as a preview, so
          runs read them without opening them.
        </div>
        <input ref={input} type="file" accept={EXTS.join(",")} multiple className="hidden" onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
      </div>
      <ErrorLine error={error} />

      {mine.length ? (
        <div>
          <div className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-500">Attached by you ({mine.length})</div>
          <div className="grid grid-cols-3 gap-2">{mine.map(tile)}</div>
        </div>
      ) : null}

      {theirs.length ? (
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-ink-500">Produced by runs ({theirs.length})</span>
            <Button size="sm" variant="ghost" onClick={() => setOpen(theirs[theirs.length - 1])}>Open the latest</Button>
          </div>
          <div className="grid grid-cols-3 gap-2">{theirs.map(tile)}</div>
          <div className="mt-1.5 text-[11.5px] text-ink-500">
            Reports, pages, spreadsheets, diagrams and screenshots the sessions made — copied here as they appear, so they
            survive the worktree being removed. Source files are not kept: those are in the Diff.
          </div>
        </div>
      ) : null}

      {!attachments.length ? <div className="text-[12px] text-ink-500">No files yet.</div> : null}
      {open ? <Preview a={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
