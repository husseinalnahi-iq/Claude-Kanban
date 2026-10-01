import { EFFORT_NOTES, type Effort, type ModelEntry } from "../../../server/src/types.ts";
import { claudeModelStatus } from "../../../server/src/engine/claudeModels.ts";
import { claudeOptions, claudeWarning, effortsFor, useClaudeModels } from "../lib/claudeModels.ts";
import { ModelCombobox } from "./ModelCombobox.tsx";
import { RICH_SELECT, Select } from "./ui.tsx";

/** Effort, offering only the levels this Claude model takes (none for Haiku). */
export function EffortSelect({
  model, value, onChange, disabled, className = "", notes, labelled,
}: {
  model: string;
  value: Effort;
  onChange: (e: Effort) => void;
  disabled?: boolean;
  className?: string;
  /** Show each level's meaning next to it. */
  notes?: boolean;
  /** Say "high effort", not a bare "high": next to a model name a lone level does not read as a setting. */
  labelled?: boolean;
}) {
  const { result } = useClaudeModels();
  const { efforts, none } = effortsFor(model, result);
  const shown = efforts.includes(value) ? efforts : [...efforts, value];
  // The meaning of a level is a second line in the open list where the browser can draw one, and
  // part of the text where it cannot; the closed box only ever shows the level, so it never clips.
  return (
    <Select
      wide
      className={`font-mono ${className}`}
      value={value}
      disabled={disabled || none}
      title={none ? "This model has no effort setting" : `Effort: how long it may think before answering. Higher thinks more and costs more. ${EFFORT_NOTES[value]}`}
      onChange={(e) => onChange(e.target.value as Effort)}
    >
      {shown.map((ef) => {
        const note = !efforts.includes(ef) ? "not for this model" : notes ? EFFORT_NOTES[ef] : undefined;
        return (
          <option key={ef} value={ef} data-note={RICH_SELECT ? note : undefined}>
            {none ? "no effort setting" : note && !RICH_SELECT ? `${ef} — ${note}` : labelled ? `${ef} effort` : ef}
          </option>
        );
      })}
    </Select>
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
