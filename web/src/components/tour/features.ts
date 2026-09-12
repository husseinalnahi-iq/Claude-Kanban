import type { View } from "../../lib/router.ts";

export interface Feature {
  id: string;
  icon: string;
  /** A board status colour token, so a feature wears the colour of the state it is about. */
  color: string;
  title: string;
  /** What it does, in one line. */
  pitch: string;
  /** Why that is better than doing it by hand in a terminal. */
  why: string;
  /** Where to find it. */
  where: string;
  go?: View;
  /** One of the six shown in the welcome pop-up. */
  headline?: boolean;
}

export interface FeatureGroup {
  title: string;
  blurb: string;
  features: Feature[];
}

export const GROUPS: FeatureGroup[] = [
  {
    title: "It runs the work",
    blurb: "You write the card. Claude does the rest, in stages you can watch.",
    features: [
      {
        id: "pipeline",
        icon: "⇶",
        color: "var(--color-amber)",
        title: "Plan → code → review, per task",
        pitch: "Every card runs as a pipeline of Claude sessions, each stage with its own model and effort.",
        why: "The strongest model thinks where it matters and a cheap one tidies up. One Claude session doing all three pays top price for every step.",
        where: "Any task's pipeline editor",
        go: "board",
        headline: true,
      },
      {
        id: "parallel",
        icon: "⫴",
        color: "var(--color-cyan)",
        title: "Many tasks at once, never the same file",
        pitch: "Independent tasks run side by side. Two that touch the same files get a dependency automatically.",
        why: "Parallelism you can see, without two sessions editing one file. Switch the board to graph to see the waves.",
        where: "Board → graph",
        go: "board",
        headline: true,
      },
      {
        id: "intake",
        icon: "✎",
        color: "var(--color-lime)",
        title: "Improve turns a rough ask into a spec",
        pitch: "Press Improve and Claude writes the Problem, testable Done-when checks and how to verify, then sizes the pipeline.",
        why: "“Claude sized this task: code haiku/low” saves you the three-stage Opus bill on a one-line fix. Nothing changes until you press Use it.",
        where: "New task → Improve",
        go: "board",
      },
      {
        id: "mcp",
        icon: "⌘",
        color: "var(--color-slate)",
        title: "Sessions that talk to each other",
        pitch: "Every run gets board tools: read its siblings, post messages, split work into subtasks, remember decisions.",
        why: "A subtask knows what its siblings decided. Project memory carries one-line decisions into every later prompt.",
        where: "Settings → Memory",
        go: "settings",
      },
      {
        id: "delegation",
        icon: "⇄",
        color: "var(--color-iris)",
        title: "Other models, and a plan debate",
        pitch: "Run a stage on GLM, Kimi, Ollama, Codex or Gemini. Have a second model argue with a plan before any code is written.",
        why: "Cheap or local models for the easy stages. For the plan you get the objections and a revised version side by side, and you pick one.",
        where: "Settings → Providers",
        go: "settings",
      },
      {
        id: "claude-code",
        icon: "✦",
        color: "var(--color-amber)",
        title: "Your Claude Code, all of it",
        pitch: "Runs load your skills, plugins, hooks, tool servers and CLAUDE.md. New projects get /init or a bootstrap.",
        why: "Nothing to set up twice. The board adds a board on top of the Claude you already tuned.",
        where: "Skills tab · Settings → CLAUDE.md",
        go: "skills",
      },
    ],
  },
  {
    title: "You stay in charge",
    blurb: "Unattended does not mean unsupervised.",
    features: [
      {
        id: "modes",
        icon: "✋",
        color: "var(--color-rose)",
        title: "Supervised or autonomous, per task",
        pitch: "Supervised turns every write into an Allow / Deny card. Autonomous works in its own git worktree.",
        why: "Pick the leash per task. A repository whose rules say “every write approved” is obeyed, and the board never edits those rules.",
        where: "Approvals tab — press a",
        go: "approvals",
        headline: true,
      },
      {
        id: "landing",
        icon: "⤓",
        color: "var(--color-moss)",
        title: "Work lands safely",
        pitch: "Approving pulls main into the task first, re-runs your checks on the result, then merges one task at a time.",
        why: "Conflicts happen in the task's worktree, where Claude can fix them, never in your checkout. A failed merge is aborted, never reset --hard.",
        where: "Settings → Git & merging",
        go: "settings",
        headline: true,
      },
      {
        id: "browser",
        icon: "◉",
        color: "var(--color-cyan)",
        title: "It looks at what it built",
        pitch: "When a change is visible, the code stage opens it in a headless browser, takes a screenshot and fixes what looks wrong.",
        why: "The review stage checks for itself too, and the screenshots land in the task's Files tab. A backend change skips all of it and pays nothing.",
        where: "Settings → Browser & plugins",
        go: "settings",
      },
      {
        id: "guardrails",
        icon: "⛨",
        color: "var(--color-rust)",
        title: "Guardrails that can't be clicked past",
        pitch: "Blocked commands, never kill by name, a cost ceiling per task and per stage, and loop detection.",
        why: "Refused before any card appears. A card for rm -rf / is only a chance to click the wrong button.",
        where: "Settings → Runs & limits",
        go: "settings",
      },
    ],
  },
  {
    title: "It respects your time and money",
    blurb: "Honest numbers, and no babysitting.",
    features: [
      {
        id: "usage",
        icon: "◔",
        color: "var(--color-iris)",
        title: "Usage limits pause, then resume by themselves",
        pitch: "Your 5-hour and weekly windows sit in the top bar. A task that hits the limit pauses and continues when it resets.",
        why: "Nothing fails at 2 a.m. because a window ran out, and nothing already finished is redone. Reading the meter is free.",
        where: "Top bar · usage meters",
        headline: true,
      },
      {
        id: "cost",
        icon: "$",
        color: "var(--color-lime)",
        title: "What every task really cost",
        pitch: "Tokens, dollars and time per stage, plus the share of your 5-hour window it used.",
        why: "You learn which stages are worth their model. The dashboard shows spend, first-pass rate and where runs fail.",
        where: "Dashboard · the cost on any task",
        go: "dashboard",
      },
      {
        id: "alerts",
        icon: "♪",
        color: "var(--color-rose)",
        title: "It calls you when it needs you",
        pitch: "A colour and a sound for each event: needs approval, ready for review, landed, failed, all clear.",
        why: "Walk away. The tab icon shows the most urgent thing you missed, and a pop-up opens its task.",
        where: "Top bar · the bell",
        headline: true,
      },
      {
        id: "recall",
        icon: "⌕",
        color: "var(--color-slate)",
        title: "Nothing is lost",
        pitch: "Search specs, transcripts, results and memory with /. Chat continues a task's session; Follow-up starts a linked one.",
        why: "Days later you can still find what a run decided and why, and pick it up without starting over.",
        where: "Press / anywhere",
        go: "sessions",
      },
    ],
  },
];

export const ALL_FEATURES = GROUPS.flatMap((g) => g.features);
export const HEADLINES = ALL_FEATURES.filter((f) => f.headline);

export const SHORTCUTS: [string, string][] = [
  ["1 – 8", "switch tabs"],
  ["a", "approvals"],
  ["y / n", "allow / deny the top approval, on the Approvals tab"],
  ["/  or  Ctrl K", "search everything"],
  ["Ctrl + / − / 0", "zoom the board"],
  ["Esc", "close whatever is open"],
];
