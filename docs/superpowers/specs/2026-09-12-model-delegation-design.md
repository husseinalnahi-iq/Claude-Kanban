# Model delegation + plan debate

## Context

Every pipeline stage today runs on Claude through the Agent SDK. The user wants to (1) cut cost by running stages on cheaper models, (2) send niche work to a model that is better at it, and (3) let a second model critique the plan before code starts. Research (2026-09) shows three working patterns in the wild, each with a different safety profile; the user chose all three but wants the subprocess one scoped to subscription-backed agents they own (ChatGPT/Codex, Kimi, GLM plans, Gemini CLI).

Decisions already made with the user:
- Mechanisms: **Claude Code pointed at an Anthropic-compatible backend** (GLM/z.ai, Kimi, MiniMax, OpenRouter, Ollama), **direct OpenAI-compatible HTTP** (text-only), and **CLI subprocess** for subscription agents (Codex, Gemini, Kimi CLI, OpenCode/custom).
- Debate: **one round** (plan → critic objects → planner revises), then **the user picks** original / revised / custom before code runs.
- User has: OpenRouter key, Ollama local, Codex and/or Gemini CLI, and will add GLM.

Ship in three phases, each independently useful. A is the cheapest win (a code stage on GLM through Claude Code with every guardrail intact). B adds the debate. C adds foreign CLIs, which is the riskiest piece and stays off by default.

Verified ground truth used below: `QueryFn` seam at `server/src/engine/runner.ts:32`; `runQuery` (~:520-700) builds SDK `Options`, consumes `AsyncIterable<SDKMessage>`, persists every message as an event, reads `session_id`, `assistant.message.usage`, and `result.{subtype,is_error,result,total_cost_usd,modelUsage}`; `runPipeline` (~:367-444) with `startOpts {fromStage, resume}`; `sizedPipeline` at :96; `latestByStage` keys by stage_index; `stageSchema` zod is duplicated in `routes/projects.ts:10` and `engine/boardMcp.ts:18`; tiers are plain model-id strings; `docs/DECISIONS.md` ends at **D120**; tests use `fakeQuery()` + `openDb(":memory:")` in `server/test/runner.test.ts:13-68`; transcript renders only `system:init | assistant | user | result* | user:prompt | verify:* | board:workspace`.

Non-goals (v1): delegating triage/vision, OS keychain, multi-round debate, mixing models inside one stage, enforcing the board blocklist inside foreign CLIs (documented gap).

---

## Shared foundation (lands in Phase A)

### Types (`server/src/types.ts`)
```ts
export type ProviderKind = "anthropic-compatible" | "openai-compatible" | "cli";
export type CliPreset = "codex" | "gemini" | "kimi" | "opencode" | "custom";
export const ANTHROPIC_PROVIDER_ID = "anthropic";        // implicit, never stored in providers[]
export interface ProviderModel { id: string; label: string; inputPer1M?: number; outputPer1M?: number; contextWindow?: number }
export interface Provider {
  id: string; label: string; kind: ProviderKind; enabled: boolean;
  baseUrl?: string;                    // http kinds
  authRef: string;                     // secret NAME, e.g. "ZAI_API_KEY" (resolved secrets.json → process.env)
  models: ProviderModel[];
  cli?: { preset: CliPreset; command?: string; extraArgs?: string[]; envPassthrough?: string[] };
  mayEditFiles: boolean;               // cli only; default false
}
export type TierRef = { provider: string; model: string };
export interface DebateSettings { enabled: boolean; critic: { provider: string; model: string; effort: Effort } }
export interface Objection { n: number; severity: "high" | "medium" | "low"; claim: string; change: string }
export interface PlanGate { stage_index: number; critic_run_id: string; created_at: string; original: string; critique: { raw: string; objections: Objection[] }; revised: string }
export interface ProviderTestResult { ok: boolean; latencyMs: number; modelEcho: string | null; usageReported: boolean; costReported: boolean; error: string | null }
// Stage  += provider?: string; debate?: boolean | { provider: string; model: string; effort?: Effort }   (debate: plan stages only)
// Run    += provider: string | null; role: "stage" | "critic"; cost_source: "sdk" | "estimated" | "subscription" | "provider"
// Task   += plan_gate: PlanGate | null
// Settings: tiers → Record<"cheap"|"balanced"|"strong", TierRef>; += providers: Provider[]; debate: DebateSettings; delegateTimeoutMin: number (30)
```
`cost_source` is stored, not derived: prices can be edited later and a run must keep saying what it was (same rule as D92).

### DB (`server/src/db.ts` LATER_COLUMNS + `schema.sql`)
```
runs.provider TEXT | runs.role TEXT NOT NULL DEFAULT 'stage' | runs.cost_source TEXT NOT NULL DEFAULT 'sdk' | tasks.plan_gate_json TEXT
```
Seeds: `providers=[]`, `debate={enabled:false, critic:{provider:"anthropic", model:"claude-sonnet-5", effort:"medium"}}`, `delegateTimeoutMin=30`, tiers seed in the new shape. Old string tiers are normalised **on read** in `Repo.getSettings()` (`string → {provider:"anthropic", model}`); no DB rewrite.

### Repo (`server/src/repo.ts`)
- `toRun` maps provider/role/cost_source; `createRun` takes optional `provider`, `role`; `updateRun` accepts the three columns.
- `TASK_COLUMNS` += `plan_gate` (json, column `plan_gate_json`).
- New `stageRuns(taskId)` (role='stage'). `latestRun` and `taskCards` filter `role='stage'` so a critic never becomes "the latest run" or recolours a stage dot. `runsForTask` stays unfiltered.
- `runAggregates.byModel` keys on `COALESCE(provider,'anthropic') || ':' || model`.

### Secrets (`server/src/secrets.ts`, new)
`SecretStore(file)` with `has/get/set/delete/redact`. File `<stateDir>/secrets.json`, written with mode 0600 (no-op on win32). `get` = file first, then `process.env[ref]`. `redact(text)` replaces every known value (≥8 chars) with `•••`. `RunnerDeps.secrets` and `AppDeps.secrets`; `TaskRunner.log()` wraps through `redact`. Never touched by `GET/PATCH /settings`; `Provider.authRef` is only a name.

### Provider registry + adapter contract (`server/src/engine/providers/`, new)
```
types.ts  registry.ts  presets.ts  cost.ts  anthropicCompatible.ts  (A)
openaiCompatible.ts  ../debate.ts                                    (B)
cli/{spawn,env,translate,codex,gemini,kimi,opencode,custom}.ts        (C)
```
```ts
export interface StageInvocation { run; task; project; prompt; cwd; provider; model; effort; readOnly: boolean; mode: Mode; resume?: string; abort: AbortSignal; timeoutMs: number; secret: string | null; emit(type, payload): void; log(line): void }
export interface ProviderAdapter {
  kind: ProviderKind | "anthropic";
  canResume: boolean;      // true only for anthropic + anthropic-compatible
  hasTools: boolean;       // false for openai-compatible → text-only stages
  applyOptions?(options: Options, inv: Pick<StageInvocation,"provider"|"model"|"secret">): Options;  // SDK-backed kinds
  run?(inv: StageInvocation): AsyncIterable<SDKMessage>;                                            // HTTP / CLI kinds
  test(p: Provider, model: string, secret: string | null, queryFn: QueryFn): Promise<ProviderTestResult>;
}
```
`ProviderRegistry(repo, secrets).resolve(id)`: `null|"anthropic"` → built-in identity adapter; unknown/disabled → `PolicyError("Stage uses provider "x" which does not exist or is disabled (Settings → Providers).")`. `allowedOn(kind, mayEditFiles, stage, mode)` matrix:

| kind | plan | review | code / custom |
|---|---|---|---|
| anthropic / anthropic-compatible | yes | yes | yes |
| openai-compatible (text-only) | yes | yes | refused |
| cli, mayEditFiles=false | yes (read-only) | yes (read-only) | refused |
| cli, mayEditFiles=true | yes | yes | autonomous only |

### `runQuery` dispatch (the one structural change in runner.ts)
```ts
const res = this.providers.resolve(run.provider);
const resume = res.adapter.canResume ? a.resume : undefined;
let options = { ...today, model: run.model, resume };
if (res.adapter.applyOptions) options = res.adapter.applyOptions(options, {...});
const stream = res.adapter.run ? res.adapter.run(inv) : this.queryFn({ prompt: userMessage(a.prompt), options });
```
Inside the existing loop, for non-anthropic providers: (a) a board-side **cost meter** sums `estimateCost(assistant.usage)` and aborts past `maxCostPerStageUsd` (the SDK prices unknown ids as $0, so `maxBudgetUsd` never fires); (b) `rate_limit_event`/`limit_before/after` are skipped (Claude windows only); (c) result cost = `sdk` for anthropic, `provider` when the API returned a price, else `estimateCost` → `estimated`/`subscription`. Return `providerId` so `runPipeline` calls `pauseForLimit` only for anthropic. Replace `if (!a.accumulate)` prompt-event guard with `a.promptEvent !== false` so the debate revision prompt is still recorded.

### zod
`stageSchema` (both copies) += `provider: z.string().trim().min(1).max(40).optional()`, `debate: z.union([z.boolean(), z.object({provider, model, effort?})]).optional()`. `routes/settings.ts` patchSchema += `tiers` (TierRef shape), `providers` (id `/^[a-z0-9-]{2,40}$/`, ≠ "anthropic", max 30, models max 60, prices 0..1000, baseUrl url), `debate`, `delegateTimeoutMin` (1..240). Route-level rule: http kinds need `baseUrl`; cli needs `cli.preset`; custom needs `cli.command` containing `{prompt_file}`.

### Routes (`server/src/routes/providers.ts`, new; register in `app.ts`)
| Method | Path | Returns |
|---|---|---|
| GET | `/providers` | `(Provider & {hasSecret})[]` |
| GET | `/providers/presets` | `PROVIDER_PRESETS` |
| PUT | `/providers/:id/secret` `{value}` | `{hasSecret:true}` (value never echoed) |
| DELETE | `/providers/:id/secret` | `{hasSecret}` |
| POST | `/providers/:id/test` `{model?}` | `ProviderTestResult` |
Provider CRUD itself goes through `PATCH /settings {providers}`.

### Prompt hygiene (`server/src/engine/prompts.ts`)
`PromptCtx` += `previousFrom?: {provider, model}`, `earlierResults[].from?`, `capabilities: "sdk"|"cli"|"text"`. When the previous result came from a non-anthropic provider its heading becomes *"Previous stage result — produced by another model (glm-4.7 via zai). Verify its claims against the code; do not assume it is right."* `text`: no `## Board` section, add `## Diff` (review) / `## Repository file list` (plan). `cli`: no `## Board`; "list subtasks under a `## Subtasks` heading" instead of `board_create_subtasks`.

---

## Phase A — providers, secrets, Anthropic-compatible adapter, cost estimation

Outcome: a code stage runs on GLM / Kimi / MiniMax / OpenRouter / Ollama **through Claude Code**, with board MCP, canUseTool, hooks, worktrees and transcript unchanged.

**A0** types + DB columns + repo mappings + zod (behaviour-neutral; suite green). Also save this design as `docs/superpowers/specs/2026-09-11-model-delegation-design.md`.

**A1** `secrets.ts`, `providers/{types,registry,presets,cost,anthropicCompatible}.ts`, `runQuery` dispatch with the anthropic adapter as identity. Full suite must be unchanged here.

`presets.ts` (dependency-free, importable by web): zai `https://api.z.ai/api/anthropic`, kimi `https://api.moonshot.ai/anthropic`, minimax `https://api.minimax.io/anthropic`, openrouter-anthropic `https://openrouter.ai/api`, ollama `http://localhost:11434` (authRef `OLLAMA_TOKEN`, seed value `"ollama"` on add). Starter `models[]` with labels, prices blank.

`cost.ts`: `estimateCost(provider, model, {inputTokens, cacheRead, cacheCreation, outputTokens}) → {usd, source}`; all prices absent/0 → `subscription`, usd 0.

`anthropicCompatible.applyOptions`: drop `effort` and `settings.fastMode` (Claude-only controls), set `model`, and env `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=<secret>`, `ANTHROPIC_API_KEY=""`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` all = model, blank `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`. `test()`: 1-turn "Reply with exactly: ok" with `tools: []`, `permissionMode: "dontAsk"`, reads `system:init.model`, `modelUsage`, `total_cost_usd`.

**A2** routes + web.

| File | Change |
|---|---|
| `server/src/config.ts`, `index.ts`, `app.ts` | `SECRETS_PATH`; construct `SecretStore`; pass to runner + app; register provider routes |
| `server/src/engine/runner.ts` | `this.providers`; `sizedPipeline(sizing, tiers: Record<Tier,TierRef>)` emits `provider` only when ≠ anthropic; `assertRunnable` validates every stage via `resolve` + `allowedOn`; `createRun({provider})`; `pauseForLimit` anthropic-only; `log()` redacts; `chat()` → `ConflictError("This stage ran on <label>, which cannot continue a session…")` when `!canResume`; `promptCtx` fills `previousFrom` |
| `web/src/lib/api.ts` | `providers()`, `providerPresets()`, `setProviderSecret`, `deleteProviderSecret`, `testProvider` |
| `web/src/lib/format.ts` | `modelLabel(run)` → `"glm-4.7 · zai"`; `costLabel(run)` → `"$0.12 est."` / `"subscription"` |
| `web/src/components/ProviderPicker.tsx` (new) | provider `<select>` (Anthropic + enabled providers) then model `<select>` from `settings.models` or `provider.models`, keeps the "Other model id…" escape |
| `web/src/views/settings/ProviderSettings.tsx` (new) + `Settings.tsx` | new **Providers** tab: add-from-preset, per-provider card (label, kind read-only after create, baseUrl, authRef + password field with Set/Clear + `hasSecret`, models table with $/1M in/out + context, enabled, **Test** button showing latency / model echo / usage+cost yes-no). Models tab: tiers use `ProviderPicker` |
| `web/src/components/PipelineEditor.tsx` | `ProviderPicker` per stage; effort select and fast button disabled when provider ≠ anthropic |
| `TaskDrawer.tsx`, `CostPanel.tsx`, `Transcript.tsx`, `Sessions.tsx`, `Dashboard.tsx` | provider chip on runs; `modelLabel`/`costLabel`; CostPanel hint "foreign rows are tokens × your price table; subscription rows show tokens only"; `system:init` line appends provider label; chat form disabled with hint when the run can't resume |

Edge cases: old pipelines (`provider` undefined → anthropic); provider disabled after a task references it → PolicyError at queue with the stage number; foreign 429 fails with the provider's text, never pauses; secrets never in settings/WS/logs; Ollama token seeded so `hasSecret` is true.

Existing tests to update: `server/test/triage.test.ts:255-257` (tiers shape). `runner.test.ts:70` event list must stay identical for the default provider. Extract `fakeQuery/setup/until` into `server/test/helpers.ts`.

New tests `server/test/providers.test.ts`, `secrets.test.ts`: env overrides exact (`ANTHROPIC_BASE_URL`, token, blank API key, model vars, `effort === undefined`, `settings === undefined`, `mcpServers.board` still present); cost estimation (1M in + 100k out at 0.6/2.2 → ≈0.82 `estimated`; no prices → 0 `subscription`; anthropic keeps `sdk`); per-stage meter aborts with `/estimated cost passed/`; missing provider → PolicyError, task stays backlog; foreign "429 quota" → `failed` not `paused` (anthropic still pauses); `rate_limit_event` on foreign run leaves `usage_limits` untouched; tiers migration on read; `sizedPipeline` with a foreign strong tier; `POST /providers/zai/test` shape; secrets round-trip, env fallback, `redact`, 0600 on posix, `GET /settings` and `GET /providers` bodies never contain the value.

---

## Phase B — OpenAI-compatible HTTP adapter, text-only stages, plan debate, gate UI

**B1** `providers/openaiCompatible.ts` (`fetchFn` injectable): `canResume:false, hasTools:false`. POST `{baseUrl}/chat/completions` with Bearer secret (omitted when null), `stream:false`, `usage:{include:true}` when baseUrl is OpenRouter; `signal = AbortSignal.any([inv.abort, AbortSignal.timeout(timeoutMs)])`. Emits `delegate:command {kind:"http", method, url, model}` (no headers/body), then SDK-shaped `system:init` (session_id = run.id, tools [], permissionMode "dontAsk", claude_code_version "board-http"), `assistant` (one text block + usage), `result` (`total_cost_usd = usage.cost ?? 0`, `cost_source: usage.cost != null ? "provider" : undefined`, `modelUsage[model]` with prompt/completion/cached tokens and `contextWindow` from the provider model). Non-2xx / network / timeout → `result {subtype:"error_during_execution", is_error:true, errors:["HTTP 401: …" clipped 500 chars, redacted]}`.

**B2** text-only plan/review in `runPipeline`/`prompts.ts`: review inlines `this.diff(task)` (file/status/patch, clamped 60k; supervised fallback `gitOps.diffWorkingTree(cwd)`, new); plan inlines `gitOps.lsFiles(project.path)` (new, capped 400 lines). Plan instruction: "You cannot read files; plan from what is given and say what you would need to check."

**B3** debate (`server/src/engine/debate.ts`: `buildCriticPrompt`, `buildRevisionPrompt`, `parseCritique` tolerant regex over `N. Severity/Claim/Change` items, garbage → one medium objection). Hook in `runPipeline` right after a successful **plan** stage (after `commitWorktree`, before the review-verdict block):
1. `critic = registry.debateFor(stage, settings)` (`stage.debate === false` → null; `true`/undefined → global if enabled; object → that). Null → skip.
2. **Critic run**: `createRun({stage:"plan", stage_index:i, role:"critic", provider, model, effort})`, `runQuery` with `disallowedTools: PLAN_DISALLOWED`; prompt asks for ≤8 objections with severity/claim/change, "No objections" if none. Critic fails or zero objections → event `debate:skipped` on the plan run, continue **without** a gate.
3. **Revision** on the original plan run: `runQuery({run: planRun, resume: canResume ? planRun.session_id : undefined, accumulate:true, promptEvent:true, prompt: buildRevisionPrompt(critique, canResume ? undefined : original)})`; prompt: ACCEPT/REBUT each objection in one line, then full plan under `## Revised plan`. Extract that section (else whole text). Revision fails → gate anyway with `revised=""`.
4. **Gate**: `setTask({status:"approval", plan_gate:{...}, note:"Plan debated — pick the plan to build from."})`, return.

`POST /tasks/:id/plan-decision {choice:"original"|"revised"|"custom", text?}` → `runner.decidePlan`: requires gate and not busy; writes chosen text to the plan stage run's `result_md`; event `debate:decision {choice}`; `setTask({plan_gate:null, note:null, status:"queued"})`, `startOpts.set(taskId,{fromStage: stage_index+1})`, enqueue directly (like `recover()`); if no later stage → `review`.

Bookkeeping: `latestByStage` iterates `stageRuns`; `stopTask` on a gated task → `failed` + clear gate; `rejectTask/discardTask/deleteTask/followUp` clear `plan_gate`; `recover()` exempts gated tasks from the `approval → failed` sweep.

**B4** web: `api.planDecision`; `components/PlanGate.tsx` (header "Plan debated by <critic>", objections with severity chips, two Markdown columns original vs revised each with "Use this", "Edit and continue" textarea → custom, disabled while busy); `TaskDrawer` mounts it above `Actions`, default tab `spec` when gated, hides Queue/Retry while gated, `critic` chip on runs; `PipelineEditor` plan rows get a tri-state debate toggle (default/on/off) with a `ProviderPicker` override; Settings → Models "Plan debate" section (enabled + critic picker + effort); `Transcript` renders `delegate:command` (`→ POST url (model)`), `debate:skipped`, `debate:decision`.

Tests `openaiCompatible.test.ts` (fake fetch): happy path events `user:prompt, delegate:command, system:init, assistant, result:success`, `result_md`, `cost_usd 0.0012 provider`, `session_id === run.id`, `usage.include` only for OpenRouter, secret absent from every stored event; no cost + prices → estimated, none → subscription; 401 → failed not paused; timeout → `/timed out/`; stop → fetch aborted; review prompt has `## Diff` and no `## Board`; code stage → PolicyError; retry has no resume; chat refused. `debate.test.ts` (sequenced fakeQuery, plan→code): call order plan/critic/revision with `options.resume === "s-plan"`, task `approval`, gate contents; `decidePlan("revised")` → code prompt contains revised and not v1, ends `review`, `runsForTask` 3 / `stageRuns` 2, `stage_states` `[success,success]`; custom text; critic failure → no gate + `debate:skipped`; "No objections" → no gate; stop/reject clear gate; `recover()` keeps `approval`; per-stage override false/object; `latestRun` after debate is the plan run so chat resumes it; `parseCritique` variants.

---

## Phase C — CLI adapters (Codex, Gemini, Kimi, OpenCode, custom)

Off unless the user adds a cli provider; `mayEditFiles` default false.

**C1** `cli/spawn.ts`: `spawnCli(spec, io:{stdin, onLine, onStderr}, opts:{cwd, env, timeoutMs, abort, spawnFn?, platform?})`. Prompt **never on the command line** (stdin for codex/gemini/kimi/opencode, temp file `<stateDir>/tmp/<runId>.prompt.md` for custom, deleted in finally). Windows: resolve executable along PATH+PATHEXT; `.cmd/.bat` → `shell:true` with every arg validated against `/^[\w.\-:\\\/@ ]+$/` and double-quoted, else PolicyError; otherwise `shell:false`. Kill: win32 `taskkill /pid /T /F`, else SIGTERM then SIGKILL after 5 s; on abort and on `delegateTimeoutMin` timeout (`errors:["Timed out after N min"]`). Emit `delegate:command {kind:"cli", command, args (redacted), cwd, readOnly}` before spawn.

`cli/env.ts` allowlist: `PATH PATHEXT SystemRoot ComSpec TEMP TMP HOME USERPROFILE APPDATA LOCALAPPDATA HOMEDRIVE HOMEPATH LANG LC_ALL TERM NO_COLOR=1 CI=1 KANBAN_TASK_ID KANBAN_PORT` + per preset: codex `OPENAI_API_KEY CODEX_HOME`; gemini `GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_CLOUD_PROJECT GOOGLE_GENAI_USE_VERTEXAI`; kimi `KIMI_API_KEY MOONSHOT_API_KEY`; opencode/custom `cli.envPassthrough` (`/^[A-Z0-9_]+$/`, never `^ANTHROPIC_|^KANBAN_STATE`). Values from `secrets.get(name)` then `process.env[name]`; nothing else crosses.

`cli/translate.ts`: `CliTranslator { init(); onLine(line); finish(exit) }` + builders `assistantText/toolUse/toolResult/thinking/resultOf`. Unknown lines → `delegate:raw`; stderr tail (4k, redacted) → `delegate:stderr`.

Presets (args verified from official docs 2026-09):
- **codex**: `codex exec --json --skip-git-repo-check -C <cwd> -m <model> -s read-only|workspace-write -a never -o <lastmsg> -` ; `-c model_reasoning_effort=<effort>`. Map `thread.started`→session id, `item.completed` agent_message→text, reasoning→thinking, command_execution→Bash tool_use+result, file_change→Edit tool_use, `turn.completed.usage`→modelUsage, `turn.failed`/`error`→error. Result = `-o` file, fallback last agent_message.
- **gemini**: `gemini --output-format stream-json --approval-mode plan|auto_edit -m <model>`; map init/message/tool_use/tool_result/`result.stats`; `status:"error"` → error.
- **kimi**: `kimi --print --output-format stream-json -w <cwd> -m <model> [--plan]`. Capture its JSONL from the installed CLI first; build parser against a fixture, raw-line fallback.
- **opencode**: `opencode run --format json -m <provider/model> --dir <cwd>` (`--auto` only when mayEditFiles); shape unverified → start as text-stdout (custom-style), upgrade when a fixture exists.
- **custom**: template `{prompt_file} {cwd} {model} {mode}`; stdout tail = one assistant text + result.

**C2** enforcement: `readOnly = stage ∈ {plan, review} || !mayEditFiles` → codex `-s read-only`, gemini `plan`, kimi `--plan`, custom `{mode}=read-only`. Supervised + cli on code/custom → PolicyError ("cannot ask for approvals; run autonomously or use a Claude stage"). After any read-only delegated stage: `git.isDirty(cwd)` → fail the run *before* `commitWorktree` ("Read-only provider modified the worktree; nothing was committed"). Translated `tool_use` blocks feed the existing `countRepeats` loop detector → abort kills the child.

**C3** web: cli fields on the provider card (preset, command, extra args, env passthrough, `mayEditFiles` with warning "the board cannot approve or block what this CLI does; keep it off unless the task runs in a worktree"); Transcript `$ codex exec … (read-only)` line, collapsible `delegate:stderr`, hidden `delegate:raw`; Settings → Runs "Delegated stage timeout (min)".

Tests `cli.test.ts` + `test/fixtures/cli/{codex,gemini,kimi}.jsonl` (injected `spawnFn` replaying a fixture, recording cmd/args/env/stdin): codex translation → event sequence, `result_md` from lastmsg, `input_tokens = input + cached`, session_id = thread id; gemini stats + error status; custom stdout, prompt file exists during and removed after; env allowlist (has PATH + OPENAI_API_KEY from secret, no `ANTHROPIC_*`, no other provider's secret, no random test env var); read-only args per stage/mayEditFiles; supervised+cli code → PolicyError; dirty tree after read-only → failed, no commit; timeout → kill + `/Timed out/`; stop → kill + "stopped by user"; win32 arg validation (`"gpt-5; rm -rf"` → PolicyError); unknown JSONL → `delegate:raw`, still succeeds; `delegate:command` has no secret, stderr redacted; retry no resume, chat refused.

---

## DECISIONS.md (append "Model delegation and plan debate", D121+)

| # | Decision | Trade-off |
|---|---|---|
| D121 | Three adapter kinds instead of one abstraction over every API | Three paths, but Anthropic-compatible keeps every tool/hook/gate for free |
| D122 | Compatible providers run the real Claude Code with env overrides; OPUS/SONNET/HAIKU/subagent model pinned to the same id | Subagents never hit Claude ids on a foreign endpoint; no mixing inside a stage |
| D123 | Foreign cost = tokens × your price table, stored `estimated`; subscriptions are $0 with tokens shown | Honest "estimated" beats a wrong dollar figure (D92) |
| D124 | Board meters per-stage cost itself for foreign models; CLI stages get wall-clock only | SDK prices unknown ids as $0 so `maxBudgetUsd` never fires |
| D125 | Secrets in `<stateDir>/secrets.json` (0600), by name, file-then-env; API exposes only `hasSecret`; logs redacted | Portable and dependency-free, file-level protection only |
| D126 | Child CLIs get an env allowlist plus their own auth var, never `process.env` | One provider never sees another's token or the Anthropic one |
| D127 | HTTP/CLI runs cannot resume: Retry re-runs, Chat is refused | Paying again beats faking continuity |
| D128 | Text-only providers allowed on plan/review only, diff or file list inlined | A model with no tools cannot implement; it can read a diff |
| D129 | CLI launches read-only unless `mayEditFiles` and autonomous; supervised+CLI code refused | Approvals cannot cross a process boundary; the worktree is the net |
| D130 | Blocklist and autonomous gate are not enforced inside foreign CLIs — stated, not pretended | Better a documented gap than false enforcement |
| D131 | One debate round; the human picks original/revised/custom | An unbounded critic loop spends money arguing |
| D132 | Critic runs carry `role=critic`: visible in transcript/cost, invisible to stage bookkeeping | A critique must never become "the latest run" |
| D133 | Delegated results are labelled in the next prompt as another model's output to verify | Claude trusts its own earlier output; a foreign plan should be checked |
| D134 | Windows spawn uses `shell:true` only for `.cmd/.bat`; prompt over stdin/file; shell-bound args charset-validated | Node refuses `.cmd` without a shell; nothing free-form on the command line |
| D135 | Foreign 429/quota fails the task instead of pausing | The pause timer is tied to Claude's windows |
| D136 | Provider Test is one tiny call through the same adapter path | Tests the exact configuration a stage will use |
| D137 | Read-only delegated stages that leave the tree dirty fail; nothing is committed | A plan that edited files is a broken contract |

Also: README roadmap + a "Providers" section; `docs/VERIFICATION.md` rows for the manual checks below.

## Sequencing
A0 → A1 (suite unchanged) → A2 → B1 → B2 → B3 (run `resume.test.ts`, `runner.test.ts` after) → B4 → C (spawn+env, then codex against the installed CLI, gemini, custom, opencode, kimi last after capturing its JSONL). Commit per sub-step. The pause/auto-resume work currently uncommitted in the tree is unrelated; commit it first (or stash) so the delegation diff stays clean.

## Verification
1. `npm run typecheck && npm test` green after every sub-step; A1 must leave every existing test and the runner.test event list byte-identical.
2. Phase A end to end (Ollama is local, no key needed): add the Ollama preset, `Test` → model echo + usage yes / cost no; set a task's code stage to `ollama / qwen3-coder`, queue in autonomous mode, confirm `system:init` shows the provider, board tools still called, run row shows `subscription`, task lands in review. Repeat with OpenRouter (user pastes key in Settings → Providers) on `openrouter-anthropic` and confirm `cost_source` and price estimate; then GLM once the user adds it.
3. Phase B: OpenRouter `openai-compatible` provider, `Test`; a review stage on it shows `## Diff` in the `user:prompt` event and a `→ POST …` line; enable debate with critic = that provider, queue a plan→code task, confirm the PlanGate card, pick "revised", confirm code stage prompt contains the revised plan and no `critic` run in the cost by stage of the card colours.
4. Phase C: `codex --version` / `gemini --version` on this machine; add the Codex preset (no key: ChatGPT login), `Test` → read-only 1-turn; plan stage on Codex shows the `$ codex exec … (read-only)` line and translated tool calls; a code stage with `mayEditFiles` off is refused at queue with the documented message; with it on and autonomous, the worktree diff shows Codex's edits and `kanban(code)` commit exists. Stop mid-run → process gone (`tasklist`), run failed "stopped by user".
5. Secrets: `GET /api/settings` and `GET /api/providers` bodies grep-clean of the key; `<stateDir>/logs/<runId>.log` of a delegated run grep-clean.
6. Browser pass via the `kanban-dev` launch config for the Providers tab, PipelineEditor pickers, PlanGate card, and the dark theme.
