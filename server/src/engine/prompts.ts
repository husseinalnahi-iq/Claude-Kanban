import type { Mode, StageName } from "../types.ts";

/** Context is a finite budget: keep the head and tail of long text and say what was dropped. */
export function clamp(text: string, max: number, tailShare = 0.3): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const tail = Math.floor(max * tailShare);
  const head = max - tail;
  return `${t.slice(0, head)}\n\n…[${t.length - max} characters trimmed — ask the board or read the files for the rest]…\n\n${t.slice(-tail)}`;
}

const LIMITS = {
  spec: 8000,
  parentSpec: 3000,
  previousResult: 6000,
  earlierResult: 1500,
  siblings: 15,
  summary: 200,
  messages: 10,
  messageBody: 800,
  verification: 4000,
  note: 280,
  imageDescription: 1200,
  filePreview: 2000,
};

export interface PromptCtx {
  stage: StageName;
  customPrompt?: string;
  mode: Mode;
  task: { id: string; title: string; spec_md: string };
  branch?: string | null;
  baseSha?: string | null;
  parent?: { id: string; title: string; spec_md: string } | null;
  siblings: { id: string; title: string; status: string; summary: string | null }[];
  previousResult?: string | null;
  /** Set when the previous stage ran on another provider: its output is labelled as such (D133). */
  previousFrom?: { provider: string; model: string } | null;
  /** Results of earlier stages (stage index → result), so review sees the plan, not just the code summary. */
  earlierResults?: { stage: StageName; result: string }[];
  skills: string[];
  messages: { from: string; body: string }[];
  /** Why a human sent this task back to Backlog, if they did. */
  rejectNote?: string | null;
  /** Output of the project's verify command when it failed on the previous attempt. */
  verificationFailure?: string | null;
  /** This stage was started on another model, which ran out partway: what the new one needs to know. */
  handover?: string | null;
  /** Durable project memory: decisions and conventions from earlier tasks. */
  memory?: string[];
  /** Files the human attached: images (described), spreadsheets, documents, data. */
  images?: { name: string; path: string; note: string | null; description: string | null; kind: "image" | "text" | "document" }[];
  /** Finished tasks this one follows up on. */
  relatedTasks?: { id: string; title: string; status: string; summary: string | null }[];
  /** The command the board will run to verify this work, if the project defines one. */
  verifyCommand?: string | null;
  /** The run has a browser to look at what it built. `port` is reserved for this task's dev server. */
  browser?: { port: number | null; chrome: boolean } | null;
  /**
   * What the model running this stage can do. `sdk`: Claude Code with every tool and the board MCP
   * server. `cli`: another agent with its own tools, no board server. `text`: nothing but the prompt,
   * so the diff or the file list is inlined (docs/DECISIONS.md D128).
   */
  capabilities?: "sdk" | "cli" | "text";
  /** Text-only review: the change itself, since the model cannot run git. */
  inlineDiff?: { file: string; status: string; patch: string }[] | null;
  /** Text-only plan: what the repository contains, since the model cannot list it. */
  fileList?: { files: string[]; total: number } | null;
}

const TEXT_LIMITS = { diff: 60_000, patchPerFile: 12_000 };

/**
 * Checking a visible change the way a person would. Only code and review stages get it: planning
 * has nothing to look at yet, and a custom stage carries its own instructions.
 */
function browserSection(ctx: PromptCtx): string | null {
  if (!ctx.browser || (ctx.stage !== "code" && ctx.stage !== "review")) return null;
  const port = ctx.browser.port ? `port ${ctx.browser.port} (also in \`$KANBAN_PORT\`)` : "the port in `$KANBAN_PORT`";
  const lines = [
    "\n## Look at it in a browser",
    ctx.stage === "code"
      ? "If this change affects something a person sees — a page, a component, a layout, a style — check it before you finish, the way a person would:"
      : "If this change affects something a person sees, look at it yourself before your verdict — a summary saying it looks right is not evidence:",
    `- start the app on ${port} as a background command; the port is reserved for this task, so parallel tasks do not collide`,
    "- open it with the `browser_*` tools, take a screenshot (no file name — it comes straight back to you), and look at it; fix what is wrong and take one more",
    "- when you are done, stop **only the process you started**: its background command, or its PID. Never kill processes by name (`taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name`) — that also kills the board running this task and everything else on the machine, and the board refuses it",
    "Screenshots are saved to this task on the board, so the person reviewing it sees what you saw. Each one costs about as much as a page of text: take the few that show the result, not one per step. Local addresses (localhost) open freely; anything else is refused or needs approval. Skip all of this when nothing visible changed.",
  ];
  if (ctx.browser.chrome) {
    lines.push(
      "Claude in Chrome is also available: the user's own Chrome, signed in to their accounts, and every action in it is approved by them. Use it only when the check needs their signed-in session; otherwise use the `browser_*` tools.",
    );
  }
  return lines.join("\n");
}

function stageInstructions(ctx: PromptCtx): string {
  const caps = ctx.capabilities ?? "sdk";
  switch (ctx.stage) {
    case "plan":
      if (caps === "text") {
        return [
          "Produce an implementation plan for the task below. You cannot read files or run commands: plan from the spec, the file list and the context given here, and say explicitly what you would need to check in the code before implementing.",
          "If the task is too big for one focused session, list independent subtasks under a `## Subtasks` heading, each with a self-contained spec.",
          "End with the plan as markdown; it is handed to the next stage.",
        ].join("\n");
      }
      return [
        "Produce an implementation plan for the task below. Do not edit files — editing tools are disabled in this stage; read whatever code you need.",
        caps === "cli"
          ? "If the task is too big for one focused session, list independent subtasks under a `## Subtasks` heading (each with a self-contained spec) and say so in your plan."
          : "If the task is too big for one focused session, split it into independent subtasks with `board_create_subtasks` (each with a self-contained spec) and say so in your plan.",
        "End with the plan as markdown; it is handed to the next stage.",
      ].join("\n");
    case "code":
      return [
        "Implement the task below, following the previous stage's plan when there is one. Keep the change focused on the spec.",
        ctx.verifyCommand
          ? `Before you finish, run \`${ctx.verifyCommand}\` and keep working until it passes — the board runs it too and will send the task back if it fails. Never weaken or delete a check to make it pass.`
          : "Verify your work (run the project's tests or build if it has them) and show the output rather than asserting success.",
        "End with a concise markdown summary of what you changed; it is handed to the next stage.",
      ].join("\n");
    case "review": {
      if (caps === "text") {
        return [
          "Review the change below against the task's spec. You cannot run anything or open files: judge the diff as given, and say what you could not verify.",
          "Point at concrete defects with file and line; do not expand scope.",
          "End with a line `VERDICT: APPROVE` or `VERDICT: CHANGES_NEEDED`, followed by your reasons.",
        ].join("\n");
      }
      const how = ctx.baseSha ? `Inspect the changes with \`git diff ${ctx.baseSha}\`.` : "Inspect the files the previous stage changed.";
      return [
        `Review the changes made for the task below against its spec. ${how}`,
        "Fix only clear defects; do not expand scope.",
        "End with a line `VERDICT: APPROVE` or `VERDICT: CHANGES_NEEDED`, followed by your reasons.",
      ].join("\n");
    }
    case "custom":
      return ctx.customPrompt?.trim() || "Work on the task below.";
  }
}

export function buildStagePrompt(ctx: PromptCtx): string {
  const out: string[] = [];
  out.push(`# Stage: ${ctx.stage}`);
  out.push(`You are one stage of a pipeline on the Claude Kanban board (task \`${ctx.task.id}\`).`);
  out.push(stageInstructions(ctx));
  const browser = (ctx.capabilities ?? "sdk") === "sdk" ? browserSection(ctx) : null;
  if (browser) out.push(browser);

  out.push(`\n## Task: ${ctx.task.title}\n${clamp(ctx.task.spec_md, LIMITS.spec) || "(no spec written — use the title)"}`);

  if (ctx.parent) {
    out.push(`\n## Parent task: ${ctx.parent.title} (\`${ctx.parent.id}\`)\n${clamp(ctx.parent.spec_md, LIMITS.parentSpec) || "(no spec)"}`);
  }
  if (ctx.siblings.length) {
    const shown = ctx.siblings.slice(0, LIMITS.siblings);
    const lines = shown.map((s) => `- ${s.title} — ${s.status}${s.summary ? ` — ${s.summary.slice(0, LIMITS.summary)}` : ""} (\`${s.id}\`)`);
    if (ctx.siblings.length > shown.length) lines.push(`- …and ${ctx.siblings.length - shown.length} more (use \`board_list_siblings\`)`);
    out.push(`\n## Sibling tasks\n${lines.join("\n")}`);
  }
  if (ctx.relatedTasks?.length) {
    out.push(
      `\n## Earlier tasks this follows up on\n${ctx.relatedTasks.map((r) => `- ${r.title} (\`${r.id}\`, ${r.status})${r.summary ? ` — ${r.summary.slice(0, LIMITS.summary)}` : ""}`).join("\n")}\n` +
        "Use `board_get_task` for the full spec and result of any of them.",
    );
  }
  if (ctx.memory?.length) {
    out.push(
      `\n## Decisions from earlier tasks in this project\n${ctx.memory.map((m) => `- ${m.slice(0, LIMITS.note)}`).join("\n")}\n` +
        "These are notes from past work, not orders: follow them unless this task's spec says otherwise, and say so if one looks wrong or stale.",
    );
  }
  if (ctx.rejectNote?.trim()) {
    out.push(`\n## Why this was sent back\nA human rejected the previous attempt: ${ctx.rejectNote.trim()}\nAddress this before anything else.`);
  }
  if (ctx.verificationFailure?.trim()) {
    out.push(
      `\n## The last attempt failed verification\nThe board ran \`${ctx.verifyCommand ?? "the project's verify command"}\` and it failed:\n\n` +
        "```\n" + clamp(ctx.verificationFailure, LIMITS.verification, 0.8) + "\n```\n" +
        "Fix the cause, not the symptom, and do not weaken or delete the checks to make them pass.",
    );
  }
  if (ctx.handover?.trim()) {
    out.push(`\n## Picking up from another model\n${clamp(ctx.handover.trim(), LIMITS.previousResult)}`);
  }
  for (const earlier of ctx.earlierResults ?? []) {
    out.push(`\n## Earlier stage result (${earlier.stage})\n${clamp(earlier.result, LIMITS.earlierResult)}`);
  }
  if (ctx.previousResult?.trim()) {
    const from = ctx.previousFrom;
    const heading = from
      ? `## Previous stage result — produced by another model (${from.model} via ${from.provider})\nVerify its claims against the code; do not assume it is right.`
      : "## Previous stage result";
    out.push(`\n${heading}\n${clamp(ctx.previousResult, LIMITS.previousResult)}`);
  }
  if (ctx.capabilities === "text" && ctx.stage === "review") {
    const files = ctx.inlineDiff ?? [];
    if (!files.length) out.push("\n## Diff\n(no committed change could be found for this task — review the previous stage's summary and say so)");
    else {
      let budget = TEXT_LIMITS.diff;
      const parts: string[] = [];
      for (const f of files) {
        const patch = clamp(f.patch || "(binary or empty)", Math.min(TEXT_LIMITS.patchPerFile, Math.max(400, budget)), 0.2);
        budget -= patch.length;
        parts.push(`### ${f.status} ${f.file}\n\`\`\`diff\n${patch}\n\`\`\``);
        if (budget <= 0) {
          parts.push(`…and ${files.length - parts.length} more file(s) not shown.`);
          break;
        }
      }
      out.push(`\n## Diff (${files.length} file${files.length === 1 ? "" : "s"})\n${parts.join("\n")}`);
    }
  }
  if (ctx.capabilities === "text" && ctx.stage === "plan" && ctx.fileList) {
    const { files, total } = ctx.fileList;
    out.push(`\n## Repository file list (${total} tracked file${total === 1 ? "" : "s"}${total > files.length ? `, first ${files.length} shown` : ""})\n${files.join("\n")}`);
  }
  if (ctx.messages.length) {
    const shown = ctx.messages.slice(-LIMITS.messages);
    out.push(`\n## Messages for this task\n${shown.map((m) => `- from ${m.from}: ${clamp(m.body, LIMITS.messageBody)}`).join("\n")}`);
  }
  if (ctx.images?.length) {
    // Images arrive already described by the cheap vision model, and text files carry their own first
    // few KB, so this stage spends none of its own (often far more expensive) tokens on either. The
    // path is always here for when the summary is not enough.
    const lines = ctx.images.map((i) => {
      const head = `- **${i.name}**${i.note ? ` (${i.note})` : ""} — \`${i.path}\``;
      if (!i.description) return head;
      const body = clamp(i.description, i.kind === "image" ? LIMITS.imageDescription : LIMITS.filePreview);
      const label = i.kind === "image" ? "" : "  (the start of the file)\n";
      return `${head}\n${label}  ${body.split("\n").join("\n  ")}`;
    });
    out.push(
      `\n## Files attached to this task\n${lines.join("\n")}\n` +
        "Open one only when you need more than is shown above." +
        (ctx.images.some((i) => i.kind === "document")
          ? " A spreadsheet or document (xlsx, docx, pdf) is not plain text: open it with a short script or a library the project already has, rather than guessing at its contents."
          : ""),
    );
  }
  if (ctx.skills.length) {
    out.push(`\n## Skills\n${ctx.skills.map((s) => `- use the \`${s}\` skill`).join("\n")}`);
  }
  if (ctx.mode === "autonomous" && ctx.branch) {
    out.push(
      `\n## Working directory\nYou are in a git worktree on branch \`${ctx.branch}\`. Edit files freely inside it. ` +
        "Do not commit, push, switch branches, or touch files outside it — the board commits your changes after this stage.",
    );
  }
  if ((ctx.capabilities ?? "sdk") === "sdk") {
    out.push(
      "\n## Board\nYou have board tools: `board_get_task`, `board_list_siblings`, `board_post_message`, `board_create_subtasks`, `board_set_summary`. " +
        "Call `board_set_summary` with a one-line progress note when you start and when you finish. " +
        "Use `board_post_message` to tell the parent or a sibling something they need to know.",
    );
  }
  return out.join("\n");
}
