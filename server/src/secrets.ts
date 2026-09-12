import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Provider keys, kept apart from settings on purpose (docs/DECISIONS.md D125).
 *
 * Settings travel to the browser and over the WebSocket; a key must never ride along. So the
 * settings row holds only the NAME of a secret ("ZAI_API_KEY"), and this store holds the value —
 * in `<stateDir>/secrets.json`, mode 0600 where the platform honours it — or, failing that, the
 * server's own environment under the same name. The API answers "is one set?", never "what is it?".
 */
export class SecretStore {
  private cache: Record<string, string> | null = null;

  /** `":memory:"` keeps everything in-process (tests). */
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    if (this.cache) return this.cache;
    if (this.file === ":memory:" || !existsSync(this.file)) return (this.cache = {});
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      this.cache = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private write(): void {
    if (this.file === ":memory:") return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.read(), null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600); // no-op on Windows, where the user's profile ACL applies instead
    } catch {
      // best effort
    }
  }

  has(ref: string): boolean {
    return this.get(ref) !== null;
  }

  /** The stored value first, then the server's environment under the same name. */
  get(ref: string): string | null {
    if (!ref) return null;
    const own = this.read()[ref];
    if (own) return own;
    const env = process.env[ref];
    return env ? env : null;
  }

  set(ref: string, value: string): void {
    this.read()[ref] = value;
    this.write();
  }

  delete(ref: string): void {
    delete this.read()[ref];
    this.write();
  }

  /** Every name with a stored value (not environment ones). */
  names(): string[] {
    return Object.keys(this.read());
  }

  /** Blanks every known secret value in `text`, so a log line or an error can never leak one. */
  redact(text: string): string {
    let out = text;
    for (const v of Object.values(this.read())) if (v.length >= 8 && out.includes(v)) out = out.split(v).join("•••");
    return out;
  }
}
