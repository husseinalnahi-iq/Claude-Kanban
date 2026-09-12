import { homedir } from "node:os";
import { join } from "node:path";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.KANBAN_PORT ?? 4310);
export const STATE_DIR = process.env.KANBAN_STATE_DIR ?? join(homedir(), ".claude-kanban");
export const DB_PATH = join(STATE_DIR, "kanban.db");
export const LOG_DIR = join(STATE_DIR, "logs");
export const SECRETS_PATH = join(STATE_DIR, "secrets.json");
