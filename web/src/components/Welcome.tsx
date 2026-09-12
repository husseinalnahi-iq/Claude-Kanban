import { useEffect, useState } from "react";
import { navigate } from "../lib/router.ts";
import { closeWelcome, forecast } from "../lib/welcome.ts";
import { ALL_FEATURES, HEADLINES } from "./tour/features.ts";
import { DodgeButton } from "./tour/DodgeButton.tsx";
import { MiniBoard } from "./tour/MiniBoard.tsx";
import { TourStyles, tint, useDisplayFont } from "./tour/TourStyles.tsx";
import { Button } from "./ui.tsx";

/**
 * What a first-time user sees: the six things that make the board worth using, a demo card walking
 * across it, and a Skip button with a sense of humour. Shown once per machine; the Tour tab has the
 * rest and can replay this.
 */
export function Welcome({ hasProjects, onAddProject }: { hasProjects: boolean; onAddProject: () => void }) {
  useDisplayFont();
  const [line] = useState(forecast);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && closeWelcome();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const go = (then: () => void) => {
    closeWelcome();
    then();
  };
  const more = ALL_FEATURES.length - HEADLINES.length;

  return (
    <div className="kb-scrim fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-labelledby="kb-welcome-title">
      <TourStyles />
      <div className="kb-welcome relative max-h-[94vh] w-full max-w-[940px] overflow-y-auto overflow-x-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/70">
        {/* a warm light from the corner and a faint grid, so it reads as a place, not a form */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(620px 300px at 0% 0%, rgb(242 169 59 / .13), transparent 70%), radial-gradient(520px 260px at 100% 100%, rgb(94 200 216 / .07), transparent 70%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[260px] opacity-[.35]"
          style={{
            backgroundImage: "linear-gradient(var(--color-ink-800) 1px, transparent 1px), linear-gradient(90deg, var(--color-ink-800) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage: "linear-gradient(to bottom, black, transparent)",
          }}
        />

        <div className="relative">
          <header className="flex items-start justify-between gap-4 px-8 pt-6">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-end gap-[3px] rounded-md bg-ink-800 p-[5px]">
                <span className="h-full w-1.5 rounded-sm bg-amber" />
                <span className="h-2/3 w-1.5 rounded-sm bg-ink-200" />
                <span className="h-1/3 w-1.5 rounded-sm bg-ink-500" />
              </div>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-400">Welcome to Claude Kanban</span>
            </div>
            <DodgeButton onClose={closeWelcome} />
          </header>

          <section className="px-8 pt-5">
            <h1 id="kb-welcome-title" className="kb-display max-w-[720px] text-[46px] leading-[1.02] text-ink-100">
              Your Claude, <em className="text-amber">running a whole board.</em>
            </h1>
            <p className="mt-3 max-w-[640px] text-[14.5px] leading-relaxed text-ink-300">
              Write a card and walk away. Claude plans it, codes it, looks at the result in a browser, and asks before
              anything risky. You approve what lands.
            </p>
            <div className="mt-3 inline-flex items-center rounded-full border border-ink-700 bg-ink-950/60 px-3 py-1 text-[12px] text-ink-300">{line}</div>
          </section>

          <section className="px-8 pt-5">
            <MiniBoard />
          </section>

          <section className="kb-stagger grid grid-cols-1 gap-2.5 px-8 pt-5 sm:grid-cols-2 lg:grid-cols-3">
            {HEADLINES.map((f) => (
              <div
                key={f.id}
                className="kb-feature group rounded-xl border border-ink-800 bg-ink-850/70 p-3.5 hover:bg-ink-850"
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = tint(f.color, 45))}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[14px]"
                    style={{ background: tint(f.color, 16), color: f.color }}
                  >
                    {f.icon}
                  </span>
                  <h3 className="text-[13px] font-semibold leading-snug text-ink-100">{f.title}</h3>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-ink-400 group-hover:text-ink-300">{f.why}</p>
              </div>
            ))}
          </section>

          <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 bg-ink-950/40 px-8 py-4">
            <p className="text-[12.5px] text-ink-400">
              <span className="text-ink-200">+{more} more</span> in the <b className="font-semibold text-ink-200">Tour</b> tab, any time. It all runs on the
              Claude Code you already have.
            </p>
            <div className="flex items-center gap-2">
              <Button onClick={() => go(() => navigate({ view: "tour", taskId: null }))}>Show me everything →</Button>
              {hasProjects ? (
                <Button variant="primary" onClick={() => go(() => navigate({ view: "board", taskId: null }))}>
                  Take me to my board
                </Button>
              ) : (
                <Button variant="primary" onClick={() => go(onAddProject)}>
                  + Add my first project
                </Button>
              )}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
