import { useEffect } from "react";
import { kindInfo, unseenWord, useUnseen } from "./alerts.ts";

const ORIGINAL = "/favicon.ico";

/**
 * Reads a colour token (`var(--color-rose)`) as the hex a canvas can draw with.
 *
 * The mark is drawn on a dark plate in both themes — it sits in the browser's tab strip, not in the
 * app — so a `--color-x` token is served from its `--kb-vivid-x` twin, which does not follow the
 * theme. Without that, light mode would paint its deepened hues onto near-black and the dot would
 * go muddy just when it matters: when something needs you.
 */
function resolve(color: string): string {
  const name = /var\((--[\w-]+)\)/.exec(color)?.[1];
  if (!name) return color;
  const css = getComputedStyle(document.documentElement);
  const vivid = name.startsWith("--color-") ? `--kb-vivid-${name.slice("--color-".length)}` : "";
  return (vivid && css.getPropertyValue(vivid).trim()) || css.getPropertyValue(name).trim() || "#f2a93b";
}

/** The board's mark (three bars) with a coloured dot — the colour of the most urgent thing waiting. */
function drawIcon(dot: string): string {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return ORIGINAL;
  g.fillStyle = resolve("var(--kb-badge-plate)");
  g.beginPath();
  g.roundRect(2, 6, 56, 56, 12);
  g.fill();
  const bars: [number, number, string][] = [
    [12, 1, resolve("var(--kb-badge-bar-1)")],
    [26, 0.66, resolve("var(--kb-badge-bar-2)")],
    [40, 0.36, resolve("var(--kb-badge-bar-3)")],
  ];
  for (const [x, h, col] of bars) {
    g.fillStyle = col;
    g.beginPath();
    g.roundRect(x, 54 - 38 * h, 9, 38 * h, 2);
    g.fill();
  }
  g.fillStyle = resolve("var(--kb-badge-notch)");
  g.beginPath();
  g.arc(50, 14, 14, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = dot;
  g.beginPath();
  g.arc(50, 14, 10, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL("image/png");
}

function setIcon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

/**
 * The browser tab tells you what happened while you were elsewhere: an approval waiting turns the
 * icon's dot rose and puts the count in the title; otherwise the dot takes the colour of the most
 * urgent event you missed (rust for a failure, lime for a review…), and clears when you come back.
 */
export function useTabBadge(pendingApprovals: number) {
  const unseen = useUnseen();
  useEffect(() => {
    if (pendingApprovals) {
      document.title = `(${pendingApprovals}) Claude Kanban — waiting for you`;
      setIcon(drawIcon(resolve("var(--color-rose)")));
    } else if (unseen) {
      const info = kindInfo(unseen);
      document.title = `● ${unseenWord() ?? info.label} — Claude Kanban`;
      setIcon(drawIcon(resolve(info.color)));
    } else {
      document.title = "Claude Kanban";
      setIcon(ORIGINAL);
    }
  }, [pendingApprovals, unseen]);
}
