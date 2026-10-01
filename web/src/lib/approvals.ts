import type { Approval } from "../../../server/src/types.ts";

/** The one line that says what a card wants to do: the command, the file, the pattern. */
export function inputSummary(a: Approval): string {
  const i = (a.input ?? {}) as Record<string, unknown>;
  const first = (i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.prompt ?? "") as string;
  return typeof first === "string" ? first : "";
}
