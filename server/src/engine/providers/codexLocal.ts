import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { EFFORTS, type CatalogModel, type Effort, type Provider, type Settings, type Stage, type TierRef } from "../../types.ts";
import { spawnCli, type SpawnFn } from "./cli/spawn.ts";

/**
 * What this computer's Codex is and knows: where the command is, which account it is signed in to,
 * the models that account offers with the effort levels each takes (D294, D298), and making a picture
 * with it (D297). Server-only; nothing here reads Codex's tokens file.
 */

export const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");

function onPath(name: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  if (runImpl !== realRunCodex) return false;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of ["", ...exts]) if (existsSync(join(dir, `${name}${ext}`))) return true;
  }
  return false;
}

type RunCodex = (command: string, args: string[], timeoutMs?: number) => Promise<{ code: number | null; out: string }>;

/** Test seam: tests answer for Codex instead of running the one on this computer. */
let runImpl: RunCodex = realRunCodex;
export function setCodexRunner(fn: RunCodex | null): void {
  runImpl = fn ?? realRunCodex;
  forgetCodexStatus();
}
export const runCodex: RunCodex = (command, args, timeoutMs) => runImpl(command, args, timeoutMs);

/** Runs a short Codex command with fixed arguments. A bare `codex` on Windows is a .cmd shim and needs cmd. */
function realRunCodex(command: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  const viaCmd = process.platform === "win32" && !/[\\/]/.test(command);
  const [file, argv] = viaCmd ? ["cmd.exe", ["/d", "/s", "/c", command, ...args]] : [command, args];
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/**
 * Where the Codex app keeps its own command. Windows: the Store package, asked of Windows because its
 * folder is versioned and WindowsApps cannot be listed (its older copy under ~/.codex/.sandbox-bin is
 * refused current models by OpenAI). Mac: the app has moved it between releases, so each known place is
 * tried — t3code#14110, cc-connect#1927 — and only one that answers its version is used.
 */
async function appCodexCandidates(): Promise<string[]> {
  if (runImpl !== realRunCodex) return []; // a test answers for Codex: never ask this computer
  if (process.platform === "win32") {
    const dir = await new Promise<string>((resolve) =>
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation"],
        { timeout: 10_000, windowsHide: true },
        (err, stdout) => resolve(err ? "" : String(stdout).trim()),
      ),
    );
    return dir ? [join(dir, "app", "resources", "codex.exe")] : [];
  }
  if (process.platform === "darwin") {
    const roots = ["/Applications", join(homedir(), "Applications")];
    const apps = ["Codex.app", "ChatGPT.app"];
    const inside = ["Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "Contents/Resources/codex"];
    return roots.flatMap((r) => apps.flatMap((a) => inside.map((i) => join(r, a, i))));
  }
  return [];
}

let found: { at: number; command: string } | null = null;

/**
 * `codex` when the CLI is installed (npm i -g @openai/codex); otherwise the Codex app's own command,
 * so a ChatGPT plan already signed in through the app works without installing anything (D294, D296).
 * Looked up again after ten minutes, so installing or updating either is picked up without a restart.
 */
export async function codexCommand(): Promise<string> {
  if (found && Date.now() - found.at < 10 * 60_000) return found.command;
  let command = "codex";
  if (!onPath("codex")) {
    for (const c of await appCodexCandidates()) {
      if (existsSync(c) && (await runCodex(c, ["--version"], 10_000)).code === 0) {
        command = c;
        break;
      }
    }
  }
  found = { at: Date.now(), command };
  return command;
}

export interface CodexStatus {
  /** Codex answered its version. */
  found: boolean;
  command: string;
  version: string | null;
  /** Which account it runs on: a ChatGPT plan, an API key, or none yet. */
  signedIn: "chatgpt" | "api-key" | null;
  /** Codex's own words for the sign-in. */
  line: string;
}

/** `login status` in Codex's words, read as which account it runs on. Pure, for tests. */
export function readLoginStatus(code: number | null, out: string): Pick<CodexStatus, "signedIn" | "line"> {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (code !== 0) return { signedIn: null, line };
  return { signedIn: /api key/i.test(line) ? "api-key" : /chatgpt/i.test(line) ? "chatgpt" : null, line };
}

let status: { at: number; value: CodexStatus } | null = null;

/** Found, which version, signed in to what. Asked of Codex itself and kept a minute. */
export async function codexStatus(force = false): Promise<CodexStatus> {
  if (!force && status && Date.now() - status.at < 60_000) return status.value;
  const command = await codexCommand();
  const v = await runCodex(command, ["--version"], 10_000);
  const version = v.code === 0 ? (v.out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null) : null;
  let login: Pick<CodexStatus, "signedIn" | "line"> = { signedIn: null, line: "" };
  if (version) {
    const r = await runCodex(command, ["login", "status"], 10_000);
    login = readLoginStatus(r.code, r.out);
  }
  const value: CodexStatus = { found: Boolean(version), command, version, ...login };
  status = { at: Date.now(), value };
  return value;
}

/** Forget what was learned, after a sign-in or an install. */
export function forgetCodexStatus(): void {
  status = null;
  found = null;
  live = null;
}

interface CatalogEntry {
  slug?: string;
  display_name?: string;
  visibility?: string;
  supported_in_api?: boolean;
  context_window?: number;
  supported_reasoning_levels?: { effort?: string }[];
  priority?: number;
}

let cache: { file: string; mtime: number; models: CatalogEntry[] } | null = null;

/** Codex's own copy of the account's models (`models_cache.json`), when it cannot be asked. */
function cachedModels(): CatalogEntry[] | null {
  const file = join(codexHome(), "models_cache.json");
  try {
    const mtime = statSync(file).mtimeMs;
    if (cache?.file === file && cache.mtime === mtime) return cache.models;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: CatalogEntry[] };
    cache = { file, mtime, models: Array.isArray(parsed.models) ? parsed.models : [] };
    return cache.models;
  } catch {
    return null;
  }
}

let live: { at: number; models: CatalogEntry[] } | null = null;

/**
 * The account's models as Codex fetches them now (`codex debug models`: free, no model call), kept ten
 * minutes; the cache file when Codex cannot answer. A newer model shows up without waiting for Codex
 * to run (D298).
 */
async function accountModels(): Promise<CatalogEntry[] | null> {
  if (live && Date.now() - live.at < 10 * 60_000) return live.models;
  try {
    const r = await runCodex(await codexCommand(), ["debug", "models"], 30_000);
    if (r.code === 0) {
      // The JSON may follow a log line: start at its first bracket.
      const at = r.out.search(/[[{]/);
      const body = JSON.parse(r.out.slice(Math.max(0, at))) as { models?: CatalogEntry[] } | CatalogEntry[];
      const models = Array.isArray(body) ? body : body.models ?? [];
      if (models.length) {
        live = { at: Date.now(), models };
        return models;
      }
    }
  } catch {
    // Not installed, or an answer that is not JSON: the cache file still knows what Codex last saw.
  }
  return cachedModels();
}

/** Whether a Codex provider runs on the signed-in ChatGPT plan or on an API key (D293). */
export function codexAuth(provider: Pick<Provider, "cli" | "authRef">, hasKey: (name: string) => boolean): "login" | "api-key" {
  if (provider.cli?.auth) return provider.cli.auth;
  // Older boards have one Codex entry for both: a key set means the key, none means the login.
  return provider.authRef && hasKey(provider.authRef) ? "api-key" : "login";
}

const boardEfforts = (m: CatalogEntry): Effort[] =>
  (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is Effort => EFFORTS.includes(e as Effort));

/** Models OpenAI refused to this account although Codex lists them ("does not exist or you do not have access"). */
const refused = new Set<string>();
export function noteCodexRefused(model: string): void {
  refused.add(model);
}

/** Pure: the account's catalog as picker rows. On a plan, every listed model; with a key, only those the API serves. */
export function codexRows(models: CatalogEntry[], auth: "login" | "api-key"): CatalogModel[] {
  return models
    .filter((m) => m.slug && m.visibility === "list" && (auth === "login" || m.supported_in_api !== false))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => ({
      id: m.slug!,
      label: m.display_name || m.slug!,
      group: auth === "login" ? ("plan" as const) : ("paid" as const),
      ...(m.context_window ? { contextWindow: m.context_window } : {}),
      ...(boardEfforts(m).length ? { efforts: boardEfforts(m) } : {}),
      ...(refused.has(m.slug!) ? { warning: "Listed, but OpenAI refused it to this account" } : {}),
    }));
}

/** The models Codex offers its account, for the picker. null when Codex has never run here. */
export async function codexModels(auth: "login" | "api-key"): Promise<CatalogModel[] | null> {
  const models = await accountModels();
  return models ? codexRows(models, auth) : null;
}

/** The board's effort levels a Codex model takes, from what is already known; null when Codex has not said. */
export function codexEfforts(model: string): Effort[] | null {
  const m = (live?.models ?? cachedModels())?.find((x) => x.slug === model);
  const levels = m ? boardEfforts(m) : [];
  return levels.length ? levels : null;
}

/**
 * The reasoning effort to ask Codex for: the stage's own when the model takes it, else the nearest
 * level below it (above it only when there is none below). Codex takes low to max now; mapping xhigh
 * and max down to high threw away what the stage asked for.
 */
export function codexEffort(model: string, effort: Effort): Effort {
  const levels = codexEfforts(model);
  if (!levels || levels.includes(effort)) return effort;
  const want = EFFORTS.indexOf(effort);
  const below = levels.filter((l) => EFFORTS.indexOf(l) <= want).sort((a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a));
  return below[0] ?? [...levels].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}

/** "gpt-6.1-sol" → { family: "sol", version: 6.1 }; null for a name without that shape. */
export function codexFamily(id: string): { family: string; version: number } | null {
  const m = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/i.exec(id.trim());
  return m ? { family: m[2].toLowerCase(), version: Number(m[1]) } : null;
}

/** The newest listed model of a family ("sol"), or null. */
export function newestOf(rows: Pick<CatalogModel, "id">[], family: string): string | null {
  let best: { id: string; version: number } | null = null;
  for (const r of rows) {
    const f = codexFamily(r.id);
    if (f && f.family === family && (!best || f.version > best.version)) best = { id: r.id, version: f.version };
  }
  return best?.id ?? null;
}

/** The plan-debate critic when Codex is linked: the newest Sol, else the first model Codex lists (D299). */
export const criticModel = (rows: Pick<CatalogModel, "id">[]): string | null => newestOf(rows, "sol") ?? rows[0]?.id ?? null;

/** The model that makes pictures when none is chosen: the newest Luna (cheap), else the first listed (D297). */
export const pictureModel = (rows: Pick<CatalogModel, "id">[]): string | null => newestOf(rows, "luna") ?? rows[0]?.id ?? null;

export interface CodexMove {
  where: string;
  from: string;
  to: string;
  label: string;
}

/**
 * Pure: every Codex pick in Settings that has a newer model of its own family on the account (GPT-6
 * Luna → GPT-6.1 Luna), and the patch that moves them. Tasks already on the board are not touched (D298).
 */
export function codexUpgrades(s: Pick<Settings, "debate" | "tiers" | "defaultPipeline" | "imageModel" | "providers">, rows: Pick<CatalogModel, "id">[]): { moves: CodexMove[]; patch: Partial<Settings> } {
  const codexIds = new Set(s.providers.filter((p) => p.kind === "cli" && p.cli?.preset === "codex").map((p) => p.id));
  const moves: CodexMove[] = [];
  const newer = (id: string): string | null => {
    const f = codexFamily(id);
    const best = f ? newestOf(rows, f.family) : null;
    return best && best !== id && codexFamily(best)!.version > f!.version ? best : null;
  };
  const patch: Partial<Settings> = {};
  const c = s.debate.critic;
  if (codexIds.has(c.provider)) {
    const to = newer(c.model);
    if (to) {
      moves.push({ where: "plan debate critic", from: c.model, to, label: to });
      patch.debate = { ...s.debate, critic: { ...c, model: to } };
    }
  }
  let tiersMoved = false;
  const tiers = { ...s.tiers };
  for (const k of ["cheap", "balanced", "strong"] as const) {
    const t: TierRef = s.tiers[k];
    const to = codexIds.has(t.provider) ? newer(t.model) : null;
    if (to) {
      moves.push({ where: `right-sizing, ${k}`, from: t.model, to, label: to });
      tiers[k] = { ...t, model: to };
      tiersMoved = true;
    }
  }
  if (tiersMoved) patch.tiers = tiers;
  let pipeMoved = false;
  const pipeline: Stage[] = s.defaultPipeline.map((st, i) => {
    const to = st.provider && codexIds.has(st.provider) ? newer(st.model) : null;
    if (!to) return st;
    moves.push({ where: `default pipeline, stage ${i + 1} (${st.stage})`, from: st.model, to, label: to });
    pipeMoved = true;
    return { ...st, model: to };
  });
  if (pipeMoved) patch.defaultPipeline = pipeline;
  if (s.imageModel) {
    const to = newer(s.imageModel);
    if (to) {
      moves.push({ where: "pictures", from: s.imageModel, to, label: to });
      patch.imageModel = to;
    }
  }
  return { moves, patch };
}

// ---------------------------------------------------------------- pictures (D297)

/** What a picture request to Codex came to: the picture, or why Codex could not make one here. */
export type CodexPicture = { ok: true; bytes: Uint8Array; format: "png" | "jpeg" | "webp" } | { ok: false; unavailable: boolean; reason: string };

/** Extras Codex would otherwise load into a picture request; each one costs input tokens and none of them draws. */
const LEAN = ["apps", "plugins", "browser_use", "computer_use", "in_app_browser"].flatMap((f) => ["--disable", f]);
const NOT_HERE = /not available|isn['’]t available|unavailable|can['’]t access|cannot access|not exposed/i;

function newestPicture(dir: string, since: number): string | null {
  let best: { path: string; at: number } | null = null;
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 2) walk(p, depth + 1);
      } else if (/\.(png|jpe?g|webp)$/i.test(n) && st.mtimeMs >= since && (!best || st.mtimeMs > best.at)) best = { path: p, at: st.mtimeMs };
    }
  };
  walk(dir, 0);
  return best ? (best as { path: string }).path : null;
}

/**
 * Asks Codex for one picture with its built-in image tool, on the signed-in account, in a throwaway
 * folder, and reads the file where Codex saves it (`$CODEX_HOME/generated_images/<thread>/`). Codex's
 * extras are switched off: a picture request with them read 118k tokens, without them 9k. On Windows
 * `codex exec` does not offer the image tool today (openai/codex#19133): that comes back `unavailable`.
 */
export async function codexPicture(
  req: { prompt: string; model: string; width?: number; height?: number },
  opts: { env: Record<string, string>; timeoutMs?: number; spawnFn?: SpawnFn },
): Promise<CodexPicture> {
  const command = await codexCommand();
  const work = mkdtempSync(join(tmpdir(), "kanban-codex-picture-"));
  const since = Date.now() - 1000;
  const shape = req.width && req.height ? (req.width > req.height * 1.2 ? "landscape" : req.height > req.width * 1.2 ? "portrait" : "square") : "square";
  const prompt = [
    `Use your built-in image generation tool to create this image (${shape}): ${req.prompt}`,
    "After it is generated, STOP. Do not move, copy, rename or save the file anywhere, and do not run commands. Reply with one short line.",
  ].join("\n");
  let thread = "";
  let said = "";
  try {
    const result = await spawnCli(
      { command, args: ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-m", req.model, "-c", "model_reasoning_effort=low", ...LEAN, "-C", work, "-"] },
      {
        stdin: prompt,
        onLine: (line) => {
          try {
            const ev = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string }; message?: string; error?: { message?: string } };
            if (ev.type === "thread.started" && ev.thread_id) thread = ev.thread_id;
            if (ev.item?.type === "agent_message" && ev.item.text) said = ev.item.text;
            if (ev.type === "turn.failed") said = ev.error?.message ?? said;
          } catch {
            // a log line, not an event
          }
        },
        onStderr: () => {},
      },
      { cwd: work, env: opts.env, timeoutMs: opts.timeoutMs ?? 180_000, abort: new AbortController().signal, spawnFn: opts.spawnFn },
    );
    const images = join(codexHome(), "generated_images");
    // Its own thread's folder only: another picture being made at the same time must not be taken for it.
    const file = thread ? newestPicture(join(images, thread), since) : null;
    if (file) {
      const ext = extname(file).toLowerCase();
      return { ok: true, bytes: new Uint8Array(readFileSync(file)), format: ext === ".webp" ? "webp" : ext === ".png" ? "png" : "jpeg" };
    }
    if (result.timedOut) return { ok: false, unavailable: false, reason: "Codex took too long to make the picture." };
    return NOT_HERE.test(said)
      ? { ok: false, unavailable: true, reason: "Codex on this computer does not offer its image tool to the board yet (a known Codex limitation on Windows)." }
      : { ok: false, unavailable: false, reason: said ? `Codex made no picture: ${said.slice(0, 300)}` : "Codex made no picture." };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
