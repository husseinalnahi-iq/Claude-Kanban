import { useState } from "react";
import { navigate } from "../lib/router.ts";
import { forecast, openWelcome } from "../lib/welcome.ts";
import { GROUPS, SHORTCUTS, type Feature } from "../components/tour/features.ts";
import { MiniBoard } from "../components/tour/MiniBoard.tsx";
import { TourStyles, tint, useDisplayFont } from "../components/tour/TourStyles.tsx";
import { Button } from "../components/ui.tsx";

function FeatureCard({ f }: { f: Feature }) {
  return (
    <div
      className="kb-feature group relative flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900/70 p-4 hover:bg-ink-900"
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = tint(f.color, 45))}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: `linear-gradient(90deg, ${f.color}, transparent 85%)` }} />
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[15px]" style={{ background: tint(f.color, 15), color: f.color }}>
          {f.icon}
        </span>
        <h3 className="text-[14px] font-semibold leading-snug text-ink-100">{f.title}</h3>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-200">{f.pitch}</p>
      <p className="mt-1.5 flex-1 text-[12.5px] leading-relaxed text-ink-400">
        <span className="font-semibold" style={{ color: f.color }}>Why it's good: </span>
        {f.why}
      </p>
      <div className="mt-3">
        {f.go ? (
          <button
            className="cursor-pointer rounded-full border border-ink-700 px-2.5 py-0.5 font-mono text-[10.5px] text-ink-400 transition-colors hover:border-ink-500 hover:text-ink-100"
            onClick={() => navigate({ view: f.go!, taskId: null })}
          >
            {f.where} →
          </button>
        ) : (
          <span className="rounded-full border border-ink-800 px-2.5 py-0.5 font-mono text-[10.5px] text-ink-500">{f.where}</span>
        )}
      </div>
    </div>
  );
}

/** The dedicated tab: every feature, why it beats doing it by hand, and where to find it. */
export function Tour({ hasProjects, onAddProject }: { hasProjects: boolean; onAddProject: () => void }) {
  useDisplayFont();
  const [sound, setSound] = useState(false);
  const [line] = useState(forecast);

  const steps = [
    {
      n: "1",
      title: "Register a folder",
      body: "The board looks at it and offers /init for code, or a bootstrap for an empty folder. Anything missing on this computer? The Setup tab checks and installs it.",
      action: hasProjects ? null : { label: "+ Add a project", run: onAddProject },
    },
    {
      n: "2",
      title: "Write a card, press Improve",
      body: "Claude turns a rough ask into a spec with testable checks, and picks a pipeline that fits the job.",
      action: hasProjects ? { label: "Open the board", run: () => navigate({ view: "board", taskId: null }) } : null,
    },
    {
      n: "3",
      title: "Queue it and walk away",
      body: "The plan goes to the coder whole, and the reviewer checks every step was done. The bell calls you only when it needs a decision: a change to allow (just looking needs no card), a plan to pick, or a task at its cost ceiling. Approve what lands; Retry or Chat what doesn't.",
      action: null,
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <TourStyles />
      <div className="relative mx-auto max-w-[1180px] px-8 pb-16 pt-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
          style={{ background: "radial-gradient(700px 300px at 15% 0%, rgb(242 169 59 / .10), transparent 70%)" }}
        />

        {/* hero */}
        <section className="relative grid items-end gap-8 lg:grid-cols-[1fr_auto]">
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-500">Tour · what you get</div>
            <h1 className="kb-display mt-2 text-[52px] leading-[1] text-ink-100">
              Everything this board <em className="text-amber">does for you.</em>
            </h1>
            <p className="mt-3 max-w-[620px] text-[14.5px] leading-relaxed text-ink-300">
              A board you can see across every project, on top of the Claude Code you already use. Work runs in parallel,
              lands safely, and costs you only what it needs.
            </p>
            <div className="mt-3 inline-flex rounded-full border border-ink-700 bg-ink-950/60 px-3 py-1 text-[12px] text-ink-300">{line}</div>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <Button variant={sound ? "go" : "outline"} onClick={() => setSound((s) => !s)} title="Each step plays the sound the real board would, in your chosen theme">
              {sound ? "♪ Sound on" : "♪ Play the demo with sound"}
            </Button>
            <Button variant="ghost" onClick={openWelcome}>
              ↺ Replay the welcome
            </Button>
          </div>
        </section>

        <section className="relative mt-6 rounded-2xl border border-ink-800 bg-ink-900/50 p-4">
          <MiniBoard sound={sound} />
          <p className="mt-3 text-[11.5px] text-ink-500">
            One task's whole life, sped up: queued, planned, coded, checked in a browser, approved by you, reviewed, landed.
            The colours are the ones the real board uses for each state.
          </p>
        </section>

        {/* getting started */}
        <section className="relative mt-10">
          <h2 className="kb-display text-[30px] text-ink-100">Start in three steps</h2>
          <div className="kb-stagger mt-4 grid gap-3 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.n} className="relative overflow-hidden rounded-xl border border-ink-800 bg-ink-900/70 p-4">
                <span aria-hidden className="kb-display pointer-events-none absolute right-4 top-2 text-[64px] leading-none text-ink-700/70">
                  {s.n}
                </span>
                <div className="relative pr-12">
                  <h3 className="text-[14px] font-semibold text-ink-100">{s.title}</h3>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-400">{s.body}</p>
                  {s.action ? (
                    <Button size="sm" variant="primary" className="mt-3" onClick={s.action.run}>
                      {s.action.label}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>

        {GROUPS.map((g) => (
          <section key={g.title} className="relative mt-12">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h2 className="kb-display text-[30px] text-ink-100">{g.title}</h2>
              <p className="text-[13px] text-ink-500">{g.blurb}</p>
            </div>
            {/* four cards sit two by two rather than three and an orphan */}
            <div className={`kb-stagger mt-4 grid gap-3 md:grid-cols-2 ${g.features.length % 3 === 0 ? "xl:grid-cols-3" : ""}`}>
              {g.features.map((f) => (
                <FeatureCard key={f.id} f={f} />
              ))}
            </div>
          </section>
        ))}

        {/* shortcuts */}
        <section className="relative mt-12 grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div>
            <h2 className="kb-display text-[30px] text-ink-100">Fingers on the keys</h2>
            <div className="mt-4 overflow-hidden rounded-xl border border-ink-800">
              {SHORTCUTS.map(([k, what], n) => (
                <div key={k} className={`flex items-center justify-between gap-4 px-4 py-2.5 ${n % 2 ? "bg-ink-900/40" : "bg-ink-900/80"}`}>
                  <span className="text-[12.5px] text-ink-300">{what}</span>
                  <kbd className="rounded border border-ink-600 bg-ink-850 px-2 py-0.5 font-mono text-[11px] text-ink-100">{k}</kbd>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h2 className="kb-display text-[30px] text-ink-100">Good to know</h2>
            <ul className="mt-4 space-y-3 text-[12.5px] leading-relaxed text-ink-400">
              <li>
                <b className="text-ink-200">Dollar figures are estimates, not a bill.</b> Runs go through your Claude subscription; the share of your
                5-hour window is the number that can actually stop you.
              </li>
              <li>
                <b className="text-ink-200">A locked-down repository stays locked.</b> Register it with the Supervised-only preset and the board refuses
                autonomous runs there. It never edits the repository's own rules.
              </li>
              <li>
                <b className="text-ink-200">Same task, same day: Chat.</b> While it is running, Chat hands your message over live — it does not stop.
                New symptom days later: ↪ Follow-up task, which starts fresh from the repository as it is now.
              </li>
              <li>
                <b className="text-ink-200">Sound needs one click first.</b> Browsers stay silent until you've clicked the page once. The bell's ▾ has
                themes, volume and desktop notifications.
              </li>
            </ul>
          </div>
        </section>

        <p className="relative mt-14 text-center text-[12px] text-ink-600">Built with Claude, supervised by you. Have a good one. 🌤️</p>
      </div>
    </div>
  );
}
