import { setViewPrefs, THEMES, useViewPrefs, type Theme } from "../lib/view.ts";

/**
 * Light, dark or navy, or whatever the computer is set to. Sits beside the zoom control because both answer
 * the same question — how this screen should look — and both are remembered per machine.
 */
const ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾", navy: "◈" };

export function ThemeControl() {
  const { theme } = useViewPrefs();
  return (
    // Icons only: three words here pushed the whole bar past the edge of a 1440px window. The words
    // are in Settings → Appearance, and each icon says its name on hover and to a screen reader.
    <div className="flex items-center rounded-md border border-ink-700 text-[12px]" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.value}
          onClick={() => setViewPrefs({ theme: t.value })}
          title={`${t.label}: ${t.hint.charAt(0).toLowerCase()}${t.hint.slice(1)}`}
          aria-label={t.label}
          aria-pressed={theme === t.value}
          className={`w-7 py-1 text-center cursor-pointer transition-colors ${
            theme === t.value ? "text-amber" : "text-ink-500 hover:text-ink-200"
          }`}
        >
          {ICON[t.value]}
        </button>
      ))}
    </div>
  );
}
