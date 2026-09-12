# Live model catalog in the model picker

**Date:** 2026-09-12 · **Status:** approved

## Problem

The stage model dropdown only shows the models typed into Settings → Providers. For Ollama that is
not what is installed; for OpenRouter it is five of ~450. Nothing says which models are free. The
place to paste an OpenRouter key exists (Settings → Providers → add the OpenRouter preset → Key) but
nothing in the picker leads there.

## Design

### Server: `ModelCatalog` (`server/src/engine/providers/catalog.ts`)

`GET /api/providers/:id/models` → `{ source: "live" | "saved", models: CatalogModel[], error?: string }`.

```ts
interface CatalogModel {
  id: string; label: string;
  group: "local" | "cloud" | "free" | "paid" | "saved";
  inputPer1M?: number; outputPer1M?: number; contextWindow?: number;
  installed?: boolean; // Ollama only: false for a saved model that is not pulled
}
```

- **Ollama** (id starts with `ollama` or base URL on `:11434`): `GET <origin>/api/tags`. A name with
  `remote_host` or ending `-cloud` / `:cloud` → `cloud` (Ollama's hosted models: free tier with
  usage limits); otherwise `local`. `:latest` is dropped from ids. Saved models not in the tag list
  are returned as `saved` with `installed: false`.
- **OpenRouter** (base URL on `openrouter.ai`): `GET https://openrouter.ai/api/v1/models` (public, no
  key sent). Text-output models only; negative-priced routers (`openrouter/auto`…) skipped.
  Prices are per token strings → × 1e6. Both zero → `free`, else `paid`. For an
  `anthropic-compatible` provider only models whose `supported_parameters` include `tools`.
- **Anything else**, or a failed fetch: the saved list, `source: "saved"`, `error` set on failure.
- Cached per provider for 10 minutes; a failure is cached for 30 s.
- Saved models the live list lacks are appended as `saved` so nothing disappears.

### Cost fallback

`estimateCost(provider, model, usage, fallback?)`: the saved price wins; with none, the catalog's
cached live price is used (`runner` passes `catalog.priceOf(provider, model)`). A paid OpenRouter
model picked from the live list is no longer billed as a $0 "subscription".

### Web: `ModelCombobox` (`web/src/components/ModelCombobox.tsx`)

Replaces the model `<select>` in `ProviderPicker` (pipeline stages, tiers, debate critic).
A button showing the current id; clicking opens a panel with a filter input and grouped rows:
Local · free / Ollama cloud · free tier, limits / Free / Paid / Your list. Paid rows show
`$in/$out per 1M` and context. Arrow keys + Enter + Esc. "Other model id…" kept. Claude's own
models use the same component with one ungrouped list. The catalog is fetched once per provider per
page load (shared promise).

### Finding the key

The provider `<select>` gets a last option "+ Add a provider (OpenRouter, GLM…)" that opens
Settings → Providers in a new browser tab (`#/settings?tab=providers`), so a half-written task is
not lost. Settings reads `tab` from the hash on first render.

### Addendum: LM Studio and Ollama's cloud list

- **LM Studio preset** (`lmstudio`, anthropic-compatible, `http://localhost:1234`, secret `LM_API_TOKEN`
  seeded with the placeholder `lmstudio`, empty model list). Catalog: `GET <origin>/api/v1/models`
  (Bearer token sent when set). `llm`/`vlm` only; groups `loaded` then `downloaded`; label is name ·
  params · quantisation · size; `warning` when loaded with < 32k context or not trained for tools.
  Server off → "Open LM Studio → Developer and start the server"; 401/403 → "wants a token".
- **Ollama cloud list**: `https://ollama.com/api/tags` (public) fetched alongside the local tags;
  names mapped with `cloudId` (size tag → `-cloud`, else `:cloud`); ones not pulled come back with
  `installed: false`. ollama.com unreachable changes nothing.
- **Setup**: an LM Studio server check; no key check for local providers; Ollama pull checks also
  cover models picked in the default pipeline, tiers and debate critic.
- **Test button**: a provider with an empty list is tested on the first model it reports; disabled
  with "Save settings first" while the card has unsaved changes. Adding a preset saves at once.
- **Local models guide** (`web/src/views/settings/LocalModelsGuide.tsx`, `GET /api/setup/local-models`
  from `server/src/setup/local.ts`): hardware (nvidia-smi / Apple unified memory, RAM, free disk),
  LM Studio and Ollama installed / running / models / added, and a dated `PICKS` list judged fast /
  ok / slow / too-big against the machine. Six steps per app that tick themselves off (polled every
  4 s while open); local providers show "No key needed" instead of a key field.

## Testing

`server/test/catalog.test.ts`: Ollama local/cloud split and `:latest`; saved-but-not-pulled; OpenRouter
free/paid split, per-1M conversion, tools filter for agentic, router/image models skipped; offline
fallback with error; cache hit; `estimateCost` fallback. Then the real app against OpenRouter.
