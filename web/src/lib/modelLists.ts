import { modelKey, type ModelSurface, type Settings } from "../../../server/src/types.ts";

/**
 * Whether a picker lists a model (Settings → Model lists, D300). A hide-list: anything not hidden shows,
 * so a model new to a provider appears by itself. "provider:*" hides a provider's every model, and the
 * pick already made always shows, so a saved choice never silently disappears.
 */
export function visibleIn(settings: Pick<Settings, "hiddenModels"> | null | undefined, surface: ModelSurface, provider: string | null | undefined, model: string, current?: string): boolean {
  if (current !== undefined && model === current) return true;
  const hidden = settings?.hiddenModels?.[surface] ?? [];
  if (!hidden.length) return true;
  return !hidden.includes(modelKey(provider, model)) && !hidden.includes(modelKey(provider, "*"));
}

/** Whether a picker lists a provider at all: not when all of it is hidden there (its current pick still shows). */
export function providerVisibleIn(settings: Pick<Settings, "hiddenModels"> | null | undefined, surface: ModelSurface, provider: string, current?: string): boolean {
  return current === provider || !(settings?.hiddenModels?.[surface] ?? []).includes(modelKey(provider, "*"));
}
