/**
 * Which version of Claude's engine (the Agent SDK, with the Claude Code binary inside it) may replace
 * the installed one. Shared by the launcher's updater (scripts/update-engine.mjs) and the Setup row,
 * so both give the same answer. Pure, and written so plain Node can load it without a build.
 */

export const ENGINE_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const ENGINE_LATEST_URL = `https://registry.npmjs.org/${ENGINE_PACKAGE}/latest`;

/** [major, minor, patch], or null for anything that is not a plain release (a beta, a tag). */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `latest` may replace `installed`: it is newer, and the same major.minor as `floor` — the
 * version in server/package.json, which the board was tested on. A new minor or major may change the
 * SDK's API, so it waits for a board update. `skipped` are versions that were tried and did not start.
 */
export function shouldInstall(v: { installed: unknown; latest: unknown; floor: unknown; skipped?: string[] }): boolean {
  const i = parseVersion(v.installed);
  const l = parseVersion(v.latest);
  const f = parseVersion(v.floor);
  if (!i || !l || !f || (v.skipped ?? []).includes(String(v.latest))) return false;
  if (l[0] !== f[0] || l[1] !== f[1]) return false;
  return l[0] > i[0] || (l[0] === i[0] && (l[1] > i[1] || (l[1] === i[1] && l[2] > i[2])));
}
