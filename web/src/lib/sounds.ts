/**
 * The board's sounds, synthesised in the browser with Web Audio — no audio files, nothing to
 * download, and every sound exists in three voices from the same notes.
 *
 * Each kind of event has its own short motif, so you can tell what happened without looking:
 * good news rises, bad news falls, "needs you" knocks, and a usage limit hums down and back up.
 */

export type SoundTheme = "chimes" | "arcade" | "soft";
export type SoundId = "approval" | "review" | "done" | "failed" | "paused" | "resumed" | "started" | "usage" | "allClear";

export const THEMES: { id: SoundTheme; label: string; hint: string }[] = [
  { id: "chimes", label: "Chimes", hint: "Glassy bells" },
  { id: "arcade", label: "Arcade", hint: "8-bit blips" },
  { id: "soft", label: "Soft", hint: "Muted marimba" },
];

/** f: frequency (Hz) · at: start (s) · dur: length (s) · to: glide target (Hz) · g: loudness 0–1. */
type Note = { f: number; at: number; dur: number; to?: number; g?: number };

const C4 = 261.63, E4 = 329.63, G4 = 392, A4 = 440, B4 = 493.88;
const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, B5 = 987.77;
const C6 = 1046.5, E6 = 1318.51, G6 = 1567.98, C7 = 2093;

const MOTIFS: Record<SoundId, Note[]> = {
  // knock, knock… ping — the one that asks for you
  approval: [{ f: E5, at: 0, dur: 0.07 }, { f: E5, at: 0.13, dur: 0.07 }, { f: B5, at: 0.3, dur: 0.42 }],
  // a rising major triad: something is ready for you to look at
  review: [{ f: C5, at: 0, dur: 0.16 }, { f: E5, at: 0.11, dur: 0.16 }, { f: G5, at: 0.22, dur: 0.55 }],
  // a quick sparkle up to the top: landed
  done: [
    { f: C6, at: 0, dur: 0.12, g: 0.55 }, { f: E6, at: 0.07, dur: 0.12, g: 0.55 },
    { f: G6, at: 0.14, dur: 0.14, g: 0.55 }, { f: C7, at: 0.21, dur: 0.7, g: 0.5 },
  ],
  // two notes falling, the second sagging: it went wrong
  failed: [{ f: E4, at: 0, dur: 0.2 }, { f: C4, at: 0.19, dur: 0.5, to: 0.94 * C4 }],
  // a long slide down: stopped by the usage limit
  paused: [{ f: A5, at: 0, dur: 0.7, to: A4, g: 0.7 }],
  // and back up again when the window reopens
  resumed: [{ f: A4, at: 0, dur: 0.38, to: A5, g: 0.7 }, { f: E6, at: 0.36, dur: 0.28, g: 0.4 }],
  // a single light tick: a task started
  started: [{ f: G5, at: 0, dur: 0.06, g: 0.45 }],
  // beep, beep, lower: usage is getting high
  usage: [{ f: D5, at: 0, dur: 0.11 }, { f: D5, at: 0.17, dur: 0.11 }, { f: A4, at: 0.36, dur: 0.32 }],
  // a small fanfare: nothing running, nothing queued, nothing waiting on you
  allClear: [
    { f: G4, at: 0, dur: 0.12 }, { f: C5, at: 0.12, dur: 0.12 }, { f: E5, at: 0.24, dur: 0.12 },
    { f: G5, at: 0.36, dur: 0.75 }, { f: C6, at: 0.36, dur: 0.75, g: 0.35 }, { f: B4, at: 0.36, dur: 0.75, g: 0.2 },
  ],
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  // A gentle limiter so overlapping sounds never clip.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 6;
  master = ctx.createGain();
  master.connect(comp).connect(ctx.destination);
  return ctx;
}

/**
 * Browsers only allow sound after you have interacted with the page. The first click or key press
 * anywhere unlocks it; until then sounds are skipped silently rather than queued up.
 */
export function armSounds() {
  const unlock = () => {
    const c = audio();
    if (c && c.state === "suspended") void c.resume();
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
}

function voice(c: AudioContext, out: AudioNode, n: Note, t0: number, theme: SoundTheme) {
  const start = t0 + n.at;
  const end = start + n.dur;
  const peak = (n.g ?? 0.8) * (theme === "arcade" ? 0.32 : theme === "soft" ? 0.9 : 0.6);
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, start);
  const attack = theme === "soft" ? 0.02 : 0.004;
  env.gain.exponentialRampToValueAtTime(peak, start + attack);
  // Bells ring past their written length; arcade blips stop dead; the marimba is in between.
  const tail = theme === "chimes" ? n.dur * 2.2 : theme === "soft" ? n.dur * 1.4 : n.dur;
  env.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(tail, 0.05));

  let chain: AudioNode = env;
  if (theme === "soft") {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    env.connect(lp);
    chain = lp;
  }
  chain.connect(out);

  const osc = c.createOscillator();
  osc.type = theme === "arcade" ? "square" : theme === "soft" ? "triangle" : "sine";
  osc.frequency.setValueAtTime(n.f, start);
  if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, end);
  osc.connect(env);
  osc.start(start);
  osc.stop(start + Math.max(tail, 0.05) + 0.05);

  // What makes a bell a bell: a quieter, inharmonic partial above the note.
  if (theme === "chimes") {
    const partial = c.createOscillator();
    const pg = c.createGain();
    partial.type = "sine";
    partial.frequency.setValueAtTime(n.f * 2.76, start);
    if (n.to) partial.frequency.exponentialRampToValueAtTime(n.to * 2.76, end);
    pg.gain.value = 0.18;
    partial.connect(pg).connect(env);
    partial.start(start);
    partial.stop(start + tail + 0.05);
  }
}

/** Plays one event's motif in the chosen voice. `volume` is 0–1. Never throws. */
export function playSound(id: SoundId, theme: SoundTheme, volume: number) {
  try {
    const c = audio();
    if (!c || !master || c.state !== "running" || volume <= 0) return;
    master.gain.setValueAtTime(Math.min(1, volume), c.currentTime);
    const t0 = c.currentTime + 0.02;
    for (const n of MOTIFS[id]) voice(c, master, n, t0, theme);
  } catch {
    // A sound is a nicety; it must never break the board.
  }
}

/** Sounds for the welcome's skip button, which are not board events and so have no alert settings. */
const FUN: Record<"dodge" | "giggle", Note[]> = {
  // a quick upward swish: it got away
  dodge: [{ f: G4, at: 0, dur: 0.16, to: G6, g: 0.45 }],
  // ha-ha-ha, each one a little lower: it gave up
  giggle: [
    { f: A5, at: 0, dur: 0.07, to: E5, g: 0.5 }, { f: G5, at: 0.11, dur: 0.07, to: D5, g: 0.5 },
    { f: E5, at: 0.22, dur: 0.07, to: B4, g: 0.5 }, { f: C6, at: 0.36, dur: 0.22, g: 0.35 },
  ],
};

export function playFun(id: keyof typeof FUN, theme: SoundTheme, volume: number) {
  try {
    const c = audio();
    if (!c || !master || c.state !== "running" || volume <= 0) return;
    master.gain.setValueAtTime(Math.min(1, volume), c.currentTime);
    for (const n of FUN[id]) voice(c, master, n, c.currentTime + 0.01, theme);
  } catch {
    // a nicety, never an error
  }
}

/** For the settings page: whether the browser has let the board make sound yet. */
export const soundsUnlocked = () => ctx?.state === "running";
