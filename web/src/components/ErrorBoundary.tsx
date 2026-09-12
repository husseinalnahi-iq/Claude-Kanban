import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { api, ApiError } from "../lib/api.ts";
import { Button } from "./ui.tsx";

const RESTART = "close the minimised “Claude Kanban” window in the taskbar (best when no task is running), then open the board again from its icon";

/**
 * Whether the server runs older code than what is on disk. The page is rebuilt from disk, so a server
 * left running across an update serves a page that asks it for things it does not have yet.
 */
export function useServerStale(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const check = () =>
      void api.version().then(
        (v) => setStale(v.stale),
        // A server from before this check existed has no /version at all.
        (e) => e instanceof ApiError && e.status === 404 && setStale(true),
      );
    check();
    const t = setInterval(check, 120_000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, []);
  return stale;
}

export function StaleServerBanner() {
  if (!useServerStale()) return null;
  return (
    <div className="border-b border-amber/40 bg-amber/10 px-4 py-1.5 text-[12px] text-amber">
      ⚠ The board is running older code than what is on disk, so some screens may not work. To update, {RESTART}.
    </div>
  );
}

function StaleHint() {
  return useServerStale() ? (
    <p className="text-amber">The board is running older code than what is on disk — that is the likely cause. To update, {RESTART}.</p>
  ) : null;
}

/**
 * A screen that throws shows what went wrong instead of taking the whole board down to a black page.
 * With `onClose` it floats (for drawers and panels); without, it fills the space the screen had.
 * Give it a `key` that changes with the screen, so moving on clears the error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onClose?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { onClose } = this.props;
    const body = (
      <div className="space-y-3 text-[13px]">
        <div className="text-[15px] font-semibold text-ink-100">This screen hit an error</div>
        <div className="break-words rounded-md border border-rust/40 bg-rust/5 px-3 py-2 font-mono text-[12px] text-rust">{error.message || String(error)}</div>
        <StaleHint />
        <p className="text-ink-400">The rest of the board still works. Try again, or reload the page.</p>
        <div className="flex gap-2">
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button variant="ghost" onClick={() => location.reload()}>Reload the page</Button>
          {onClose ? (
            <Button variant="ghost" className="ml-auto" onClick={() => { this.setState({ error: null }); onClose(); }}>Close</Button>
          ) : null}
        </div>
      </div>
    );
    return onClose ? (
      <div className="fixed right-4 top-16 z-50 w-[380px] rounded-lg border border-ink-700 bg-ink-900 p-4 shadow-2xl">{body}</div>
    ) : (
      <div className="mx-auto mt-16 max-w-lg px-6">{body}</div>
    );
  }
}
