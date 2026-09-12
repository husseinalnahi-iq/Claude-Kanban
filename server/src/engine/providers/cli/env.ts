import type { SecretStore } from "../../../secrets.ts";
import type { CliPreset, Provider } from "../../../types.ts";

/** Non-secret variables every child may see: enough to run, nothing about the board. */
const BASE_KEYS = [
  "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "TERM", "ProgramFiles", "ProgramData",
];

/** Auth variables each agent's CLI reads, filled from the provider's secret or the environment. */
const PRESET_AUTH: Record<CliPreset, string[]> = {
  codex: ["OPENAI_API_KEY", "CODEX_HOME"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_APPLICATION_CREDENTIALS"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  opencode: [],
  custom: [],
};

/**
 * What a child CLI is allowed to see (docs/DECISIONS.md D126): a fixed base, its own auth variable,
 * and the board's task hints — never `process.env` wholesale, so one provider's key or the board's
 * own Anthropic token never leaks into another agent's process.
 */
export function childEnv(
  provider: Provider,
  secrets: SecretStore,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { NO_COLOR: "1", CI: "1" };
  for (const k of BASE_KEYS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  const preset = provider.cli?.preset ?? "custom";
  const names = [...PRESET_AUTH[preset]];
  // The provider's own secret name is stored under whatever the auth var is called; feed it too.
  if (provider.authRef) names.push(provider.authRef);
  // A custom/opencode provider names the variables it needs; never an ANTHROPIC or board one.
  for (const name of provider.cli?.envPassthrough ?? []) {
    if (/^[A-Z0-9_]{1,64}$/.test(name) && !/^ANTHROPIC_/.test(name) && !name.startsWith("KANBAN_STATE")) names.push(name);
  }
  for (const name of new Set(names)) {
    const value = secrets.get(name);
    if (value) out[name] = value;
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}
