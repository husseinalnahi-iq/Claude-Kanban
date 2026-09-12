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
}

export const ZOOMS = [85, 100, 115, 125, 150];
export const COLUMN_SIZES: { label: string; value: number | "fill" }[] = [
  { label: "fill", value: "fill" },
  { label: "S", value: 240 },
  { label: "M", value: 272 },
  { label: "L", value: 320 },
  { label: "XL", value: 380 },
];

const KEY = "kanban.view";
const DEFAULTS: ViewPrefs = { zoom: 100, columns: "fill" };

function read(): ViewPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<ViewPrefs>;
    return {
      zoom: ZOOMS.includes(Number(v.zoom)) ? Number(v.zoom) : DEFAULTS.zoom,
      columns: v.columns === "fill" || typeof v.columns === "number" ? v.columns : DEFAULTS.columns,
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
