/**
 * Work in flight that is not a queued task: a side-chat reply, a spec rewrite, a Setup install, an open
 * terminal. Each lives in its own service, and each route file is handed only its own service, so they
 * report here and anything that must know "is the board in the middle of something?" asks in one place:
 * the launcher before it restarts an older server, and a project before it is deleted.
 *
 * Keyed by the board's runner, which every route file can reach, so two boards in one process (tests)
 * never see each other's work.
 */
export interface BusyItem {
  what: "chat" | "spec" | "setup" | "terminal";
  project_id?: string;
  task_id?: string;
}

type Source = () => BusyItem[];

const sources = new WeakMap<object, Map<string, Source>>();

export function reportBusy(board: object, name: string, source: Source): void {
  const mine = sources.get(board) ?? new Map<string, Source>();
  mine.set(name, source);
  sources.set(board, mine);
}

export function busyItems(board: object): BusyItem[] {
  return [...(sources.get(board)?.values() ?? [])].flatMap((source) => {
    try {
      return source();
    } catch {
      // One service failing to answer must not hide what the others are doing.
      return [];
    }
  });
}
