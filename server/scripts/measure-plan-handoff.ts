// Would a code stage that continued its plan stage's session save money? (D408: no — measured 2026-10-06)
// Each stage starts a session of its own, and the plan reaches the coder as text, so the coder may read
// again what the planner read. This measures it from your board's database, read-only: no lock, no
// migration, no model call, nothing written.
//
// For every task whose plan stage was followed by a code stage, it reports:
// - what the coder read again that the planner had read, and how big that was;
// - what the coder spent before its first edit (the most continuing could save);
// - an estimate of what carrying the plan's whole context through the code stage would add instead:
//   one hour-cache write of the plan's context (the tool list changes, so the cache cannot be reused)
//   plus a cache read of it on every code turn.
// Dollars come from each run's own cost per weighted token (explore.ts WEIGHT), so any model prices right.
//
// Run (from server/): node --disable-warning=ExperimentalWarning --import tsx scripts/measure-plan-handoff.ts [--db <kanban.db>] [--since 2026-09-01] [--json]
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { DB_PATH } from "../src/config.ts";
import { EDIT_TOOLS, WEIGHT, usageWeight } from "../src/engine/explore.ts";
import { normPath, restore } from "./measure-chat-handoff.ts";

type Row = Record<string, unknown>;
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

export interface PairMeasure {
  task_id: string;
  title: string;
  plan_model: string;
  code_model: string;
  same_model: boolean;
  plan_reads: number;
  code_reads: number;
  /** Code-stage reads of a file the plan stage had already read. */
  reread: number;
  reread_tokens: number;
  code_searches: number;
  /** Code-stage searches the plan stage had already run, word for word. */
  research: number;
  code_turns: number;
  code_usd: number;
  /** What the code stage spent before its first edit. */
  code_reading_usd: number;
  /** The plan stage's context at its last turn, in tokens: what the coder would carry if it continued. */
  plan_context_tokens: number;
  /** The code stage's own context at its first turn: what it carries anyway (instructions, tools, project files). */
  code_start_tokens: number;
  /**
   * Estimated: what continuing would add — the plan's context beyond the code stage's own start, written to
   * the hour cache once (the tool list changes, so the old cache cannot be reused) and read on every code turn.
   */
  carry_usd: number;
  /** Estimated: what the re-reads cost — each written to the cache once, then read on about half the turns after it. */
  reread_usd: number;
  cut_turns: number;
}

interface Stage {
  reads: Set<string>;
  readCount: number;
  searches: Set<string>;
  searchCount: number;
  resultSize: Map<string, number>;
  readIds: Map<string, string>;
  turns: number;
  total: number;
  beforeEdit: number;
  lastContext: number;
  firstContext: number;
  cut: number;
}

function readStage(events: Row[], roots: string[]): Stage {
  const s: Stage = { reads: new Set(), readCount: 0, searches: new Set(), searchCount: 0, resultSize: new Map(), readIds: new Map(), turns: 0, total: 0, beforeEdit: 0, lastContext: 0, firstContext: 0, cut: 0 };
  const seen = new Set<string>();
  let edited = false;
  for (const ev of events) {
    const msg = ev.message as Row | undefined;
    const blocks = (Array.isArray(msg?.content) ? msg!.content : []) as Row[];
    if (ev.type === "user") {
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue;
        const size = typeof b.size === "number" ? b.size : typeof b.content === "string" ? b.content.length : JSON.stringify(b.content ?? "").length;
        s.resultSize.set(String(b.tool_use_id), size);
      }
      continue;
    }
    if (ev.cut) s.cut++;
    if (blocks.some((b) => b?.type === "tool_use" && EDIT_TOOLS.has(String(b.name)))) edited = true;
    const id = String(msg?.id ?? "");
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      const u = msg?.usage as Row | undefined;
      const w = usageWeight(u);
      if (u) {
        s.turns++;
        const n = (k: string) => Number(u[k] ?? 0) || 0;
        s.lastContext = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if (s.turns === 1) s.firstContext = s.lastContext;
      }
      s.total += w;
      if (!edited) s.beforeEdit += w;
    }
    for (const b of blocks) {
      if (b?.type !== "tool_use") continue;
      const input = (b.input ?? {}) as Row;
      if (b.name === "Read" && typeof input.file_path === "string") {
        const file = normPath(input.file_path, roots);
        s.readCount++;
        s.reads.add(file);
        s.readIds.set(String(b.id), file);
      } else if (SEARCH_TOOLS.has(String(b.name)) && typeof input.pattern === "string") {
        s.searchCount++;
        s.searches.add(input.pattern);
      }
    }
  }
  return s;
}

export function measurePlanHandoff(db: DatabaseSync, opts: { since?: string } = {}): PairMeasure[] {
  const tasks = db.prepare(
    `SELECT t.id, t.title, t.worktree_path, p.path AS project_path FROM tasks t JOIN projects p ON p.id = t.project_id
     ${opts.since ? "WHERE t.created_at >= ?" : ""} ORDER BY t.created_at`,
  ).all(...(opts.since ? [opts.since] : [])) as Row[];
  const runsOf = db.prepare("SELECT id, stage, role, model, status, cost_usd FROM runs WHERE task_id = ? ORDER BY started_at, stage_index");
  const eventsOf = db.prepare("SELECT type, payload_json FROM events WHERE run_id = ? AND type IN ('assistant', 'user') ORDER BY id");
  const load = (runId: unknown) => (eventsOf.all(String(runId)) as Row[]).map((e) => restore(String(e.type), JSON.parse(String(e.payload_json)) as Row));

  const out: PairMeasure[] = [];
  for (const t of tasks) {
    const roots = [t.worktree_path, t.project_path].filter((r): r is string => typeof r === "string" && r.length > 0);
    const runs = (runsOf.all(String(t.id)) as Row[]).filter((r) => r.role !== "critic");
    for (let i = 0; i < runs.length; i++) {
      if (runs[i]!.stage !== "plan" || runs[i]!.status !== "success") continue;
      // Every code run after this plan and before the next one: a crash, a retry or a turn-limit continue
      // splits one code stage over several runs, and the one that did the work is often not the first.
      const after = runs.slice(i + 1);
      const end = after.findIndex((r) => r.stage === "plan");
      const codeRuns = (end < 0 ? after : after.slice(0, end)).filter((r) => r.stage === "code");
      if (!codeRuns.length) continue;
      const code = codeRuns[0]!;
      const planEv = load(runs[i]!.id);
      const codeEv = codeRuns.flatMap((r) => load(r.id));
      if (!planEv.length || !codeEv.length) continue;
      const plan = readStage(planEv, roots);
      const c = readStage(codeEv, roots);
      let reread = 0;
      let rereadChars = 0;
      for (const [id, file] of c.readIds) {
        if (!plan.reads.has(file)) continue;
        reread++;
        rereadChars += c.resultSize.get(id) ?? 0;
      }
      const codeUsd = codeRuns.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
      const usdPerWeight = c.total > 0 ? codeUsd / c.total : 0;
      const extra = Math.max(0, plan.lastContext - c.firstContext);
      const carryWeight = extra * WEIGHT.write1h + extra * WEIGHT.read * c.turns;
      const rereadTokens = rereadChars / 4;
      const rereadWeight = rereadTokens * WEIGHT.write1h + rereadTokens * WEIGHT.read * (c.turns / 2);
      out.push({
        task_id: String(t.id), title: String(t.title),
        plan_model: String(runs[i]!.model ?? ""), code_model: String(code.model ?? ""), same_model: runs[i]!.model === code.model,
        plan_reads: plan.readCount, code_reads: c.readCount, reread, reread_tokens: Math.round(rereadChars / 4),
        code_searches: c.searchCount, research: [...c.searches].filter((p) => plan.searches.has(p)).length,
        code_turns: c.turns, code_usd: codeUsd, code_reading_usd: c.total > 0 ? codeUsd * (c.beforeEdit / c.total) : codeUsd,
        plan_context_tokens: plan.lastContext, code_start_tokens: c.firstContext, carry_usd: carryWeight * usdPerWeight, reread_usd: rereadWeight * usdPerWeight, cut_turns: plan.cut + c.cut,
      });
      break; // the first plan → code of the task; later ones are retries of the same work
    }
  }
  return out;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : "–");

export function formatPlanHandoff(pairs: PairMeasure[]): string {
  if (!pairs.length) return "No task has a plan stage followed by a code stage with its transcript kept.";
  const sum = (k: keyof PairMeasure) => pairs.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const lines = [
    `Plan → code hand-off on ${pairs.length} task(s) (${pairs.filter((p) => p.same_model).length} with the same model on both stages):`,
    "",
    `  code-stage reads ............. ${sum("code_reads")}, of which ${sum("reread")} (${pct(sum("reread"), sum("code_reads"))}) the plan had already read, about ${Math.round(sum("reread_tokens") / 1000)}k tokens`,
    `  code-stage searches ........... ${sum("code_searches")}, of which ${sum("research")} repeated the plan's word for word`,
    `  code stages cost .............. ${usd(sum("code_usd"))}, ${usd(sum("code_reading_usd"))} of it (${pct(sum("code_reading_usd"), sum("code_usd"))}) before the first edit — the most continuing could save`,
    `  what the re-reads cost ......... about ${usd(sum("reread_usd"))} — what continuing would save on them`,
    `  carrying the plan's context ... about ${usd(sum("carry_usd"))} more (what the plan held beyond the code stage's own start: one cache write, then a cache read each code turn)`,
    "",
    "  task                                            same model  reread  reading$  reread$  carry$",
  ];
  for (const p of pairs.sort((a, b) => b.code_reading_usd - a.code_reading_usd).slice(0, 25)) {
    lines.push(`  ${p.title.slice(0, 46).padEnd(46)}  ${(p.same_model ? "yes" : "no").padEnd(10)}  ${String(p.reread).padStart(6)}  ${usd(p.code_reading_usd).padStart(8)}  ${usd(p.reread_usd).padStart(7)}  ${usd(p.carry_usd).padStart(6)}`);
  }
  if (sum("cut_turns")) lines.push("", `  ${sum("cut_turns")} turn(s) were too big to keep whole: their tokens are missing, so reading leans low.`);
  return lines.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = arg("db") ?? DB_PATH;
  // Read-only, so it is safe while the board is running and cannot rewrite its state (CLAUDE.md).
  const db = new DatabaseSync(file, { readOnly: true });
  const pairs = measurePlanHandoff(db, { since: arg("since") });
  console.log(process.argv.includes("--json") ? JSON.stringify(pairs, null, 2) : formatPlanHandoff(pairs));
  db.close();
}
