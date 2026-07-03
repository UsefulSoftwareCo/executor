import type { AgentDefinition, AgentToolName, SkillDocument } from "@/lib/agents/definitions";
import { AGENT_TOOL_NAMES } from "@/lib/agents/definitions";
import type { WorkspaceRepo } from "@/lib/workspace-repos";
import {
  AUTOMATION_AUTONOMY_LEVELS,
  isBuiltInToolAllowedForAutonomy,
} from "./policy";
import type { AutomationPolicy } from "./types";

export type AutomationCatalogOption = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  badge?: string;
  keywords?: string[];
};

export type AutomationEventSourceCatalogItem = AutomationCatalogOption & {
  events: AutomationCatalogOption[];
};

export type AutomationTriggerKind = "event" | "schedule" | "poll" | "manual";
export type AutomationActionKind =
  | "notify"
  | "startSession"
  | "messageSession"
  | "runFunction"
  | "emitEvent"
  | "monitor";
export type AutomationNotifyDestination = "inbox" | "webhook" | "slack" | "github" | "linear";
export type AutomationAutonomy = AutomationPolicy["autonomy"];

export type AutomationSchedulePreset = AutomationCatalogOption & {
  schedule:
    | { kind: "interval"; everyMs: number }
    | { kind: "cron"; expression: string; timezone?: string };
};

export type AutomationBuiltInToolCatalogItem = AutomationCatalogOption & {
  id: AgentToolName;
  allowedByAutonomy: AutomationAutonomy[];
};

export type AutomationExecutorSourceCatalogItem = AutomationCatalogOption & {
  pattern: string;
  toolCount: number;
};

export type AutomationExecutorToolCatalogItem = AutomationCatalogOption & {
  sourceId?: string;
  pattern: string;
};

export type AutomationAgentCatalogItem = {
  id: string;
  name: string;
  description: string;
  model?: string;
  tools: string[];
  repos: WorkspaceRepo[];
  skills: string[];
  isDefault: boolean;
};

export type AutomationSkillCatalogItem = {
  id: string;
  name: string;
  description: string;
  userInvocable?: boolean;
  allowedTools: string[];
  agent?: string;
};

export type AutomationRepoOwnerCatalogItem = {
  id: string;
  label: string;
  accountType: "User" | "Organization";
  installationId: number;
  repositorySelection: "all" | "selected";
};

export type AutomationRepoCatalogItem = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  cloneUrl?: string;
  branch?: string;
  updatedAt?: string;
};

export type AutomationBuilderCatalog = {
  triggerKinds: AutomationCatalogOption[];
  eventSources: AutomationEventSourceCatalogItem[];
  schedulePresets: AutomationSchedulePreset[];
  actions: AutomationCatalogOption[];
  notifyDestinations: AutomationCatalogOption[];
  autonomyLevels: AutomationCatalogOption[];
  builtInTools: AutomationBuiltInToolCatalogItem[];
  executorSources: AutomationExecutorSourceCatalogItem[];
  executorTools: AutomationExecutorToolCatalogItem[];
  agents: AutomationAgentCatalogItem[];
  skills: AutomationSkillCatalogItem[];
  repoOwners: AutomationRepoOwnerCatalogItem[];
  repos: AutomationRepoCatalogItem[];
  defaultAgentName: string | null;
  errors: string[];
};

export const AUTOMATION_TRIGGER_KIND_OPTIONS = [
  {
    id: "event",
    label: "Event",
    description: "GitHub, Slack, Linear, webhook",
  },
  {
    id: "schedule",
    label: "Schedule",
    description: "Queue-backed cadence",
  },
  {
    id: "poll",
    label: "Poll",
    description: "Scheduled evaluator",
  },
  {
    id: "manual",
    label: "Manual",
    description: "Test and API starts",
  },
] as const satisfies readonly AutomationCatalogOption[];

export const AUTOMATION_SCHEDULE_PRESETS = [
  {
    id: "every-15-minutes",
    label: "Every 15 minutes",
    description: "High-frequency checks for active work.",
    schedule: { kind: "interval", everyMs: 15 * 60 * 1000 },
  },
  {
    id: "hourly",
    label: "Hourly",
    description: "Default for triage and polling.",
    schedule: { kind: "interval", everyMs: 60 * 60 * 1000 },
  },
  {
    id: "every-6-hours",
    label: "Every 6 hours",
    description: "A quieter background cadence.",
    schedule: { kind: "interval", everyMs: 6 * 60 * 60 * 1000 },
  },
  {
    id: "weekday-9am",
    label: "Weekdays at 9 AM",
    description: "Morning operational review.",
    schedule: {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "America/Chicago",
    },
  },
] as const satisfies readonly AutomationSchedulePreset[];

export const AUTOMATION_ACTION_OPTIONS = [
  {
    id: "messageSession",
    label: "Message session",
    description: "Continue a correlated thread",
  },
  {
    id: "startSession",
    label: "Start session",
    description: "Create a focused agent run",
  },
  {
    id: "notify",
    label: "Notify",
    description: "Inbox or external callback",
  },
  {
    id: "runFunction",
    label: "Run function",
    description: "Executor TypeScript",
  },
  {
    id: "emitEvent",
    label: "Emit event",
    description: "Fan out to more routes",
  },
  {
    id: "monitor",
    label: "Monitor",
    description: "Record an observation artifact",
  },
] as const satisfies readonly AutomationCatalogOption[];

export const AUTOMATION_NOTIFY_DESTINATIONS = [
  {
    id: "inbox",
    label: "Inbox",
    description: "Record an automation inbox item.",
  },
  {
    id: "webhook",
    label: "Webhook",
    description: "Send a callback to an external endpoint.",
  },
  {
    id: "slack",
    label: "Slack",
    description: "Post to a Slack destination.",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Create GitHub-facing output.",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Create Linear-facing output.",
  },
] as const satisfies readonly AutomationCatalogOption[];

export const AUTOMATION_EVENT_SOURCES = [
  {
    id: "github",
    label: "GitHub",
    description: "GitHub App webhook events normalized by repository and subject.",
    events: [
      { id: "pull_request.*", label: "Any pull request event" },
      { id: "pull_request.opened", label: "Pull request opened" },
      { id: "pull_request.synchronize", label: "Pull request synchronized" },
      { id: "pull_request.reopened", label: "Pull request reopened" },
      { id: "pull_request.ready_for_review", label: "Pull request ready for review" },
      { id: "pull_request.closed", label: "Pull request closed" },
      { id: "check_run.*", label: "Any check run event" },
      { id: "check_run.completed", label: "Check run completed" },
      { id: "check_suite.*", label: "Any check suite event" },
      { id: "check_suite.completed", label: "Check suite completed" },
      { id: "push", label: "Push" },
      { id: "issues.*", label: "Any issue event" },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    description: "Slack bot thread messages.",
    events: [{ id: "message.received", label: "Message received" }],
  },
  {
    id: "linear",
    label: "Linear",
    description: "Linear webhook and poller issue activity.",
    events: [
      { id: "issue.*", label: "Any issue event" },
      { id: "issue.create", label: "Issue created" },
      { id: "issue.update", label: "Issue updated" },
      { id: "issue.remove", label: "Issue removed" },
      { id: "comment.*", label: "Any comment event" },
    ],
  },
  {
    id: "webhook",
    label: "Custom webhook",
    description: "Public automation webhook endpoint.",
    events: [{ id: "webhook.received", label: "Webhook received" }],
  },
  {
    id: "automation",
    label: "Automation",
    description: "Events emitted by automation actions and workflows.",
    events: [
      { id: "automation.followup", label: "Follow-up requested" },
      { id: "automation.schedule.due", label: "Schedule due" },
      { id: "automation.poll.due", label: "Poll due" },
      { id: "automation.run.started", label: "Run started" },
      { id: "automation.run.resumed", label: "Run resumed" },
      { id: "automation.run.failed", label: "Run failed" },
      { id: "automation.approval.requested", label: "Approval requested" },
      { id: "automation.approval.decided", label: "Approval decided" },
      { id: "automation.approval.expired", label: "Approval expired" },
      { id: "automation.message.queued", label: "Message queued" },
    ],
  },
  {
    id: "schedule",
    label: "Scheduler",
    description: "Internal schedule and polling ticks emitted by durable workflows.",
    events: [
      { id: "automation.schedule.due", label: "Schedule due" },
      { id: "automation.poll.due", label: "Poll due" },
    ],
  },
  {
    id: "open-agents",
    label: "Open Agents",
    description: "Agent lifecycle events emitted from automation-backed sessions.",
    events: [
      { id: "agent.run.started", label: "Agent run started" },
      { id: "agent.run.finished", label: "Agent run finished" },
      { id: "agent.run.failed", label: "Agent run failed" },
      { id: "agent.task.started", label: "Agent task started" },
      { id: "agent.task.completed", label: "Agent task completed" },
    ],
  },
] as const satisfies readonly AutomationEventSourceCatalogItem[];

const TOOL_LABELS: Record<AgentToolName, string> = {
  bash: "Shell",
  glob: "Files",
  grep: "Search",
  load_skill: "Skills",
  read_file: "Read",
  todo: "Todos",
  web_fetch: "Fetch",
  write_file: "Write",
};

const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  bash: "Run shell commands in the Eve sandbox.",
  glob: "Find files by pattern.",
  grep: "Search the repository.",
  load_skill: "Load session-start dynamic skill instructions.",
  read_file: "Read files from the Eve sandbox.",
  todo: "Track multi-step work.",
  web_fetch: "Read external web resources.",
  write_file: "Create or replace files in the Eve sandbox.",
};

export const AUTOMATION_BUILT_IN_TOOLS = AGENT_TOOL_NAMES.map((toolName) => ({
  id: toolName,
  label: TOOL_LABELS[toolName],
  description: TOOL_DESCRIPTIONS[toolName],
  allowedByAutonomy: AUTOMATION_AUTONOMY_LEVELS.filter((autonomy) =>
    isBuiltInToolAllowedForAutonomy(autonomy, toolName),
  ),
})) satisfies AutomationBuiltInToolCatalogItem[];

export const AUTOMATION_AUTONOMY_OPTIONS = [
  {
    id: "read-only",
    label: "Read-only",
    description: "Read, search, and summarize.",
  },
  {
    id: "repo-edit",
    label: "Repo edit",
    description: "Allow file edits.",
  },
  {
    id: "branch-pr",
    label: "Branch + PR",
    description: "Allow branch work and pull requests.",
  },
  {
    id: "production",
    label: "Production",
    description: "Allow the widest tool envelope with approvals.",
  },
] as const satisfies readonly AutomationCatalogOption[];

export const EMPTY_AUTOMATION_BUILDER_CATALOG: AutomationBuilderCatalog = {
  triggerKinds: [...AUTOMATION_TRIGGER_KIND_OPTIONS],
  eventSources: [...AUTOMATION_EVENT_SOURCES],
  schedulePresets: [...AUTOMATION_SCHEDULE_PRESETS],
  actions: [...AUTOMATION_ACTION_OPTIONS],
  notifyDestinations: [...AUTOMATION_NOTIFY_DESTINATIONS],
  autonomyLevels: [...AUTOMATION_AUTONOMY_OPTIONS],
  builtInTools: AUTOMATION_BUILT_IN_TOOLS,
  executorSources: [],
  executorTools: [],
  agents: [],
  skills: [],
  repoOwners: [],
  repos: [],
  defaultAgentName: null,
  errors: [],
};

export function automationAgentsToCatalogItems(
  agents: AgentDefinition[],
  defaultAgentName: string | null,
): AutomationAgentCatalogItem[] {
  return agents.map((agent) => ({
    id: agent.slug,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    tools: agent.tools,
    repos: agent.repos,
    skills: agent.skills,
    isDefault: agent.slug === defaultAgentName,
  }));
}

export function automationSkillsToCatalogItems(
  skills: SkillDocument[],
): AutomationSkillCatalogItem[] {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    userInvocable: skill.userInvocable,
    allowedTools: skill.allowedTools ?? [],
    agent: skill.agent,
  }));
}
