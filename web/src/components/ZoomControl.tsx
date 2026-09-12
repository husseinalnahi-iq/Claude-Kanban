import { setViewPrefs, useViewPrefs, ZOOMS } from "../lib/view.ts";

/** Whole-UI scale. Sits in the top bar because it is the control people look for when text is small. */
export function ZoomControl() {
  const { zoom } = useViewPrefs();
  const step = (dir: -1 | 1) => {
    const i = ZOOMS.indexOf(zoom);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.indexOf(100) : i) + dir))];
    setViewPrefs({ zoom: next });
  };
  return (
    <div className="flex items-center rounded-md border border-ink-700 font-mono text-[11px]" title="Interface size (Ctrl+- / Ctrl+= also work)">
      <button className="px-1.5 py-1 text-ink-400 hover:text-ink-100 cursor-pointer disabled:opacity-30" disabled={zoom === ZOOMS[0]} onClick={() => step(-1)}>
        −
      </button>
      <button
        className="min-w-[38px] px-0.5 py-1 text-center text-ink-300 hover:text-ink-100 cursor-pointer"
        onClick={() => setViewPrefs({ zoom: 100 })}
        title="Reset to 100%"
      >
        {zoom}%
      </button>
      <button
        className="px-1.5 py-1 text-ink-400 hover:text-ink-100 cursor-pointer disabled:opacity-30"
        disabled={zoom === ZOOMS[ZOOMS.length - 1]}
        onClick={() => step(1)}
      >
        +
      </button>
    </div>
  );
}
