import { FONTS, setViewPrefs, useViewPrefs, type UiFont } from "../lib/view.ts";
import { RICH_SELECT } from "./ui.tsx";

/**
 * The text face, beside the theme switch: both say how this screen should look and are kept per
 * machine. The box is an "Aa" the width of a theme icon, because the top bar has no room for a name
 * (D261): a real <select> sits invisibly on top of it, so the keyboard, a screen reader and the open
 * list all work as in any drop-down. In that list each name is drawn in its own face where the
 * browser allows it, so it doubles as a preview.
 */
export function FontControl() {
  const { font } = useViewPrefs();
  const current = FONTS.find((f) => f.value === font) ?? FONTS[0];
  return (
    <span
      className="kb-select group relative flex h-[26px] w-8 shrink-0 items-center justify-center rounded-md border border-ink-700 text-[12.5px] font-medium text-ink-400 transition-colors focus-within:border-amber/60 hover:border-ink-500 hover:text-ink-200"
      title={`Font: ${current.label}. ${current.hint}.`}
    >
      <span aria-hidden>Aa</span>
      {/* Opacity, not transparent text: the operating system's own list (Firefox, Safari) would take a transparent colour too. */}
      <select
        aria-label="Font"
        value={font}
        onChange={(e) => setViewPrefs({ font: e.target.value as UiFont })}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {FONTS.map((f) => (
          <option key={f.value} value={f.value} style={{ fontFamily: f.stack }} data-note={RICH_SELECT ? f.maker : undefined}>
            {RICH_SELECT ? f.short : f.label}
          </option>
        ))}
      </select>
    </span>
  );
}
