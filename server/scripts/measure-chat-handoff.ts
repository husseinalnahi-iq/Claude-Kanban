// How much a card made from a chat looks up again what its chat had already looked up — the measurement
// that decided the rounds plan — and, since rounds (D375), whether each round found its memory in the cache.
// Reads your board's database read-only: no lock, no migration, no model call, nothing written.
// Run (from server/): node --disable-warning=ExperimentalWarning --import tsx scripts/measure-chat-handoff.ts [--db <kanban.db>] [--project <name>] [--since 2026-09-01] [--json]
import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { DB_PATH } from "../src/config.ts";
import { EDIT_TOOLS, usageWeight } from "../src/engine/explore.ts";

const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

export interface CardMeasure {
  task_id: string;
  title: string;
  chat_id: string;
  stages: string[];
  cost_usd: number;
  /** False when the card's transcript was pruned (Settings keeps it eventRetentionDays) or it never ran. */
  has_transcript: boolean;
  /** Files and searches the chat had done before the card existed. */
  chat_reads: number;
  chat_searches: number;
  /** Every Read and Grep/Glob the card's runs made. */
  card_reads: number;
  card_searches: number;
  /** Of those, the ones the chat had already done. */
  reads_chat_had: number;
  searches_chat_had: number;
  /** Rough size of what the repeated reads put into the card's context (characters / 4). */
  reread_tokens: number;
  /** A later stage reading a file an earlier stage of the same card already read. */
  stage_rereads: number;
  /** What the card spent before its first edit (a stage with no edit counts whole). */
  reading_usd: number;
  /** Turns too big to keep whole in the transcript: their tokens are missing from the reading split. */
  cut_turns: number;
  repeated: string[];
}

export interface HandoffReport {
  db: string;
  cards: CardMeasure[];
  /** Cards from a chat with no transcript left, so they are left out of the totals. */
  pruned: number;
}

interface Row { [k: string]: unknown }

/** One spelling for a path whichever folder it was read from: the project, a task's worktree, or Windows. */
export function normPath(p: string, roots: string[]): string {
  let s = p.replace(/\\/g, "/");
  for (const r of roots) {
    const root = r.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root && s.toLowerCase().startsWith(root.toLowerCase() + "/")) { s = s.slice(root.length + 1); break; }
  }
  // A worktree that was removed after landing is no longer on the task, but its folder name says what it was.
  s = s.replace(/^(?:.*?\/)?\.kanban\/wt\/[^/]+\//, "");
  return s.toLowerCase();
}

/**
 * What the chat had looked at, from its tool lines (describeTool in engine/chat.ts writes `read <path>`,
 * `searched the code for “…”`, `looked for files matching “…”`). The chat keeps no raw tool calls, and
 * its session file can be replaced mid-chat, so these lines are the record that lasts.
 */
export function chatLookups(lines: string[]): { files: Set<string>; searches: Set<string> } {
  const files = new Set<string>();
  const searches = new Set<string>();
  for (const line of lines) {
    const read = /^read (.+)$/.exec(line);
    if (read) { files.add(read[1]!.trim().replace(/\\/g, "/").toLowerCase()); continue; }
    const search = /^(?:searched the code for|looked for files matching) “(.*)”$/.exec(line);
    if (search) searches.add(search[1]!);
  }
  return { files, searches };
}

/** A path the chat read outside the project is stored as its file name alone (describeTool's fallback). */
function chatHad(file: string, chatFiles: Set<string>): boolean {
  if (chatFiles.has(file)) return true;
  const name = basename(file);
  return chatFiles.has(name) && ![...chatFiles].some((f) => f.endsWith("/" + name));
}

/**
 * An event over MAX_EVENT_CHARS is stored as a cut preview (repo.ts `slimmed`), and a whole file read
 * often is one. Its start still names the tool call, and `chars` gives its size, so a read is still
 * counted; a big turn's token usage sits past the cut and is lost, which `cut_turns` reports.
 */
export function restore(type: string, ev: Row): Row & { cut?: boolean } {
  if (!ev.truncated || typeof ev.preview !== "string") return ev;
  const p = ev.preview;
  const str = (re: RegExp) => { const m = re.exec(p); return m ? (JSON.parse(`"${m[1]}"`) as string) : undefined; };
  if (type === "user") {
    const id = str(/"tool_use_id":"((?:[^"\\]|\\.)*)"/);
    return { type: "user", cut: true, message: { content: id ? [{ type: "tool_result", tool_use_id: id, size: Number(ev.chars) || 0 }] : [] } };
  }
  const blocks: Row[] = [];
  const tool = /"type":"tool_use","id":"((?:[^"\\]|\\.)*)","name":"((?:[^"\\]|\\.)*)","input":\{"(?:file_path|pattern)":"((?:[^"\\]|\\.)*)"/g;
  for (let m; (m = tool.exec(p)); ) {
    const name = JSON.parse(`"${m[2]}"`) as string;
    const value = JSON.parse(`"${m[3]}"`) as string;
    blocks.push({ type: "tool_use", id: JSON.parse(`"${m[1]}"`), name, input: SEARCH_TOOLS.has(name) ? { pattern: value } : { file_path: value } });
  }
  return { type: "assistant", cut: true, message: { id: str(/"id":"(msg_(?:[^"\\]|\\.)*)"/), content: blocks } };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as Row).text) : "")).join("");
  return "";
}

export function measureChatHandoff(db: DatabaseSync, opts: { project?: string; since?: string; dbPath?: string } = {}): HandoffReport {
  const where = ["t.chat_id IS NOT NULL"];
  const args: string[] = [];
  if (opts.project) { where.push("(p.name = ? OR p.id = ?)"); args.push(opts.project, opts.project); }
  if (opts.since) { where.push("t.created_at >= ?"); args.push(opts.since); }
  const tasks = db.prepare(
    `SELECT t.id, t.title, t.chat_id, t.created_at, t.worktree_path, p.path AS project_path
     FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where.join(" AND ")} ORDER BY t.created_at`,
  ).all(...args) as Row[];

  const chatLines = db.prepare("SELECT text FROM chat_messages WHERE chat_id = ? AND role = 'tool' AND ts <= ? ORDER BY id");
  const runsOf = db.prepare("SELECT id, stage, role, cost_usd FROM runs WHERE task_id = ? ORDER BY started_at, stage_index");
  const eventsOf = db.prepare("SELECT type, payload_json FROM events WHERE run_id = ? AND type IN ('assistant', 'user') ORDER BY id");

  const cards: CardMeasure[] = [];
  let pruned = 0;
  for (const t of tasks) {
    const roots = [t.worktree_path, t.project_path].filter((r): r is string => typeof r === "string" && r.length > 0);
    const chat = chatLookups((chatLines.all(String(t.chat_id), String(t.created_at)) as Row[]).map((r) => String(r.text)));
    const m: CardMeasure = {
      task_id: String(t.id), title: String(t.title), chat_id: String(t.chat_id), stages: [], cost_usd: 0,
      has_transcript: false, chat_reads: chat.files.size, chat_searches: chat.searches.size,
      card_reads: 0, card_searches: 0, reads_chat_had: 0, searches_chat_had: 0, reread_tokens: 0,
      stage_rereads: 0, reading_usd: 0, cut_turns: 0, repeated: [],
    };
    const earlierStages = new Set<string>();
    for (const run of runsOf.all(String(t.id)) as Row[]) {
      const cost = Number(run.cost_usd) || 0;
      m.cost_usd += cost;
      m.stages.push(run.role === "critic" ? `${run.stage} (critic)` : String(run.stage));
      const events = (eventsOf.all(String(run.id)) as Row[]).map((e) => restore(String(e.type), JSON.parse(String(e.payload_json)) as Row));
      if (!events.length) continue;
      m.has_transcript = true;

      // Parallel tool calls arrive as several assistant messages sharing one id and one usage: count it once.
      const seen = new Set<string>();
      let total = 0, beforeEdit = 0, edited = false;
      const repeatIds = new Map<string, string>();
      const thisStage = new Set<string>();
      for (const ev of events) {
        const msg = ev.message as Row | undefined;
        if (ev.type === "user") {
          for (const block of (Array.isArray(msg?.content) ? msg!.content : []) as Row[]) {
            if (block?.type === "tool_result" && repeatIds.has(String(block.tool_use_id))) {
              m.reread_tokens += Math.round((typeof block.size === "number" ? block.size : resultText(block.content).length) / 4);
            }
          }
          continue;
        }
        const blocks = (Array.isArray(msg?.content) ? msg!.content : []) as Row[];
        // The turn that makes the first edit is writing: its output is the edit itself.
        if (blocks.some((b) => b?.type === "tool_use" && EDIT_TOOLS.has(String(b.name)))) edited = true;
        const id = String(msg?.id ?? "");
        if (ev.cut) m.cut_turns++;
        if (!id || !seen.has(id)) {
          if (id) seen.add(id);
          const w = usageWeight(msg?.usage as Row | undefined);
          total += w;
          if (!edited) beforeEdit += w;
        }
        for (const block of blocks) {
          if (block?.type !== "tool_use") continue;
          const name = String(block.name);
          const input = (block.input ?? {}) as Row;
          if (name === "Read" && typeof input.file_path === "string") {
            const file = normPath(input.file_path, roots);
            m.card_reads++;
            if (chatHad(file, chat.files)) {
              m.reads_chat_had++;
              repeatIds.set(String(block.id), file);
              if (!m.repeated.includes(file)) m.repeated.push(file);
            }
            if (earlierStages.has(file)) m.stage_rereads++;
            thisStage.add(file);
          } else if (SEARCH_TOOLS.has(name) && typeof input.pattern === "string") {
            m.card_searches++;
            if (chat.searches.has(input.pattern.slice(0, 80))) m.searches_chat_had++;
          }
        }
      }
      // A stage with no usage recorded (another provider's CLI) cannot be split, so it counts as reading.
      m.reading_usd += total > 0 ? cost * (beforeEdit / total) : cost;
      for (const f of thisStage) earlierStages.add(f);
    }
    if (m.has_transcript) cards.push(m);
    else if (m.stages.length) pruned++;
  }
  return { db: opts.dbPath ?? "", cards, pruned };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : "–");

export function formatReport(r: HandoffReport): string {
  const c = r.cards;
  const sum = (k: keyof CardMeasure) => c.reduce((s, m) => s + (m[k] as number), 0);
  if (!c.length) {
    return [`Database: ${r.db}`, "", "No card made from a chat has a transcript to measure.",
      r.pruned ? `${r.pruned} card(s) from a chat are older than the transcripts the board keeps (Settings → eventRetentionDays).` : ""].join("\n");
  }
  const cost = sum("cost_usd");
  const reading = sum("reading_usd");
  const out = [
    `Database: ${r.db}`,
    `Cards made from a chat, with a transcript: ${c.length}${r.pruned ? `  (${r.pruned} more are older than the transcripts kept)` : ""}`,
    `Of those, cards whose chat had read files first: ${c.filter((m) => m.chat_reads > 0).length}`,
    "",
    `What the cards cost:                          ${usd(cost)}`,
    `  spent before their first edit (reading):    ${usd(reading)}  (${pct(reading, cost)})`,
    `Files the cards read:                         ${sum("card_reads")}`,
    `  already read by the chat first:             ${sum("reads_chat_had")}  (${pct(sum("reads_chat_had"), sum("card_reads"))}), about ${sum("reread_tokens").toLocaleString("en-US")} tokens of file text`,
    `Searches the cards ran:                       ${sum("card_searches")}`,
    `  already run by the chat first:              ${sum("searches_chat_had")}  (${pct(sum("searches_chat_had"), sum("card_searches"))})`,
    `Reads a later stage repeated from an earlier: ${sum("stage_rereads")}  (${pct(sum("stage_rereads"), sum("card_reads"))} of all reads)`,
    ...(sum("cut_turns") ? [`Turns too big to keep whole in the transcript: ${sum("cut_turns")} — their tokens are missing, so the reading share leans high.`] : []),
    "",
    "How to read it: the reading cost is the most that handing the card the chat's findings could save;",
    "the share already read by the chat says how much of that reading was a repeat.",
    "",
    "Cards with the most repeated reading:",
  ];
  const top = [...c].sort((a, b) => b.reads_chat_had - a.reads_chat_had || b.reading_usd - a.reading_usd).slice(0, 15);
  for (const m of top) {
    out.push(`  ${m.task_id}  ${m.title.slice(0, 50).padEnd(50)}  ${m.stages.join("→").padEnd(18)}  ${usd(m.cost_usd).padStart(7)}  reading ${usd(m.reading_usd).padStart(6)}  repeats ${m.reads_chat_had}/${m.card_reads} reads, ${m.searches_chat_had}/${m.card_searches} searches, ${m.stage_rereads} stage re-reads`);
  }
  return out.join("\n");
}

export interface RoundMeasure {
  task_id: string;
  title: string;
  round: number;
  fell_back: boolean;
  /** The round's first turn: what it read from the cache and what it had to write. A warm round reads. */
  first_read: number;
  first_write: number;
  cost_usd: number;
  /** What the card's first round cost, for comparison. */
  round1_usd: number;
}

/** Every round after the first that ran (D375): did it find its memory in the cache, and what did it cost? */
export function measureRounds(db: DatabaseSync): RoundMeasure[] {
  const hasRounds = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_rounds'").get() as Row | undefined) !== undefined;
  if (!hasRounds) return [];
  const rows = db.prepare(
    `SELECT r.task_id, r.round, r.fell_back, t.title FROM task_rounds r JOIN tasks t ON t.id = r.task_id ORDER BY r.started_at`,
  ).all() as Row[];
  const runsOf = db.prepare("SELECT id, cost_usd FROM runs WHERE task_id = ? AND round = ? AND role = 'stage' ORDER BY started_at, rowid");
  const firstMsg = db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'assistant' ORDER BY id LIMIT 1");
  const out: RoundMeasure[] = [];
  for (const r of rows) {
    const runs = runsOf.all(String(r.task_id), Number(r.round)) as Row[];
    if (!runs.length) continue;
    const msg = firstMsg.get(String(runs[0]!.id)) as Row | undefined;
    const usage = (msg ? (JSON.parse(String(msg.payload_json)) as Row).message as Row | undefined : undefined)?.usage as Row | undefined;
    const round1 = runsOf.all(String(r.task_id), 1) as Row[];
    out.push({
      task_id: String(r.task_id),
      title: String(r.title),
      round: Number(r.round),
      fell_back: Number(r.fell_back) === 1,
      first_read: Number(usage?.cache_read_input_tokens ?? 0),
      first_write: Number(usage?.cache_creation_input_tokens ?? 0),
      cost_usd: runs.reduce((sum, x) => sum + (Number(x.cost_usd) || 0), 0),
      round1_usd: round1.reduce((sum, x) => sum + (Number(x.cost_usd) || 0), 0),
    });
  }
  return out;
}

export function formatRounds(rounds: RoundMeasure[]): string {
  if (!rounds.length) return "Rounds: none have run on this board yet.";
  const warm = rounds.filter((r) => !r.fell_back && r.first_read > r.first_write).length;
  const cost = rounds.reduce((s, r) => s + r.cost_usd, 0);
  const first = rounds.reduce((s, r) => s + r.round1_usd, 0);
  return [
    `Rounds that ran: ${rounds.length}`,
    `  found their memory in the cache on the first turn: ${warm}  (${pct(warm, rounds.length)})`,
    `  started fresh because the session could not be reopened: ${rounds.filter((r) => r.fell_back).length}`,
    `  cost ${usd(cost)} in all, against ${usd(first)} for those cards' first rounds`,
    "",
    ...rounds.slice(-15).map((r) => `  ${r.task_id}  ${r.title.slice(0, 40).padEnd(40)}  round ${String(r.round).padEnd(2)}  ${usd(r.cost_usd).padStart(7)} (round 1 ${usd(r.round1_usd)})  first turn: ${r.first_read.toLocaleString("en-US")} read / ${r.first_write.toLocaleString("en-US")} written${r.fell_back ? "  · started fresh" : ""}`),
  ].join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = arg("db") ?? DB_PATH;
  // Read-only, so it is safe while the board is running and cannot rewrite its state (CLAUDE.md).
  const db = new DatabaseSync(file, { readOnly: true });
  const report = measureChatHandoff(db, { project: arg("project"), since: arg("since"), dbPath: file });
  const rounds = measureRounds(db);
  console.log(process.argv.includes("--json") ? JSON.stringify({ ...report, rounds }, null, 2) : `${formatReport(report)}\n\n${formatRounds(rounds)}`);
  db.close();
}
