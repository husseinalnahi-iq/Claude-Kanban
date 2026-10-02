import { useEffect, type RefObject } from "react";

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

/**
 * Plays each `[data-reveal]` element's entrance the first time it scrolls into view, instead of all of
 * them at once when the page opens, when most are still below the fold. Elements that come into view
 * together are staggered in the order they appear.
 */
export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    // Without an observer nothing is ever hidden: the hiding rule only applies under data-revealing.
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        let n = 0;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const t = e.target as HTMLElement;
          t.style.setProperty("--kb-delay", `${Math.min(n++, 6) * 70}ms`);
          t.setAttribute("data-shown", "");
          io.unobserve(t);
        }
      },
      { root: el, rootMargin: "0px 0px -6% 0px", threshold: 0.12 },
    );
    el.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));
    // A data attribute rather than a class: React owns className and would drop one added here.
    el.setAttribute("data-revealing", "");
    return () => io.disconnect();
  }, [root]);
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
@keyframes kb-ask { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-rose) 55%, transparent) } 70%,100% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--color-rose) 0%, transparent) } }
.kb-bit { position: absolute; width: 4px; height: 7px; border-radius: 1px; animation: kb-burst .9s cubic-bezier(.15,.8,.3,1) forwards; }
@keyframes kb-burst { from { transform: translate(0,0) rotate(0); opacity: 1 } to { transform: translate(var(--dx), var(--dy)) rotate(var(--r)); opacity: 0 } }
.kb-card-in { animation: kb-pop-in .4s cubic-bezier(.34,1.56,.64,1) both; }
.kb-say { animation: kb-up .4s cubic-bezier(.16,1,.3,1) both; }
.kb-scene-bar { transform-origin: left; animation: kb-scene var(--kb-dur) linear both; }
@keyframes kb-scene { from { transform: scaleX(0) } }
.kb-type::after { content: "▍"; margin-left: 1px; animation: kb-blink 1s steps(1) infinite; color: var(--color-amber); }
@keyframes kb-blink { 50% { opacity: 0 } }

/* Scroll reveal (useReveal). "backwards", not "both": a held end state would pin transform and fight the hover lift. */
[data-revealing] [data-reveal]:not([data-shown]) { opacity: 0; }
[data-revealing] [data-reveal][data-shown] { animation: kb-reveal .7s cubic-bezier(.16,1,.3,1) var(--kb-delay, 0s) backwards; }
[data-revealing] [data-shown] .kb-bar { transform-origin: left; animation: kb-bar 1s cubic-bezier(.16,1,.3,1) calc(var(--kb-delay, 0s) + .2s) backwards; }
[data-revealing] [data-shown] .kb-icon { animation: kb-pop-in .5s cubic-bezier(.34,1.56,.64,1) calc(var(--kb-delay, 0s) + .15s) backwards; }
@keyframes kb-reveal { from { opacity: 0; transform: translateY(16px); filter: blur(3px) } }
@keyframes kb-bar { from { transform: scaleX(0) } }

.kb-feature { transition: transform .25s cubic-bezier(.16,1,.3,1), border-color .25s, background-color .25s; }
.kb-feature:hover { transform: translateY(-2px); }
/* every card's icon gives a nod when you point at it; on the glyph, so the box's reveal pop is not restarted */
.kb-feature:hover .kb-glyph { animation: kb-nod .55s cubic-bezier(.34,1.56,.64,1); }
@keyframes kb-nod { 40% { transform: rotate(-12deg) scale(1.18) } 70% { transform: rotate(6deg) } }

@media (prefers-reduced-motion: reduce) {
  .kb-scrim, .kb-welcome, .kb-stagger > *, .kb-bubble, .kb-laugh, .kb-ask, .kb-bit, .kb-type::after, .kb-card-in, .kb-say, .kb-scene-bar { animation: none !important; }
  .kb-dodge, .kb-card, .kb-feature { transition: none !important; }
  .kb-feature:hover .kb-glyph { animation: none !important; }
  [data-revealing] [data-reveal], [data-revealing] [data-shown] .kb-bar, [data-revealing] [data-shown] .kb-icon { opacity: 1 !important; animation: none !important; }
}
`;

export const TourStyles = () => <style>{CSS}</style>;
