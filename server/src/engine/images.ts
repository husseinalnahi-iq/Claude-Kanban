import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_PREFIX, IMAGE_PROVIDERS, IMAGE_SERVER, IMAGE_TOOL, type ImageProvider, type ImageStatus } from "../types.ts";

/**
 * Free image generation for runs, so a task that needs an illustration, an icon or a placeholder
 * photo can make one instead of stopping (docs/DECISIONS.md D262).
 *
 * Two backends, both free without a card:
 *  - Pollinations.ai — no account at all. Anonymous calls are rate-limited (about one every 15 s) and
 *    carry a small watermark; a free key (enter.pollinations.ai) removes the watermark and lifts the
 *    limit. The default, because it works the moment the board is installed.
 *  - Cloudflare Workers AI — FLUX.1 schnell on a free plan's daily allowance (10,000 neurons, roughly
 *    500 images), no watermark. Needs an account id and an API token from the Cloudflare dashboard.
 *
 * The board never keeps the image itself: it is written into the run's working folder, where the code
 * stage can reference it, and the tool returns the path.
 */
export { IMAGE_PREFIX, IMAGE_SERVER, IMAGE_TOOL };
export type { ImageProvider, ImageStatus };

export const isImageProvider = (v: unknown): v is ImageProvider => (IMAGE_PROVIDERS as readonly unknown[]).includes(v);

/** Names the keys are stored under in the secret store (never the values: docs/DECISIONS.md D125). */
export const POLLINATIONS_KEY_REF = "POLLINATIONS_API_KEY";
export const CLOUDFLARE_TOKEN_REF = "CLOUDFLARE_API_TOKEN";

export const POLLINATIONS_URL = "https://image.pollinations.ai";
export const CLOUDFLARE_URL = "https://api.cloudflare.com/client/v4";
/** The one free image model Cloudflare's free plan is sized for; other models cost more neurons. */
export const CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** Where a generated image lands when the caller names no file. */
export const DEFAULT_IMAGE_DIR = "generated-images";

const MIN_SIDE = 64;
const MAX_SIDE = 2048;
const MAX_PROMPT = 2000;
/** Pollinations answers a free request within a minute or so; a longer wait is a stuck call. */
const TIMEOUT_MS = 120_000;
/** Anonymous Pollinations allows about one call per 15 s: one retry after that covers a run that asks twice in a row. */
const RETRY_AFTER_MS = 16_000;

export interface ImageConfig {
  provider: ImageProvider;
  /** Optional: removes the watermark and lifts the anonymous limit. */
  pollinationsKey: string | null;
  cloudflareAccountId: string;
  cloudflareToken: string | null;
}

export interface ImageRequest {
  prompt: string;
  width?: number;
  height?: number;
  seed?: number;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  /** "jpeg" or "png", from the response, so the saved file gets the right extension. */
  format: "jpeg" | "png";
  provider: Exclude<ImageProvider, "off">;
}

export type FetchFn = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface GenerateOptions {
  fetchFn?: FetchFn;
  /** How long to wait before the one retry of a rate-limited call (tests shorten it). */
  retryAfterMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Which of the two the board would use, and why not, in plain words. */
export function imageReadiness(cfg: ImageConfig): { ready: boolean; detail: string } {
  switch (cfg.provider) {
    case "off":
      return { ready: false, detail: "Image generation is switched off in Settings." };
    case "cloudflare":
      if (!cfg.cloudflareAccountId || !cfg.cloudflareToken) return { ready: false, detail: "Cloudflare needs an account id and an API token in Settings → Images." };
      return { ready: true, detail: "Cloudflare Workers AI (FLUX.1 schnell), free daily allowance, no watermark." };
    default:
      return { ready: true, detail: cfg.pollinationsKey ? "Pollinations.ai with your free key: no watermark." : "Pollinations.ai without a key: free, a small watermark, about one image every 15 seconds." };
  }
}

/** A side clamped to what both providers accept, rounded to a multiple of 8 the models are happiest with. */
function side(n: number | undefined, fallback: number): number {
  const v = Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, n ?? fallback)));
  return v - (v % 8);
}

function formatOf(contentType: string | null): "jpeg" | "png" {
  return /png/i.test(contentType ?? "") ? "png" : "jpeg";
}

async function pollinations(req: ImageRequest, cfg: ImageConfig, fetchFn: FetchFn, retryAfterMs: number): Promise<GeneratedImage> {
  const params = new URLSearchParams({
    model: "flux",
    width: String(side(req.width, 1024)),
    height: String(side(req.height, 1024)),
    seed: String(req.seed ?? Math.floor(Math.random() * 1_000_000_000)),
    // Off the public feed: a task's prompt can describe an unreleased product.
    private: "true",
    referrer: "claude-kanban",
  });
  if (cfg.pollinationsKey) params.set("nologo", "true");
  const url = `${POLLINATIONS_URL}/prompt/${encodeURIComponent(req.prompt)}?${params}`;
  const headers: Record<string, string> = { accept: "image/*" };
  if (cfg.pollinationsKey) headers.authorization = `Bearer ${cfg.pollinationsKey}`;

  let res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429 || res.status >= 500) {
    // The free tier's one-every-15-seconds limit, or a busy GPU: one patient retry, then an honest error.
    await sleep(retryAfterMs);
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 429) throw new Error("Pollinations.ai is rate-limiting free requests right now (about one image every 15 seconds without a key). Wait a moment and try again, or add a free key in Settings → Images.");
    if (res.status === 401 || res.status === 403) throw new Error(`Pollinations.ai refused the key in Settings → Images (HTTP ${res.status}). ${text}`.trim());
    throw new Error(`Pollinations.ai answered HTTP ${res.status}. ${text}`.trim());
  }
  const type = res.headers.get("content-type");
  if (!/^image\//i.test(type ?? "")) throw new Error(`Pollinations.ai sent ${type ?? "no content type"} instead of an image.`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), format: formatOf(type), provider: "pollinations" };
}

async function cloudflare(req: ImageRequest, cfg: ImageConfig, fetchFn: FetchFn): Promise<GeneratedImage> {
  if (!cfg.cloudflareAccountId || !cfg.cloudflareToken) throw new Error("Cloudflare needs an account id and an API token in Settings → Images.");
  const url = `${CLOUDFLARE_URL}/accounts/${encodeURIComponent(cfg.cloudflareAccountId)}/ai/run/${CLOUDFLARE_MODEL}`;
  const body = JSON.stringify({ prompt: req.prompt.slice(0, 2048), steps: 4, ...(req.seed !== undefined ? { seed: req.seed } : {}) });
  const res = await fetchFn(url, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.cloudflareToken}`, "content-type": "application/json", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: { success?: boolean; result?: { image?: string }; image?: string; errors?: { message?: string }[] } = {};
  try {
    json = JSON.parse(text);
  } catch {
    // A non-JSON body is reported below with its status.
  }
  if (!res.ok || json.success === false) {
    const why = json.errors?.map((e) => e.message).filter(Boolean).join("; ") || text.slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new Error(`Cloudflare refused the API token in Settings → Images (HTTP ${res.status}). It needs the "Workers AI" permission. ${why}`.trim());
    if (res.status === 429) throw new Error(`Cloudflare's free daily allowance is used up (HTTP 429). It resets at midnight UTC. ${why}`.trim());
    throw new Error(`Cloudflare Workers AI answered HTTP ${res.status}. ${why}`.trim());
  }
  // The REST API wraps the model's answer in `result`; the docs' example shows the unwrapped shape.
  const b64 = json.result?.image ?? json.image;
  if (typeof b64 !== "string" || !b64) throw new Error("Cloudflare Workers AI answered without an image.");
  return { bytes: new Uint8Array(Buffer.from(b64, "base64")), format: "jpeg", provider: "cloudflare" };
}

/** One image from whichever provider Settings name. The caller decides where it goes. */
export async function generateImage(req: ImageRequest, cfg: ImageConfig, opts: GenerateOptions = {}): Promise<GeneratedImage> {
  const fetchFn = opts.fetchFn ?? (fetch as FetchFn);
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error("Say what the image should show.");
  if (prompt.length > MAX_PROMPT) throw new Error(`Keep the description under ${MAX_PROMPT} characters.`);
  const r = { ...req, prompt };
  switch (cfg.provider) {
    case "off": throw new Error("Image generation is switched off in Settings → Images.");
    case "cloudflare": return cloudflare(r, cfg, fetchFn);
    default: return pollinations(r, cfg, fetchFn, opts.retryAfterMs ?? RETRY_AFTER_MS);
  }
}

/** A file name from the first words of the prompt: "a red bicycle, studio photo" → "a-red-bicycle-studio-photo". */
export function slug(prompt: string): string {
  const s = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return s || "image";
}

/**
 * Where an image is saved: inside `cwd`, never above it, never over a file that is already there.
 * A relative `file` is taken as given (its extension corrected to what came back); none means
 * `generated-images/<slug>-<n>.<ext>`.
 */
export function imagePath(cwd: string, file: string | undefined, prompt: string, format: "jpeg" | "png"): string {
  const ext = format === "png" ? ".png" : ".jpg";
  let target: string;
  if (file?.trim()) {
    const abs = insideProject(cwd, file);
    const known = [".jpg", ".jpeg", ".png"].includes(extname(abs).toLowerCase());
    target = known ? abs.slice(0, -extname(abs).length) + ext : abs + ext;
  } else {
    target = join(resolve(cwd), DEFAULT_IMAGE_DIR, slug(prompt) + ext);
  }
  // Never overwrite: a second image for the same prompt gets "-2", and a file the project already had stays.
  const base = target.slice(0, -ext.length);
  let candidate = target;
  for (let n = 2; existsSync(candidate); n++) candidate = `${base}-${n}${ext}`;
  return candidate;
}

/** The absolute path a caller's file name means, or an error when it would leave the project. Checked before any image is made. */
export function insideProject(cwd: string, file: string): string {
  const given = file.trim();
  const abs = isAbsolute(given) ? resolve(given) : resolve(cwd, given);
  const rel = relative(resolve(cwd), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`The image must be saved inside the project (${cwd}); refused ${given}.`);
  return abs;
}

export function saveImage(cwd: string, file: string | undefined, prompt: string, image: GeneratedImage): string {
  const path = imagePath(cwd, file, prompt, image.format);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, image.bytes);
  return path;
}

export const TOOL_NAME = "generate_image";
export const TOOL_DESCRIPTION =
  "Make an image from a description with a free AI image model and save it inside the project. Returns the file path. " +
  "Good for illustrations, icons, hero images, placeholder photos and mock-ups; not for exact text, logos of real brands, or diagrams that must be precise. " +
  "Each image takes about 10–30 seconds. Describe the subject, style, colours and framing in one or two sentences.";
export const TOOL_INPUT = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT).describe("What the image should show, in plain words: subject, style, colours, framing."),
  file: z.string().max(400).optional().describe("Where to save it, relative to the project (for example public/images/hero.jpg). Default: generated-images/<name>.jpg. Never overwrites an existing file."),
  width: z.number().int().min(MIN_SIDE).max(MAX_SIDE).optional().describe("Width in pixels (default 1024). Cloudflare always makes 1024×1024."),
  height: z.number().int().min(MIN_SIDE).max(MAX_SIDE).optional().describe("Height in pixels (default 1024)."),
  seed: z.number().int().min(0).optional().describe("Same description + same seed = same image. Leave out for a fresh one."),
});
export type ToolInput = z.infer<typeof TOOL_INPUT>;

/** The Claude Kanban folder (the one with both workspaces), for the command that points Claude Code at the stdio entry. */
export function boardDir(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
}

/** The arguments after `claude` that give your own Claude Code the same tool: the board's own tsx runs the stdio entry, so nothing is installed globally. */
export function claudeCodeArgs(dir = boardDir()): string[] {
  return ["mcp", "add", "--scope", "user", IMAGE_SERVER, "--", "node", join(dir, "node_modules", "tsx", "dist", "cli.mjs"), join(dir, "server", "src", "imageMcp.ts")];
}

/** The same as one line to paste, the two paths quoted for a folder with spaces in it (the default install is `C:\Users\<you>\Claude Kanban`). */
export function claudeCodeCommand(dir = boardDir()): string {
  return ["claude", ...claudeCodeArgs(dir).map((a) => (a.includes("/") || a.includes("\\") ? `"${a.replace(/"/g, "")}"` : a))].join(" ");
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const fail = (message: string) => ({ ...text(message), isError: true });

export interface ImageServerDeps {
  cwd: string;
  config: () => ImageConfig;
  fetchFn?: FetchFn;
  /** Told about every image made, so the run's record can show it. */
  onImage?: (info: { path: string; prompt: string; provider: string; bytes: number }) => void;
}

/** The tool's handler, apart from the MCP wrapper so tests can call it directly. */
export function imageHandlers(deps: ImageServerDeps) {
  return {
    async generate(args: ToolInput) {
      const cfg = deps.config();
      // A path that would leave the project is refused before a picture is made for nothing.
      if (args.file?.trim()) {
        try {
          insideProject(deps.cwd, args.file);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      let image: GeneratedImage;
      try {
        image = await generateImage(args, cfg, { fetchFn: deps.fetchFn });
      } catch (e) {
        return fail(`Could not make the image: ${(e as Error).message}`);
      }
      let path: string;
      try {
        path = saveImage(deps.cwd, args.file, args.prompt, image);
      } catch (e) {
        return fail((e as Error).message);
      }
      deps.onImage?.({ path, prompt: args.prompt, provider: image.provider, bytes: image.bytes.length });
      const rel = relative(deps.cwd, path).split("\\").join("/");
      return text(
        `Saved ${rel} (${Math.round(image.bytes.length / 1024)} KB, ${image.format}, made by ${image.provider === "cloudflare" ? "Cloudflare Workers AI" : "Pollinations.ai"}). ` +
          "Look at it with Read if what it shows matters; ask again with a more precise description or another seed if it does not fit.",
      );
    },
  };
}

/** The `images` MCP server a run gets when Settings → Images is on: one tool, `generate_image`. */
export function createImageServer(deps: ImageServerDeps): McpServerConfig {
  const h = imageHandlers(deps);
  return createSdkMcpServer({
    name: IMAGE_SERVER,
    version: "1.0.0",
    tools: [tool(TOOL_NAME, TOOL_DESCRIPTION, TOOL_INPUT.shape, async (args) => h.generate(args))],
  });
}
