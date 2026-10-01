import type { AgentDefinition, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { HelperModel } from "../types.ts";
import { BROWSER_SERVER } from "./browser.ts";
import { modelFamily } from "./claudeModels.ts";

/**
 * A cheaper helper a stage can hand its browser check to (D273). What makes a stage expensive is not
 * the thinking but the re-reading: every turn re-reads everything the session has seen, at the
 * stage's price, and a browser check fills it with page snapshots and screenshots. The helper does
 * the looking in its own short session on a cheaper model and hands back a few lines.
 *
 * A reading helper was built the same way and measured (D274): offered to an Opus plan that had to
 * read a large repository, it was never called — Opus read everything itself — so it was removed.
 */

export const BROWSER_AGENT = "browser-check";

/** Never set for a helper: they look and report; changing the work is the stage's job. */
const NO_EDITS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"];

const BROWSER_PROMPT = [
  "You check a web app that another agent is building, the way a person would, and report back. You do not change any code.",
  "The message you get says which address to open and what to check. Open it with the browser_* tools and do exactly that: click, type, press keys, resize to a phone size when asked.",
  "Take a screenshot of each thing that matters (no file name — it comes straight back to you) and look at it closely: layout, text, colours, anything cut off, overlapping or missing. Read the console for errors.",
  "Only local addresses open (localhost, 127.0.0.1); file:// pages are blocked, so if you are given a file path, say so and ask for a localhost address instead of trying.",
  "Answer in at most 15 lines: what you checked, what works, and what is broken or looks wrong — with where on the page, so it can be fixed without looking. Say plainly when you could not check something and why.",
].join("\n");

/** Cheapest first. A stage on a model not named here (another id shape) counts as the dearest. */
const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
function rankOf(model: string): number {
  const id = model.trim().toLowerCase();
  return RANK[modelFamily(id)?.family ?? id.replace(/\[1m\]$/, "")] ?? 5;
}

/**
 * The helper's model, or undefined when there should be no helper: "stage" (the setting says the
 * stage does it itself), or a helper no cheaper than the stage. Measured (D273): a Sonnet review
 * handing its browser check to a Sonnet helper cost 2.2× its own look — two sessions for one job.
 */
function modelOf(m: HelperModel, stageModel: string): HelperModel | undefined {
  if (m === "stage") return undefined;
  return RANK[m] < rankOf(stageModel) ? m : undefined;
}

/** Whether a stage on `stageModel` gets this helper; the prompt and the options must agree. */
export const usesHelper = (m: HelperModel, stageModel: string) => modelOf(m, stageModel) !== undefined;

export function helperAgents(o: {
  /** The board's browser server, when browser checks are on and go to a helper; the stage itself then has none. */
  browser: McpServerConfig | null;
  browserModel: HelperModel;
  /** The stage's own model: a helper is only worth it when it is cheaper. */
  stageModel: string;
}): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  const browserModel = modelOf(o.browserModel, o.stageModel);
  if (o.browser && browserModel) {
    out[BROWSER_AGENT] = {
      description:
        "Opens the app being built in a headless browser, does what you ask (click, type, press keys, resize), takes screenshots and reports what works and what is broken. Use it for every visual check: tell it the address and exactly what to check.",
      prompt: BROWSER_PROMPT,
      model: browserModel,
      effort: "medium",
      mcpServers: [{ [BROWSER_SERVER]: o.browser as never }],
      disallowedTools: [...NO_EDITS, "Bash", "PowerShell"],
      maxTurns: 25,
      omitClaudeMd: true,
    };
  }
  return out;
}
