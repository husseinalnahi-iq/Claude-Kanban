import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { useAlertPrefs } from "../../lib/alerts.ts";
import { playFun } from "../../lib/sounds.ts";

/** Where it hides on each attempt: first to the left, then straight back home. */
const HIDING = [-172, 0];
const TAUNTS = ["Nope 🙃", "Too slow! 😝"];

/**
 * The welcome's Skip button, which does not want to be clicked. A mouse that comes near it sends it
 * sliding away, twice; after that it gives up, laughs, and closes like any button. Keyboard users
 * are never teased: Enter, Space and Esc close at once.
 */
export function DodgeButton({ onClose }: { onClose: () => void }) {
  const [tries, setTries] = useState(0);
  // Refs, not state: the hover and the click of one quick approach arrive before React re-renders,
  // and must count as one escape, not two.
  const count = useRef(0);
  const lastMove = useRef(0);
  const prefs = useAlertPrefs();
  const tired = tries >= HIDING.length;
  const x = tries === 0 ? 0 : HIDING[Math.min(tries, HIDING.length) - 1]!;
  const fun = (id: "dodge" | "giggle") => !prefs.muted && playFun(id, prefs.theme, prefs.volume * 0.8);
  const justMoved = (ms: number) => Date.now() - lastMove.current < ms;

  const dodge = () => {
    if (count.current >= HIDING.length || justMoved(350)) return;
    count.current += 1;
    lastMove.current = Date.now();
    fun("dodge");
    setTries(count.current);
  };

  const onPointerEnter = (e: PointerEvent) => e.pointerType === "mouse" && dodge();
  // A finger never hovers, so on touch it slips away from the tap itself.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && count.current < HIDING.length) {
      e.preventDefault();
      dodge();
    }
  };
  const onClick = (e: MouseEvent) => {
    // detail is 0 for a click made with the keyboard: close at once, no teasing.
    if (e.detail === 0) return onClose();
    if (count.current < HIDING.length) return dodge();
    // The click that made it give up is not also the click that closes it: read the note first.
    if (justMoved(600)) return;
    fun("giggle");
    onClose();
  };

  return (
    <div className="kb-dodge relative" style={{ transform: `translateX(${x}px)` }}>
      <div>
        <button
          type="button"
          aria-label="Skip the welcome"
          onPointerEnter={onPointerEnter}
          onPointerDown={onPointerDown}
          onClick={onClick}
          className={`flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[12.5px] font-medium whitespace-nowrap cursor-pointer ${
            tired ? "border-lime/60 bg-lime/15 text-lime hover:bg-lime/25" : "border-ink-600 bg-ink-850 text-ink-300 hover:text-ink-100"
          }`}
        >
          {tired ? (
            <>
              <span className="kb-laugh text-[16px] leading-none">😂</span> Okay, you win
            </>
          ) : (
            <>Skip ✕</>
          )}
        </button>
      </div>
      {tries > 0 ? (
        <div
          key={tries}
          className="kb-bubble absolute right-0 top-[calc(100%+8px)] z-10 w-max max-w-[250px] rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-[12px] leading-snug text-ink-200 shadow-xl shadow-black/60"
        >
          <span className="absolute -top-[5px] right-5 h-2.5 w-2.5 rotate-45 border-t border-l border-ink-600 bg-ink-950" />
          {tired ? (
            <>
              <b className="text-ink-100">Persistent!</b> You'd make a great review stage — you never give up. Click me, I'm done running. 🏳️
            </>
          ) : (
            TAUNTS[tries - 1]
          )}
        </div>
      ) : null}
    </div>
  );
}
