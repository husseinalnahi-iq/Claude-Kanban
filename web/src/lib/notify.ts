const KEY = "kanban.notify";

/**
 * Desktop notifications for the two things worth interrupting you for: a run that needs an approval,
 * and a task that has finished. Off until you turn it on, because a board that asks for permission
 * to notify on first load is the kind of thing people close.
 */
export const notifyEnabled = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "on" && "Notification" in window && Notification.permission === "granted";
  } catch {
    return false;
  }
};

export async function enableNotifications(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  const granted = Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
  try {
    localStorage.setItem(KEY, granted ? "on" : "off");
  } catch {
    // A browser with storage blocked still gets notifications for this session.
  }
  return granted;
}

export function disableNotifications() {
  try {
    localStorage.setItem(KEY, "off");
  } catch {
    // nothing to do
  }
}

/** True when the user asked for notifications and the browser agreed. */
export const notifyState = (): "on" | "off" | "unsupported" =>
  !("Notification" in window) ? "unsupported" : notifyEnabled() ? "on" : "off";

/** When each tag last notified: a repeat of the same thing is held back, a different thing is not. */
const lastAt = new Map<string, number>();

/**
 * A desktop notification — only while the board is in a background tab (in front of you, the
 * in-board pop-up is enough). Which events get one is chosen per kind in the bell panel.
 *
 * Throttled per tag, not across the board: one global throttle let a "ready for review" swallow
 * the approval that arrived a second later (D282). `sticky` keeps it on screen until dealt with;
 * the caller closes it when the thing is handled on the board.
 */
export function desktopNotify(title: string, body: string, tag: string, opts: { sticky?: boolean; onClick?: () => void } = {}): Notification | null {
  if (!notifyEnabled() || document.visibilityState === "visible") return null;
  if (Date.now() - (lastAt.get(tag) ?? 0) < 1500) return null;
  lastAt.set(tag, Date.now());
  try {
    const n = new Notification(title, { body, tag, requireInteraction: !!opts.sticky });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
    return n;
  } catch {
    // Notification can throw on some platforms; never let it break the board.
    return null;
  }
}
