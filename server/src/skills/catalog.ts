import type { SuggestedSkill } from "../types.ts";

/**
 * The Skills tab's Recommended list (spec 2026-09-12 §3, D317–D321). Every entry was read at the
 * commit pinned here; a skill is copied from that commit, never from whatever the repo holds today,
 * because a skill is instructions an unattended run follows. Plugins come through their marketplace,
 * which pins its own versions. Pure data: the web may import it, so no Node imports.
 */

interface Base {
  id: string;
  name: string;
  what: string;
  starter?: boolean;
  fits?: SuggestedSkill["fits"];
  needsPython?: boolean;
  /** Programs it needs that the card checks for: python, libreoffice. */
  needs?: ("python" | "libreoffice")[];
  tooltip: SuggestedSkill["tooltip"];
}

export interface CatalogSkill extends Base {
  kind: "skill";
  /** GitHub owner/name. */
  repo: string;
  commit: string;
  /** The skill's folder inside the repo; its last part names the folder in ~/.claude/skills unless `dest` does. */
  path: string;
  /** The folder in ~/.claude/skills, when the repo's folder is not named after the skill. */
  dest?: string;
  /** The name in its SKILL.md, when it is not the folder's: how a copy installed some other way is recognised. */
  skillName?: string;
  /** A global npm package the skill drives, installed first and left in place on remove. */
  npmTool?: string;
}

export interface CatalogPlugin extends Base {
  kind: "plugin";
  plugin: string;
  marketplace: string;
  /** What `claude plugin marketplace add` takes. */
  marketplaceRepo: string;
  /** It has no skills, so the Skills list cannot switch it off and its card does (D319). */
  noSkills?: boolean;
  /** One of its skills' names: a copy of it installed some other way still counts as on this computer. */
  skillName?: string;
}

/** Not a skill: installed and checked by its Setup check (`setup/recommended.ts`), shown in the same list. */
export interface CatalogTool extends Base {
  kind: "tool";
  check: string;
  link: string;
}

export type CatalogEntry = CatalogSkill | CatalogPlugin | CatalogTool;

const SUPERPOWERS = { repo: "obra/superpowers", commit: "8ca22dba9a94f28898bbce59f2537ff4d87c747d" };
const OFFICIAL = { marketplace: "claude-plugins-official", marketplaceRepo: "anthropics/claude-plugins-official" };

export const CATALOG: CatalogEntry[] = [
  {
    id: "verification-before-completion",
    name: "verification-before-completion",
    what: 'Must show the tests passing before it says "done".',
    kind: "skill",
    ...SUPERPOWERS,
    path: "skills/verification-before-completion",
    starter: true,
    tooltip: { unattended: "yes", watch: 'Runs the tests before it says "done", so a task takes a little longer and costs a little more.', off: null },
  },
  {
    id: "systematic-debugging",
    name: "systematic-debugging",
    what: "Finds the real cause of a bug before changing code.",
    kind: "skill",
    ...SUPERPOWERS,
    path: "skills/systematic-debugging",
    starter: true,
    tooltip: {
      unattended: "note",
      watch: "After several failed fixes it wants to talk to a person. On the board that becomes a question on the card with a default answer, and the task carries on.",
      off: null,
    },
  },
  {
    id: "test-driven-development",
    name: "test-driven-development",
    what: "Writes a failing test first, so the fix is proven.",
    kind: "skill",
    ...SUPERPOWERS,
    path: "skills/test-driven-development",
    starter: true,
    tooltip: {
      unattended: "note",
      watch: "Writes a test before the fix, so tasks take longer. Exceptions it would ask a person about become a question on the card.",
      off: null,
    },
  },
  {
    id: "ponytail",
    name: "Ponytail",
    what: "Writes less code: checks whether it already exists first. About 10% cheaper per task in JetBrains' independent test.",
    kind: "plugin",
    plugin: "ponytail",
    marketplace: "ponytail",
    marketplaceRepo: "DietrichGebert/ponytail",
    starter: true,
    tooltip: {
      unattended: "yes",
      watch: "Pushes for less code. If test-driven-development is also on, check that tests still get written. JetBrains measured it about 10% cheaper per task.",
      off: null,
    },
  },
  {
    id: "code-simplifier",
    name: "code-simplifier",
    what: "Tidies freshly written code without changing what it does.",
    kind: "plugin",
    plugin: "code-simplifier",
    ...OFFICIAL,
    starter: true,
    tooltip: { unattended: "yes", watch: "Runs on Opus, so each use costs more than the task's own model. It only tidies code and never changes what it does.", off: null },
  },
  {
    id: "frontend-design",
    name: "frontend-design",
    what: "UI changes look designed, not generic.",
    kind: "plugin",
    plugin: "frontend-design",
    ...OFFICIAL,
    // The same skill, byte for byte, as anthropics/skills' copy: one installed from there counts.
    skillName: "frontend-design",
    fits: "web",
    tooltip: {
      unattended: "yes",
      watch: "Only helps tasks that change screens. On a vague brief it may stop to confirm what the product is, so say what it is and who it is for.",
      off: null,
    },
  },
  {
    id: "pr-review-toolkit",
    name: "pr-review-toolkit",
    what: "Extra reviewers for tests, hidden errors and types.",
    kind: "plugin",
    plugin: "pr-review-toolkit",
    ...OFFICIAL,
    tooltip: { unattended: "yes", watch: "Its main reviewer runs on Opus, so each review costs more. It uses the GitHub tool (gh) to look at an open pull request.", off: null },
  },
  {
    id: "react-best-practices",
    name: "react-best-practices",
    what: "React habits that avoid slow, buggy pages.",
    kind: "skill",
    repo: "vercel-labs/agent-skills",
    commit: "063bee94c3f4df8453406c830b0a7df0f2860278",
    path: "skills/react-best-practices",
    skillName: "vercel-react-best-practices",
    fits: "react",
    tooltip: { unattended: "yes", watch: "Only useful in React projects. Its repo has no licence file; the skill itself says MIT.", off: null },
  },
  {
    id: "document-skills",
    name: "document-skills",
    what: "Reads, makes and edits PDFs and Excel, Word and PowerPoint files.",
    kind: "plugin",
    plugin: "document-skills",
    marketplace: "anthropic-agent-skills",
    marketplaceRepo: "anthropics/skills",
    needsPython: true,
    needs: ["python", "libreoffice"],
    tooltip: {
      unattended: "yes",
      watch:
        "Needs Python and LibreOffice on this computer. Without LibreOffice, Excel formulas are not recalculated and some conversions fail. Anthropic's licence: free to use with Claude, not to copy or share.",
      off: null,
    },
  },
  {
    id: "playwright-cli",
    name: "playwright-cli",
    what: "Opens the web page it just built, clicks through it and takes screenshots.",
    kind: "skill",
    repo: "microsoft/playwright-cli",
    commit: "b85c7a736bb473bf55b584e54a09ffa698d6d871",
    path: "skills/playwright-cli",
    // Its own `install --skills` writes into the current folder, which for a run is the task's worktree.
    npmTool: "@playwright/cli@latest",
    fits: "web",
    tooltip: {
      unattended: "yes",
      watch: "Opens a hidden browser. The task must be able to start the app on its own, and pages behind a login need test account details in the task.",
      off: null,
    },
  },
  {
    id: "context7-find-docs",
    name: "Context7 find-docs",
    what: "Looks up a library's current docs instead of guessing from memory.",
    kind: "skill",
    repo: "upstash/context7",
    commit: "bfa02ea67b5707fe0e0a673faa49d0f50b28c80b",
    path: "skills/find-docs",
    tooltip: {
      unattended: "yes",
      watch:
        "Sends your library questions, but no code or passwords, to Context7's online service. Free without an account; a free key raises the limit. You need this or the Context7 plugin, not both.",
      off: null,
    },
  },
  {
    id: "context7-plugin",
    name: "Context7 plugin",
    what: "The same docs lookup, as a connection Claude can call at any time.",
    kind: "plugin",
    plugin: "context7",
    ...OFFICIAL,
    noSkills: true,
    tooltip: {
      unattended: "yes",
      watch: "Every task connects to Context7's online service, even one that needs no docs. You need this or Context7 find-docs, not both.",
      off: "Use the switch on this card: it has no skills, so the switches in the Skills list do not cover it.",
    },
  },
  {
    id: "emil-design-eng",
    name: "Emil Kowalski — design engineering",
    what: "Interfaces that feel finished: when to animate and how fast, natural easing, buttons that respond to a press.",
    kind: "skill",
    repo: "emilkowalski/skills",
    commit: "e8a175de22ae1e49370fc144c1f3bb9aeedf988d",
    path: "skills/emil-design-eng",
    fits: "web",
    tooltip: {
      unattended: "note",
      watch: "Asked to use it with no actual job, it only says hello and stops, so give each task a concrete request. Licence: MIT.",
      off: null,
    },
  },
  {
    id: "design-taste-frontend",
    name: "Taste — pages that don't look generic",
    what: "Steers landing pages and portfolios away from the template look, toward a deliberate style.",
    kind: "skill",
    repo: "Leonxlnx/taste-skill",
    commit: "ce26fc25c0e5e8cab638f883de62d9a86ee5e45b",
    path: "skills/taste-skill",
    dest: "design-taste-frontend",
    fits: "web",
    tooltip: {
      unattended: "note",
      watch:
        "Very long (about 22,000 tokens each time it is used). On a vague brief it asks one question, which becomes a question on the card. It uses any picture maker you have connected.",
      off: null,
    },
  },
  {
    id: "ui-ux-pro-max",
    name: "UI/UX Pro Max",
    what: "A design library Claude searches for styles, colour palettes, font pairings and chart types, plus brand, banner and slide skills.",
    kind: "plugin",
    plugin: "ui-ux-pro-max",
    marketplace: "ui-ux-pro-max-skill",
    marketplaceRepo: "nextlevelbuilder/ui-ux-pro-max-skill",
    skillName: "ui-ux-pro-max",
    fits: "web",
    needsPython: true,
    needs: ["python"],
    tooltip: {
      unattended: "note",
      watch:
        "Its banner, logo and brand skills ask you questions: on the card in an unattended task, waiting for you in a supervised one. Needs Python 3; its logo and image tools need paid API keys.",
      off: null,
    },
  },
  {
    id: "markitdown",
    name: "MarkItDown (Microsoft)",
    what: "A tool rather than a skill: Claude reads PDFs, Word, Excel and PowerPoint files and web pages as text.",
    kind: "tool",
    check: "tool:markitdown",
    link: "https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp",
    needsPython: true,
    tooltip: {
      unattended: "yes",
      watch:
        "Needs Python 3.10 to 3.14. Documents are converted on this computer, but an audio or video file is sent to Google's speech service to be written out. It fetches any web address a task gives it.",
      off: "Settings → Browser, images & plugins stops tasks using it.",
    },
  },
];

/** The order of the cards: the starter pack, design, documents, then the rest. */
const ORDER = [
  "verification-before-completion", "systematic-debugging", "test-driven-development", "ponytail", "code-simplifier",
  "frontend-design", "emil-design-eng", "design-taste-frontend", "ui-ux-pro-max", "react-best-practices",
  "document-skills", "markitdown",
  "pr-review-toolkit", "playwright-cli", "context7-find-docs", "context7-plugin",
];
CATALOG.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

/** The folder a catalog skill lands in under ~/.claude/skills. */
export const skillDir = (s: CatalogSkill): string => s.dest ?? s.path.split("/").at(-1)!;

export const pluginKey = (p: CatalogPlugin): string => `${p.plugin}@${p.marketplace}`;

/** "obra/superpowers" for a skill, the marketplace's repo for a plugin, the tool's own repo. */
export const fromOf = (e: CatalogEntry): string =>
  e.kind === "skill" ? e.repo : e.kind === "plugin" ? e.marketplaceRepo : e.link.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+).*$/, "$1");

/** Where to read it: a skill at the very commit that is installed. */
export const linkOf = (e: CatalogEntry): string =>
  e.kind === "skill" ? `https://github.com/${e.repo}/tree/${e.commit}/${e.path}` : e.kind === "plugin" ? `https://github.com/${e.marketplaceRepo}` : e.link;

/** The Setup check behind a card: its "Install with Claude", and all of a tool's state. */
export const checkOf = (e: CatalogEntry): string => (e.kind === "tool" ? e.check : `skill:${e.id}`);
