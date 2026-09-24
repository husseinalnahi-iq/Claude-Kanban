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
  /** Dark, light, or whatever this computer is set to. */
  theme: Theme;
}

export type Theme = "system" | "light" | "dark";

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
];

export const KEY = "kanban.view";
const DEFAULTS: ViewPrefs = { zoom: 100, columns: "fill", theme: "system" };

function read(): ViewPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      zoom: ZOOMS.includes(Number(v.zoom)) ? Number(v.zoom) : DEFAULTS.zoom,
      columns: v.columns === "fill" || typeof v.columns === "number" ? v.columns : DEFAULTS.columns,
      theme: v.theme === "light" || v.theme === "dark" || v.theme === "system" ? v.theme : DEFAULTS.theme,
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
 * Paints the chosen theme onto <html>, and keeps following the computer while the choice is "system".
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
