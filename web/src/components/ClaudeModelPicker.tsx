import { EFFORT_NOTES, type Effort, type ModelEntry } from "../../../server/src/types.ts";
import { claudeModelStatus } from "../../../server/src/engine/claudeModels.ts";
import { claudeOptions, claudeWarning, effortsFor, useClaudeModels } from "../lib/claudeModels.ts";
import { ModelCombobox } from "./ModelCombobox.tsx";
import { inputCls } from "./ui.tsx";

/** Effort, offering only the levels this Claude model takes (none for Haiku). */
export function EffortSelect({
  model, value, onChange, disabled, className = "", notes,
}: {
  model: string;
  value: Effort;
  onChange: (e: Effort) => void;
  disabled?: boolean;
  className?: string;
  /** Show each level's meaning next to it. */
  notes?: boolean;
}) {
  const { result } = useClaudeModels();
  const { efforts, none } = effortsFor(model, result);
  const shown = efforts.includes(value) ? efforts : [...efforts, value];
  return (
    <select
      className={`${inputCls} font-mono ${className}`}
      value={value}
      disabled={disabled || none}
      title={none ? "This model has no effort setting" : EFFORT_NOTES[value]}
      onChange={(e) => onChange(e.target.value as Effort)}
    >
      {shown.map((ef) => (
        <option key={ef} value={ef}>
          {none ? "no effort setting" : !efforts.includes(ef) ? `${ef} — not for this model` : notes ? `${ef} — ${EFFORT_NOTES[ef]}` : ef}
        </option>
      ))}
    </select>
  );
}

/** A Claude-only model picker: your list plus what your login has, and a warning on a bad id. */
export function ClaudeModelPicker({ value, onChange, models }: { value: string; onChange: (id: string) => void; models: ModelEntry[] }) {
  const { result, loading } = useClaudeModels();
  return (
    <ModelCombobox
      value={value}
      onChange={onChange}
      options={claudeOptions(models, result)}
      loading={loading && !result}
      warn={claudeWarning(claudeModelStatus(value, result))}
      note={result?.error ? `Could not ask Claude Code for its models (${result.error}). Showing your list.` : null}
    />
  );
}
