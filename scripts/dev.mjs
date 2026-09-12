// Starts the API server (tsx watch, :4310) and the Vite dev server (:5173) together.
import { spawn } from "node:child_process";

const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim() };
const procs = [
  { name: "server", color: "\x1b[33m", args: ["run", "dev", "-w", "server"] },
  { name: "web   ", color: "\x1b[36m", args: ["run", "dev", "-w", "web"] },
].map(({ name, color, args }) => {
  const p = spawn(`npm ${args.join(" ")}`, { env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => console.log(`${color}[${name}]\x1b[0m ${line}`));
  p.stdout.on("data", prefix);
  p.stderr.on("data", prefix);
  p.on("exit", (code) => {
    console.log(`${color}[${name}]\x1b[0m exited (${code})`);
    shutdown(code ?? 0);
  });
  return p;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (!p.killed) p.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
console.log("Claude Kanban dev → UI http://127.0.0.1:5173  ·  API http://127.0.0.1:4310");
