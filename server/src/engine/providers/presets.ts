import type { Provider } from "../../types.ts";

/**
 * Starting points for Settings → Providers. Dependency-free so the web can import it.
 * Prices are left for you to fill in: they change, and a wrong number is worse than "estimated".
 * URLs verified against each vendor's Claude Code integration page (September 2026).
 */
export interface ProviderPreset extends Omit<Provider, "enabled"> {
  /** Shown under the name in the picker. */
  blurb: string;
  /** Written into the secret store when the preset is added, for endpoints that want a fixed dummy token. */
  seedSecret?: string;
  /** Where to get a key / how to log in. */
  help: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "zai", label: "GLM (z.ai)", kind: "anthropic-compatible", baseUrl: "https://api.z.ai/api/anthropic", authRef: "ZAI_API_KEY",
    models: [{ id: "glm-5.3", label: "GLM 5.3" }, { id: "glm-5.3-flash", label: "GLM 5.3 Flash" }, { id: "glm-4.7", label: "GLM 4.7" }],
    mayEditFiles: true,
    blurb: "Z.ai coding plan or API key. Runs the real Claude Code against GLM.",
    help: "Key from z.ai → API keys, or your GLM Coding Plan token (docs.z.ai/devpack/tool/claude).",
  },
  {
    id: "kimi", label: "Kimi (Moonshot)", kind: "anthropic-compatible", baseUrl: "https://api.moonshot.ai/anthropic", authRef: "MOONSHOT_API_KEY",
    models: [{ id: "kimi-k3", label: "Kimi K3" }, { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" }],
    mayEditFiles: true,
    blurb: "Kimi coding plan or API key, through Claude Code.",
    help: "Key from platform.kimi.ai (platform.kimi.ai/docs/guide/claude-code-kimi).",
  },
  {
    id: "minimax", label: "MiniMax", kind: "anthropic-compatible", baseUrl: "https://api.minimax.io/anthropic", authRef: "MINIMAX_API_KEY",
    models: [{ id: "MiniMax-M3", label: "MiniMax M3" }],
    mayEditFiles: true,
    blurb: "MiniMax coding plan, through Claude Code.",
    help: "Key from platform.minimax.io (Coding Plan → Claude Code).",
  },
  {
    id: "openrouter-anthropic", label: "OpenRouter (agentic)", kind: "anthropic-compatible", baseUrl: "https://openrouter.ai/api", authRef: "OPENROUTER_API_KEY",
    models: [
      { id: "moonshotai/kimi-k3", label: "Kimi K3" }, { id: "z-ai/glm-5.3", label: "GLM 5.3" }, { id: "qwen/qwen3-coder-next", label: "Qwen3 Coder Next" },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }, { id: "minimax/minimax-m3", label: "MiniMax M3" },
    ],
    mayEditFiles: true,
    blurb: "Any OpenRouter model, running Claude Code with tools. OpenRouter only guarantees this for Anthropic models; others usually work.",
    help: "Key from openrouter.ai/keys. Same key as the text-only OpenRouter provider.",
  },
  {
    id: "openrouter", label: "OpenRouter (text only)", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", authRef: "OPENROUTER_API_KEY",
    models: [
      { id: "moonshotai/kimi-k3", label: "Kimi K3" }, { id: "z-ai/glm-5.3", label: "GLM 5.3" }, { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" }, { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ],
    mayEditFiles: false,
    blurb: "Plain chat calls: plan critique, debate, review of a diff. Cost comes back from OpenRouter itself.",
    help: "Key from openrouter.ai/keys.",
  },
  {
    id: "ollama", label: "Ollama (agentic)", kind: "anthropic-compatible", baseUrl: "http://localhost:11434", authRef: "OLLAMA_TOKEN",
    models: [{ id: "qwen3-coder", label: "Qwen3 Coder" }, { id: "gpt-oss:20b", label: "GPT-OSS 20B" }],
    mayEditFiles: true, seedSecret: "ollama",
    blurb: "Local models through Claude Code (Ollama ≥ 0.14). Free; needs a model with ≥ 64k context.",
    help: "Run `ollama pull qwen3-coder`. The token is a placeholder Ollama ignores.",
  },
  {
    id: "ollama-text", label: "Ollama (text only)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", authRef: "OLLAMA_TOKEN",
    models: [{ id: "qwen3-coder", label: "Qwen3 Coder" }, { id: "gpt-oss:20b", label: "GPT-OSS 20B" }],
    mayEditFiles: false, seedSecret: "ollama",
    blurb: "Local models for critique and review. Free.",
    help: "Run `ollama pull <model>` first.",
  },
  {
    id: "lmstudio", label: "LM Studio", kind: "anthropic-compatible", baseUrl: "http://localhost:1234", authRef: "LM_API_TOKEN",
    models: [],
    mayEditFiles: true, seedSecret: "lmstudio",
    blurb: "Models you downloaded in LM Studio, through Claude Code (LM Studio ≥ 0.4.1). Free; runs on this computer. The picker lists what you have downloaded.",
    help: "LM Studio → Developer → start the server (port 1234), and load models with 32k+ context. The token is a placeholder unless you turn on “Require authentication”.",
  },
  {
    id: "codex", label: "Codex CLI (OpenAI)", kind: "cli", authRef: "OPENAI_API_KEY",
    models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }, { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    cli: { preset: "codex" }, mayEditFiles: false,
    blurb: "Your ChatGPT subscription via `codex exec`. Read-only unless you allow edits.",
    help: "Install: npm i -g @openai/codex, then `codex login`. Leave the key empty to use the login.",
  },
  {
    id: "gemini", label: "Gemini CLI (Google)", kind: "cli", authRef: "GEMINI_API_KEY",
    models: [{ id: "gemini-3.8-pro", label: "Gemini 3.8 Pro" }, { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }],
    cli: { preset: "gemini" }, mayEditFiles: false,
    blurb: "Google login or API key via `gemini -p`.",
    help: "Install: npm i -g @google/gemini-cli, then run `gemini` once to log in. Leave the key empty to use the login.",
  },
  {
    id: "kimi-cli", label: "Kimi Code CLI", kind: "cli", authRef: "KIMI_API_KEY",
    models: [{ id: "kimi-k3", label: "Kimi K3" }],
    cli: { preset: "kimi" }, mayEditFiles: false,
    blurb: "Kimi Code subscription via the `kimi` CLI.",
    help: "Install from code.kimi.com, then `kimi login`.",
  },
  {
    id: "opencode", label: "OpenCode", kind: "cli", authRef: "",
    models: [{ id: "openrouter/moonshotai/kimi-k3", label: "Kimi K3 via OpenRouter" }],
    cli: { preset: "opencode", envPassthrough: ["OPENROUTER_API_KEY"] }, mayEditFiles: false,
    blurb: "`opencode run` with whatever providers you configured in OpenCode.",
    help: "Install from opencode.ai; model ids are provider/model as OpenCode names them.",
  },
  {
    id: "custom-cli", label: "Custom command", kind: "cli", authRef: "",
    models: [{ id: "default", label: "default" }],
    cli: { preset: "custom", command: "my-agent --prompt-file {prompt_file} --model {model} --cwd {cwd} --mode {mode}" }, mayEditFiles: false,
    blurb: "Any command. The prompt is written to {prompt_file}; stdout is the result.",
    help: "Placeholders: {prompt_file} {cwd} {model} {mode} (read-only | write).",
  },
];
