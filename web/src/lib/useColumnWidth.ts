import { useState } from "react";

/**
 * A column's width, dragged by its edge and remembered on this computer (localStorage, like the
 * terminal's height), never narrower than `min` nor wider than `max`. `grow` says which way the
 * pointer moves to widen it: +1 for a column on the left (drag right), −1 for one on the right.
 */
export function useColumnWidth(key: string, fallback: number, min: number, max: number) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const [width, setWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return n ? clamp(n) : fallback;
    } catch {
      return fallback;
    }
  });

  const drag = (e: React.PointerEvent, grow: 1 | -1) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    // The whole page drags, not just the handle: without this the text under the pointer gets selected.
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (m: PointerEvent) => setWidth(clamp(startW + grow * (m.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      setWidth((w) => {
        try {
          localStorage.setItem(key, String(w));
        } catch {
          // per-computer nicety only
        }
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const reset = () => {
    setWidth(fallback);
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing was saved
    }
  };

  return { width, drag, reset };
}
