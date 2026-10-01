import { useEffect, useMemo, useState } from "react";
import type { DiffFile } from "../../../server/src/types.ts";
import { api } from "../lib/api.ts";
import { Button, Empty } from "./ui.tsx";

const STATUS_TONE: Record<string, string> = { A: "text-moss", M: "text-amber", D: "text-rust" };

/** A note you pinned to one line of the changes, waiting to be sent. */
export interface DiffComment {
  file: string;
  /** Line number in the new file; for a removed line, in the old one. */
  line: number;
  removed: boolean;
  code: string;
  text: string;
}

interface Row {
  text: string;
  kind: "add" | "del" | "ctx" | "hunk";
  /** The line's number in the file, or 0 for a hunk header. */
  line: number;
}

/** The patch as rows, each knowing which line of the file it is — that is what a comment points at. */
export function patchRows(patch: string): Row[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const rows: Row[] = [];
  const lines = patch.split("\n");
  // git ends a patch with a newline; that is not a line of the file, and a comment on it would name one past the last.
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ text, kind: "hunk", line: 0 });
      continue;
    }
    // Before the first hunk is the file header (diff --git, index, ---, +++). Inside one, a line that
    // starts with --- or +++ is a removed or added line whose own text starts with -- or ++ (a SQL
    // comment, say): dropping it hid the line and put every number after it out by one.
    if (!inHunk || text.startsWith("\\")) continue;
    if (text.startsWith("+")) rows.push({ text, kind: "add", line: newLine++ });
    else if (text.startsWith("-")) rows.push({ text, kind: "del", line: oldLine++ });
    else {
      rows.push({ text, kind: "ctx", line: newLine });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}

/** What Claude receives: every comment with its file, line and the line's own text, in one message. */
export function commentsMessage(comments: DiffComment[]): string {
  const lines = comments.map((c, i) => `${i + 1}. ${c.file}, ${c.removed ? "removed line" : "line"} ${c.line} (\`${c.code.trim().slice(0, 160)}\`):\n   ${c.text.trim().replace(/\n/g, "\n   ")}`);
  return `I read the changes and have ${comments.length === 1 ? "a comment" : `${comments.length} comments`}. Please deal with ${comments.length === 1 ? "it" : "each one"}, then say what you changed.\n\n${lines.join("\n\n")}`;
}

const key = (c: { file: string; line: number; removed: boolean }) => `${c.file}|${c.removed ? "-" : "+"}${c.line}`;

function Patch({
  file, patch, comments, onSave, onRemove, readOnly,
}: {
  file: string;
  patch: string;
  comments: Map<string, DiffComment>;
  onSave: (c: DiffComment) => void;
  onRemove: (k: string) => void;
  /** Landed work: its session cannot take comments any more, so lines are only shown. */
  readOnly: boolean;
}) {
  const rows = useMemo(() => patchRows(patch), [patch]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      {rows.map((r, i) => {
        if (r.kind === "hunk") return <div key={i} className="whitespace-pre pt-1 text-cyan/80">{r.text}</div>;
        const k = key({ file, line: r.line, removed: r.kind === "del" });
        const saved = comments.get(k);
        const tone = r.kind === "add" ? "bg-moss/10 text-[var(--kb-diff-add)]" : r.kind === "del" ? "bg-rust/10 text-[var(--kb-diff-del)]" : "text-ink-400";
        if (readOnly) {
          return (
            <div key={i} className={`flex whitespace-pre ${tone}`}>
              <span className="w-10 shrink-0 select-none pr-2 text-right text-ink-600">{r.line}</span>
              <span className="flex-1">{r.text || " "}</span>
            </div>
          );
        }
        const open = () => {
          setEditing(k);
          setDraft(saved?.text ?? "");
        };
        const save = () => {
          if (draft.trim()) onSave({ file, line: r.line, removed: r.kind === "del", code: r.text.slice(1), text: draft.trim() });
          else onRemove(k);
          setEditing(null);
        };
        return (
          <div key={i}>
            <div
              role="button"
              tabIndex={0}
              title="Click to comment on this line"
              className={`group flex cursor-pointer whitespace-pre hover:brightness-125 ${tone}`}
              onClick={open}
              onKeyDown={(e) => e.key === "Enter" && open()}
            >
              <span className="w-10 shrink-0 select-none pr-2 text-right text-ink-600">{r.line}</span>
              <span className="flex-1">{r.text || " "}</span>
              <span className="sticky right-1 select-none px-1 text-amber opacity-0 group-hover:opacity-100">✎</span>
            </div>
            {editing === k ? (
              <div className="my-1 ml-10 rounded-md border border-amber/50 bg-ink-850 p-1.5 font-sans">
                <textarea
                  autoFocus
                  rows={2}
                  className="block w-full resize-y bg-transparent px-1.5 py-1 text-[12.5px] text-ink-100 outline-none placeholder:text-ink-500"
                  placeholder="What should change here?"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      save();
                    } else if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
                <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-ink-500">
                  <span>Enter keeps it · Shift+Enter new line · Esc cancels</span>
                  <Button size="sm" className="ml-auto" onClick={save}>Keep</Button>
                </div>
              </div>
            ) : saved ? (
              <div className="my-1 ml-10 flex items-start gap-2 rounded-md border border-amber/40 bg-amber/5 px-2 py-1 font-sans text-[12px] text-ink-100">
                <span className="text-amber">✎</span>
                <button type="button" className="min-w-0 flex-1 cursor-pointer whitespace-pre-wrap text-left" onClick={open} title="Edit this comment">{saved.text}</button>
                <button type="button" className="cursor-pointer text-ink-500 hover:text-rust" onClick={() => onRemove(k)} aria-label="Remove this comment">×</button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The task's changes, file by file. Click any line to pin a comment to it; all of them go to the
 * task's own Claude session in one message, which is easier than describing where a problem is.
 */
export function DiffView({ taskId, refreshKey, canComment = true }: { taskId: string; refreshKey: unknown; canComment?: boolean }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<Map<string, DiffComment>>(new Map());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    api.diff(taskId).then((f) => {
      setFiles(f);
      setError(null);
    }, (e: Error) => setError(e.message));
  }, [taskId, refreshKey]);
  useEffect(() => setComments(new Map()), [taskId]);

  const save = (c: DiffComment) => setComments((prev) => new Map(prev).set(key(c), c));
  const remove = (k: string) => setComments((prev) => {
    const next = new Map(prev);
    next.delete(k);
    return next;
  });
  const send = async () => {
    const list = [...comments.values()];
    if (!list.length) return;
    setSending(true);
    setSendError(null);
    try {
      await api.chat(taskId, commentsMessage(list));
      setSent(list.length);
      setComments(new Map());
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  if (error) return <Empty>{error}</Empty>;
  if (!files) return <div className="text-[12px] text-ink-500">Loading diff…</div>;
  if (!files.length) return <Empty>No committed changes on this task's branch yet. Diffs exist for autonomous tasks after a stage finishes.</Empty>;
  return (
    <div className="space-y-2">
      {canComment ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/95 px-3 py-1.5 text-[12px] text-ink-400 backdrop-blur">
          {comments.size ? (
            <>
              <span className="text-ink-100">{comments.size} comment{comments.size === 1 ? "" : "s"} ready</span>
              <span>Claude gets them all at once, in this task's own session.</span>
              <Button size="sm" variant="primary" className="ml-auto" busy={sending} onClick={() => void send()}>Send to Claude</Button>
              <Button size="sm" variant="ghost" onClick={() => setComments(new Map())}>Clear</Button>
            </>
          ) : sent ? (
            <span><span className="text-moss">✓</span> Sent {sent} comment{sent === 1 ? "" : "s"}. The task is working on {sent === 1 ? "it" : "them"}; the changes here update when it is done.</span>
          ) : (
            <span>Click any line to comment on it, then send all your comments to Claude in one go.</span>
          )}
          {sendError ? <span className="basis-full text-rust">{sendError}</span> : null}
        </div>
      ) : null}
      {files.map((f) => {
        const rows = patchRows(f.patch);
        const adds = rows.filter((r) => r.kind === "add").length;
        const dels = rows.filter((r) => r.kind === "del").length;
        const isOpen = open === f.file || files.length === 1;
        const pinned = [...comments.values()].filter((c) => c.file === f.file).length;
        return (
          <div key={f.file} className="overflow-hidden rounded-lg border border-ink-700 bg-ink-900/60">
            <button className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[12px] hover:bg-ink-800 cursor-pointer" onClick={() => setOpen(isOpen ? null : f.file)}>
              <span className={`w-3 font-semibold ${STATUS_TONE[f.status] ?? "text-ink-300"}`}>{f.status}</span>
              <span className="flex-1 truncate text-ink-100">{f.file}</span>
              {pinned ? <span className="text-amber">✎ {pinned}</span> : null}
              <span className="text-moss">+{adds}</span>
              <span className="text-rust">−{dels}</span>
            </button>
            {isOpen ? (
              <div className="border-t border-ink-700 px-1 py-1">
                <Patch file={f.file} patch={f.patch} comments={comments} onSave={save} onRemove={remove} readOnly={!canComment} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
