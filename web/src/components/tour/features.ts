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
        pitch: "Every card runs as a pipeline of Claude sessions, each stage with its own model and effort, picked from what your Claude login actually has.",
        why: "The strongest model thinks where it matters and a cheap one tidies up. One Claude session doing all three pays top price for every step. A misspelt model shows in red in Settings, not as a failed run.",
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
      },
      {
        id: "chat",
        icon: "✦",
        color: "var(--color-amber)",
        title: "Talk it through, get the cards",
        pitch: "The ✦ Chat panel answers questions about your project and turns what you want into task cards: start them, or schedule them.",
        why: "Like chatting with Claude Code, but it only reads: it never changes code by itself. Work still goes through cards, approvals and review.",
        where: "Top bar → ✦ Chat, or press c",
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
        id: "rewrite",
        icon: "✦",
        color: "var(--color-iris)",
        title: "✦ Rewrite a spec after reading the code",
        pitch: "One click on a task's Spec: Opus reads the files the request is about and rewrites it into a clear spec with checks you can test.",
        why: "A spec that names the right files saves a whole run going the wrong way. Your own words are always kept: go back to them, or try another model.",
        where: "Any task → Spec → ✦ Rewrite",
        go: "board",
      },
      {
        id: "terminal",
        icon: ">_",
        color: "var(--color-slate)",
        title: "Your terminal, built in",
        pitch: "A real terminal under the board, opened in the project's folder, or in a task's own copy with Terminal here.",
        why: "Run the app, check git, try a command, without leaving the board or hunting for the right folder. Tabs keep several going, and they keep running when you hide the panel.",
        where: "Top bar → Terminal, or Ctrl + `",
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
        pitch: "Run a stage on a GLM, Kimi Code or Qwen subscription, Ollama, Codex or Gemini. Have a second model argue with a plan before any code is written.",
        why: "Claude plans; a $20 subscription does the typing. For the plan you get the objections and a revised version side by side, and you pick one.",
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
    title: "It works while you sleep",
    blurb: "Line work up for the night, or for every Monday, and let it run.",
    features: [
      {
        id: "schedule",
        icon: "⏰",
        color: "var(--color-cyan)",
        title: "Start later, or on repeat",
        pitch: "Set a card to start at a time, when your usage limit resets, or every chosen day at a set time.",
        why: "Queue the big job for 2 AM and wake up to it in Review. A repeating schedule makes a fresh card each time, so nightly checks never overwrite each other.",
        where: "Board → ⏰ Schedules · a card's ⏰ Schedule",
        go: "board",
        headline: true,
      },
      {
        id: "runs-out",
        icon: "⇆",
        color: "var(--color-iris)",
        title: "When a provider runs out, work goes on",
        pitch: "If GLM, Kimi or Claude itself runs out mid-task, the task waits for it to reset, or carries on with the fallback you picked. Credit that ran out asks you.",
        why: "The next model is told what the last one did and finds its changes in place, so nothing is redone. Work queued for a provider that is out waits instead of failing.",
        where: "Settings → Providers → When it runs out · a paused card",
        go: "settings",
      },
      {
        id: "awake",
        icon: "☾",
        color: "var(--color-iris)",
        title: "The computer stays awake for it",
        pitch: "While anything is queued, running or scheduled, the computer is asked not to sleep. The screen can still turn off.",
        why: "Night work only happens if the machine is on. If it was off anyway, a missed schedule runs once as soon as the board opens.",
        where: "Settings → Runs & limits",
        go: "settings",
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
        id: "steer",
        icon: "✎",
        color: "var(--color-amber)",
        title: "Talk to it while it works",
        pitch: "Open a running task's Chat tab and type — “use the blue from the header”, “skip the tests for now”. It reads it at its next step and carries on.",
        why: "You never have to stop a task and pay for a restart to change one thing. What you typed shows in the transcript, so you can see it was heard.",
        where: "Any running task · Chat tab",
        headline: true,
      },
      {
        id: "ask",
        icon: "?",
        color: "var(--color-iris)",
        title: "Claude asks when it matters",
        pitch: "When a choice really needs you, Claude stops and asks: options to pick from, or your own words. The card says asks you.",
        why: "No more guessing at the one decision that mattered. It waits for your answer, or, if you'd rather, decides itself after a time you set and says what it chose.",
        where: "The task's approvals tab · Approvals tab",
        go: "approvals",
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
        id: "watch",
        icon: "◉",
        color: "var(--color-rose)",
        title: "Watch it click through your app",
        pitch: "When a task opens its app in the browser, a live chip appears on its card: open it and watch the page as it clicks and types.",
        why: "You see what it is testing while it tests, not only the screenshots afterwards. No windows pop up over your work, and the picture only streams while you watch.",
        where: "A card's live chip · the task's Browser tab",
        go: "board",
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
        pitch: "Your 5-hour and weekly windows sit in the top bar, with your other providers' plans below them. A task that hits a limit pauses and continues when it resets.",
        why: "Nothing fails at 2 a.m. because a window ran out, and nothing already finished is redone. GLM, Kimi Code and OpenRouter report what is left; reading it is free.",
        where: "Top bar · usage meters",
        headline: true,
      },
      {
        id: "cost",
        icon: "$",
        color: "var(--color-lime)",
        title: "What every task really cost",
        pitch: "Tokens, dollars and time per stage. A task that reaches its cost ceiling pauses and asks — Continue with a bit more, or Stop — instead of throwing the work away.",
        why: "You learn which stages are worth their model, and money never fails a task at 90% done. The dashboard shows spend, first-pass rate and where runs fail.",
        where: "Dashboard · the cost on any task",
        go: "dashboard",
      },
      {
        id: "alerts",
        icon: "♪",
        color: "var(--color-rose)",
        title: "It calls you when it needs you",
        pitch: "A colour and a sound for each event: needs you, ready for review, landed, failed, all clear.",
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
  ["1 – 9", "switch tabs"],
  ["a", "approvals"],
  ["c", "open or close the chat"],
  ["Ctrl + `", "show or hide the terminal"],
  ["y / n", "allow / deny the top approval, on the Approvals tab"],
  ["/  or  Ctrl K", "search everything"],
  ["Ctrl + / − / 0", "zoom the board"],
  ["Esc", "close whatever is open"],
];
