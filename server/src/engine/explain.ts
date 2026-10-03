/**
 * What a shell command does, in plain words, from a fixed table: free, instant, and the same every
 * time (D336). Most people approving a card have never typed `git stash` or `npm ci`; the card used to
 * show only the command. No model is asked here: a command the table does not know says so, and the
 * UI offers to ask one.
 *
 * Pure: no Node imports, so the web renders the same explanation the server would.
 */

/** How much a command can do, from least to most. The highest of a chain's parts is the chain's. */
export type CommandRisk = "reads" | "runs" | "writes" | "network" | "installs" | "deletes" | "system" | "unknown";

export const RISK_ORDER: CommandRisk[] = ["reads", "runs", "writes", "network", "installs", "deletes", "system", "unknown"];

export const RISK_INFO: Record<CommandRisk, { label: string; hint: string }> = {
  reads: { label: "Looks only", hint: "Reads files or asks for information. Changes nothing." },
  runs: { label: "Runs a program", hint: "Runs code, tests or a build in the project. Can take time and write its own output files." },
  writes: { label: "Changes files", hint: "Creates, edits, moves or copies files in the project." },
  network: { label: "Uses the internet", hint: "Sends or fetches data over the network." },
  installs: { label: "Installs software", hint: "Downloads and installs packages or tools." },
  deletes: { label: "Deletes", hint: "Removes files or folders. Check what, and whether it is in the project." },
  system: { label: "Changes the computer", hint: "Touches settings, permissions, processes or services outside the project." },
  unknown: { label: "Not in the table", hint: "The board has no ready explanation for this command." },
};

export interface CommandPart {
  /** The part of the command line this explains. */
  text: string;
  /** What it does, in one plain sentence. */
  meaning: string;
  risk: CommandRisk;
  /** Whether the table knew it. */
  known: boolean;
}

export interface Explanation {
  /** The whole thing in one line: the parts joined with "then". */
  summary: string;
  parts: CommandPart[];
  risk: CommandRisk;
  /** True when every part was in the table. */
  complete: boolean;
}

type Rule = (args: string[], raw: string) => { meaning: string; risk: CommandRisk } | null;

const q = (s: string | undefined, fallback = "something") => (s ? `“${s.length > 60 ? `${s.slice(0, 57)}…` : s}”` : fallback);
/** The first argument that is not a flag. */
const target = (args: string[], skip = 0) => args.filter((a) => !a.startsWith("-")).slice(skip)[0];
const targets = (args: string[]) => args.filter((a) => !a.startsWith("-"));
const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a) || (a.startsWith("-") && !a.startsWith("--") && flags.some((f) => f.length === 2 && a.includes(f[1]!))));

const GIT: Record<string, Rule> = {
  status: () => ({ meaning: "shows which files changed and what is staged", risk: "reads" }),
  log: () => ({ meaning: "shows the history of commits", risk: "reads" }),
  diff: (a) => ({ meaning: a.length ? `shows what changed in ${q(target(a), "the files")}` : "shows the changes not yet committed", risk: "reads" }),
  show: (a) => ({ meaning: `shows a commit or file ${q(target(a), "")}`.trim(), risk: "reads" }),
  blame: (a) => ({ meaning: `shows who last changed each line of ${q(target(a), "a file")}`, risk: "reads" }),
  branch: (a) => (has(a, "-d", "-D", "--delete") ? { meaning: `deletes the branch ${q(target(a))}`, risk: "deletes" } : a.length && !a[0]!.startsWith("-") ? { meaning: `creates the branch ${q(a[0])}`, risk: "writes" } : { meaning: "lists the branches", risk: "reads" }),
  checkout: (a) => (has(a, "-b") ? { meaning: `creates and switches to the branch ${q(target(a))}`, risk: "writes" } : has(a, "--") || a.some((x) => x.includes("/") || x.includes(".")) ? { meaning: `throws away local edits to ${q(target(a), "files")}, restoring the last committed version`, risk: "deletes" } : { meaning: `switches to the branch or commit ${q(target(a))}`, risk: "writes" }),
  switch: (a) => ({ meaning: `switches to the branch ${q(target(a))}`, risk: "writes" }),
  restore: (a) => (has(a, "--staged") ? { meaning: `unstages ${q(target(a), "files")} (the edits stay)`, risk: "writes" } : { meaning: `throws away local edits to ${q(target(a), "files")}, restoring the last committed version`, risk: "deletes" }),
  add: (a) => ({ meaning: a.includes("-A") || a.includes(".") || a.includes("--all") ? "stages every change for the next commit" : `stages ${q(target(a), "files")} for the next commit`, risk: "writes" }),
  commit: (a) => ({ meaning: has(a, "--amend") ? "rewrites the last commit with the staged changes" : "records the staged changes as a commit", risk: "writes" }),
  stash: (a) => (a[0] === "pop" || a[0] === "apply" ? { meaning: "brings back the changes put aside earlier", risk: "writes" } : a[0] === "drop" || a[0] === "clear" ? { meaning: "throws away changes that were put aside", risk: "deletes" } : a[0] === "list" || a[0] === "show" ? { meaning: "shows the changes put aside", risk: "reads" } : { meaning: "puts the uncommitted changes aside, leaving a clean folder", risk: "writes" }),
  fetch: () => ({ meaning: "downloads new commits from the remote repository without changing your files", risk: "network" }),
  pull: () => ({ meaning: "downloads new commits from the remote repository and merges them into the current branch", risk: "network" }),
  push: (a) => ({ meaning: has(a, "-f", "--force") ? `uploads commits to the remote repository, overwriting its history (force push)` : "uploads your commits to the remote repository", risk: "network" }),
  clone: (a) => ({ meaning: `downloads the repository ${q(target(a))}`, risk: "network" }),
  merge: (a) => ({ meaning: `brings the branch ${q(target(a))} into the current one`, risk: "writes" }),
  rebase: (a) => ({ meaning: has(a, "--abort") ? "cancels the rebase in progress" : has(a, "--continue") ? "carries on the rebase in progress" : `replays this branch's commits on top of ${q(target(a), "another branch")} (rewrites history)`, risk: "writes" }),
  reset: (a) => (has(a, "--hard") ? { meaning: "throws away all uncommitted changes and moves the branch (hard reset)", risk: "deletes" } : { meaning: "unstages changes or moves the branch pointer; your edits stay", risk: "writes" }),
  clean: (a) => ({ meaning: has(a, "-n", "--dry-run") ? "lists the untracked files it would delete" : "deletes untracked files from the folder", risk: has(a, "-n", "--dry-run") ? "reads" : "deletes" }),
  rm: (a) => ({ meaning: `removes ${q(target(a), "files")} from the repository${has(a, "--cached") ? " (keeps them on disk)" : ""}`, risk: has(a, "--cached") ? "writes" : "deletes" }),
  mv: (a) => ({ meaning: `renames or moves ${q(target(a))}`, risk: "writes" }),
  tag: (a) => ({ meaning: has(a, "-d") ? `deletes the tag ${q(target(a))}` : a.length ? `creates the tag ${q(target(a))}` : "lists the tags", risk: has(a, "-d") ? "deletes" : a.length ? "writes" : "reads" }),
  remote: (a) => ({ meaning: a[0] === "add" ? `adds the remote repository ${q(a[1])}` : "shows the remote repositories", risk: a[0] === "add" || a[0] === "set-url" || a[0] === "remove" ? "writes" : "reads" }),
  worktree: (a) => ({ meaning: a[0] === "add" ? `checks out a branch into a separate folder ${q(a[1])}` : a[0] === "remove" || a[0] === "prune" ? "removes a worktree folder" : "lists the worktrees", risk: a[0] === "add" ? "writes" : a[0] === "remove" || a[0] === "prune" ? "deletes" : "reads" }),
  "rev-parse": () => ({ meaning: "looks up a commit id or the repository's folder", risk: "reads" }),
  "ls-files": () => ({ meaning: "lists the files git tracks", risk: "reads" }),
  grep: (a) => ({ meaning: `searches tracked files for ${q(target(a))}`, risk: "reads" }),
  config: (a) => ({ meaning: a.length > 1 && !a.some((x) => x.startsWith("--get") || x === "-l" || x === "--list") ? `sets the git setting ${q(target(a))}` : "reads git settings", risk: a.length > 1 && !a.some((x) => x.startsWith("--get") || x === "-l" || x === "--list") ? "system" : "reads" }),
  init: () => ({ meaning: "starts a new git repository in this folder", risk: "writes" }),
  bisect: () => ({ meaning: "walks through commits to find which one broke something", risk: "writes" }),
  cherry_pick: () => ({ meaning: "copies a commit onto the current branch", risk: "writes" }),
};

const NPM_SCRIPTS: Record<string, string> = {
  test: "runs the project's tests", build: "builds the project", dev: "starts the project's development server", start: "starts the project",
  lint: "checks the code style", typecheck: "checks the code's types", format: "reformats the code",
};

/** Package managers behave alike; one rule serves them. */
const pm = (name: string): Rule => (a) => {
  const sub = a[0];
  if (!sub) return { meaning: `runs ${name}`, risk: "runs" };
  if (["install", "i", "ci", "add"].includes(sub)) return { meaning: targets(a.slice(1)).length ? `installs the package ${q(targets(a.slice(1)).join(" "))}` : "installs the project's dependencies", risk: "installs" };
  if (["uninstall", "remove", "rm", "un"].includes(sub)) return { meaning: `removes the package ${q(target(a, 1))}`, risk: "deletes" };
  if (["update", "upgrade", "up"].includes(sub)) return { meaning: "updates the project's dependencies", risk: "installs" };
  if (["audit", "outdated", "ls", "list", "view", "info", "why", "explain"].includes(sub)) return { meaning: "looks at the project's dependencies", risk: "reads" };
  if (sub === "publish") return { meaning: "publishes the package to the registry", risk: "network" };
  if (sub === "run" || sub === "exec" || sub === "x") return { meaning: NPM_SCRIPTS[a[1] ?? ""] ?? `runs the project's ${q(a[1])} script`, risk: "runs" };
  if (NPM_SCRIPTS[sub]) return { meaning: NPM_SCRIPTS[sub]!, risk: "runs" };
  return { meaning: `runs ${name} ${sub}`, risk: "runs" };
};

const TABLE: Record<string, Rule> = {
  // ---- looking
  ls: (a) => ({ meaning: `lists the files in ${q(target(a), "this folder")}`, risk: "reads" }),
  dir: (a) => ({ meaning: `lists the files in ${q(target(a), "this folder")}`, risk: "reads" }),
  tree: () => ({ meaning: "shows the folder structure", risk: "reads" }),
  pwd: () => ({ meaning: "shows the current folder", risk: "reads" }),
  cat: (a) => ({ meaning: `prints the file ${q(target(a))}`, risk: "reads" }),
  type: (a) => ({ meaning: `prints the file ${q(target(a))}`, risk: "reads" }),
  less: (a) => ({ meaning: `shows the file ${q(target(a))}`, risk: "reads" }),
  more: (a) => ({ meaning: `shows the file ${q(target(a))}`, risk: "reads" }),
  head: (a) => ({ meaning: `shows the first lines of ${q(target(a), "the input")}`, risk: "reads" }),
  tail: (a) => ({ meaning: `shows the last lines of ${q(target(a), "the input")}${has(a, "-f") ? ", and keeps following it" : ""}`, risk: "reads" }),
  wc: () => ({ meaning: "counts lines, words or characters", risk: "reads" }),
  grep: (a) => ({ meaning: `searches for ${q(target(a))}${target(a, 1) ? ` in ${q(target(a, 1))}` : ""}`, risk: "reads" }),
  rg: (a) => ({ meaning: `searches for ${q(target(a))}${target(a, 1) ? ` in ${q(target(a, 1))}` : ""}`, risk: "reads" }),
  ag: (a) => ({ meaning: `searches for ${q(target(a))}`, risk: "reads" }),
  find: (a) => (a.includes("-delete") ? { meaning: "finds files and deletes them", risk: "deletes" } : a.includes("-exec") ? { meaning: `finds files and runs a command on each (${q(a.slice(a.indexOf("-exec") + 1).join(" "))})`, risk: "runs" } : { meaning: `looks for files${a.includes("-name") ? ` named ${q(a[a.indexOf("-name") + 1])}` : ""}`, risk: "reads" }),
  fd: (a) => ({ meaning: `looks for files matching ${q(target(a))}`, risk: "reads" }),
  which: (a) => ({ meaning: `checks whether ${q(target(a))} is installed and where`, risk: "reads" }),
  where: (a) => ({ meaning: `checks whether ${q(target(a))} is installed and where`, risk: "reads" }),
  whoami: () => ({ meaning: "shows which user account this runs as", risk: "reads" }),
  env: () => ({ meaning: "shows the environment variables (may include keys)", risk: "reads" }),
  printenv: () => ({ meaning: "shows environment variables (may include keys)", risk: "reads" }),
  echo: (a) => ({ meaning: `prints ${q(a.join(" "))}`, risk: "reads" }),
  date: () => ({ meaning: "shows the date and time", risk: "reads" }),
  stat: (a) => ({ meaning: `shows details of ${q(target(a))}`, risk: "reads" }),
  file: (a) => ({ meaning: `says what kind of file ${q(target(a))} is`, risk: "reads" }),
  du: () => ({ meaning: "measures how much disk space folders use", risk: "reads" }),
  df: () => ({ meaning: "shows free disk space", risk: "reads" }),
  diff: (a) => ({ meaning: `compares ${q(target(a))} with ${q(target(a, 1))}`, risk: "reads" }),
  sort: () => ({ meaning: "sorts lines", risk: "reads" }),
  uniq: () => ({ meaning: "drops repeated lines", risk: "reads" }),
  cut: () => ({ meaning: "picks columns out of lines", risk: "reads" }),
  tr: () => ({ meaning: "replaces characters in text", risk: "reads" }),
  awk: () => ({ meaning: "picks and reshapes text", risk: "reads" }),
  jq: () => ({ meaning: "reads or reshapes JSON", risk: "reads" }),
  xargs: (a) => ({ meaning: `runs ${q(target(a), "a command")} on each line of input`, risk: "runs" }),
  sed: (a) => (has(a, "-i") || a.some((x) => x.startsWith("-i")) ? { meaning: `edits ${q(targets(a).at(-1), "files")} in place`, risk: "writes" } : { meaning: "prints text with a find-and-replace or a slice of lines", risk: "reads" }),
  test: () => ({ meaning: "checks a condition (a file exists, a value matches)", risk: "reads" }),
  "[": () => ({ meaning: "checks a condition", risk: "reads" }),
  true: () => ({ meaning: "does nothing", risk: "reads" }),
  sleep: (a) => ({ meaning: `waits ${a[0] ?? "a while"} seconds`, risk: "reads" }),
  cd: (a) => ({ meaning: `moves into the folder ${q(target(a), "home")}`, risk: "reads" }),
  pushd: (a) => ({ meaning: `moves into the folder ${q(target(a))}`, risk: "reads" }),
  popd: () => ({ meaning: "moves back to the previous folder", risk: "reads" }),
  export: (a) => ({ meaning: `sets the variable ${q(a[0]?.split("=")[0])} for the following commands`, risk: "reads" }),
  set: () => ({ meaning: "sets shell options or variables", risk: "reads" }),
  source: (a) => ({ meaning: `runs the script ${q(target(a))} in this shell`, risk: "runs" }),
  ".": (a) => ({ meaning: `runs the script ${q(target(a))} in this shell`, risk: "runs" }),
  // ---- changing files
  mkdir: (a) => ({ meaning: `creates the folder ${q(targets(a).join(" "))}`, risk: "writes" }),
  touch: (a) => ({ meaning: `creates the empty file ${q(targets(a).join(" "))} (or updates its time)`, risk: "writes" }),
  cp: (a) => ({ meaning: `copies ${q(target(a))} to ${q(targets(a).at(-1))}`, risk: "writes" }),
  copy: (a) => ({ meaning: `copies ${q(target(a))} to ${q(targets(a).at(-1))}`, risk: "writes" }),
  mv: (a) => ({ meaning: `moves or renames ${q(target(a))} to ${q(targets(a).at(-1))}`, risk: "writes" }),
  move: (a) => ({ meaning: `moves or renames ${q(target(a))}`, risk: "writes" }),
  ren: (a) => ({ meaning: `renames ${q(target(a))}`, risk: "writes" }),
  rename: (a) => ({ meaning: `renames ${q(target(a))}`, risk: "writes" }),
  ln: (a) => ({ meaning: `makes a link to ${q(target(a))}`, risk: "writes" }),
  tee: (a) => ({ meaning: `writes the output into ${q(target(a))}`, risk: "writes" }),
  chmod: (a) => ({ meaning: `changes who may read, write or run ${q(targets(a).at(-1))}`, risk: "system" }),
  chown: (a) => ({ meaning: `changes the owner of ${q(targets(a).at(-1))}`, risk: "system" }),
  zip: (a) => ({ meaning: `packs files into the archive ${q(target(a))}`, risk: "writes" }),
  unzip: (a) => ({ meaning: `unpacks the archive ${q(target(a))}`, risk: "writes" }),
  tar: (a) => ({ meaning: has(a, "-x") || a[0]?.includes("x") ? `unpacks the archive ${q(targets(a)[0])}` : has(a, "-c") || a[0]?.includes("c") ? `packs files into the archive ${q(targets(a)[0])}` : "lists an archive's contents", risk: has(a, "-t") || a[0]?.includes("t") ? "reads" : "writes" }),
  // ---- deleting
  rm: (a) => ({ meaning: `deletes ${q(targets(a).join(" "), "files")}${has(a, "-r", "-R", "--recursive") ? ", folders and all" : ""}${has(a, "-f", "--force") ? ", without asking" : ""}`, risk: "deletes" }),
  rmdir: (a) => ({ meaning: `removes the empty folder ${q(target(a))}`, risk: "deletes" }),
  del: (a) => ({ meaning: `deletes ${q(targets(a).join(" "))}`, risk: "deletes" }),
  erase: (a) => ({ meaning: `deletes ${q(targets(a).join(" "))}`, risk: "deletes" }),
  rd: (a) => ({ meaning: `removes the folder ${q(target(a))}`, risk: "deletes" }),
  shred: (a) => ({ meaning: `destroys the file ${q(target(a))} beyond recovery`, risk: "deletes" }),
  truncate: (a) => ({ meaning: `empties or resizes ${q(targets(a).at(-1))}`, risk: "deletes" }),
  // ---- network
  curl: (a) => ({ meaning: `${has(a, "-X", "-d", "--data", "-F", "-T", "--upload-file") || a.some((x) => /^-X?(POST|PUT|PATCH|DELETE)$/i.test(x)) ? "sends data to" : "fetches"} ${q(a.find((x) => /^https?:\/\//.test(x)) ?? target(a), "a web address")}${has(a, "-o", "-O") ? " and saves it" : ""}`, risk: "network" }),
  wget: (a) => ({ meaning: `downloads ${q(a.find((x) => /^https?:\/\//.test(x)) ?? target(a), "a web address")}`, risk: "network" }),
  ping: (a) => ({ meaning: `checks whether ${q(target(a))} answers on the network`, risk: "network" }),
  ssh: (a) => ({ meaning: `logs in to another computer, ${q(target(a))}`, risk: "network" }),
  scp: (a) => ({ meaning: `copies files to or from another computer (${q(targets(a).join(" → "))})`, risk: "network" }),
  rsync: (a) => ({ meaning: `syncs files to ${q(targets(a).at(-1))}`, risk: "network" }),
  nc: () => ({ meaning: "opens a raw network connection", risk: "network" }),
  telnet: () => ({ meaning: "opens a raw network connection", risk: "network" }),
  dig: (a) => ({ meaning: `looks up the address of ${q(target(a))}`, risk: "network" }),
  nslookup: (a) => ({ meaning: `looks up the address of ${q(target(a))}`, risk: "network" }),
  gh: (a) => ({ meaning: a[0] === "pr" ? `${a[1] === "create" ? "opens" : a[1] === "merge" ? "merges" : a[1] === "view" || a[1] === "list" || a[1] === "checks" || a[1] === "diff" ? "looks at" : `works on (${a[1]})`} a pull request on GitHub` : a[0] === "issue" ? `${a[1] === "create" ? "opens" : a[1] === "view" || a[1] === "list" ? "looks at" : `works on (${a[1]})`} an issue on GitHub` : a[0] === "repo" ? `works with the repository on GitHub (${a[1] ?? "view"})` : a[0] === "api" ? `calls GitHub's API (${q(target(a, 1))})` : a[0] === "run" ? "looks at or triggers GitHub Actions" : a[0] === "auth" ? "checks or changes the GitHub login" : `uses GitHub (${a[0] ?? ""})`.trim(), risk: ["view", "list", "status", "checks", "diff"].includes(a[1] ?? "") || a[0] === "auth" && a[1] === "status" ? "network" : "network" }),
  // ---- installing
  npm: pm("npm"), npx: (a) => ({ meaning: `downloads if needed and runs the tool ${q(target(a))}`, risk: "installs" }),
  pnpm: pm("pnpm"), yarn: pm("yarn"), bun: pm("bun"),
  pip: (a) => ({ meaning: a[0] === "install" ? `installs the Python package ${q(targets(a.slice(1)).join(" "), "requirements")}` : a[0] === "uninstall" ? `removes the Python package ${q(target(a, 1))}` : a[0] === "list" || a[0] === "show" || a[0] === "freeze" ? "lists installed Python packages" : `runs pip ${a[0] ?? ""}`.trim(), risk: a[0] === "install" ? "installs" : a[0] === "uninstall" ? "deletes" : a[0] === "list" || a[0] === "show" || a[0] === "freeze" ? "reads" : "runs" }),
  pip3: (a) => TABLE.pip!(a, ""),
  uv: (a) => ({ meaning: a[0] === "pip" ? TABLE.pip!(a.slice(1), "")!.meaning : a[0] === "add" || a[0] === "sync" ? "installs the project's Python dependencies" : a[0] === "run" ? `runs ${q(target(a, 1))} in the project's Python environment` : `runs uv ${a[0] ?? ""}`.trim(), risk: a[0] === "add" || a[0] === "sync" || (a[0] === "pip" && a[1] === "install") ? "installs" : a[0] === "run" ? "runs" : "runs" }),
  brew: (a) => ({ meaning: a[0] === "install" ? `installs ${q(target(a, 1))} on this Mac` : a[0] === "uninstall" ? `removes ${q(target(a, 1))}` : `runs Homebrew ${a[0] ?? ""}`.trim(), risk: a[0] === "install" ? "installs" : a[0] === "uninstall" ? "deletes" : "reads" }),
  apt: (a) => ({ meaning: a.includes("install") ? `installs ${q(targets(a).filter((x) => x !== "install").join(" "))} on this computer` : a.includes("remove") || a.includes("purge") ? "removes software from this computer" : "updates the list of available software", risk: a.includes("install") ? "installs" : a.includes("remove") || a.includes("purge") ? "deletes" : "network" }),
  "apt-get": (a) => TABLE.apt!(a, ""),
  winget: (a) => ({ meaning: a[0] === "install" ? `installs ${q(target(a, 1))} on Windows` : a[0] === "uninstall" ? `removes ${q(target(a, 1))}` : "looks at installed software", risk: a[0] === "install" ? "installs" : a[0] === "uninstall" ? "deletes" : "reads" }),
  choco: (a) => TABLE.winget!(a, ""),
  // ---- running programs
  node: (a) => ({ meaning: has(a, "-e", "--eval") ? "runs a snippet of JavaScript" : `runs the JavaScript file ${q(target(a))}`, risk: "runs" }),
  deno: (a) => ({ meaning: `runs ${q(target(a, 1), "a program")} with Deno`, risk: "runs" }),
  python: (a) => ({ meaning: has(a, "-c") ? "runs a snippet of Python" : has(a, "-m") ? `runs the Python module ${q(a[a.indexOf("-m") + 1])}` : `runs the Python file ${q(target(a))}`, risk: "runs" }),
  python3: (a) => TABLE.python!(a, ""),
  py: (a) => TABLE.python!(a, ""),
  pytest: () => ({ meaning: "runs the Python tests", risk: "runs" }),
  tsc: (a) => ({ meaning: a.includes("--noEmit") ? "checks the TypeScript types without writing files" : "compiles the TypeScript", risk: a.includes("--noEmit") ? "reads" : "writes" }),
  tsx: (a) => ({ meaning: `runs the TypeScript file ${q(target(a))}`, risk: "runs" }),
  vitest: () => ({ meaning: "runs the tests", risk: "runs" }),
  jest: () => ({ meaning: "runs the tests", risk: "runs" }),
  mocha: () => ({ meaning: "runs the tests", risk: "runs" }),
  eslint: (a) => ({ meaning: a.includes("--fix") ? "checks the code style and fixes what it can" : "checks the code style", risk: a.includes("--fix") ? "writes" : "reads" }),
  prettier: (a) => ({ meaning: a.includes("--write") || a.includes("-w") ? "reformats the code" : "checks the formatting", risk: a.includes("--write") || a.includes("-w") ? "writes" : "reads" }),
  make: (a) => ({ meaning: `runs the build step ${q(target(a), "default")}`, risk: "runs" }),
  cargo: (a) => ({ meaning: a[0] === "build" ? "builds the Rust project" : a[0] === "test" ? "runs the Rust tests" : a[0] === "run" ? "runs the Rust project" : a[0] === "add" ? `adds the Rust package ${q(target(a, 1))}` : `runs cargo ${a[0] ?? ""}`.trim(), risk: a[0] === "add" ? "installs" : "runs" }),
  go: (a) => ({ meaning: a[0] === "build" ? "builds the Go project" : a[0] === "test" ? "runs the Go tests" : a[0] === "run" ? "runs the Go project" : a[0] === "get" || (a[0] === "mod" && a[1] === "download") ? "downloads Go dependencies" : `runs go ${a[0] ?? ""}`.trim(), risk: a[0] === "get" || a[0] === "mod" ? "installs" : "runs" }),
  dotnet: (a) => ({ meaning: a[0] === "build" ? "builds the .NET project" : a[0] === "test" ? "runs the .NET tests" : a[0] === "run" ? "runs the .NET project" : `runs dotnet ${a[0] ?? ""}`.trim(), risk: "runs" }),
  java: (a) => ({ meaning: `runs the Java program ${q(target(a))}`, risk: "runs" }),
  mvn: () => ({ meaning: "builds or tests the Java project with Maven", risk: "runs" }),
  gradle: () => ({ meaning: "builds or tests the project with Gradle", risk: "runs" }),
  docker: (a) => ({ meaning: a[0] === "ps" || a[0] === "images" || a[0] === "logs" || a[0] === "inspect" ? "looks at containers or images" : a[0] === "build" ? "builds a container image" : a[0] === "run" ? `starts a container from ${q(targets(a).at(-1))}` : a[0] === "compose" ? `runs docker compose ${a[1] ?? ""}`.trim() : a[0] === "rm" || a[0] === "rmi" || a[0] === "prune" || a[1] === "prune" ? "removes containers or images" : a[0] === "pull" ? `downloads the image ${q(target(a, 1))}` : `runs docker ${a[0] ?? ""}`.trim(), risk: ["ps", "images", "logs", "inspect"].includes(a[0] ?? "") ? "reads" : a[0] === "pull" ? "network" : a[0] === "rm" || a[0] === "rmi" || a[0] === "prune" || a[1] === "prune" ? "deletes" : "system" }),
  "docker-compose": (a) => ({ meaning: `runs docker compose ${a[0] ?? ""}`.trim(), risk: "system" }),
  bash: (a) => ({ meaning: has(a, "-c") ? "runs the quoted commands in a new shell" : `runs the script ${q(target(a))}`, risk: "runs" }),
  sh: (a) => TABLE.bash!(a, ""),
  zsh: (a) => TABLE.bash!(a, ""),
  powershell: () => ({ meaning: "runs PowerShell commands", risk: "runs" }),
  pwsh: () => ({ meaning: "runs PowerShell commands", risk: "runs" }),
  cmd: () => ({ meaning: "runs Windows command-prompt commands", risk: "runs" }),
  timeout: (a) => ({ meaning: `runs ${q(targets(a).slice(1).join(" "), "a command")} and stops it after ${a[0] ?? "a while"} seconds`, risk: "runs" }),
  time: (a) => ({ meaning: `runs ${q(a.join(" "))} and measures how long it takes`, risk: "runs" }),
  // ---- the computer
  kill: (a) => ({ meaning: `stops the running program with id ${q(targets(a).join(" "))}`, risk: "system" }),
  killall: (a) => ({ meaning: `stops every running ${q(target(a))}`, risk: "system" }),
  pkill: (a) => ({ meaning: `stops running programs called ${q(target(a))}`, risk: "system" }),
  taskkill: () => ({ meaning: "stops a running program", risk: "system" }),
  ps: () => ({ meaning: "lists the running programs", risk: "reads" }),
  top: () => ({ meaning: "shows the running programs and their load", risk: "reads" }),
  lsof: () => ({ meaning: "shows which programs have which files or ports open", risk: "reads" }),
  netstat: () => ({ meaning: "shows network connections and open ports", risk: "reads" }),
  sudo: (a) => ({ meaning: `runs ${q(a.join(" "))} as the administrator`, risk: "system" }),
  systemctl: (a) => ({ meaning: `${a[0] ?? "manages"} the service ${q(a[1])}`, risk: a[0] === "status" ? "reads" : "system" }),
  service: (a) => ({ meaning: `${a[1] ?? "manages"} the service ${q(a[0])}`, risk: a[1] === "status" ? "reads" : "system" }),
  crontab: (a) => ({ meaning: has(a, "-l") ? "lists the scheduled jobs" : "changes the scheduled jobs", risk: has(a, "-l") ? "reads" : "system" }),
  reboot: () => ({ meaning: "restarts the computer", risk: "system" }),
  shutdown: () => ({ meaning: "shuts the computer down", risk: "system" }),
  // ---- PowerShell cmdlets, which Windows runs often appear with
  "get-childitem": (a) => ({ meaning: `lists the files in ${q(target(a), "this folder")}`, risk: "reads" }),
  gci: (a) => ({ meaning: `lists the files in ${q(target(a), "this folder")}`, risk: "reads" }),
  "get-content": (a) => ({ meaning: `prints the file ${q(target(a))}`, risk: "reads" }),
  gc: (a) => ({ meaning: `prints the file ${q(target(a))}`, risk: "reads" }),
  "select-string": (a) => ({ meaning: `searches for ${q(target(a))}`, risk: "reads" }),
  "get-process": () => ({ meaning: "lists the running programs", risk: "reads" }),
  "get-location": () => ({ meaning: "shows the current folder", risk: "reads" }),
  "set-location": (a) => ({ meaning: `moves into the folder ${q(target(a))}`, risk: "reads" }),
  "new-item": (a) => ({ meaning: `creates ${q(target(a))}`, risk: "writes" }),
  "copy-item": (a) => ({ meaning: `copies ${q(target(a))}`, risk: "writes" }),
  "move-item": (a) => ({ meaning: `moves ${q(target(a))}`, risk: "writes" }),
  "rename-item": (a) => ({ meaning: `renames ${q(target(a))}`, risk: "writes" }),
  "set-content": (a) => ({ meaning: `writes into the file ${q(target(a))}`, risk: "writes" }),
  "out-file": (a) => ({ meaning: `writes the output into ${q(target(a))}`, risk: "writes" }),
  "remove-item": (a) => ({ meaning: `deletes ${q(targets(a).join(" "))}${a.some((x) => /^-recurse/i.test(x)) ? ", folders and all" : ""}`, risk: "deletes" }),
  ri: (a) => TABLE["remove-item"]!(a, ""),
  "invoke-webrequest": (a) => ({ meaning: `fetches ${q(a.find((x) => /^https?:\/\//.test(x)) ?? target(a), "a web address")}`, risk: "network" }),
  iwr: (a) => TABLE["invoke-webrequest"]!(a, ""),
  "invoke-restmethod": (a) => ({ meaning: `calls the web API ${q(a.find((x) => /^https?:\/\//.test(x)) ?? target(a))}`, risk: "network" }),
  irm: (a) => TABLE["invoke-restmethod"]!(a, ""),
  "stop-process": () => ({ meaning: "stops a running program", risk: "system" }),
  "start-process": (a) => ({ meaning: `starts the program ${q(target(a))}`, risk: "runs" }),
  "invoke-expression": () => ({ meaning: "runs text as a command", risk: "runs" }),
  iex: () => ({ meaning: "runs text as a command", risk: "runs" }),
  "set-executionpolicy": () => ({ meaning: "changes whether Windows lets scripts run", risk: "system" }),
  "get-command": (a) => ({ meaning: `checks whether ${q(target(a))} is installed`, risk: "reads" }),
  "test-path": (a) => ({ meaning: `checks whether ${q(target(a))} exists`, risk: "reads" }),
  "write-host": (a) => ({ meaning: `prints ${q(a.join(" "))}`, risk: "reads" }),
  "write-output": (a) => ({ meaning: `prints ${q(a.join(" "))}`, risk: "reads" }),
};

const GENERIC_TOOL: Record<string, string> = { claude: "Claude Code", code: "Visual Studio Code", open: "the default app for the file", start: "the default app for the file", xdg_open: "the default app for the file" };

/** Splits a shell line into words, honouring quotes well enough for a summary; not a full shell parser. */
export function shellWords(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += ch;
      any = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      any = true;
    } else if (/\s/.test(ch)) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/** One command line into the commands it chains (`a && b`, `a | b`, `a; b`), quotes respected, subshells kept whole. */
export function splitChain(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const two = command.slice(i, i + 2);
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && (two === "&&" || two === "||")) { parts.push(cur); cur = ""; i++; continue; }
    if (depth === 0 && (ch === ";" || ch === "|" || ch === "\n")) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Drops leading `VAR=value`, `sudo`, `env`, `command`, `exec`, `nohup`, `time`-free wrappers that only decorate the real command. */
function unwrap(words: string[]): { words: string[]; note: string } {
  let note = "";
  let w = words;
  while (w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) { w = w.slice(1); continue; }
    if (w[0] === "sudo") { note = " as the administrator"; w = w.slice(1); continue; }
    if (w[0] === "env" || w[0] === "command" || w[0] === "exec" || w[0] === "nohup" || w[0] === "builtin") { w = w.slice(1); continue; }
    break;
  }
  return { words: w, note };
}

/** One command (no chain) in plain words. */
function explainOne(segment: string): CommandPart {
  const text = segment.trim();
  // Redirections are not words the table needs; "> file" means the output is saved.
  // `2>&1` only joins the error stream to the output: no file is written.
  const noJoin = text.replace(/\s*\d?>&\d\b/g, " ");
  const redirect = /(?:^|\s)(?:\d?>>?|&>)\s*(\S+)/.exec(noJoin);
  const cleaned = noJoin.replace(/(?:^|\s)(?:\d?>>?|&>|<)\s*\S+/g, " ").trim();
  const { words, note } = unwrap(shellWords(cleaned));
  const name = (words[0] ?? "").replace(/^\.\//, "").replace(/.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  const args = words.slice(1);
  const saved = redirect ? `, saving the output into ${q(redirect[1])}` : "";
  const sys = (r: CommandRisk): CommandRisk => (note ? (RISK_ORDER.indexOf("system") > RISK_ORDER.indexOf(r) ? "system" : r) : r);
  if (!name) return { text, meaning: "does nothing", risk: "reads", known: true };
  if (name === "git") {
    const sub = (args.find((a) => !a.startsWith("-")) ?? "").replace("-", "_");
    const rule = GIT[sub] ?? GIT[sub.replace("_", "-")];
    const rest = args.slice(args.findIndex((a) => !a.startsWith("-")) + 1);
    if (rule) {
      const r = rule(rest, text);
      if (r) return { text, meaning: `git ${r.meaning}${saved}${note}`, risk: sys(redirect ? (r.risk === "reads" ? "writes" : r.risk) : r.risk), known: true };
    }
    return { text, meaning: `runs git ${sub}${note}`, risk: sys("unknown"), known: false };
  }
  const rule = TABLE[name];
  if (rule) {
    const r = rule(args, text);
    if (r) return { text, meaning: `${r.meaning}${saved}${note}`, risk: sys(redirect && r.risk === "reads" ? "writes" : r.risk), known: true };
  }
  if (GENERIC_TOOL[name]) return { text, meaning: `opens ${GENERIC_TOOL[name]}${args.length ? ` with ${q(args.join(" "))}` : ""}${note}`, risk: sys("runs"), known: true };
  if (/\.(sh|ps1|bat|cmd|py|js|ts|mjs|rb|pl)$/.test(words[0] ?? "")) return { text, meaning: `runs the script ${q(words[0])}${note}`, risk: sys("runs"), known: true };
  return { text, meaning: `runs ${q(words[0])}${args.length ? ` with ${q(args.join(" "))}` : ""}${note}`, risk: sys("unknown"), known: false };
}

/** The whole command line in plain words: one part per chained command, the highest risk of any part. */
export function explainCommand(command: string): Explanation {
  const parts = splitChain(command).map(explainOne);
  if (!parts.length) return { summary: "Nothing to run.", parts, risk: "reads", complete: true };
  const risk = parts.reduce<CommandRisk>((top, p) => (RISK_ORDER.indexOf(p.risk) > RISK_ORDER.indexOf(top) ? p.risk : top), "reads");
  const summary = parts.map((p, i) => (i === 0 ? p.meaning.charAt(0).toUpperCase() + p.meaning.slice(1) : p.meaning)).join(", then ");
  return { summary: `${summary}.`, parts, risk, complete: parts.every((p) => p.known) };
}

/** An approval's command, from whichever tool it came: Bash, PowerShell, or a wrapper that carries `command`. */
export function commandOf(toolName: string, input: Record<string, unknown> | null | undefined): string | null {
  if (!input) return null;
  if (typeof input.command === "string" && (toolName === "Bash" || toolName === "PowerShell" || /bash|shell|powershell|terminal/i.test(toolName))) return input.command;
  return null;
}
