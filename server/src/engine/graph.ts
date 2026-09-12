/**
 * The dependency graph: pure functions shared by the server (which enforces them) and the web UI
 * (which draws them). A task's `depends_on` is a one-directional edge — "this cannot start until
 * that is done" — so the whole set is a DAG. Cycles are refused rather than broken, because a
 * cycle has no valid run order and would silently deadlock the queue.
 */

export interface GraphTask {
  id: string;
  depends_on: string[];
}

/** Walk a task's dependencies transitively. Visits each id once, so a pre-existing cycle terminates. */
function ancestors(start: string[], depsOf: (id: string) => string[] | null): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of depsOf(id) ?? []) stack.push(d);
  }
  return seen;
}

/** Would giving `taskId` these dependencies close a loop? */
export function createsCycle(taskId: string, depends_on: string[], depsOf: (id: string) => string[] | null): boolean {
  return ancestors(depends_on, (id) => (id === taskId ? [] : depsOf(id))).has(taskId) || depends_on.includes(taskId);
}

export interface DepCandidate {
  id: string;
  project_id: string;
  depends_on: string[];
}

/**
 * Why a proposed `depends_on` cannot be accepted, or null when it can.
 * The message is shown to the user verbatim, so it names the offending task.
 */
export function dependencyError(
  taskId: string,
  projectId: string,
  depends_on: string[],
  lookup: (id: string) => DepCandidate | null,
  titleOf: (id: string) => string = (id) => id,
): string | null {
  if (new Set(depends_on).size !== depends_on.length) return "The same task is listed twice as a dependency.";
  for (const id of depends_on) {
    if (id === taskId) return "A task cannot wait for itself.";
    const dep = lookup(id);
    if (!dep) return `No task ${id} to depend on.`;
    if (dep.project_id !== projectId) return `“${titleOf(id)}” is in another project; dependencies stay inside one project.`;
  }
  if (createsCycle(taskId, depends_on, (id) => lookup(id)?.depends_on ?? null)) {
    return `That would create a loop: “${titleOf(taskId)}” already comes before one of those tasks. Dependencies only point one way.`;
  }
  return null;
}

export interface PlacedNode<T> {
  task: T;
  /** 0 = nothing to wait for. Every node sits one column right of its latest dependency. */
  col: number;
  row: number;
}

export interface Edge {
  from: string;
  to: string;
}

/**
 * Longest-path layering: a node's column is one past its deepest dependency, so every arrow points
 * right and a column is a set of tasks that may run at the same time. Edges to tasks outside the
 * given set are ignored — a subtask graph shows only its own siblings.
 */
export function layout<T extends GraphTask>(tasks: T[]): { nodes: PlacedNode<T>[]; edges: Edge[]; columns: number } {
  const present = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const colOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // defensive: a cycle in stored data must not hang the UI
    visiting.add(id);
    const deps = (present.get(id)?.depends_on ?? []).filter((d) => present.has(d));
    const col = deps.length ? Math.max(...deps.map(colOf)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, col);
    return col;
  };

  const rows = new Map<number, number>();
  const nodes = tasks.map((task) => {
    const col = colOf(task.id);
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return { task, col, row };
  });
  const edges: Edge[] = [];
  for (const t of tasks) for (const d of t.depends_on) if (present.has(d)) edges.push({ from: d, to: t.id });
  return { nodes, edges, columns: Math.max(0, ...nodes.map((n) => n.col + 1)) };
}
