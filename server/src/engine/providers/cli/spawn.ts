import { spawn as nodeSpawn } from "node:child_process";
import { PolicyError } from "../../runner.ts";

/** A child process the way we use it. Node's ChildProcess satisfies this; tests pass a fake. */
export interface Child {
  pid?: number;
  stdin: { write(s: string): void; end(): void } | null;
  stdout: AsyncIterable<Buffer | string> | null;
  stderr: AsyncIterable<Buffer | string> | null;
  on(event: "error" | "close" | "exit", cb: (arg: unknown) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: Record<string, string>; shell: boolean }) => Child;

export interface SpawnResult {
  code: number | null;
  timedOut: boolean;
  stopped: boolean;
}

/** Only these characters may appear in an argument that has to cross a Windows shell. */
const WIN_SAFE = /^[\w.\-:\\/@ =]+$/;

/**
 * Runs another agent's CLI as a subprocess (docs/DECISIONS.md D134). The prompt is never on the
 * command line — it goes over stdin — so nothing free-form is ever quoted. On Windows a `.cmd`/`.bat`
 * shim needs a shell (Node 24 refuses one otherwise, as in routes/health.ts); the flag arguments are
 * charset-checked and the executable name is all that varies, so there is nothing for a shell to expand.
 */
export async function spawnCli(
  spec: { command: string; args: string[] },
  io: { stdin?: string; onLine: (line: string) => void; onStderr: (chunk: string) => void },
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; abort: AbortSignal; spawnFn?: SpawnFn; platform?: NodeJS.Platform },
): Promise<SpawnResult> {
  const platform = opts.platform ?? process.platform;
  if (opts.abort.aborted) return { code: null, timedOut: false, stopped: true };
  const isWin = platform === "win32";
  const looksLikeShim = isWin && !/[\\/]/.test(spec.command) && !/\.(exe|com)$/i.test(spec.command);
  const shell = looksLikeShim;
  if (shell) {
    for (const a of [spec.command, ...spec.args]) {
      if (!WIN_SAFE.test(a)) throw new PolicyError(`Cannot pass "${a}" safely to a Windows shell — a provider argument may only contain letters, digits and . - _ : \\ / @ = and spaces.`);
    }
  }
  const spawnFn: SpawnFn = opts.spawnFn ?? ((c, a, o) => nodeSpawn(c, a, { cwd: o.cwd, env: o.env, shell: o.shell, windowsHide: true }) as unknown as Child);
  const child = spawnFn(shell ? `"${spec.command}"` : spec.command, shell ? spec.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : spec.args, { cwd: opts.cwd, env: opts.env, shell });

  let timedOut = false;
  let stopped = false;
  const kill = () => {
    try {
      // On Windows a `.cmd` shim spawns a child tree that outlives child.kill(); taskkill /T reaps it.
      // We still signal the ChildProcess itself so its "close" fires even when there is no real tree.
      if (isWin && child.pid) nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5000).unref?.();
    } catch {
      /* already gone */
    }
  };
  const onAbort = () => {
    stopped = true;
    kill();
  };
  opts.abort.addEventListener("abort", onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  timer.unref?.();

  // Feed the prompt, then close stdin so a CLI that reads to EOF proceeds.
  try {
    child.stdin?.write(io.stdin ?? "");
    child.stdin?.end();
  } catch {
    /* the child may have exited already */
  }

  const pumpLines = async () => {
    if (!child.stdout) return;
    let buf = "";
    for await (const chunk of child.stdout) {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        io.onLine(buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) io.onLine(buf.replace(/\r$/, ""));
  };
  const pumpErr = async () => {
    if (!child.stderr) return;
    for await (const chunk of child.stderr) io.onStderr(chunk.toString());
  };

  const code = await new Promise<number | null>((resolve) => {
    let done = false;
    const finish = (c: number | null) => {
      if (!done) {
        done = true;
        resolve(c);
      }
    };
    child.on("error", (err) => {
      io.onStderr(String((err as Error)?.message ?? err));
      finish(null);
    });
    child.on("close", (c) => finish(typeof c === "number" ? c : null));
    child.on("exit", (c) => finish(typeof c === "number" ? c : null));
    void Promise.allSettled([pumpLines(), pumpErr()]);
  });

  clearTimeout(timer);
  opts.abort.removeEventListener("abort", onAbort);
  return { code, timedOut, stopped };
}
