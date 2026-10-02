import { useEffect, useState } from "react";

/**
 * How the board is displayed. Per-machine, not per-board: it describes this screen, so it lives in
 * localStorage rather than the database (a second PC has a different monitor).
 */
export interface ViewPrefs {
  /** Whole-UI scale in percent. */
  zoom: number;
  /** Column width in pixels, or "fill" to share the window evenly with no dead space on the right. */
  columns: number | "fill";
  /** Dark, light, navy, or whatever this computer is set to. */
  theme: Theme;
  /** The typeface for the board's text, whatever the theme. Code keeps its monospace face. */
  font: UiFont;
}

export type Theme = "system" | "light" | "dark" | "navy";
const THEME_VALUES: readonly Theme[] = ["system", "light", "dark", "navy"];

export type UiFont = "apple" | "inter" | "segoe" | "roboto" | "plex";

/**
 * The text faces on offer. `stack` is what the font picker draws each name in; index.css carries the
 * same stacks under `data-font`, which is what actually paints the board. SF Pro and Segoe UI cannot
 * be downloaded onto a page (Apple's licence allows SF Pro only for mock-ups, D304), so they show only
 * where the computer has them built in, and each falls back to the other system's own face.
 */
export const FONTS: { label: string; short: string; maker: string; value: UiFont; stack: string; hint: string }[] = [
  {
    label: "SF Pro (Apple)",
    short: "SF Pro",
    maker: "Apple · default",
    value: "apple",
    stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Segoe UI", system-ui, sans-serif',
    hint: "Apple's own font on a Mac, iPhone or iPad. Windows has no SF Pro, so it shows Segoe UI there",
  },
  { label: "Inter", short: "Inter", maker: "Rasmus Andersson", value: "inter", stack: '"Inter", ui-sans-serif, system-ui, sans-serif', hint: "Made for screens; on every computer" },
  {
    label: "Segoe UI (Microsoft)",
    short: "Segoe UI",
    maker: "Microsoft",
    value: "segoe",
    stack: '"Segoe UI", system-ui, sans-serif',
    hint: "Windows' own font. A Mac has no Segoe UI, so it shows SF Pro there",
  },
  { label: "Roboto (Google)", short: "Roboto", maker: "Google", value: "roboto", stack: '"Roboto", ui-sans-serif, system-ui, sans-serif', hint: "Android's font; on every computer" },
  { label: "IBM Plex Sans", short: "IBM Plex", maker: "IBM", value: "plex", stack: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', hint: "The board's earlier font; on every computer" },
];
const FONT_VALUES: readonly UiFont[] = FONTS.map((f) => f.value);

export const ZOOMS = [85, 100, 115, 125, 150];
export const COLUMN_SIZES: { label: string; value: number | "fill" }[] = [
  { label: "fill", value: "fill" },
  { label: "S", value: 240 },
  { label: "M", value: 272 },
  { label: "L", value: 320 },
  { label: "XL", value: 380 },
];
export const THEMES: { label: string; value: Theme; hint: string }[] = [
  { label: "Auto", value: "system", hint: "Follows this computer's light/dark setting" },
  { label: "Light", value: "light", hint: "Always light" },
  { label: "Dark", value: "dark", hint: "Always dark" },
  { label: "Navy", value: "navy", hint: "Deep blue, with JetBrains Mono for code" },
];

export const KEY = "kanban.view";
const DEFAULTS: ViewPrefs = { zoom: 100, columns: "fill", theme: "system", font: "apple" };

function read(): ViewPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      zoom: ZOOMS.includes(Number(v.zoom)) ? Number(v.zoom) : DEFAULTS.zoom,
      columns: v.columns === "fill" || typeof v.columns === "number" ? v.columns : DEFAULTS.columns,
      theme: THEME_VALUES.includes(v.theme as Theme) ? (v.theme as Theme) : DEFAULTS.theme,
      font: FONT_VALUES.includes(v.font as UiFont) ? (v.font as UiFont) : DEFAULTS.font,
    };
  } catch {
    return DEFAULTS;
  }
}

// One source of truth shared by every hook instance, so the header control and the board agree.
let current = read();
const listeners = new Set<(v: ViewPrefs) => void>();

export function setViewPrefs(patch: Partial<ViewPrefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // a private window without storage still gets the change for this session
  }
  for (const l of listeners) l(current);
}

/** The current values outside React (keyboard handlers). */
export const getViewPrefs = (): ViewPrefs => current;

export function useViewPrefs(): ViewPrefs {
  const [v, setV] = useState(current);
  useEffect(() => {
    listeners.add(setV);
    setV(current);
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}

/**
 * Paints the chosen theme onto <html>, and keeps following the computer while the choice is "system"
 * (which only ever picks light or dark; navy is always a choice).
 * The same attribute is set by a tiny script in index.html before first paint, so this only ever
 * confirms what is already on screen — there is no flash of the wrong theme on load.
 */
export function applyTheme(theme: Theme): () => void {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const paint = () => {
    document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme;
  };
  paint();
  if (theme !== "system") return () => {};
  media.addEventListener("change", paint);
  return () => media.removeEventListener("change", paint);
}

/** Paints the chosen text face onto <html>; index.html sets it before first paint, like the theme. */
export function applyFont(font: UiFont) {
  document.documentElement.dataset.font = font;
}

/**
 * The whole-UI scale as the browser applies it (App sets `zoom` on <html>). A box measured with
 * getBoundingClientRect is in real screen pixels, but a `position: fixed` element inside the zoomed
 * page is placed in zoomed ones, so anything that puts a panel next to a measured box divides by this.
 */
export const pageZoom = (): number => (typeof document === "undefined" ? 1 : Number(document.documentElement.style.zoom) || 1);
