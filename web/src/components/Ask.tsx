import { useCallback, useState, type ReactNode } from "react";
import { Button, inputCls, Modal } from "./ui.tsx";

interface AskOpts {
  title: string;
  message?: ReactNode;
  /** Present: ask for text. Absent: a yes/no confirmation. */
  input?: { placeholder?: string; initial?: string; required?: boolean };
  confirmLabel?: string;
  danger?: boolean;
}

interface Pending extends AskOpts {
  resolve: (value: string | null) => void;
}

/**
 * The board's own prompt and confirm. The browser's `prompt()` / `confirm()` block the page and are
 * dismissed without an answer in embedded browsers — seen on this board: Reject did nothing at all
 * in the in-app browser (docs/DECISIONS.md D193). Render `element` once; await `ask` or `confirm`.
 */
export function useAsk() {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((o: AskOpts) => new Promise<string | null>((resolve) => setPending({ ...o, input: o.input ?? {}, resolve })), []);
  const confirm = useCallback((o: Omit<AskOpts, "input">) => new Promise<boolean>((resolve) => setPending({ ...o, input: undefined, resolve: (v) => resolve(v !== null) })), []);
  const close = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
  };
  const element = pending ? <AskModal p={pending} onDone={close} /> : null;
  return { ask, confirm, element };
}

function AskModal({ p, onDone }: { p: Pending; onDone: (value: string | null) => void }) {
  const [text, setText] = useState(p.input?.initial ?? "");
  const blocked = !!p.input?.required && !text.trim();
  const submit = () => !blocked && onDone(p.input ? text.trim() : "");
  return (
    <Modal title={p.title} onClose={() => onDone(null)}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {p.message ? <div className="text-[13px] text-ink-300">{p.message}</div> : null}
        {p.input ? (
          <textarea
            className={`${inputCls} min-h-[90px] text-[13px]`}
            placeholder={p.input.placeholder}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            // Enter sends, as a prompt would; Shift+Enter is a new line.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onDone(null)}>Cancel</Button>
          <Button type="submit" variant={p.danger ? "danger" : "primary"} disabled={blocked} autoFocus={!p.input}>
            {p.confirmLabel ?? "OK"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
