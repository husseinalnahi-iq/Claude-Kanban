import { useEffect, useMemo, useState } from "react";
import { memoryFacts, type MemoryFacts, type MemoryInput } from "../../../server/src/engine/memory.ts";
import { api } from "./api.ts";

/** A clock that moves once a minute: memory cools with time, not with events. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * What each card of a project remembers (D374), drawn with the server's own rules. `key` changes when the
 * cards do (a run ends, a card lands), which is when the stored facts can have changed.
 */
export function useProjectMemory(projectId: string | null, key: string): Record<string, MemoryFacts> {
  const [inputs, setInputs] = useState<Record<string, MemoryInput>>({});
  const now = useMinute();
  useEffect(() => {
    if (!projectId) return setInputs({});
    let gone = false;
    // Several cards change at once when a run ends: one fetch for the burst.
    const t = setTimeout(() => {
      api.projectMemory(projectId).then((m) => !gone && setInputs(m), () => {});
    }, 400);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [projectId, key]);
  return useMemo(() => Object.fromEntries(Object.entries(inputs).map(([id, i]) => [id, memoryFacts(i, now)])), [inputs, now]);
}

/** One card's memory, for its drawer. */
export function useTaskMemory(taskId: string, key: string): MemoryFacts | null {
  const [input, setInput] = useState<MemoryInput | null>(null);
  const now = useMinute();
  useEffect(() => {
    let gone = false;
    api.taskMemory(taskId).then((m) => !gone && setInput(m), () => {});
    return () => {
      gone = true;
    };
  }, [taskId, key]);
  return useMemo(() => (input ? memoryFacts(input, now) : null), [input, now]);
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

/** The memory in one plain sentence, for a tooltip or a line under a bar. */
export function memoryLine(m: MemoryFacts): string {
  if (m.memory === "warm") return m.warmUntil ? `Memory warm until ${clock(m.warmUntil)}: a follow-up continues it at about a tenth of the price.` : "Working now: it remembers everything so far.";
  if (m.memory === "cool") return `Memory cooled: a follow-up reads it once again first.${m.keptUntil ? ` Kept until ${day(m.keptUntil)}.` : ""}`;
  return "Memory gone: a follow-up becomes a new card told what this one did.";
}
