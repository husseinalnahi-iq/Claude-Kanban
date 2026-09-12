import { useEffect, useState } from "react";
import { EFFORTS, type ClaudeModelStatus, type ClaudeModelsResult, type Effort, type ModelEntry } from "../../../server/src/types.ts";
import { claudeModelStatus, CLAUDE_STATUS_TEXT, findClaudeModel } from "../../../server/src/engine/claudeModels.ts";
import type { ModelOption } from "../components/ModelCombobox.tsx";
import { api } from "./api.ts";

/** One question per page load, shared by every picker; Refresh asks again and updates them all. */
let ask: Promise<ClaudeModelsResult> | null = null;
let last: ClaudeModelsResult | null = null;
const listeners = new Set<(r: ClaudeModelsResult) => void>();

function load(force = false): Promise<ClaudeModelsResult> {
  if (ask && !force) return ask;
  const req = api.claudeModels(force).catch(
    (err): ClaudeModelsResult => ({ source: "unavailable", models: [], checked_at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }),
  );
  ask = req;
  void req.then((r) => {
    last = r;
    // A failure is not kept: the next picker to open asks again.
    if (r.source !== "live" && ask === req) ask = null;
    for (const l of listeners) l(r);
  });
  return req;
}

/** The Claude models your login can use; null until Claude Code has answered. */
export function useClaudeModels(): { result: ClaudeModelsResult | null; loading: boolean; refresh: () => Promise<void> } {
  const [result, setResult] = useState<ClaudeModelsResult | null>(last);
  const [loading, setLoading] = useState(!last);
  useEffect(() => {
    const on = (r: ClaudeModelsResult) => {
      setResult(r);
      setLoading(false);
    };
    listeners.add(on);
    void load().then(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  const refresh = async () => {
    setLoading(true);
    await load(true);
  };
  return { result, loading, refresh };
}

/** A warning for the closed picker: red where a run fails, amber where it is probably a typo. */
export function claudeWarning(status: ClaudeModelStatus): { text: string; tone: "red" | "amber" } | undefined {
  if (status === "invalid") return { text: CLAUDE_STATUS_TEXT.invalid, tone: "red" };
  if (status === "unlisted") return { text: CLAUDE_STATUS_TEXT.unlisted, tone: "amber" };
  return undefined;
}

export const STATUS_TAG: Partial<Record<ClaudeModelStatus, string>> = { invalid: "not a Claude model", unlisted: "not on your login" };

/**
 * The Claude picker's rows: your list first (each marked when your login doesn't have it), then the
 * models your login has that the list doesn't — so nothing has to be typed.
 */
export function claudeOptions(models: ModelEntry[], r: ClaudeModelsResult | null): ModelOption[] {
  const mine: ModelOption[] = models.map((m) => {
    const info = findClaudeModel(m.id, r);
    return {
      id: m.id,
      label: info ? `${info.label} — ${info.blurb}` : m.note || m.label,
      group: "Your Claude list · uses your Claude plan",
      tag: STATUS_TAG[claudeModelStatus(m.id, r)],
    };
  });
  const listed = new Set(models.map((m) => findClaudeModel(m.id, r)?.id ?? m.id));
  const more: ModelOption[] = (r?.models ?? [])
    .filter((m) => !listed.has(m.id))
    .map((m) => ({ id: m.id, label: `${m.label} — ${m.blurb}`, group: "Also on your Claude login" }));
  return [...mine, ...more];
}

/** The effort levels a Claude model takes; `none` when it has no effort setting (Haiku). */
export function effortsFor(model: string, r: ClaudeModelsResult | null): { efforts: Effort[]; none: boolean } {
  const info = findClaudeModel(model, r);
  if (!info) return { efforts: EFFORTS, none: false };
  return info.efforts.length ? { efforts: info.efforts, none: false } : { efforts: EFFORTS, none: true };
}
