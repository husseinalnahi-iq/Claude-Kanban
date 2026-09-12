import { useEffect, useRef, useState } from "react";
import { ALERT_KINDS, kindInfo, raise, setAlertPrefs, setKindChannel, useAlertPrefs, useUnseen, type AlertKind } from "../lib/alerts.ts";
import { disableNotifications, enableNotifications, notifyState } from "../lib/notify.ts";
import { THEMES, playSound, type SoundTheme } from "../lib/sounds.ts";

/** What a preview says, so trying a sound also shows what its pop-up looks like. */
const SAMPLE: Record<AlertKind, [string, string]> = {
  approval: ["Fix the invoice sync", "Wants to: Run `npm install`"],
  review: ["Make the header look better", "Every stage finished; your turn to look"],
  done: ["Add CSV export", "Approved and merged"],
  failed: ["Refactor auth", "Verification failed — `npm test` did not pass"],
  paused: ["Write the migration", "resumes in 1h 12m · 23:50"],
  resumed: ["Write the migration", "The window reset and it carried on"],
  started: ["Add dark mode", "A task began its first stage"],
  usage: ["5-hour window at 82%", "Tasks pause by themselves if it runs out · resets in 1h 47m (23:50)"],
  allClear: ["All clear", "Nothing running, queued or waiting on you."],
};

function BellIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      {muted ? <path d="M3 3l18 18" /> : null}
    </svg>
  );
}

function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors cursor-pointer ${on ? "bg-ink-700 text-ink-100" : "text-ink-600 hover:text-ink-300"}`}
    >
      {children}
    </button>
  );
}

const preview = (kind: AlertKind) => raise({ kind, title: SAMPLE[kind][0], body: SAMPLE[kind][1], preview: true });

/**
 * The bell in the top bar. Click it to mute or unmute; the arrow opens the panel: sound theme,
 * volume, and for every kind of event whether it plays a sound, shows a pop-up, or sends a desktop
 * notification. Settings live on this computer — they describe your desk, not the board.
 */
export function BellControl() {
  const prefs = useAlertPrefs();
  const unseen = useUnseen();
  const [open, setOpen] = useState(false);
  const [desk, setDesk] = useState(notifyState());
  const [touring, setTouring] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const sample = (theme: SoundTheme = prefs.theme, volume = prefs.volume) => playSound("review", theme, volume);

  /** Every sound once, with its pop-up, so you can learn them in ten seconds. */
  const tour = () => {
    if (touring) return;
    setTouring(true);
    const kinds: AlertKind[] = ["started", "approval", "review", "failed", "paused", "resumed", "usage", "done", "allClear"];
    kinds.forEach((k, i) =>
      setTimeout(() => {
        playSound(k, prefs.theme, prefs.volume);
        preview(k);
        if (i === kinds.length - 1) setTimeout(() => setTouring(false), 800);
      }, i * 1300),
    );
  };

  const dot = unseen ? kindInfo(unseen).color : null;

  return (
    <div ref={box} className="relative flex items-center">
      <div className={`flex items-center overflow-hidden rounded-md border ${open ? "border-ink-500" : "border-ink-700"}`}>
        <button
          onClick={() => setAlertPrefs({ muted: !prefs.muted })}
          className={`relative px-2 py-1 transition-colors cursor-pointer ${prefs.muted ? "text-ink-500 hover:text-ink-300" : "text-ink-200 hover:text-amber"}`}
          title={prefs.muted ? "Sounds off — click to turn them on" : "Sounds on — click to mute"}
        >
          <BellIcon muted={prefs.muted} />
          {dot ? <span className="absolute top-0.5 right-1 h-2 w-2 rounded-full ring-2 ring-ink-950" style={{ background: dot }} /> : null}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="border-l border-ink-700 px-1.5 py-1 text-[10px] text-ink-400 hover:text-ink-100 cursor-pointer"
          title="Notification settings"
        >
          ▾
        </button>
      </div>

      {open ? (
        <div className="rise absolute right-0 top-[calc(100%+6px)] z-50 w-[420px] rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl shadow-black/60">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-semibold text-ink-100">Notifications</span>
            <button
              onClick={tour}
              disabled={touring}
              className="rounded-md border border-ink-600 px-2 py-0.5 text-[11.5px] text-ink-200 hover:border-amber hover:text-amber disabled:opacity-50 cursor-pointer"
              title="Plays every sound once, with its pop-up"
            >
              {touring ? "Playing…" : "♪ Play them all"}
            </button>
          </div>

          <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-ink-500">Sound</div>
          <div className="mb-3 flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-ink-700">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setAlertPrefs({ theme: t.id, muted: false });
                    sample(t.id);
                  }}
                  title={t.hint}
                  className={`px-2.5 py-1 text-[12px] transition-colors cursor-pointer ${prefs.theme === t.id ? "bg-amber/15 text-amber" : "text-ink-300 hover:text-ink-100"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.volume}
              onChange={(e) => setAlertPrefs({ volume: Number(e.target.value) })}
              onPointerUp={() => sample()}
              className="h-1 flex-1 accent-amber"
              title={`Volume ${Math.round(prefs.volume * 100)}%`}
            />
            <span className="w-8 text-right font-mono text-[10.5px] text-ink-400">{Math.round(prefs.volume * 100)}%</span>
          </div>

          <div className="mb-1.5 flex items-center text-[10.5px] uppercase tracking-wider text-ink-500">
            <span className="flex-1">Events</span>
            <span className="w-[150px] text-center">sound · pop-up · desktop</span>
          </div>
          <div className="space-y-0.5">
            {ALERT_KINDS.map((k) => {
              const ch = prefs.kinds[k.kind];
              return (
                <div key={k.kind} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-ink-850">
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9.5px]"
                    style={{ background: `color-mix(in srgb, ${k.color} 20%, transparent)`, color: k.color }}
                  >
                    {k.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-ink-100">{k.label}</span>
                    <span className="block truncate text-[10.5px] text-ink-500">{k.hint}</span>
                  </span>
                  <button
                    onClick={() => {
                      playSound(k.kind, prefs.theme, prefs.volume);
                      preview(k.kind);
                    }}
                    className="px-1 text-[11px] text-ink-500 opacity-0 transition-opacity group-hover:opacity-100 hover:text-amber cursor-pointer"
                    title="Hear it and see its pop-up"
                  >
                    ▶
                  </button>
                  <span className="flex w-[150px] justify-center gap-1">
                    <Chip on={ch.sound} onClick={() => setKindChannel(k.kind, "sound", !ch.sound)} title="Sound">♪</Chip>
                    <Chip on={ch.toast} onClick={() => setKindChannel(k.kind, "toast", !ch.toast)} title="Pop-up in the board">▭</Chip>
                    <Chip on={ch.desktop} onClick={() => setKindChannel(k.kind, "desktop", !ch.desktop)} title="Desktop notification (when the board is in the background)">⧉</Chip>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-ink-800 pt-3 text-[11.5px]">
            <span className="flex-1 text-ink-400">
              Desktop notifications:{" "}
              <b className={desk === "on" ? "text-moss" : "text-ink-300"}>{desk === "on" ? "on" : desk === "unsupported" ? "not supported here" : "off"}</b>
              <span className="block text-[10.5px] text-ink-500">Only while the board is in a background tab.</span>
            </span>
            {desk !== "unsupported" ? (
              <button
                onClick={async () => {
                  if (desk === "on") {
                    disableNotifications();
                    setDesk("off");
                  } else setDesk((await enableNotifications()) ? "on" : "off");
                }}
                className="rounded-md border border-ink-600 px-2 py-0.5 text-ink-200 hover:border-ink-400 cursor-pointer"
              >
                {desk === "on" ? "Turn off" : "Turn on"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
