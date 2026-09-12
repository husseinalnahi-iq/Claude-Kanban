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

let lastAt = 0;

/**
 * A desktop notification — only while the board is in a background tab (in front of you, the
 * in-board pop-up is enough). Which events get one is chosen per kind in the bell panel.
 */
export function desktopNotify(title: string, body: string, tag: string) {
  if (!notifyEnabled() || document.visibilityState === "visible") return;
  // Two runs finishing in the same second should not produce two pop-ups.
  if (Date.now() - lastAt < 1500) return;
  lastAt = Date.now();
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Notification can throw on some platforms; never let it break the board.
  }
}
