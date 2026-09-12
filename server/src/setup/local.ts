import { statfsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import type { Probe } from "./probe.ts";
import type { Settings } from "../types.ts";
import { isLmStudio, isOllama, MIN_AGENT_CONTEXT } from "../engine/providers/catalog.ts";

/**
 * What the "Free AI on this computer" guide needs to know: the machine, and how far along LM Studio
 * and Ollama are (installed, server on, models downloaded). Everything is read, nothing is changed.
 */

export interface Hardware {
  gpu: string | null;
  /** Memory the model can run from at full speed: the graphics card's, or a share of Apple's unified memory. */
  vramGB: number | null;
  ramGB: number;
  diskFreeGB: number | null;
  unified: boolean;
}

export interface LocalApp {
  installed: boolean;
  running: boolean;
  /** Server answered 401/403: "Require authentication" is on. */
  locked?: boolean;
  models: { id: string; loaded?: boolean; contextLength?: number }[];
  /** Is it on the board (Settings → Providers), and switched on? */
  added: boolean;
  url: string;
}

export interface Pick {
  name: string;
  /** What to type into the app's search box. */
  search: string;
  /** LM Studio's model key (`lms get <key>`), when it is known for certain. */
  key?: string;
  sizeGB: number;
  /** Mixture-of-experts: only a few billion parameters work per word, so it runs well partly from RAM. */
  moe: boolean;
  note: string;
  verdict: "fast" | "ok" | "slow" | "too-big";
}

export interface LocalModelsStatus {
  hardware: Hardware;
  budget: { fastGB: number | null; okGB: number };
  picks: Pick[];
  lmstudio: LocalApp;
  ollama: LocalApp & { signedInHint: boolean };
  minContext: number;
}

/**
 * A short list of good current models for coding stages, with their download size (Q4, as the apps
 * pick by default; sizes with a `key` are LM Studio's own figures, the rest are close estimates).
 * Model names date quickly: refresh this list, the verdict logic stays.
 * Updated September 2026 from LM Studio's staff picks.
 */
export const PICKS: Omit<Pick, "verdict">[] = [
  { name: "Gemma 4 12B", search: "gemma 4 12b qat", key: "google/gemma-4-12b-qat", sizeGB: 7.4, moe: false, note: "small and quick: simple edits, reviews, plan critique" },
  { name: "Gemma 4 26B A4B", search: "gemma 4 26b a4b qat", key: "google/gemma-4-26b-a4b-qat", sizeGB: 15.6, moe: true, note: "good all-rounder, trained for tools" },
  { name: "GLM 4.7 Flash", search: "glm 4.7 flash", sizeGB: 18, moe: true, note: "strong at coding for its size" },
  { name: "Qwen3.6 35B A3B", search: "qwen3.6 35b a3b", sizeGB: 21, moe: true, note: "the smartest that still runs well on a laptop" },
  { name: "Qwen3.8 27B", search: "qwen3.8 27b", key: "qwen/qwen3.8-27b", sizeGB: 16.1, moe: false, note: "smart, but every part works on every word: best with a 16 GB+ graphics card" },
];

/** The two the Setup page offers as one-click downloads: a small one, and one for a strong PC. */
export const SETUP_PICKS = ["google/gemma-4-12b-qat", "qwen/qwen3.8-27b"];

/**
 * How well a download of this size runs here. "fast": fits in graphics memory with room for 32k of
 * context. "ok": spills a little (a dense model) or a lot (mixture-of-experts, which only uses a small
 * part at a time) into RAM. Anything else is slow, or does not fit at all.
 */
export function verdictFor(sizeGB: number, moe: boolean, hw: Hardware): Pick["verdict"] {
  const { fastGB, okGB } = budgetOf(hw);
  const disk = hw.diskFreeGB ?? Infinity;
  if (sizeGB + 3 > disk || sizeGB > okGB + 4) return "too-big";
  if (fastGB !== null && sizeGB <= fastGB) return "fast";
  if (moe ? sizeGB <= okGB : hw.vramGB !== null && sizeGB <= hw.vramGB + 2) return "ok";
  return "slow";
}

function budgetOf(hw: Hardware): LocalModelsStatus["budget"] {
  const fastGB = hw.vramGB === null ? null : Math.max(0, Math.floor(hw.vramGB - 2));
  const okGB = Math.max(0, Math.floor((hw.unified ? hw.ramGB * 0.65 : (hw.vramGB ?? 0) + hw.ramGB * 0.6) - 4));
  return { fastGB, okGB };
}

/** The verdict in words, for the Setup page. */
export function verdictText(v: Pick["verdict"], hw: Hardware): string {
  if (v === "fast") return "runs fast on this computer";
  if (v === "ok") return "runs well on this computer";
  if (v === "slow") return `will be slow here${hw.vramGB ? ` (${hw.vramGB} GB graphics card)` : ""}: best with 16 GB+ of graphics memory`;
  return "too big for this computer";
}

export function judge(hw: Hardware): { budget: LocalModelsStatus["budget"]; picks: Pick[] } {
  return { budget: budgetOf(hw), picks: PICKS.map((p) => ({ ...p, verdict: verdictFor(p.sizeGB, p.moe, hw) })) };
}

/** LM Studio's command-line tool, which it installs for you on first launch. */
export function lmsPath(probe: Probe): string {
  const home = probe.env.USERPROFILE ?? probe.env.HOME ?? homedir();
  return join(home, ".lmstudio", "bin", probe.platform === "win32" ? "lms.exe" : "lms");
}

let hardwareCache: Hardware | null = null;

export async function hardware(probe: Probe): Promise<Hardware> {
  if (hardwareCache) return hardwareCache;
  const ramGB = Math.round(totalmem() / 1024 ** 3);
  let diskFreeGB: number | null = null;
  try {
    const s = statfsSync(homedir());
    diskFreeGB = Math.round((s.bavail * s.bsize) / 1024 ** 3);
  } catch {
    // unknown is fine
  }
  if (probe.platform === "darwin" && process.arch === "arm64") {
    return (hardwareCache = { gpu: "Apple silicon (shares the computer's memory)", vramGB: Math.round(ramGB * 0.65), ramGB, diskFreeGB, unified: true });
  }
  let gpu: string | null = null;
  let vramGB: number | null = null;
  const nv = await probe.run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeoutMs: 5000 });
  if (nv.code === 0 && nv.stdout.trim()) {
    const [name, mib] = nv.stdout.trim().split(/\r?\n/)[0].split(",").map((s) => s.trim());
    gpu = name;
    vramGB = Math.round(Number(mib) / 1024) || null;
  } else if (probe.platform === "win32") {
    const r = await probe.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name"], { timeoutMs: 8000 });
    gpu = r.code === 0 ? r.stdout.trim() || null : null;
  }
  return (hardwareCache = { gpu, vramGB, ramGB, diskFreeGB, unified: false });
}

const origin = (url: string | undefined, fallback: string) => {
  try {
    return new URL(url || fallback).origin;
  } catch {
    return fallback;
  }
};

async function lmStudio(probe: Probe, settings: Settings): Promise<LocalApp> {
  const p = settings.providers.find(isLmStudio);
  const url = origin(p?.baseUrl, "http://localhost:1234");
  const home = homedir();
  const out: LocalApp = { installed: false, running: false, models: [], added: Boolean(p?.enabled), url };
  try {
    const j = (await probe.fetchJson(`${url}/api/v1/models`, 2000)) as {
      models?: { type?: string; key: string; loaded_instances?: { id: string; config?: { context_length?: number } }[] }[];
    };
    out.running = true;
    out.models = (j.models ?? [])
      .filter((m) => m.type !== "embedding")
      .map((m) => ({ id: m.loaded_instances?.[0]?.id ?? m.key, loaded: Boolean(m.loaded_instances?.length), contextLength: m.loaded_instances?.[0]?.config?.context_length }));
  } catch (err) {
    if (/HTTP 40[13]/.test(err instanceof Error ? err.message : "")) out.running = out.locked = true;
  }
  out.installed = out.running || probe.exists(lmsPath(probe)) || probe.exists(join(home, ".lmstudio")) ||
    (probe.platform === "win32" && probe.exists(join(probe.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "LM Studio"))) ||
    (probe.platform === "darwin" && probe.exists("/Applications/LM Studio.app"));
  return out;
}

async function ollama(probe: Probe, settings: Settings): Promise<LocalModelsStatus["ollama"]> {
  const p = settings.providers.find(isOllama);
  const url = origin(p?.baseUrl, "http://localhost:11434");
  const out: LocalModelsStatus["ollama"] = { installed: false, running: false, models: [], added: Boolean(p?.enabled), url, signedInHint: false };
  try {
    const j = (await probe.fetchJson(`${url}/api/tags`, 2000)) as { models?: { name: string; remote_host?: string }[] };
    out.running = true;
    out.models = (j.models ?? []).map((m) => ({ id: m.name.replace(/:latest$/, "") }));
    // A pulled cloud model means `ollama signin` worked at some point.
    out.signedInHint = (j.models ?? []).some((m) => m.remote_host || /[-:]cloud$/.test(m.name));
  } catch {
    // not running
  }
  if (!out.running) {
    const v = await probe.run("ollama", ["--version"], { timeoutMs: 5000 });
    const local = probe.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    out.installed = v.code === 0 || (probe.platform === "win32" && probe.exists(join(local, "Programs", "Ollama", "ollama.exe"))) ||
      (probe.platform === "darwin" && probe.exists("/Applications/Ollama.app"));
  } else {
    out.installed = true;
  }
  return out;
}

export async function localModelsStatus(probe: Probe, settings: Settings): Promise<LocalModelsStatus> {
  const [hw, lms, oll] = await Promise.all([hardware(probe), lmStudio(probe, settings), ollama(probe, settings)]);
  return { hardware: hw, ...judge(hw), lmstudio: lms, ollama: oll, minContext: MIN_AGENT_CONTEXT };
}

/** Tests only. */
export function resetHardwareCache(): void {
  hardwareCache = null;
}
