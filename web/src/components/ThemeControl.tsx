import { setViewPrefs, THEMES, useViewPrefs } from "../lib/view.ts";

/**
 * Light or dark, or whatever the computer is set to. Sits beside the zoom control because both answer
 * the same question — how this screen should look — and both are remembered per machine.
 */
export function ThemeControl() {
  const { theme } = useViewPrefs();
  return (
    <div className="flex items-center rounded-md border border-ink-700 font-mono text-[11px]" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.value}
          onClick={() => setViewPrefs({ theme: t.value })}
          title={t.hint}
          aria-pressed={theme === t.value}
          className={`px-2 py-1 cursor-pointer transition-colors ${
            theme === t.value ? "text-amber" : "text-ink-500 hover:text-ink-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
