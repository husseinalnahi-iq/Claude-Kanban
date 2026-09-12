import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Bus } from "../bus.ts";
import type { Repo } from "../repo.ts";
import { LEAN } from "./lean.ts";

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

/**
 * Setting a project up so Claude works well in it from the first task: a good CLAUDE.md and a
 * verify command. Anthropic's own guidance (code.claude.com/docs/en/memory, /best-practices) is that
 * instruction files stay under 200 lines and specific, and that Claude needs a check it can run —
 * so the board produces those two things once, as a reviewed change, and adds nothing per stage.
 */

/** What the bootstrap task does for an empty folder. Editable in Settings; empty restores this. */
export const DEFAULT_CHECKLIST = [
  "- `git init` if the folder is not a repository; add a `.gitignore` for the stack.",
  "- A minimal runnable skeleton for the stack — entry point, config, no example features.",
  "- A test runner with one passing smoke test, and a lint or typecheck step.",
  "- One command that runs every check (tests, lint, typecheck, build). Report it on the last line as `VERIFY: <command>`.",
  "- `CLAUDE.md` under 200 lines: how to run, test and build; where things live; conventions that differ from the language's defaults; gotchas. Nothing Claude can read from the code itself.",
  "- `.claude/rules/<area>.md` with `paths:` frontmatter only where a folder needs rules of its own.",
  "- A short README: what it is and how to run it.",
].join("\n");

export type FolderKind = "empty" | "code" | "missing";

/** Git and board metadata do not make a folder a codebase: a freshly `git init`ed folder is still empty. */
const IGNORED = new Set([".git", ".claude", ".gitignore", ".ds_store", "thumbs.db", "desktop.ini"]);

export function probeFolder(path: string): FolderKind {
  if (!existsSync(path) || !statSync(path).isDirectory()) return "missing";
  return readdirSync(path).some((n) => !IGNORED.has(n.toLowerCase())) ? "code" : "empty";
}

export interface Answers {
  goal: string;
  stack: string;
  verify: string;
}

/** The bootstrap task's spec: the human's answers, the checklist, and the contract the board relies on. */
export function bootstrapSpec(a: Answers, checklist: string): string {
  return [
    "Set this empty folder up as a new project so later tasks can work in it well.",
    `\n## Goal\n${a.goal.trim()}`,
    `\n## Stack\n${a.stack.trim() || "Not chosen — choose the stack that fits the goal best and say why in CLAUDE.md."}`,
    `\n## How it is verified\n${a.verify.trim() || "Not chosen — pick the stack's standard test runner."}`,
    `\n## Checklist\n${checklist.trim() || DEFAULT_CHECKLIST}`,
    "\n## Rules",
    "- Keep `CLAUDE.md` under 200 lines and specific: commands, layout, conventions that differ from the defaults, gotchas. Leave out what Claude can read from the code.",
    "- No example features, no placeholder pages. A skeleton that runs and one smoke test that passes.",
    "- Run the checks yourself before you finish and show the output.",
    "- End your final message with one line `VERIFY: <command>` — the single command that runs every check. The board sets it as this project's verify command.",
  ].join("\n");
}

/** The last `VERIFY: <command>` line of a result, or null when there is none worth using. */
export function parseVerifyLine(text: string): string | null {
  const last = text.split(/\r?\n/).filter((l) => /^\s*VERIFY:/i.test(l)).at(-1);
  if (!last) return null;
  const cmd = last.replace(/^\s*VERIFY:\s*/i, "").replace(/^`+|`+$/g, "").trim();
  return cmd && !/^(none|null|n\/a|-)$/i.test(cmd) ? cmd : null;
}

function userMessage(text: string): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  })();
}

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: {
      type: ["string", "null"],
      description: "The one shell command that runs this project's checks (tests, lint, typecheck, build), or null if the file documents none.",
    },
  },
};

/** The project's own CLAUDE.md, wherever Claude Code would read it from, or null. */
export function readProjectClaudeMd(projectPath: string): string | null {
  for (const p of [join(projectPath, "CLAUDE.md"), join(projectPath, ".claude", "CLAUDE.md")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

/**
 * One cheap, tool-less call: which command in this CLAUDE.md runs the checks? Null when none is
 * documented — the model is told never to invent one, and an invented command would only make every
 * later task bounce off the gate.
 */
export async function extractVerifyCommand(claudeMd: string, model: string, cwd: string, queryFn: QueryFn): Promise<string | null> {
  const prompt =
    "Read this CLAUDE.md and return the single command that runs the project's checks. Prefer one that runs everything (for example `npm test` when it also covers lint and types). " +
    "Return null if none is documented. Never invent one.\n\n" +
    claudeMd.slice(0, 12_000);
  const options: Options = {
    model,
    effort: "low",
    cwd,
    ...LEAN,
    permissionMode: "dontAsk",
    tools: [],
    maxTurns: 1,
    maxBudgetUsd: 0.2,
    outputFormat: { type: "json_schema", schema: VERIFY_SCHEMA as unknown as Record<string, unknown> },
  };
  let out: unknown;
  for await (const msg of queryFn({ prompt: userMessage(prompt), options })) {
    if (msg.type === "result") out = (msg as { structured_output?: unknown }).structured_output;
  }
  const cmd = (out as { command?: unknown } | undefined)?.command;
  return typeof cmd === "string" && cmd.trim() ? cmd.trim() : null;
}

/**
 * After an onboarding task is approved: give the project a verify command if it has none. A
 * bootstrap says its own on a `VERIFY:` line; otherwise the cheap model reads the new CLAUDE.md.
 * Returns the command it set, or null when it set nothing. Never throws for the caller's sake.
 */
export async function applyOnboardingResult(deps: { repo: Repo; bus: Bus; queryFn: QueryFn }, taskId: string): Promise<string | null> {
  const task = deps.repo.getTask(taskId);
  if (!task?.onboarding) return null;
  const project = deps.repo.getProject(task.project_id);
  if (!project || project.env.verifyCommand) return null;

  let cmd: string | null = null;
  if (task.onboarding === "bootstrap") cmd = parseVerifyLine(deps.repo.latestRun(taskId)?.result_md ?? "");
  if (!cmd) {
    const md = readProjectClaudeMd(project.path);
    if (md) cmd = await extractVerifyCommand(md, deps.repo.getSettings().triageModel, project.path, deps.queryFn);
  }
  if (!cmd) return null;

  const updated = deps.repo.updateProject(project.id, { env: { ...project.env, verifyCommand: cmd } });
  deps.bus.publish({ type: "project.updated", project: updated });
  deps.repo.addNote({
    project_id: project.id,
    task_id: taskId,
    text: `Verify command set to \`${cmd}\` from ${task.onboarding === "bootstrap" ? "the bootstrap" : "CLAUDE.md"}`,
    source: "board",
  });
  const message = deps.repo.insertMessage({
    task_id: taskId,
    from_task_id: null,
    from_run_id: null,
    body: `Verify command set to \`${cmd}\`. Change it in Settings → Project if it is wrong.`,
  });
  deps.bus.publish({ type: "message.posted", message });
  return cmd;
}
