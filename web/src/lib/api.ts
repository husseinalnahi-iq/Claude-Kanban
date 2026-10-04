import type { TaskCommand } from "../../../server/src/engine/commands.ts";
import type {
  ImageStatus,
  Approval, Attachment, DiffFile, EventRow, FastModeStatus, Message, MergePolicy, Milestone, Mode, Note, RunStyle, Policy, Project, ProjectEnv, Run, RunListItem, SessionTools, Settings, SkillInfo, Stage, Task, TaskCard, UsageLimit,
  Provider, ProviderTestResult, SetupCheckResult, ModelCatalogResult, Schedule, Chat, ChatFile, ChatFolder, ChatMessage, Effort, ClaudeModelsResult, SpecVersion,
  ProviderUsage, ProviderOut, WsMessage, SuggestedSkill, FolderColor } from "../../../server/src/types.ts";
import type { ProviderPreset } from "../../../server/src/engine/providers/presets.ts";
import type { LocalModelsStatus } from "../../../server/src/setup/local.ts";
export type { LocalModelsStatus };

export type ProviderRow = Provider & { hasSecret: boolean };
export type { ProviderPreset };

import type { Analytics, StageStat } from "../../../server/src/routes/analytics.ts";
import type { InstructionFile } from "../../../server/src/routes/claudeMd.ts";
import type { TriageResult } from "../../../server/src/engine/triage.ts";
import type { SearchHit } from "../../../server/src/routes/search.ts";

export type ProjectWithGit = Project & { isGit: boolean };
export interface SuggestedList {
  skills: SuggestedSkill[];
  /** What kind of project is open, for "Good for this project". */
  project: { web: boolean; react: boolean };
  loadUserPlugins: boolean;
}
export type { TerminalInfo } from "../../../server/src/terminal.ts";
import type { TerminalInfo } from "../../../server/src/terminal.ts";
export type ScheduleBody = Partial<Pick<Schedule, "spec_md" | "mode" | "may_ask" | "type" | "priority" | "pipeline" | "skills" | "enabled">> &
  Pick<Schedule, "title" | "days" | "time">;
/** What is in a folder before it is registered: nothing, code, or no folder at all. */
export type FolderProbe = { path: string; kind: "empty" | "code" | "missing"; hasClaudeMd: boolean };
export type OnboardingAnswers = { goal: string; stack: string; verify: string };
export type { SetupCheckResult };
export type SetupReport = { checks: SetupCheckResult[]; summary: { required: number; recommended: number } };
export type TriageProposal = Omit<TriageResult, "cost_usd" | "model"> & { cost_usd?: number; model?: string };
export type { Analytics, SearchHit };

export interface WorktreeRow {
  path: string;
  branch: string | null;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
  dirty: boolean;
  unmerged: number;
  /** Commits the base branch has that this worktree doesn't — how stale it is. */
  behind: number;
  removable: boolean;
  blockers: string[];
}

export interface TaskDetail {
  task: Task;
  parent: Task | null;
  children: Task[];
  runs: Run[];
  approvals: Approval[];
  messages: Message[];
  attachments: Attachment[];
  busy: boolean;
  /** Set when the task has a worktree: which branch it lands on, and how far behind it has fallen. */
  staleness: { base: string; behind: number } | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Codex on this computer, as GET /codex/status says (D296). */
export type CodexView = Extract<WsMessage, { type: "codex.updated" }>["status"];

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, res.status);
  return data as T;
}

export interface CliHealth {
  loggedIn: boolean;
  authMethod: string | null;
  cliVersion: string | null;
  sdkVersion: string;
  error: string | null;
  checkedAt: string;
}

/** What Settings → Images → Try it gets back: the picture itself, inline, or why not. */
export interface ImageTry {
  ok: boolean;
  dataUrl: string | null;
  provider: string;
  latencyMs: number;
  error: string | null;
}

export const api = {
  health: () => req<CliHealth>("GET", "/health"),
  version: () => req<{ startedAt: string; stale: boolean }>("GET", "/version"),
  setup: (fresh = false) => req<SetupReport>("GET", `/setup${fresh ? "?fresh=1" : ""}`),
  recheckSetup: (id: string) => req<SetupCheckResult>("POST", `/setup/${encodeURIComponent(id)}/check`, {}),
  fixSetup: (id: string, body: { kind: "run"; input?: Record<string, string> } | { kind: "claude" }) =>
    req<{ started?: boolean; task?: Task }>("POST", `/setup/${encodeURIComponent(id)}/fix`, body),
  /** Skills worth having, installed with the same fixes as a Setup row (`fixSetup`). */
  recommendedSkills: (fresh = false) => req<{ checks: SetupCheckResult[] }>("GET", `/setup/recommended${fresh ? "?fresh=1" : ""}`),
  login: () => req<CliHealth & { started: boolean }>("POST", "/auth/login", {}),
  /** A Setup row's own action ("Use it", "Sign in"): one of the board's endpoints, posted as is. */
  setupAction: (endpoint: string) => req<unknown>("POST", endpoint, {}),
  codexStatus: (fresh = false) => req<CodexView>("GET", `/codex/status${fresh ? "?fresh=1" : ""}`),
  codexLink: () => req<{ changed: string[]; status: CodexView }>("POST", "/codex/link", {}),
  codexLogin: () => req<{ started: boolean }>("POST", "/codex/login", {}),
  codexPicturesReset: () => req<{ ok: boolean }>("POST", "/codex/pictures/reset", {}),
  limits: () => req<UsageLimit[]>("GET", "/limits"),
  pickFolder: (start?: string) => req<{ path: string | null; cancelled: boolean; error: string | null }>("POST", "/pick-folder", { start }),
  projects: () => req<ProjectWithGit[]>("GET", "/projects"),
  probeFolder: (path: string) => req<FolderProbe>("GET", `/projects/probe?path=${encodeURIComponent(path)}`),
  createProject: (b: { name: string; path: string; policy?: Partial<Policy>; onboarding?: { init?: boolean; bootstrap?: OnboardingAnswers } }) =>
    req<ProjectWithGit & { onboardingTask: Task | null }>("POST", "/projects", b),
  bootstrapProject: (id: string, b: OnboardingAnswers) => req<Task>("POST", `/projects/${id}/bootstrap`, b),
  patchProject: (id: string, b: { name?: string; policy?: Partial<Policy>; env?: Partial<ProjectEnv>; merge?: Partial<MergePolicy> }) =>
    req<ProjectWithGit>("PATCH", `/projects/${id}`, b),
  deleteProject: (id: string) => req<{ ok: true }>("DELETE", `/projects/${id}`),

  tasks: (projectId: string) => req<TaskCard[]>("GET", `/tasks?project=${encodeURIComponent(projectId)}`),
  task: (id: string) => req<TaskDetail>("GET", `/tasks/${id}`),
  createTask: (b: { project_id: string; title: string; spec_md?: string; mode?: Mode; pipeline?: Stage[]; parent_id?: string | null; milestone_id?: string | null; skills?: string[]; live?: boolean; plan_approval?: boolean | null; own_branch?: boolean; may_ask?: boolean; depends_on?: string[] }) =>
    req<Task>("POST", "/tasks", b),
  patchTask: (
    id: string,
    b: Partial<Pick<Task, "title" | "spec_md" | "mode" | "pipeline" | "milestone_id" | "skills" | "position" | "parent_id" | "type" | "priority" | "labels" | "depends_on" | "auto_queue_children" | "suggestion" | "live" | "plan_approval" | "own_branch" | "may_ask">>,
  ) =>
    req<Task>("PATCH", `/tasks/${id}`, b),
  deleteTask: (id: string) => req<{ ok: true }>("DELETE", `/tasks/${id}`),
  /** Start a Backlog card later: an ISO time, "reset" for when the usage window resets, or null to cancel. */
  scheduleTask: (id: string, start_at: string | null) => req<Task>("POST", `/tasks/${id}/schedule`, { start_at }),
  schedules: (projectId: string) => req<Schedule[]>("GET", `/projects/${projectId}/schedules`),
  createSchedule: (b: ScheduleBody & { project_id: string }) => req<Schedule>("POST", "/schedules", b),
  patchSchedule: (id: string, b: Partial<ScheduleBody>) => req<Schedule>("PATCH", `/schedules/${id}`, b),
  deleteSchedule: (id: string) => req<{ ok: true }>("DELETE", `/schedules/${id}`),
  runSchedule: (id: string) => req<Task>("POST", `/schedules/${id}/run`),

  terminals: () => req<TerminalInfo[]>("GET", "/terminals"),
  createTerminal: (b: { project_id: string; task_id?: string | null }) => req<TerminalInfo>("POST", "/terminals", b),
  deleteTerminal: (id: string) => req<{ ok: boolean }>("DELETE", `/terminals/${id}`),

  chats: (projectId: string) => req<Chat[]>("GET", `/projects/${projectId}/chats`),
  createChat: (projectId: string) => req<Chat>("POST", `/projects/${projectId}/chats`, {}),
  patchChat: (id: string, b: { title?: string; model?: string; effort?: Effort; provider?: string; archived?: boolean; folder_id?: string | null; keep_alive?: boolean; use_tools?: boolean; mode?: RunStyle }) => req<Chat>("PATCH", `/chats/${id}`, b),
  suggestNext: (id: string) => req<ChatMessage>("POST", `/chats/${id}/suggest`, {}),
  chatFiles: (id: string) => req<ChatFile[]>("GET", `/chats/${id}/files`),
  addChatFile: (id: string, b: { name: string; data: string }) => req<ChatFile>("POST", `/chats/${id}/files`, b),
  deleteChatFile: (id: string) => req<{ ok: true }>("DELETE", `/chat-files/${id}`),
  chatFileUrl: (id: string) => `/api/chat-files/${id}/raw`,
  /** Opens the file on the computer the board runs on, or shows it selected in its folder (D351). */
  openChatFile: (id: string, where: "file" | "folder") => req<{ ok: true }>("POST", `/chat-files/${id}/open`, { where }),
  chatFolders: (projectId: string) => req<ChatFolder[]>("GET", `/projects/${projectId}/chat-folders`),
  createChatFolder: (projectId: string, name: string) => req<ChatFolder>("POST", `/projects/${projectId}/chat-folders`, { name }),
  patchChatFolder: (id: string, b: { name?: string; color?: FolderColor | null }) => req<ChatFolder>("PATCH", `/chat-folders/${id}`, b),
  deleteChatFolder: (id: string) => req<{ ok: true }>("DELETE", `/chat-folders/${id}`),
  deleteChat: (id: string) => req<{ ok: true }>("DELETE", `/chats/${id}`),
  chatMessages: (id: string) => req<ChatMessage[]>("GET", `/chats/${id}/messages`),
  sendChat: (id: string, text: string) => req<ChatMessage>("POST", `/chats/${id}/send`, { text }),
  stopChat: (id: string) => req<{ stopped: boolean }>("POST", `/chats/${id}/stop`),
  /** `force` starts the task beside whatever is running, outside the concurrency caps. */
  /** `confirmSetup`: Start pressed on the setup card, where its mode and models were shown (D365). */
  queue: (id: string, force?: boolean, confirmSetup?: boolean) => req<Task>("POST", `/tasks/${id}/queue`, { force, confirm_setup: confirmSetup || undefined }),
  retry: (id: string, stage_index?: number, force?: boolean) => req<Task>("POST", `/tasks/${id}/retry`, { stage_index, force }),
  stop: (id: string) => req<Task>("POST", `/tasks/${id}/stop`),
  approve: (id: string) => req<Task>("POST", `/tasks/${id}/approve`),
  resolveConflict: (id: string) => req<Task>("POST", `/tasks/${id}/resolve`),
  reject: (id: string, note: string | null) => req<Task>("POST", `/tasks/${id}/reject`, { note }),
  discard: (id: string) => req<Task>("POST", `/tasks/${id}/discard`),
  escalate: (id: string) => req<Task>("POST", `/tasks/${id}/escalate`),
  answerQuestion: (id: string, questionId: string, answer: string) => req<Task>("POST", `/tasks/${id}/questions/${questionId}`, { answer }),
  chat: (id: string, body: string) => req<Run>("POST", `/tasks/${id}/message`, { body }),
  diff: (id: string) => req<DiffFile[]>("GET", `/tasks/${id}/diff`),

  runs: () => req<RunListItem[]>("GET", "/runs"),
  explainCommand: (command: string) => req<{ text: string }>("POST", "/explain", { command }),
  taskCommands: (taskId: string) => req<TaskCommand[]>("GET", `/tasks/${taskId}/commands`),
  events: (runId: string, after = 0) => req<EventRow[]>("GET", `/runs/${runId}/events?after=${after}`),
  pendingApprovals: () => req<Approval[]>("GET", "/approvals"),
  /** `always`: allow, and stop asking for this command in this project (D353). */
  decide: (id: string, decision: "allow" | "deny", note?: string, always?: boolean) => req<Approval>("POST", `/approvals/${id}`, { decision, note, always }),
  /** Answer a question Claude asked: question text → the option label(s) chosen, or your own words. */
  answer: (id: string, answers: Record<string, string>) => req<Approval>("POST", `/approvals/${id}/answer`, { answers }),

  milestones: (projectId: string) => req<Milestone[]>("GET", `/milestones?project=${encodeURIComponent(projectId)}`),
  createMilestone: (b: { project_id: string; title: string; due_date?: string | null }) => req<Milestone>("POST", "/milestones", b),
  patchMilestone: (id: string, b: Partial<Pick<Milestone, "title" | "position" | "due_date" | "notes">>) => req<Milestone>("PATCH", `/milestones/${id}`, b),
  deleteMilestone: (id: string) => req<{ ok: true }>("DELETE", `/milestones/${id}`),

  skills: (projectId?: string) => req<SkillInfo[]>("GET", `/skills${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`),
  openSkill: (path: string, project?: string) => req<{ ok: true }>("POST", "/skills/open", { path, project }),
  suggestedSkills: (projectId?: string) =>
    req<SuggestedList>("GET", `/skills/suggested${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`),
  installSuggested: (id: string) => req<{ started: true }>("POST", `/skills/suggested/${encodeURIComponent(id)}/install`),
  removeSuggested: (id: string) => req<{ started: true }>("POST", `/skills/suggested/${encodeURIComponent(id)}/remove`),
  setSuggestedEnabled: (id: string, on: boolean) => req<SuggestedSkill>("POST", `/skills/suggested/${encodeURIComponent(id)}/enabled`, { on }),
  installStarterPack: () => req<{ queued: string[] }>("POST", "/skills/suggested/starter"),

  search: (q: string, projectId?: string) =>
    req<SearchHit[]>("GET", `/search?q=${encodeURIComponent(q)}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`),
  followUp: (taskId: string, b: { title?: string; note?: string; type?: Task["type"] }) => req<Task>("POST", `/tasks/${taskId}/follow-up`, b),

  stageStats: (projectId: string) => req<StageStat[]>("GET", `/stats/stages?project=${encodeURIComponent(projectId)}`),
  analytics: (projectId: string | undefined, days: number) =>
    req<Analytics>("GET", `/analytics?days=${days}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`),
  specStatus: (taskId: string) => req<{ versions: SpecVersion[]; rewriting: { model: string; note: string } | null }>("GET", `/tasks/${taskId}/spec`),
  rewriteSpec: (taskId: string, body: { model?: string; effort?: Effort; instruction?: string }) =>
    req<{ started: true; model: string }>("POST", `/tasks/${taskId}/spec/rewrite`, body),
  stopSpecRewrite: (taskId: string) => req<{ stopped: boolean }>("POST", `/tasks/${taskId}/spec/stop`, {}),
  restoreSpec: (taskId: string, versionId: string) => req<Task>("POST", `/tasks/${taskId}/spec/restore`, { version_id: versionId }),
  refine: (taskId: string) => req<TriageProposal>("POST", `/tasks/${taskId}/refine`),
  applyRefine: (taskId: string, proposal: TriageProposal & { auto_queue_children?: boolean }) =>
    req<{ task: Task; subtasks: Task[] }>("POST", `/tasks/${taskId}/refine/apply`, proposal),

  memory: (projectId: string) => req<Note[]>("GET", `/memory?project=${encodeURIComponent(projectId)}`),
  addMemory: (project_id: string, text: string) => req<Note>("POST", "/memory", { project_id, text }),
  deleteMemory: (id: string) => req<{ ok: true }>("DELETE", `/memory/${id}`),
  keepMemory: (id: string) => req<Note>("POST", `/memory/${id}/keep`),

  pausedTasks: () => req<Task[]>("GET", "/tasks/paused"),
  claudeMd: (projectId: string) => req<InstructionFile[]>("GET", `/projects/${projectId}/claude-md`),
  initClaudeMd: (projectId: string) => req<Task>("POST", `/projects/${projectId}/claude-md/init`),
  fastMode: (force = false) => req<FastModeStatus>("GET", `/fast-mode${force ? "?force=1" : ""}`),
  claudeModels: (force = false) => req<ClaudeModelsResult>("GET", `/claude/models${force ? "?force=1" : ""}`),
  sessionTools: (force = false) => req<SessionTools>("GET", `/session-tools${force ? "?force=1" : ""}`),
  resumeTask: (id: string) => req<Task>("POST", `/tasks/${id}/resume`),
  /** A task paused at its cost ceiling: spend one more stage's worth, or give up. */
  continueTask: (id: string) => req<Task>("POST", `/tasks/${id}/continue`),
  stopPaused: (id: string) => req<Task>("POST", `/tasks/${id}/stop-paused`),
  /** A task paused because Claude or a provider ran out: carry its stage on elsewhere now. */
  switchStage: (id: string, body: { provider: string; model: string; remember?: boolean }) => req<Task>("POST", `/tasks/${id}/switch`, body),
  refreshLimits: () => req<UsageLimit[]>("POST", "/limits/refresh"),
  dismissSuggestion: (id: string, what: { fields?: boolean; pipeline?: boolean; mode?: boolean; live?: boolean }) => req<Task>("POST", `/tasks/${id}/dismiss-suggestion`, what),
  acceptSuggestion: (id: string, what: { fields?: boolean; pipeline?: boolean; mode?: boolean; live?: boolean }) => req<Task>("POST", `/tasks/${id}/accept-suggestion`, what),
  planDecision: (id: string, b: { choice: "original" | "revised" | "custom"; text?: string }) => req<Task>("POST", `/tasks/${id}/plan-decision`, b),
  describeAttachment: (id: string) => req<{ description: string }>("POST", `/attachments/${id}/describe`),

  archive: (id: string) => req<Task>("POST", `/tasks/${id}/archive`),
  unarchive: (id: string) => req<Task>("POST", `/tasks/${id}/unarchive`),
  archiveDone: (project_id: string, olderThanDays = 0) => req<{ archived: string[] }>("POST", "/tasks/archive-done", { project_id, olderThanDays }),

  attachments: (taskId: string) => req<Attachment[]>("GET", `/tasks/${taskId}/attachments`),
  addAttachment: (taskId: string, b: { name: string; media_type: string; data: string; note?: string | null }) =>
    req<Attachment>("POST", `/tasks/${taskId}/attachments`, b),
  deleteAttachment: (id: string) => req<{ ok: true }>("DELETE", `/attachments/${id}`),
  /** The bytes: inline for an <img src>, a download for anything else. */
  attachmentUrl: (id: string) => `/api/attachments/${id}/raw`,
  /** Opens the file on the computer the board runs on, or shows it selected in its folder (D351). */
  openAttachment: (id: string, where: "file" | "folder") => req<{ ok: true }>("POST", `/attachments/${id}/open`, { where }),
  /** A text file's content, as plain text, for previews. */
  attachmentText: async (id: string) => {
    const r = await fetch(`/api/attachments/${id}/text`);
    if (!r.ok) throw new ApiError(await r.text(), r.status);
    return r.text();
  },

  updateFromBase: (taskId: string) => req<{ pulled: number; base: string }>("POST", `/tasks/${taskId}/update-from-base`),

  worktrees: (projectId: string) => req<WorktreeRow[]>("GET", `/worktrees?project=${encodeURIComponent(projectId)}`),
  pruneWorktrees: (project_id: string) => req<{ removed: string[] }>("POST", "/worktrees/prune", { project_id }),

  settings: () => req<Settings>("GET", "/settings"),
  providers: () => req<ProviderRow[]>("GET", "/providers"),
  providerPresets: () => req<ProviderPreset[]>("GET", "/providers/presets"),
  providerUsage: (force = false) => req<ProviderUsage[]>("GET", `/providers/usage${force ? "?force=1" : ""}`),
  providerOuts: () => req<ProviderOut[]>("GET", "/providers/out"),
  setProviderSecret: (id: string, value: string) => req<{ hasSecret: boolean }>("PUT", `/providers/${id}/secret`, { value }),
  deleteProviderSecret: (id: string) => req<{ hasSecret: boolean }>("DELETE", `/providers/${id}/secret`),
  testVision: (provider: string, model: string) =>
    req<{ ok: boolean; text: string | null; latencyMs: number; error: string | null }>("POST", "/settings/vision/test", { provider, model }),
  localModels: () => req<LocalModelsStatus>("GET", "/setup/local-models"),
  providerModels: (id: string) => req<ModelCatalogResult>("GET", `/providers/${encodeURIComponent(id)}/models`),
  testProvider: (id: string, model?: string) => req<ProviderTestResult>("POST", `/providers/${id}/test`, { model }),
  patchSettings: (b: Partial<Omit<Settings, "stateDir">>) => req<Settings>("PATCH", "/settings", b),
  imageStatus: () => req<ImageStatus>("GET", "/settings/images"),
  setImageSecret: (name: string, value: string) => req<ImageStatus>("PUT", "/settings/images/secret", { name, value }),
  deleteImageSecret: (name: string) => req<ImageStatus>("DELETE", `/settings/images/secret/${encodeURIComponent(name)}`),
  testImage: (prompt?: string) => req<ImageTry>("POST", "/settings/images/test", { prompt }),
};
