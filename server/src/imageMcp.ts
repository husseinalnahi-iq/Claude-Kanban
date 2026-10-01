/**
 * The image tool for your own Claude Code: `claude mcp add --scope user images -- node <tsx> <this file>`
 * (Settings → Browser, images & plugins has the exact line, and Setup adds it in one click, D263).
 *
 * A stdio MCP server, written by hand: the protocol is small (initialize, tools/list, tools/call), and
 * the board's runs already get the same tool in-process from the Agent SDK. It reads the board's own
 * settings and secrets, so the picture maker and key you chose there apply here too, and works without
 * the board running. With no maker ready it answers each call with what is missing (D303).
 *
 * stdout is the wire; anything to say goes to stderr.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DB_PATH, SECRETS_PATH } from "./config.ts";
import { SecretStore } from "./secrets.ts";
import { z } from "zod";
import { CLOUDFLARE_TOKEN_REF, POLLINATIONS_KEY_REF, TOOL_DESCRIPTION, TOOL_INPUT, TOOL_NAME, imageHandlers, type ImageConfig, type ToolInput } from "./engine/images.ts";
import { IMAGE_SERVER, type ImageProvider, type Settings } from "./types.ts";
import { codexImagePart } from "./engine/codexImages.ts";

const cwd = process.env.KANBAN_IMAGE_DIR || process.cwd();

/** Settings → Images as the board stores them; the defaults when there is no board database yet. */
async function config(): Promise<ImageConfig> {
  const secrets = new SecretStore(SECRETS_PATH);
  let provider: ImageProvider = "codex";
  let cloudflareAccountId = "";
  let settings: Settings | null = null;
  if (existsSync(DB_PATH)) {
    try {
      const { openDb } = await import("./db.ts");
      const { Repo } = await import("./repo.ts");
      const s = new Repo(openDb(DB_PATH)).getSettings();
      settings = s;
      provider = s.imageProvider;
      cloudflareAccountId = s.cloudflareAccountId;
    } catch (e) {
      process.stderr.write(`images: could not read the board's settings (${(e as Error).message}))\n`);
    }
  }
  // "Off" switches the tool off for the board's runs; here you asked for it by adding the server.
  if (provider === "off") provider = "codex";
  // Codex makes them when the board says so (D297); what this process learns is kept for it alone.
  const codex = settings ? await codexImagePart(settings, secrets, (works, detail, version) => {
    settings!.codexPictures = { works, version, detail, checked_at: new Date().toISOString() };
  }) : null;
  return { provider, pollinationsKey: secrets.get(POLLINATIONS_KEY_REF), cloudflareAccountId, cloudflareToken: secrets.get(CLOUDFLARE_TOKEN_REF), codex };
}

const handlers = imageHandlers({ cwd, config: () => cachedConfig!, onImage: (i) => process.stderr.write(`images: ${i.path} (${i.provider})\n`) });
let cachedConfig: ImageConfig | null = null;

interface Request { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> }

type Reply = { jsonrpc: "2.0"; id: Request["id"]; result?: unknown; error?: { code: number; message: string } };
const reply = (id: Request["id"], result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
const refuse = (id: Request["id"], code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });

/** One request in, one reply out (none for a notification). Apart from the wire so a test can call it. */
export async function handle(req: Request, generate: (args: ToolInput) => Promise<unknown> = (a) => handlers.generate(a)): Promise<Reply | undefined> {
  const { id, method, params = {} } = req;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: IMAGE_SERVER, version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: z.toJSONSchema(TOOL_INPUT) }] });
    case "tools/call": {
      if (params.name !== TOOL_NAME) return refuse(id, -32602, `Unknown tool ${String(params.name)}`);
      const parsed = TOOL_INPUT.safeParse(params.arguments ?? {});
      if (!parsed.success) return reply(id, { content: [{ type: "text", text: `Bad arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }], isError: true });
      cachedConfig ??= await config();
      return reply(id, await generate(parsed.data));
    }
    default:
      if (id === undefined) return undefined; // a notification we do not know: nothing to answer
      return refuse(id, -32601, `Method not found: ${method}`);
  }
}

/** Reads one JSON-RPC message per line until stdin closes. Not run when imported by a test. */
export function serve(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (msg: Reply | undefined): void => void (msg && process.stdout.write(JSON.stringify(msg) + "\n"));
  let chain = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      send(refuse(null, -32700, "Parse error"));
      return;
    }
    // One at a time, in order: a second image request waits for the first, which the free tier wants anyway.
    chain = chain.then(() => handle(req)).then(send, (e) => send(refuse(req.id ?? null, -32603, (e as Error).message)));
  });
  // Claude Code closes stdin to stop the server; a call still in flight finishes first.
  lines.on("close", () => void chain.finally(() => process.exit(0)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
