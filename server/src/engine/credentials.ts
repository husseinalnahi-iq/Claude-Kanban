/**
 * Does a tool call touch a credentials file, and would it show what is in it? Pure — no node imports —
 * so the approval card in the browser uses the same rule as the server (docs/DECISIONS.md D201).
 *
 * Found in a real supervised run: a review stage asked to `cat .codex-secrets/bizapp-api.json`. One
 * Allow would have written the live BizApp key and secret into the transcript, which the board keeps
 * in its database. Nothing on the card said so.
 */

export interface CredentialRisk {
  /** "prints": the values would land in the transcript. "touches": a script reads the file; fine if it only loads it. */
  level: "prints" | "touches";
  files: string[];
}

/** Files and folders that hold credentials by convention. Templates (`.env.example`) are not credentials. */
const CREDENTIAL_PATH =
  /(?:^|[\\/\s"'=(,])((?:[\w.-]*[\\/])*(?:\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)?|[\w.-]*secrets?(?:[\w.-]*)|[\w.-]*credentials?[\w.-]*|\.git-credentials|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|ed25519|ecdsa|dsa)|[\w.-]+\.(?:pem|p12|pfx|key))(?:[\\/][\w.-]+)*)(?=$|[\\/\s"'),;|&>])/gi;

/** Programs whose job is to put a file's contents on screen. */
const PRINTERS = /(?:^|[\s;&|(])(cat|type|more|less|head|tail|bat|nl|od|xxd|strings|Get-Content|gc|Format-Hex|Write-Output|Write-Host|echo|printf)(?=\s)/i;

/** Source and docs *about* secrets (`secrets.ts`, `credentials.md`) are code, not credentials. */
const CODE_FILE = /\.(?:ts|tsx|mts|cts|jsx|md|mdx|test\.[jt]s)$/i;

function credentialPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CREDENTIAL_PATH)) if (!CODE_FILE.test(m[1])) out.add(m[1]);
  return [...out];
}

export function credentialRisk(toolName: string, input: Record<string, unknown>): CredentialRisk | null {
  // Reading a file with a tool puts its contents straight into the transcript.
  if (toolName === "Read" || toolName === "NotebookRead") {
    const p = String(input.file_path ?? input.notebook_path ?? "");
    const files = credentialPaths(p);
    return files.length ? { level: "prints", files } : null;
  }
  if (toolName !== "Bash" && toolName !== "PowerShell") return null;
  const command = String(input.command ?? "");
  const files = credentialPaths(command);
  if (!files.length) return null;
  // A segment that both names the file and runs a printer on it shows the values.
  const prints = command.split(/&&|\|\||[;\n]/).some((segment) => PRINTERS.test(segment) && credentialPaths(segment).length > 0);
  return { level: prints ? "prints" : "touches", files };
}
