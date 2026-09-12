import { useEffect } from "react";

export const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** One display face for the welcome and the tour only, loaded when they first open. */
export function useDisplayFont() {
  useEffect(() => {
    const id = "kb-display-font";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap";
    document.head.appendChild(link);
  }, []);
}

// Kept beside the components that use it, like the toasts' styles.
const CSS = `
.kb-display { font-family: "Instrument Serif", Georgia, "Times New Roman", serif; font-weight: 400; letter-spacing: -0.01em; }
.kb-scrim { animation: kb-fade .35s ease both; }
.kb-welcome { animation: kb-drop .55s cubic-bezier(.16,1,.3,1) both; }
.kb-stagger > * { animation: kb-up .5s cubic-bezier(.16,1,.3,1) both; }
.kb-stagger > *:nth-child(1) { animation-delay: .18s } .kb-stagger > *:nth-child(2) { animation-delay: .24s }
.kb-stagger > *:nth-child(3) { animation-delay: .30s } .kb-stagger > *:nth-child(4) { animation-delay: .36s }
.kb-stagger > *:nth-child(5) { animation-delay: .42s } .kb-stagger > *:nth-child(6) { animation-delay: .48s }
.kb-stagger > *:nth-child(n+7) { animation-delay: .54s }
@keyframes kb-fade { from { opacity: 0 } }
@keyframes kb-drop { from { opacity: 0; transform: translateY(18px) scale(.975) } }
@keyframes kb-up { from { opacity: 0; transform: translateY(10px) } }

.kb-dodge { transition: transform .42s cubic-bezier(.34,1.56,.64,1), background-color .2s, color .2s, border-color .2s; }
.kb-bubble { animation: kb-pop-in .3s cubic-bezier(.34,1.56,.64,1) both; }
@keyframes kb-pop-in { from { opacity: 0; transform: translateY(-4px) scale(.8) } }
.kb-laugh { display: inline-block; animation: kb-laugh .5s ease-in-out 3; transform-origin: 50% 80%; }
@keyframes kb-laugh { 0%,100% { transform: rotate(0) } 25% { transform: rotate(-14deg) scale(1.15) } 75% { transform: rotate(14deg) scale(1.15) } }

.kb-card { transition: left .75s cubic-bezier(.65,0,.35,1), border-color .4s, box-shadow .4s; }
.kb-lane-on { transition: background-color .4s, color .4s; }
.kb-ask { animation: kb-ask 1.1s ease-out infinite; }
@keyframes kb-ask { 0% { box-shadow: 0 0 0 0 rgb(240 86 122 / .55) } 70%,100% { box-shadow: 0 0 0 9px rgb(240 86 122 / 0) } }
.kb-bit { position: absolute; width: 4px; height: 7px; border-radius: 1px; animation: kb-burst .9s cubic-bezier(.15,.8,.3,1) forwards; }
@keyframes kb-burst { from { transform: translate(0,0) rotate(0); opacity: 1 } to { transform: translate(var(--dx), var(--dy)) rotate(var(--r)); opacity: 0 } }
.kb-type::after { content: "▍"; margin-left: 1px; animation: kb-blink 1s steps(1) infinite; color: var(--color-amber); }
@keyframes kb-blink { 50% { opacity: 0 } }

.kb-feature { transition: transform .25s cubic-bezier(.16,1,.3,1), border-color .25s, background-color .25s; }
.kb-feature:hover { transform: translateY(-2px); }

@media (prefers-reduced-motion: reduce) {
  .kb-scrim, .kb-welcome, .kb-stagger > *, .kb-bubble, .kb-laugh, .kb-ask, .kb-bit, .kb-type::after { animation: none !important; }
  .kb-dodge, .kb-card, .kb-feature { transition: none !important; }
}
`;

export const TourStyles = () => <style>{CSS}</style>;
