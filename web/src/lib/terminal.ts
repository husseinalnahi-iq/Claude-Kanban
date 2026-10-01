/**
 * Opens a terminal from anywhere (a task's "Terminal here"): the dock listens for this.
 * Kept apart from the dock itself, so asking for a terminal does not pull the terminal's code
 * into the page before anyone opens one.
 */
export function openTerminal(detail: { projectId: string; taskId?: string | null }) {
  window.dispatchEvent(new CustomEvent("kanban:terminal", { detail }));
}
