import { useRef, type ClipboardEvent } from "react";
import { ATTACH_ACCEPT } from "../lib/files.ts";
import { Button } from "./ui.tsx";

/** The 📎 button: opens the file picker for every type the board takes. */
export function AttachButton({ onFiles, disabled, busy }: { onFiles: (files: File[]) => void; disabled?: boolean; busy?: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={picker} type="file" multiple className="hidden" accept={ATTACH_ACCEPT} onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <Button type="button" variant="ghost" busy={busy} disabled={disabled} title="Attach files — or paste a screenshot or file into the box" onClick={() => picker.current?.click()}>📎</Button>
    </>
  );
}

/** Files pasted into a text box (a screenshot, a copied file); text pastes as usual. */
export function onPasteFiles(onFiles: (files: File[]) => void) {
  return (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    onFiles(files);
  };
}

/** What is attached so far, each with a × to take it off again. */
export function FileChips({ files, onRemove }: { files: { key: string; name: string }[]; onRemove: (key: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <span key={f.key} className="inline-flex max-w-[16rem] items-center gap-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-[11px] text-ink-200">
          <span className="truncate" title={f.name}>📎 {f.name}</span>
          <button type="button" className="cursor-pointer text-ink-400 hover:text-rose" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.key)}>×</button>
        </span>
      ))}
    </div>
  );
}
