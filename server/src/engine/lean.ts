import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * For the board's own small calls (vision, triage, usage and fast-mode checks, onboarding): nothing
 * from your own Claude setup — no settings, no MCP servers, no skills, no plugins, no Chrome.
 *
 * `settingSources: []` alone is not enough: user-level MCP servers still load, and their tool
 * descriptions went into every call. On a machine with a dozen of them that was ~60k tokens — one
 * screenshot described by Haiku measured $0.134 with them and $0.007 without, and the $0.05 usage
 * probe could not finish at all. Task stages are different: they get your setup on purpose.
 */
export const LEAN: Partial<Options> = {
  settingSources: [],
  mcpServers: {},
  strictMcpConfig: true,
  skills: [],
  plugins: [],
  extraArgs: { "no-chrome": null },
};
