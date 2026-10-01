import type { Approval, EventRow, Message, Project, Run, Task } from "../types.ts";

/**
 * A task's whole story as one Markdown file: what was asked, every stage, every step Claude took in
 * order, what it asked and was told, what it cost and which files it changed. For keeping, sharing,
 * or reading back later than the transcript is kept (Settings → transcripts are pruned after N days).
 * Pure: the route gathers the rows, this only writes them down.
 */

export interface RecordInput {
  task: Task;
  project: Project;
  runs: Run[];
  /** Every event of each run, oldest first. */
  events: Map<string, EventRow[]>;
  approvals: Approval[];
  messages: Message[];
  /** Files the task's branch changed, when it has one. */
  files: { file: string; status: string }[];
}

const clip = (s: unknown, max: number) => {
  const t = String(s ?? "").trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
};
const money = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const clock = (iso: string) => new Date(iso).toISOString().slice(11, 19);
const day = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function took(run: Run): string {
  if (!run.ended_at) return "still running";
  const s = Math.max(0, Math.round((Date.parse(run.ended_at) - Date.parse(run.started_at)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** What a tool call was about, in one short phrase. */
function toolSubject(name: string, input: Record<string, unknown>): string {
  const what = input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.title ?? input.prompt ?? "";
  return `${name.replace(/^mcp__[^_]+__/, "")}${what ? ` — ${clip(String(what).replace(/\s+/g, " "), 160)}` : ""}`;
}

/** One transcript row as record lines. Rows that say nothing to a reader (stream noise, init) give none. */
export function recordLines(e: EventRow): string[] {
  const p = (e.payload ?? {}) as {
    type?: string; text?: string; result?: string; is_error?: boolean; count?: number; command?: string; ok?: boolean; tool?: string;
    message?: { content?: unknown };
  };
  const at = clock(e.ts);
  switch (p.type) {
    case "user_chat": return [`- \`${at}\` **You:** ${clip(p.text, 1500)}`];
    case "steer": return [`- \`${at}\` _Your message reached Claude mid-run._`];
    case "verify": return [`- \`${at}\` **Check** \`${clip(p.command, 120)}\`: ${p.ok ? "passed" : "failed"}`];
    case "auto_allowed": return [`- \`${at}\` _Allowed without a card (read-only):_ \`${clip(p.command, 160)}\``];
    case "turns_continued": return [`- \`${at}\` _Reached the turn limit and carried on in the same session._`];
    case "provider_switch": return [`- \`${at}\` _${clip(p.text, 300)}_`];
    case "result": return [`- \`${at}\` **${p.is_error ? "Stage failed" : "Stage finished"}**`];
  }
  if (p.type !== "assistant" || !Array.isArray(p.message?.content)) return [];
  const out: string[] = [];
  for (const b of p.message.content as { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (b.type === "text" && b.text?.trim()) out.push(`- \`${at}\` **Claude:** ${clip(b.text, 2000).replace(/\n+/g, "\n  ")}`);
    else if (b.type === "tool_use") out.push(`- \`${at}\` → ${toolSubject(String(b.name), b.input ?? {})}`);
  }
  return out;
}

/**
 * What a task achieved, in one line: the first line of the last successful stage that did the work
 * (not the plan, which only proposes, nor the review, which judges). The card's summary is a "what it
 * is doing now" line that a stage may never update at its end — "Reviewing it against the spec" was
 * written into project memory as the outcome — so it is only the fallback.
 */
export function outcomeLine(runs: Pick<Run, "stage" | "role" | "status" | "result_md">[], summary: string | null | undefined): string | null {
  const first = (s: string | null | undefined) => s?.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? null;
  const ok = runs.filter((x) => x.role === "stage" && x.status === "success" && x.result_md?.trim());
  const work = ok.filter((x) => x.stage !== "plan" && x.stage !== "review");
  return first(work.at(-1)?.result_md) ?? first(ok.at(-1)?.result_md) ?? (summary?.trim() || null);
}

export function taskRecord(r: RecordInput): string {
  const { task, project, runs } = r;
  const total = runs.reduce((sum, x) => sum + x.cost_usd, 0);
  const first = runs[0]?.started_at;
  const last = runs.findLast((x) => x.ended_at)?.ended_at;
  const out: string[] = [
    `# ${task.title}`,
    "",
    `- **Project:** ${project.name}`,
    `- **Status:** ${task.status}${task.error ? ` — ${clip(task.error, 300)}` : ""}`,
    `- **Mode:** ${task.mode}${task.branch ? ` · branch \`${task.branch}\`` : ""}`,
    `- **Pipeline:** ${task.pipeline.map((s) => `${s.stage} (${s.provider ? `${s.provider} · ` : ""}${s.model} · ${s.effort})`).join(" → ")}`,
    `- **Created:** ${day(task.created_at)}${first ? ` · **first run:** ${day(first)}` : ""}${last ? ` · **last run ended:** ${day(last)}` : ""}`,
    `- **Cost:** ${money(total)} across ${runs.length} run${runs.length === 1 ? "" : "s"}`,
    "",
    "## What was asked",
    "",
    task.spec_md.trim() || "_No spec._",
    "",
  ];
  const outcome = outcomeLine(runs, task.summary);
  if (outcome) out.push("## Outcome", "", outcome, "");

  out.push("## Stages", "", "| # | Stage | Model | Effort | Result | Took | Cost | Tokens in / out |", "|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    const role = run.role === "stage" ? run.stage : `${run.stage} (${run.role})`;
    out.push(`| ${run.stage_index + 1} | ${role} | ${run.provider ? `${run.provider} · ` : ""}${run.model} | ${run.effort} | ${run.status} | ${took(run)} | ${money(run.cost_usd)} | ${run.input_tokens.toLocaleString("en")} / ${run.output_tokens.toLocaleString("en")} |`);
  }
  out.push("");

  if (r.files.length) {
    out.push("## Files changed", "");
    for (const f of r.files) out.push(`- \`${f.status}\` ${f.file}`);
    out.push("");
  }

  out.push("## Step by step", "");
  for (const run of runs) {
    out.push(`### ${run.stage_index + 1}. ${run.stage} — ${run.model} · ${run.effort} (${run.status}, ${took(run)}, ${money(run.cost_usd)})`, "");
    const lines = (r.events.get(run.id) ?? []).flatMap(recordLines);
    out.push(...(lines.length ? lines : ["_No transcript kept for this run._"]), "");
    if (run.error) out.push(`**Error:** ${clip(run.error, 1200)}`, "");
    if (run.result_md?.trim()) out.push("**Result**", "", run.result_md.trim(), "");
  }

  const asked = r.approvals.filter((a) => a.decision);
  if (asked.length) {
    out.push("## What you were asked to approve", "");
    for (const a of asked) {
      const answers = a.answers ? ` — ${Object.entries(a.answers).map(([q, v]) => `${clip(q, 80)}: ${clip(v, 120)}`).join("; ")}` : "";
      out.push(`- \`${clock(a.created_at)}\` ${clip(a.title ?? a.tool_name, 200)} → **${a.decision}**${a.note ? ` (${clip(a.note, 200)})` : ""}${answers}`);
    }
    out.push("");
  }
  const qa = task.questions.filter((q) => q.answer);
  if (qa.length) {
    out.push("## Questions it asked", "");
    for (const q of qa) out.push(`- **${clip(q.text, 300)}** → ${clip(q.answer, 300)}`);
    out.push("");
  }
  if (r.messages.length) {
    out.push("## Messages", "");
    for (const m of r.messages) out.push(`- \`${clock(m.ts)}\` ${m.from_task_id ? `from task ${m.from_task_id}` : "you"}: ${clip(m.body, 600)}`);
    out.push("");
  }
  return out.join("\n");
}
