import { useEffect } from "react";
import { kindInfo, useUnseen } from "./alerts.ts";

const ORIGINAL = "/favicon.ico";

/** Reads a colour token (`var(--color-rose)`) as the hex a canvas can draw with. */
function resolve(color: string): string {
  const name = /var\((--[\w-]+)\)/.exec(color)?.[1];
  return name ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#f2a93b" : color;
}

/** The board's mark (three bars) with a coloured dot — the colour of the most urgent thing waiting. */
function drawIcon(dot: string): string {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return ORIGINAL;
  g.fillStyle = "#1d1e1a";
  g.beginPath();
  g.roundRect(2, 6, 56, 56, 12);
  g.fill();
  const bars: [number, number, string][] = [[12, 1, "#f2a93b"], [26, 0.66, "#d4d1c6"], [40, 0.36, "#57574e"]];
  for (const [x, h, col] of bars) {
    g.fillStyle = col;
    g.beginPath();
    g.roundRect(x, 54 - 38 * h, 9, 38 * h, 2);
    g.fill();
  }
  g.fillStyle = "#0c0d0b";
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
      document.title = `(${pendingApprovals}) Claude Kanban — approval waiting`;
      setIcon(drawIcon(resolve("var(--color-rose)")));
    } else if (unseen) {
      const info = kindInfo(unseen);
      document.title = `● ${info.label} — Claude Kanban`;
      setIcon(drawIcon(resolve(info.color)));
    } else {
      document.title = "Claude Kanban";
      setIcon(ORIGINAL);
    }
  }, [pendingApprovals, unseen]);
}
