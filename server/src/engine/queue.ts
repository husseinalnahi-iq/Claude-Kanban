export interface QueueItem {
  taskId: string;
  projectId: string;
  /** "Run now": starts outside both caps, and is not counted by them. Bounded by `forcedCap`. */
  force?: boolean;
}

export interface RunQueueOptions {
  globalCap: () => number;
  projectCap: (projectId: string) => number;
  /** How many forced runs may be in flight at once, on top of the caps. */
  forcedCap?: () => number;
  /**
   * A veto consulted for every item on every pump: false leaves it waiting without consuming a slot.
   * Used to hold Claude work while a usage-limit window is open.
   */
  canStart?: (item: QueueItem) => boolean;
  /** Runs the task; the slot is held until the promise settles. */
  start: (item: QueueItem) => Promise<void>;
  onError?: (item: QueueItem, err: unknown) => void;
}

/** Per-project FIFO with a per-project concurrency cap and a global cap. */
export class RunQueue {
  private waiting: QueueItem[] = [];
  private running = new Map<string, QueueItem>();

  constructor(private opts: RunQueueOptions) {}

  enqueue(item: QueueItem): void {
    if (this.isRunning(item.taskId)) return;
    const queued = this.waiting.find((w) => w.taskId === item.taskId);
    if (queued) {
      // Already waiting: a second call can still promote it to forced, but never demote it.
      if (item.force) queued.force = true;
      this.pump();
      return;
    }
    this.waiting.push(item);
    this.pump();
  }

  cancel(taskId: string): boolean {
    const i = this.waiting.findIndex((w) => w.taskId === taskId);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    return true;
  }

  isQueued(taskId: string): boolean {
    return this.waiting.some((w) => w.taskId === taskId);
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  snapshot(): { running: string[]; waiting: string[] } {
    return { running: [...this.running.keys()], waiting: this.waiting.map((w) => w.taskId) };
  }

  private runningFor(projectId: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.projectId === projectId && !r.force) n++;
    return n;
  }

  private countRunning(forced: boolean): number {
    let n = 0;
    for (const r of this.running.values()) if (Boolean(r.force) === forced) n++;
    return n;
  }

  /** Public so the runner can retry held items when a usage-limit window reopens. */
  pump(): void {
    for (let i = 0; i < this.waiting.length; ) {
      const item = this.waiting[i];
      if (!this.fits(item) || this.opts.canStart?.(item) === false) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.running.set(item.taskId, item);
      let p: Promise<void>;
      try {
        p = this.opts.start(item);
      } catch (err) {
        p = Promise.reject(err);
      }
      p.catch((err) => this.opts.onError?.(item, err)).finally(() => {
        this.running.delete(item.taskId);
        this.pump();
      });
    }
  }

  /** A forced item answers to its own ceiling alone; an ordinary one to both caps. */
  private fits(item: QueueItem): boolean {
    if (item.force) return this.countRunning(true) < (this.opts.forcedCap?.() ?? 0);
    return this.countRunning(false) < this.opts.globalCap() && this.runningFor(item.projectId) < this.opts.projectCap(item.projectId);
  }
}
