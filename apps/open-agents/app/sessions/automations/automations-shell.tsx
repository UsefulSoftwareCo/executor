/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-json-parse -- boundary: browser fetch handlers and JSON editor parse failures surface as component state */
"use client";

import {
  AlertCircle,
  ArrowRight,
  Bell,
  Bot,
  CalendarClock,
  CheckCircle2,
  Circle,
  ClipboardList,
  Clock3,
  Code2,
  Database,
  FileJson2,
  Gauge,
  GitPullRequest,
  KeyRound,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Route,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TestTube2,
  Wrench,
  Workflow,
  XCircle,
} from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  SearchableCatalogPicker,
  type SearchableCatalogOption,
} from "@/components/automation/searchable-catalog-picker";
import {
  AUTOMATION_SCHEDULE_PRESETS,
  EMPTY_AUTOMATION_BUILDER_CATALOG,
  type AutomationAutonomy,
  type AutomationBuilderCatalog,
  type AutomationSchedulePreset,
} from "@/lib/automation/catalog";
import { isBuiltInToolAllowedForAutonomy } from "@/lib/automation/policy";
import { cn } from "@/lib/utils";

type AutomationListItem = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  updatedAt: string;
  version: {
    id: string;
    version: number;
    definitionJson: AutomationDefinitionJson;
  } | null;
  lastRun: AutomationRunSummary | null;
  recentRunCounts: {
    succeeded: number;
    failed: number;
    skipped: number;
    blocked: number;
    running: number;
  };
};

type AutomationDefinitionJson = {
  id?: string;
  version?: number;
  name: string;
  description?: string;
  enabled?: boolean;
  scope: { kind?: string; id?: string };
  owner?: { kind?: string; id?: string };
  identity?: {
    kind?: string;
    userId?: string;
    botId?: string;
    accountId?: string;
  };
  triggers: Array<Record<string, unknown>>;
  conditions?: Array<Record<string, unknown>>;
  concurrency?: Record<string, unknown>;
  correlation?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  action: Record<string, unknown>;
  policy: Record<string, unknown>;
  state?: Record<string, unknown>;
  outputs?: Array<Record<string, unknown>>;
};

type AutomationRunSummary = {
  id: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  lastError: string | null;
  sessionId: string | null;
  chatId: string | null;
};

type AutomationTemplate = {
  id: string;
  name: string;
  description: string;
  definition: AutomationDefinitionJson;
};

type AutomationDetail = {
  automation: {
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
  };
  version: AutomationListItem["version"];
  runs: AutomationRunSummary[];
  state: Array<Record<string, unknown>>;
  correlations: Array<Record<string, unknown>>;
};

type RunDetail = AutomationRunSummary & {
  eveSessionId: string | null;
  correlationKey: string | null;
  startedAt: string | null;
  policySnapshotJson: unknown;
  agentSnapshotJson: unknown;
  automation: Record<string, unknown> | null;
  version: Record<string, unknown> | null;
  invocation: Record<string, unknown> | null;
  event: Record<string, unknown> | null;
  timeline: Array<{
    id: string;
    type: string;
    visibility: string;
    timestamp: string;
    payloadJson: unknown;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    kind: string;
    createdAt: string;
    dataJson: unknown;
  }>;
  approvals: Array<{
    id: string;
    kind: string;
    status: string;
    requestJson: unknown;
    decisionJson: unknown;
  }>;
  outbox: Array<Record<string, unknown>>;
};

type AutomationsResponse = {
  automations: AutomationListItem[];
  templates: AutomationTemplate[];
};

type DiffLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

type BuilderTriggerKind = "event" | "schedule" | "poll" | "manual";
type BuilderActionKind =
  | "notify"
  | "startSession"
  | "messageSession"
  | "runFunction"
  | "emitEvent"
  | "monitor";
type BuilderAutonomy = AutomationAutonomy;

type BuilderTrigger = {
  id: string;
  kind: BuilderTriggerKind;
  eventSource: string;
  eventType: string;
  schedulePresetId: string;
  pollCode: string;
};

type AutomationBuilderState = {
  name: string;
  description: string;
  enabled: boolean;
  triggers: BuilderTrigger[];
  selectedTriggerId: string;
  triggerKind: BuilderTriggerKind;
  eventSource: string;
  eventType: string;
  schedulePresetId: string;
  pollCode: string;
  actionKind: BuilderActionKind;
  notifyDestination: "inbox" | "webhook" | "slack" | "github" | "linear";
  notifyTarget: string;
  notifyMessage: string;
  agentName: string;
  repoOwner: string;
  repoName: string;
  skillIds: string[];
  prompt: string;
  functionCode: string;
  emitEventSource: string;
  emitEventType: string;
  autonomy: BuilderAutonomy;
  maxModelSteps: string;
  builtInTools: string[];
  executorTools: string[];
  requireApproval: boolean;
};

type AutomationCatalogResponse = {
  catalog: AutomationBuilderCatalog;
};

const DEFAULT_TEST_EVENT = {
  type: "automation.manual.test",
  subjectKind: "automation",
  payload: {
    note: "Manual test event",
  },
};

const DEFAULT_EVENT_SOURCE = "github";
const DEFAULT_EVENT_TYPE = "pull_request.*";
const DEFAULT_SCHEDULE_PRESET_ID = "hourly";
const DEFAULT_POLL_CODE =
  "return { status: \"skip\", state: context.state, summary: \"No changes found\" };";
const DEFAULT_TRIGGER_ID = "trigger-1";
const EVENT_TRIGGER_GROUP_ID = "event-triggers";

function defaultBuilderTrigger(
  kind: BuilderTriggerKind,
  id = DEFAULT_TRIGGER_ID,
): BuilderTrigger {
  return {
    id,
    kind,
    eventSource: DEFAULT_EVENT_SOURCE,
    eventType: DEFAULT_EVENT_TYPE,
    schedulePresetId: DEFAULT_SCHEDULE_PRESET_ID,
    pollCode: DEFAULT_POLL_CODE,
  };
}

const DEFAULT_BUILDER_STATE: AutomationBuilderState = {
  name: "",
  description: "",
  enabled: false,
  triggers: [defaultBuilderTrigger("event")],
  selectedTriggerId: EVENT_TRIGGER_GROUP_ID,
  triggerKind: "event",
  eventSource: DEFAULT_EVENT_SOURCE,
  eventType: DEFAULT_EVENT_TYPE,
  schedulePresetId: DEFAULT_SCHEDULE_PRESET_ID,
  pollCode: DEFAULT_POLL_CODE,
  actionKind: "messageSession",
  notifyDestination: "inbox",
  notifyTarget: "",
  notifyMessage: "Automation matched {{event.type}} for {{event.subject.id}}.",
  agentName: "",
  repoOwner: "",
  repoName: "",
  skillIds: [],
  prompt:
    "Investigate {{event.type}} for {{event.subject.id}}. Summarize what changed and propose the next action.",
  functionCode:
    "return { ok: true, eventType: event.type, subject: event.subject };",
  emitEventSource: "automation",
  emitEventType: "automation.followup",
  autonomy: "read-only",
  maxModelSteps: "8",
  builtInTools: ["read_file", "grep", "glob"],
  executorTools: [],
  requireApproval: false,
};

function defaultBuilderState(catalog?: AutomationBuilderCatalog): AutomationBuilderState {
  return {
    ...DEFAULT_BUILDER_STATE,
    triggers: [defaultBuilderTrigger("event")],
    selectedTriggerId: EVENT_TRIGGER_GROUP_ID,
    agentName: catalog?.defaultAgentName ?? DEFAULT_BUILDER_STATE.agentName,
  };
}

function numberFromText(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function schedulePresetFromId(id: string): AutomationSchedulePreset {
  return (
    AUTOMATION_SCHEDULE_PRESETS.find((preset) => preset.id === id) ??
    AUTOMATION_SCHEDULE_PRESETS[1]
  );
}

function cloneSchedulePresetSchedule(preset: AutomationSchedulePreset) {
  return { ...preset.schedule };
}

function schedulePresetIdFromSchedule(schedule: unknown): string {
  if (!isRecord(schedule)) {
    return DEFAULT_BUILDER_STATE.schedulePresetId;
  }
  const match = AUTOMATION_SCHEDULE_PRESETS.find((preset) => {
    const presetSchedule = preset.schedule;
    if (presetSchedule.kind !== schedule.kind) {
      return false;
    }
    if (presetSchedule.kind === "interval") {
      return schedule.everyMs === presetSchedule.everyMs;
    }
    return (
      schedule.expression === presetSchedule.expression &&
      (schedule.timezone ?? "") === (presetSchedule.timezone ?? "")
    );
  });
  return match?.id ?? DEFAULT_BUILDER_STATE.schedulePresetId;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function eventSelectionKey(source: string, type: string): string {
  return `${source}:${type}`;
}

function parseEventSelectionKey(value: string): { source: string; type: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  return {
    source: value.slice(0, separator),
    type: value.slice(separator + 1),
  };
}

function nextTriggerId(triggers: BuilderTrigger[]): string {
  const ids = new Set(triggers.map((trigger) => trigger.id));
  let index = triggers.length + 1;
  while (ids.has(`trigger-${index}`)) {
    index += 1;
  }
  return `trigger-${index}`;
}

function triggerFromDefinition(
  trigger: Record<string, unknown>,
  index: number,
): BuilderTrigger | null {
  const id = `trigger-${index + 1}`;
  if (trigger.kind === "manual") {
    return defaultBuilderTrigger("manual", id);
  }
  if (trigger.kind === "schedule") {
    return {
      ...defaultBuilderTrigger("schedule", id),
      schedulePresetId: schedulePresetIdFromSchedule(trigger.schedule),
    };
  }
  if (trigger.kind === "poll") {
    const evaluator = isRecord(trigger.evaluator) ? trigger.evaluator : {};
    return {
      ...defaultBuilderTrigger("poll", id),
      schedulePresetId: schedulePresetIdFromSchedule(trigger.schedule),
      pollCode: optionalString(evaluator.code) ?? DEFAULT_POLL_CODE,
    };
  }
  if (trigger.kind === "event") {
    return {
      ...defaultBuilderTrigger("event", id),
      eventSource: optionalString(trigger.source) ?? DEFAULT_EVENT_SOURCE,
      eventType: optionalString(trigger.type) ?? DEFAULT_EVENT_TYPE,
    };
  }
  return null;
}

function selectedBuilderTrigger(
  builder: AutomationBuilderState,
): BuilderTrigger | null {
  return (
    builder.triggers.find((trigger) => trigger.id === builder.selectedTriggerId) ??
    builder.triggers[0] ??
    null
  );
}

function withSelectedTriggerFields(
  builder: AutomationBuilderState,
): AutomationBuilderState {
  const selected = selectedBuilderTrigger(builder);
  if (builder.selectedTriggerId === EVENT_TRIGGER_GROUP_ID) {
    const eventTrigger = builder.triggers.find(
      (trigger) => trigger.kind === "event",
    );
    return {
      ...builder,
      selectedTriggerId: EVENT_TRIGGER_GROUP_ID,
      triggerKind: "event",
      eventSource: eventTrigger?.eventSource ?? DEFAULT_EVENT_SOURCE,
      eventType: eventTrigger?.eventType ?? DEFAULT_EVENT_TYPE,
    };
  }
  if (!selected) {
    return {
      ...builder,
      selectedTriggerId: "",
      triggerKind: builder.triggerKind,
    };
  }
  return {
    ...builder,
    selectedTriggerId: selected.id,
    triggerKind: selected.kind,
    eventSource: selected.eventSource,
    eventType: selected.eventType,
    schedulePresetId: selected.schedulePresetId,
    pollCode: selected.pollCode,
  };
}

function builderAgentFromSpec(agent: unknown): {
  agentName: string;
  skillIds: string[];
} {
  if (!isRecord(agent)) {
    return {
      agentName: DEFAULT_BUILDER_STATE.agentName,
      skillIds: DEFAULT_BUILDER_STATE.skillIds,
    };
  }
  if (agent.kind === "preset") {
    return {
      agentName: optionalString(agent.name) ?? "",
      skillIds: [],
    };
  }
  if (agent.kind === "extend") {
    const override = isRecord(agent.override) ? agent.override : {};
    return {
      agentName: optionalString(agent.base) ?? "",
      skillIds: optionalStringArray(override.skills),
    };
  }
  if (agent.kind === "inline") {
    const definition = isRecord(agent.definition) ? agent.definition : {};
    return {
      agentName: "",
      skillIds: optionalStringArray(definition.skills),
    };
  }
  return {
    agentName: DEFAULT_BUILDER_STATE.agentName,
    skillIds: DEFAULT_BUILDER_STATE.skillIds,
  };
}

function firstActionAgent(action: Record<string, unknown>) {
  return isRecord(action.agent) ? action.agent : undefined;
}

function builderStateFromDefinition(
  definition: AutomationDefinitionJson,
): AutomationBuilderState {
  const triggers = definition.triggers
    .filter(isRecord)
    .map(triggerFromDefinition)
    .filter((trigger): trigger is BuilderTrigger => trigger !== null);
  const normalizedTriggers =
    triggers.length > 0 ? triggers : [defaultBuilderTrigger("event")];
  const firstEventTrigger = normalizedTriggers.find(
    (trigger) => trigger.kind === "event",
  );
  const selectedTrigger =
    firstEventTrigger ?? normalizedTriggers[0] ?? defaultBuilderTrigger("event");
  const selectedTriggerId = firstEventTrigger
    ? EVENT_TRIGGER_GROUP_ID
    : selectedTrigger.id;
  const action = isRecord(definition.action) ? definition.action : {};
  const policy = isRecord(definition.policy) ? definition.policy : {};
  const budget = isRecord(policy.budget) ? policy.budget : {};
  const actionAgent = firstActionAgent(action) ?? definition.agent;
  const agent = builderAgentFromSpec(actionAgent);
  const repo = isRecord(action.repo) ? action.repo : {};
  const notifyDestination =
    action.destination === "webhook" ||
    action.destination === "slack" ||
    action.destination === "github" ||
    action.destination === "linear"
      ? action.destination
      : "inbox";
  const emitEvent = Array.isArray(action.events) && isRecord(action.events[0])
    ? action.events[0]
    : {};
  const approvals = Array.isArray(policy.approvals)
    ? policy.approvals.filter(isRecord)
    : [];

  const builder: AutomationBuilderState = {
    ...DEFAULT_BUILDER_STATE,
    name: definition.name ?? DEFAULT_BUILDER_STATE.name,
    description: definition.description ?? DEFAULT_BUILDER_STATE.description,
    enabled: definition.enabled ?? DEFAULT_BUILDER_STATE.enabled,
    triggers: normalizedTriggers,
    selectedTriggerId,
    triggerKind: selectedTrigger.kind,
    eventSource: selectedTrigger.eventSource,
    eventType: selectedTrigger.eventType,
    schedulePresetId: selectedTrigger.schedulePresetId,
    pollCode: selectedTrigger.pollCode,
    actionKind: [
      "notify",
      "startSession",
      "messageSession",
      "runFunction",
      "emitEvent",
      "monitor",
    ].includes(String(action.kind))
      ? (action.kind as BuilderActionKind)
      : DEFAULT_BUILDER_STATE.actionKind,
    notifyDestination,
    notifyTarget: optionalString(action.target) ?? "",
    notifyMessage:
      optionalString(action.message) ?? DEFAULT_BUILDER_STATE.notifyMessage,
    agentName: agent.agentName,
    repoOwner: optionalString(repo.owner) ?? "",
    repoName: optionalString(repo.name) ?? "",
    skillIds: agent.skillIds,
    prompt:
      optionalString(isRecord(action.prompt) ? action.prompt.text : undefined) ??
      DEFAULT_BUILDER_STATE.prompt,
    functionCode:
      optionalString(
        isRecord(action.function) ? action.function.code : undefined,
      ) ?? DEFAULT_BUILDER_STATE.functionCode,
    emitEventSource:
      optionalString(emitEvent.source) ?? DEFAULT_BUILDER_STATE.emitEventSource,
    emitEventType:
      optionalString(emitEvent.type) ?? DEFAULT_BUILDER_STATE.emitEventType,
    autonomy: [
      "read-only",
      "repo-edit",
      "branch-pr",
      "production",
    ].includes(String(policy.autonomy))
      ? (policy.autonomy as BuilderAutonomy)
      : DEFAULT_BUILDER_STATE.autonomy,
    maxModelSteps:
      typeof budget.maxModelSteps === "number"
        ? String(budget.maxModelSteps)
        : DEFAULT_BUILDER_STATE.maxModelSteps,
    builtInTools: optionalStringArray(policy.builtInTools),
    executorTools: optionalStringArray(policy.executorTools),
    requireApproval: approvals.some(
      (approval) =>
        approval.required !== false &&
        (approval.when === "before-run" || approval.when === "production"),
    ),
  };

  return builder;
}

function buildBuilderAgentSpec(builder: AutomationBuilderState) {
  const skills = builder.skillIds.map((skill) => skill.trim()).filter(Boolean);
  if (builder.agentName && skills.length > 0) {
    return {
      kind: "extend",
      base: builder.agentName,
      override: { skills },
    };
  }
  if (builder.agentName) {
    return { kind: "preset", name: builder.agentName };
  }
  if (skills.length > 0) {
    return {
      kind: "inline",
      definition: {
        name: "Automation builder agent",
        skills,
      },
    };
  }
  return undefined;
}

function buildBuilderRepoBinding(builder: AutomationBuilderState) {
  if (!builder.repoOwner || !builder.repoName) {
    return {};
  }
  return {
    owner: builder.repoOwner,
    name: builder.repoName,
    cloneUrl: `https://github.com/${builder.repoOwner}/${builder.repoName}`,
  };
}

function buildBuilderTrigger(trigger: BuilderTrigger) {
  if (trigger.kind === "manual") {
    return { kind: "manual" };
  }
  if (trigger.kind === "schedule") {
    const preset = schedulePresetFromId(trigger.schedulePresetId);
    return {
      kind: "schedule",
      schedule: cloneSchedulePresetSchedule(preset),
    };
  }
  if (trigger.kind === "poll") {
    const preset = schedulePresetFromId(trigger.schedulePresetId);
    return {
      kind: "poll",
      schedule: cloneSchedulePresetSchedule(preset),
      evaluator: {
        code: trigger.pollCode.trim() || DEFAULT_POLL_CODE,
        timeoutMs: 30_000,
      },
    };
  }
  return {
    kind: "event",
    source: trigger.eventSource.trim() || DEFAULT_EVENT_SOURCE,
    type: trigger.eventType.trim() || DEFAULT_EVENT_TYPE,
  };
}

function buildBuilderTriggers(builder: AutomationBuilderState) {
  return builder.triggers.map(buildBuilderTrigger);
}

function buildBuilderAction(builder: AutomationBuilderState) {
  const agent = buildBuilderAgentSpec(builder);
  const repo = buildBuilderRepoBinding(builder);
  if (builder.actionKind === "notify") {
    return {
      kind: "notify",
      destination: builder.notifyDestination,
      target: builder.notifyTarget.trim() || undefined,
      message:
        builder.notifyMessage.trim() ||
        DEFAULT_BUILDER_STATE.notifyMessage,
      payload: {},
    };
  }
  if (builder.actionKind === "startSession") {
    return {
      kind: "startSession",
      mode: "standalone",
      ...(agent ? { agent } : {}),
      prompt: {
        text: builder.prompt.trim() || DEFAULT_BUILDER_STATE.prompt,
      },
      repo,
      autoCommit: false,
      autoPr: false,
    };
  }
  if (builder.actionKind === "runFunction") {
    return {
      kind: "runFunction",
      function: {
        code: builder.functionCode.trim() || DEFAULT_BUILDER_STATE.functionCode,
        timeoutMs: 30_000,
      },
    };
  }
  if (builder.actionKind === "monitor") {
    return {
      kind: "monitor",
      prompt: {
        text: builder.prompt.trim() || DEFAULT_BUILDER_STATE.prompt,
      },
    };
  }
  if (builder.actionKind === "emitEvent") {
    return {
      kind: "emitEvent",
      events: [
        {
          source: builder.emitEventSource,
          type: builder.emitEventType.trim() || DEFAULT_BUILDER_STATE.emitEventType,
          subject: {
            kind: "{{event.subject.kind}}",
            id: "{{event.subject.id}}",
          },
          payload: {
            parentEventType: "{{event.type}}",
          },
        },
      ],
    };
  }
  return {
    kind: "messageSession",
    correlation: "subject",
    ...(agent ? { agent } : {}),
    prompt: {
      text: builder.prompt.trim() || DEFAULT_BUILDER_STATE.prompt,
    },
    repo,
    createIfMissing: true,
  };
}

function buildDefinitionFromBuilder(
  builder: AutomationBuilderState,
  attachedSessionId: string | null | undefined,
  baseDefinition?: AutomationDefinitionJson | null,
): AutomationDefinitionJson {
  const action = buildBuilderAction(builder);
  const maxModelSteps = numberFromText(builder.maxModelSteps, 8);
  const usesAgent =
    action.kind === "startSession" || action.kind === "messageSession";
  const defaultOutputs = usesAgent
    ? [
        {
          kind: "automation-event",
          events: ["agent.run.started", "agent.run.finished"],
        },
      ]
    : [{ kind: "inbox", destination: "inbox" }];
  const basePolicyBudget = isRecord(baseDefinition?.policy?.budget)
    ? baseDefinition.policy.budget
    : {};

  return {
    ...(baseDefinition?.id ? { id: baseDefinition.id } : {}),
    ...(baseDefinition?.version ? { version: baseDefinition.version } : {}),
    name: builder.name.trim() || "Untitled automation",
    description: builder.description.trim() || undefined,
    enabled: builder.enabled,
    scope: baseDefinition?.scope ?? { kind: "user", id: "current-user" },
    owner: baseDefinition?.owner ?? { kind: "user", id: "current-user" },
    identity:
      baseDefinition?.identity ?? { kind: "user", userId: "current-user" },
    triggers: buildBuilderTriggers(builder),
    conditions: baseDefinition?.conditions ?? [],
    concurrency:
      baseDefinition?.concurrency ?? {
        key: usesAgent ? "correlation" : "event",
        onConflict: usesAgent ? "queue" : "skip",
      },
    correlation:
      baseDefinition?.correlation ?? { key: usesAgent ? "subject" : "event" },
    agent: baseDefinition?.agent,
    tools: baseDefinition?.tools,
    policy: {
      ...baseDefinition?.policy,
      autonomy: builder.autonomy,
      budget: { ...basePolicyBudget, maxModelSteps },
      executorTools: builder.executorTools,
      builtInTools: builder.builtInTools,
      memory: baseDefinition?.policy?.memory ?? "none",
      approvals: builder.requireApproval
        ? [
            {
              when: "before-run",
              required: true,
              reason: "Review before running this automation.",
            },
          ]
        : [],
    },
    action,
    state: baseDefinition?.state,
    outputs: baseDefinition?.outputs ?? defaultOutputs,
  };
}

function statusTone(status: string): string {
  if (status === "succeeded" || status === "succeeded_with_findings") {
    return "text-emerald-600";
  }
  if (status === "running" || status === "pending" || status === "needs_review") {
    return "text-blue-600";
  }
  if (status === "blocked" || status === "skipped") {
    return "text-amber-600";
  }
  return "text-red-600";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "succeeded" || status === "succeeded_with_findings") {
    return <CheckCircle2 className="h-3.5 w-3.5" />;
  }
  if (status === "running" || status === "pending") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  }
  if (status === "needs_review" || status === "blocked" || status === "skipped") {
    return <AlertCircle className="h-3.5 w-3.5" />;
  }
  return <XCircle className="h-3.5 w-3.5" />;
}

function RunActivity({
  counts,
}: {
  counts: AutomationListItem["recentRunCounts"];
}) {
  const segments = [
    { key: "succeeded", value: counts.succeeded, className: "bg-emerald-500" },
    { key: "running", value: counts.running, className: "bg-blue-500" },
    { key: "blocked", value: counts.blocked, className: "bg-amber-500" },
    { key: "skipped", value: counts.skipped, className: "bg-zinc-400" },
    { key: "failed", value: counts.failed, className: "bg-red-500" },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <span
      className="flex shrink-0 items-end gap-0.5"
      title={`${total} recent run${total === 1 ? "" : "s"}`}
    >
      {segments.map((segment) => {
        const height = total === 0 ? 0.25 : Math.max(0.25, segment.value / total);
        return (
          <span
            key={segment.key}
            className={`w-1 rounded-sm ${segment.value > 0 ? segment.className : "bg-muted-foreground/20"}`}
            style={{ height: `${Math.round(height * 16)}px` }}
          />
        );
      })}
    </span>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "never";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with ${response.status}`);
  }
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDefinitionPreview(text: string): {
  definition: AutomationDefinitionJson | null;
  error: string | null;
} {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return {
        definition: null,
        error: "Definition must be a JSON object.",
      };
    }
    return {
      definition: parsed as AutomationDefinitionJson,
      error: null,
    };
  } catch (parseError) {
    return {
      definition: null,
      error: parseError instanceof Error ? parseError.message : String(parseError),
    };
  }
}

function textValue(value: unknown, fallback = "none"): string {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return compactJson(value);
}

function compactJson(value: unknown, maxLength = 180): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 0) ?? "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function formatMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "none";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  const seconds = value / 1000;
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = minutes / 60;
  return `${hours}h`;
}

function formatScope(scope: AutomationDefinitionJson["scope"] | undefined): string {
  if (!scope) {
    return "unspecified scope";
  }
  return `${textValue(scope.kind, "scope")}:${textValue(scope.id, "id")}`;
}

function formatOwner(owner: AutomationDefinitionJson["owner"] | undefined): string {
  if (!owner) {
    return "unspecified owner";
  }
  return `${textValue(owner.kind, "owner")}:${textValue(owner.id, "id")}`;
}

function formatIdentity(
  identity: AutomationDefinitionJson["identity"] | undefined,
): string {
  if (!identity) {
    return "unspecified identity";
  }
  const id = identity.userId ?? identity.botId ?? identity.accountId;
  return `${textValue(identity.kind, "identity")}:${textValue(id, "id")}`;
}

function describeSchedule(schedule: unknown): string {
  if (!isRecord(schedule)) {
    return "schedule";
  }
  if (schedule.kind === "interval") {
    return `every ${formatMs(schedule.everyMs)}`;
  }
  if (schedule.kind === "once") {
    return `once at ${textValue(schedule.dueAt, "due time")}`;
  }
  if (schedule.kind === "cron") {
    return `cron ${textValue(schedule.expression, "expression")}`;
  }
  return compactJson(schedule);
}

function describeTrigger(trigger: Record<string, unknown>): string {
  if (trigger.kind === "event") {
    const source = textValue(trigger.source, "any source");
    return `${source} -> ${textValue(trigger.type, "event")}`;
  }
  if (trigger.kind === "schedule") {
    return describeSchedule(trigger.schedule);
  }
  if (trigger.kind === "poll") {
    return `poll ${describeSchedule(trigger.schedule)}`;
  }
  if (trigger.kind === "manual") {
    return "manual";
  }
  return compactJson(trigger);
}

function describeCondition(condition: Record<string, unknown>): string {
  if (condition.kind === "field") {
    return `${textValue(condition.path, "field")} ${textValue(condition.op, "op")} ${textValue(condition.value, "value")}`;
  }
  if (condition.kind === "rate-limit") {
    return `${textValue(condition.key, "key")} <= ${textValue(condition.max, "max")} per ${formatMs(condition.windowMs)}`;
  }
  if (condition.kind === "function") {
    const ref = isRecord(condition.ref) ? condition.ref : {};
    return `function (${textValue(ref.timeoutMs, "default timeout")})`;
  }
  return compactJson(condition);
}

function describeAgent(agent: unknown): string {
  if (!isRecord(agent)) {
    return "default action agent";
  }
  if (agent.kind === "preset") {
    return `preset:${textValue(agent.name, "agent")}`;
  }
  if (agent.kind === "extend") {
    return `extends ${textValue(agent.base, "base agent")}`;
  }
  if (agent.kind === "inline") {
    const definition = isRecord(agent.definition) ? agent.definition : {};
    return `inline:${textValue(definition.name, "custom agent")}`;
  }
  return compactJson(agent);
}

function describeAction(action: Record<string, unknown> | undefined): string {
  if (!action) {
    return "no action";
  }
  if (action.kind === "startSession") {
    return `start session (${textValue(action.mode, "standalone")})`;
  }
  if (action.kind === "messageSession") {
    return `message session by ${textValue(action.correlation, "subject")}`;
  }
  if (action.kind === "runFunction") {
    return "run function";
  }
  if (action.kind === "emitEvent") {
    const events = Array.isArray(action.events) ? action.events.length : 0;
    return `emit ${events} event${events === 1 ? "" : "s"}`;
  }
  if (action.kind === "notify") {
    return `notify ${textValue(action.destination, "destination")}`;
  }
  if (action.kind === "monitor") {
    return "monitor";
  }
  return compactJson(action);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function splitBuiltInToolsByAutonomy(policy: Record<string, unknown>) {
  const builtInTools = stringArray(policy.builtInTools);
  const rawAutonomy = textValue(policy.autonomy, "read-only");
  const autonomy = [
    "read-only",
    "repo-edit",
    "branch-pr",
    "production",
  ].includes(rawAutonomy)
    ? (rawAutonomy as BuilderAutonomy)
    : "read-only";
  return {
    allowed: builtInTools.filter((tool) =>
      isBuiltInToolAllowedForAutonomy(autonomy, tool),
    ),
    blocked: builtInTools.filter(
      (tool) => !isBuiltInToolAllowedForAutonomy(autonomy, tool),
    ),
  };
}

function outputLabel(output: Record<string, unknown>): string {
  const destination = output.destination ? `:${textValue(output.destination)}` : "";
  const name = output.name ? ` (${textValue(output.name)})` : "";
  const events = Array.isArray(output.events)
    ? output.events.filter((entry): entry is string => typeof entry === "string")
    : [];
  const eventSummary =
    events.length > 0 ? ` -> ${events.slice(0, 3).join(", ")}${events.length > 3 ? "..." : ""}` : "";
  return `${textValue(output.kind, "output")}${destination}${name}${eventSummary}`;
}

function TemplateGlyph({
  templateId,
  className = "h-4 w-4",
}: {
  templateId: string;
  className?: string;
}) {
  if (templateId === "ci-failure-fixer") {
    return <ListChecks className={className} />;
  }
  if (templateId === "pr-babysitter") {
    return <GitPullRequest className={className} />;
  }
  if (templateId === "daily-brief") {
    return <Clock3 className={className} />;
  }
  if (templateId === "custom-webhook-triage") {
    return <Route className={className} />;
  }
  return <Workflow className={className} />;
}

function builderTriggerIcon(kind: string): ReactNode {
  if (kind === "schedule") {
    return <CalendarClock className="h-4 w-4" />;
  }
  if (kind === "poll") {
    return <RefreshCw className="h-4 w-4" />;
  }
  if (kind === "manual") {
    return <Play className="h-4 w-4" />;
  }
  return <Route className="h-4 w-4" />;
}

function eventFamily(eventType: string): string {
  return eventType.split(".")[0] || eventType;
}

function eventFamilyLabel(family: string): string {
  return family
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function fuzzyMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  if (haystack.includes(needle)) {
    return true;
  }
  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) {
      cursor += 1;
      if (cursor === needle.length) {
        return true;
      }
    }
  }
  return false;
}

function triggerPillLabel(
  trigger: BuilderTrigger,
  catalog: AutomationBuilderCatalog,
): string {
  if (trigger.kind === "event") {
    const source = catalog.eventSources.find(
      (item) => item.id === trigger.eventSource,
    );
    const event = source?.events.find((item) => item.id === trigger.eventType);
    return `${source?.label ?? trigger.eventSource} / ${
      event?.label ?? trigger.eventType
    }`;
  }
  if (trigger.kind === "schedule") {
    const preset = schedulePresetFromId(trigger.schedulePresetId);
    return preset.label;
  }
  if (trigger.kind === "poll") {
    const preset = schedulePresetFromId(trigger.schedulePresetId);
    return `Poll / ${preset.label}`;
  }
  return "Manual";
}

function builderActionIcon(kind: string): ReactNode {
  if (kind === "startSession") {
    return <Bot className="h-4 w-4" />;
  }
  if (kind === "notify") {
    return <Bell className="h-4 w-4" />;
  }
  if (kind === "runFunction") {
    return <Code2 className="h-4 w-4" />;
  }
  if (kind === "emitEvent") {
    return <Workflow className="h-4 w-4" />;
  }
  if (kind === "monitor") {
    return <Search className="h-4 w-4" />;
  }
  return <Send className="h-4 w-4" />;
}

function firstTrigger(definition: AutomationDefinitionJson | undefined) {
  const trigger = definition?.triggers?.find(isRecord);
  return trigger ?? null;
}

function definitionTriggers(definition: AutomationDefinitionJson | undefined) {
  return definition?.triggers?.filter(isRecord) ?? [];
}

function triggerSummary(definition: AutomationDefinitionJson | undefined): string {
  const triggers = definitionTriggers(definition);
  const trigger = triggers[0];
  if (!trigger) {
    return "no trigger";
  }
  const suffix = triggers.length > 1 ? ` + ${triggers.length - 1} more` : "";
  if (trigger.kind === "schedule") {
    return `scheduled trigger${suffix}`;
  }
  if (trigger.kind === "poll") {
    return `poll trigger${suffix}`;
  }
  return `${describeTrigger(trigger)}${suffix}`;
}

function scheduleSummary(definition: AutomationDefinitionJson | undefined): string {
  const trigger = firstTrigger(definition);
  if (!trigger) {
    return "no schedule";
  }
  if (trigger.kind === "schedule" || trigger.kind === "poll") {
    return describeSchedule(trigger.schedule);
  }
  return "event driven";
}

function budgetSummary(policy: Record<string, unknown> | undefined): string {
  if (!policy) {
    return "no budget cap";
  }
  const budget = isRecord(policy.budget) ? policy.budget : {};
  if (typeof budget.maxCostUsd === "number") {
    return `$${budget.maxCostUsd} cap`;
  }
  if (typeof budget.maxDurationMs === "number") {
    return `${formatMs(budget.maxDurationMs)} cap`;
  }
  if (typeof budget.maxModelSteps === "number") {
    return `${budget.maxModelSteps} steps cap`;
  }
  return "no budget cap";
}

function templateSignal(template: AutomationTemplate): string {
  return `${triggerSummary(template.definition)} -> ${describeAction(template.definition.action)}`;
}

function buildLineDiff(beforeText: string, afterText: string): DiffLine[] {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] =
        before[left] === after[right]
          ? lengths[left + 1][right + 1] + 1
          : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      diff.push({ kind: "context", text: before[left] ?? "" });
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      diff.push({ kind: "remove", text: before[left] ?? "" });
      left += 1;
    } else {
      diff.push({ kind: "add", text: after[right] ?? "" });
      right += 1;
    }
  }
  while (left < before.length) {
    diff.push({ kind: "remove", text: before[left] ?? "" });
    left += 1;
  }
  while (right < after.length) {
    diff.push({ kind: "add", text: after[right] ?? "" });
    right += 1;
  }
  return diff;
}

function matchesAttachedSession(
  _automation: AutomationListItem,
  _attachedSessionId: string | null | undefined,
): boolean {
  return true;
}

export function AutomationsShell({
  attachedSessionId = null,
}: {
  attachedSessionId?: string | null;
}) {
  const [data, setData] = useState<AutomationsResponse>({
    automations: [],
    templates: [],
  });
  const [catalog, setCatalog] = useState<AutomationBuilderCatalog>(
    EMPTY_AUTOMATION_BUILDER_CATALOG,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [editorText, setEditorText] = useState("");
  const [testText, setTestText] = useState(
    JSON.stringify(DEFAULT_TEST_EVENT, null, 2),
  );
  const [testPreview, setTestPreview] = useState<unknown | null>(null);
  const [filter, setFilter] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);
  const [builder, setBuilder] = useState<AutomationBuilderState>(
    DEFAULT_BUILDER_STATE,
  );
  const [editBuilder, setEditBuilder] = useState<AutomationBuilderState>(
    DEFAULT_BUILDER_STATE,
  );
  const [editBuilderVersionId, setEditBuilderVersionId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAutomations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await readJson<AutomationsResponse>(
        await fetch("/api/automations"),
      );
      setData(next);
      const visible = next.automations.filter((automation) =>
        matchesAttachedSession(automation, attachedSessionId),
      );
      setSelectedId((current) =>
        current && visible.some((automation) => automation.id === current)
          ? current
          : visible[0]?.id ?? null,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [attachedSessionId]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const next = await readJson<AutomationCatalogResponse>(
        await fetch("/api/automations/catalog"),
      );
      setCatalog(next.catalog);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (automationId: string) => {
    setDetailLoading(true);
    setError(null);
    try {
      const next = await readJson<AutomationDetail>(
        await fetch(`/api/automations/${automationId}`),
      );
      setDetail(next);
      setEditorText(JSON.stringify(next.version?.definitionJson ?? {}, null, 2));
      setTestPreview(null);
      setRunDetail(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (!catalog.defaultAgentName) {
      return;
    }
    setBuilder((current) =>
      current.agentName
        ? current
        : { ...current, agentName: catalog.defaultAgentName ?? "" },
    );
  }, [catalog.defaultAgentName]);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    } else {
      setDetail(null);
      setEditBuilderVersionId(null);
    }
  }, [loadDetail, selectedId]);

  useEffect(() => {
    const version = detail?.version;
    if (!version || version.id === editBuilderVersionId) {
      return;
    }
    setEditBuilder(builderStateFromDefinition(version.definitionJson));
    setEditBuilderVersionId(version.id);
  }, [detail?.version, editBuilderVersionId]);

  const filteredAutomations = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const scoped = attachedSessionId
      ? data.automations.filter((automation) =>
          matchesAttachedSession(automation, attachedSessionId),
        )
      : data.automations;
    if (!query) {
      return scoped;
    }
    return scoped.filter((automation) =>
      `${automation.name} ${automation.description ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }, [attachedSessionId, data.automations, filter]);

  const selectedAutomation = detail?.automation ?? null;
  const originalEditorText = useMemo(
    () => JSON.stringify(detail?.version?.definitionJson ?? {}, null, 2),
    [detail?.version?.definitionJson],
  );
  const definitionDiff = useMemo(
    () => buildLineDiff(originalEditorText, editorText),
    [editorText, originalEditorText],
  );
  const definitionChanged = originalEditorText !== editorText;
  const parsedEditorDefinition = useMemo(
    () => parseDefinitionPreview(editorText),
    [editorText],
  );
  const selectedVersion = detail?.version ?? null;
  const builderDefinition = useMemo(
    () => buildDefinitionFromBuilder(builder, attachedSessionId),
    [attachedSessionId, builder],
  );
  const editBuilderDefinition = useMemo(
    () =>
      selectedVersion?.definitionJson
        ? buildDefinitionFromBuilder(
            editBuilder,
            attachedSessionId,
            selectedVersion.definitionJson,
          )
        : null,
    [attachedSessionId, editBuilder, selectedVersion?.definitionJson],
  );
  const scopedAutomationCount = attachedSessionId
    ? data.automations.filter((automation) =>
        matchesAttachedSession(automation, attachedSessionId),
      ).length
    : data.automations.length;

  const createTemplate = useCallback(
    async (templateId: string) => {
      setBusy(`template:${templateId}`);
      setError(null);
      try {
        const response = await fetch("/api/automations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            templateId,
            scope: undefined,
          }),
        });
        const saved = await readJson<{ automation: AutomationListItem }>(response);
        await loadAutomations();
        setSelectedId(saved.automation.id);
        setShowBuilder(false);
      } catch (createError) {
        setError(
          createError instanceof Error ? createError.message : String(createError),
        );
      } finally {
        setBusy(null);
      }
    },
    [attachedSessionId, loadAutomations],
  );

  const createBuiltAutomation = useCallback(async () => {
    setBusy("builder");
    setError(null);
    try {
      const response = await fetch("/api/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          definition: builderDefinition,
          changeSummary: "Created in automation builder",
        }),
      });
      const saved = await readJson<{ automation: AutomationListItem }>(response);
      await loadAutomations();
      setSelectedId(saved.automation.id);
      setShowBuilder(false);
      setBuilder(defaultBuilderState(catalog));
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : String(createError),
      );
    } finally {
      setBusy(null);
    }
  }, [builderDefinition, catalog, loadAutomations]);

  const resetEditBuilder = useCallback(() => {
    if (!selectedVersion?.definitionJson) {
      return;
    }
    setEditBuilder(builderStateFromDefinition(selectedVersion.definitionJson));
  }, [selectedVersion?.definitionJson]);

  const saveConfiguredAutomation = useCallback(async () => {
    if (!selectedId || !editBuilderDefinition) return;
    setBusy("builder-edit");
    setError(null);
    try {
      await readJson(
        await fetch(`/api/automations/${selectedId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            definition: editBuilderDefinition,
            changeSummary: "Updated in automation builder",
          }),
        }),
      );
      await Promise.all([loadAutomations(), loadDetail(selectedId)]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(null);
    }
  }, [
    editBuilderDefinition,
    loadAutomations,
    loadDetail,
    selectedId,
  ]);

  const saveDefinition = useCallback(async () => {
    if (!selectedId) return;
    setBusy("save");
    setError(null);
    try {
      const definition = JSON.parse(editorText) as unknown;
      await readJson(
        await fetch(`/api/automations/${selectedId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ definition, changeSummary: "UI edit" }),
        }),
      );
      await Promise.all([loadAutomations(), loadDetail(selectedId)]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(null);
    }
  }, [editorText, loadAutomations, loadDetail, selectedId]);

  const toggleEnabled = useCallback(
    async (enabled: boolean) => {
      if (!selectedId) return;
      setBusy("toggle");
      setError(null);
      try {
        await readJson(
          await fetch(`/api/automations/${selectedId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled, changeSummary: enabled ? "Enabled" : "Disabled" }),
          }),
        );
        await Promise.all([loadAutomations(), loadDetail(selectedId)]);
      } catch (toggleError) {
        setError(
          toggleError instanceof Error ? toggleError.message : String(toggleError),
        );
      } finally {
        setBusy(null);
      }
    },
    [loadAutomations, loadDetail, selectedId],
  );

  const refreshSelectedAutomation = useCallback(async () => {
    await Promise.all([
      loadAutomations(),
      selectedId ? loadDetail(selectedId) : Promise.resolve(),
    ]);
  }, [loadAutomations, loadDetail, selectedId]);

  const runTest = useCallback(async () => {
    if (!selectedId) return;
    setBusy("test");
    setError(null);
    try {
      const payload = JSON.parse(testText) as unknown;
      setTestPreview(null);
      await readJson(
        await fetch(`/api/automations/${selectedId}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      await refreshSelectedAutomation();
      window.setTimeout(() => {
        void refreshSelectedAutomation();
      }, 1200);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError));
    } finally {
      setBusy(null);
    }
  }, [refreshSelectedAutomation, selectedId, testText]);

  const dryRunTest = useCallback(async () => {
    if (!selectedId) return;
    setBusy("dry-run");
    setError(null);
    try {
      const payload = JSON.parse(testText) as unknown;
      const requestPayload = isRecord(payload)
        ? { ...payload, dryRun: true }
        : { payload, dryRun: true };
      const response = await readJson<{ preview: unknown }>(
        await fetch(`/api/automations/${selectedId}/test`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestPayload),
        }),
      );
      setTestPreview(response.preview);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError));
    } finally {
      setBusy(null);
    }
  }, [selectedId, testText]);

  const loadRun = useCallback(async (runId: string) => {
    setBusy(`run:${runId}`);
    setError(null);
    try {
      const response = await readJson<{ run: RunDetail }>(
        await fetch(`/api/automations/runs/${runId}`),
      );
      setRunDetail(response.run);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(null);
    }
  }, []);

  const decideApproval = useCallback(
    async (approvalId: string, approved: boolean) => {
      setBusy(`approval:${approvalId}`);
      setError(null);
      try {
        await readJson(
          await fetch(`/api/automations/approvals/${approvalId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ approved }),
          }),
        );
        if (runDetail) {
          await loadRun(runDetail.id);
        }
      } catch (approvalError) {
        setError(
          approvalError instanceof Error
            ? approvalError.message
            : String(approvalError),
        );
      } finally {
        setBusy(null);
      }
    },
    [loadRun, runDetail],
  );

  return (
    <>
      <header className="border-b border-border bg-background px-3 py-2 lg:px-5 lg:py-3">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="shrink-0" />
            <Workflow className="h-4 w-4 text-muted-foreground" />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-sm font-semibold">Automations</h1>
                <span className="hidden shrink-0 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline-flex">
                  {scopedAutomationCount} saved
                </span>
              </div>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                {attachedSessionId
                  ? "Automations attached to this session"
                  : "Event routes, durable runs, schedules, approvals, templates"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setBuilder(defaultBuilderState(catalog));
                setShowBuilder(true);
                setSelectedId(null);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New automation</span>
              <span className="sm:hidden">New</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refreshSelectedAutomation}
              disabled={loading}
            >
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
      </header>

      <div
        className={`grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:overflow-hidden ${
          showBuilder ? "lg:grid-cols-1" : "lg:grid-cols-[24rem_minmax(0,1fr)]"
        }`}
      >
        <aside
          className={`min-h-0 border-b border-border bg-muted/15 lg:border-b-0 lg:border-r ${
            showBuilder ? "hidden" : ""
          }`}
        >
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter automations"
                className="h-9 bg-background pl-8"
              />
            </div>
          </div>
          <div className="p-3 pb-20 lg:h-[calc(100dvh-8.5rem)] lg:overflow-y-auto lg:pb-3">
            {loading ? (
              <div className="space-y-2 p-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="h-16 animate-pulse rounded-md bg-muted" />
                ))}
              </div>
            ) : filteredAutomations.length > 0 ? (
              <div className="space-y-1">
                {filteredAutomations.map((automation) => (
                  <Button
                    key={automation.id}
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setSelectedId(automation.id);
                      setShowBuilder(false);
                    }}
                    className={`h-auto w-full justify-start whitespace-normal rounded-md border px-3 py-2 text-left transition-colors ${
                      automation.id === selectedId
                        ? "border-primary/30 bg-muted"
                        : "border-transparent hover:bg-muted/60"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">
                          {automation.name}
                        </span>
                        {automation.enabled ? (
                          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                        ) : (
                          <Circle className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {automation.description ?? "No description"}
                      </p>
                      <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Route className="h-3 w-3 shrink-0" />
                          <span className="min-w-0 truncate">
                            {triggerSummary(automation.version?.definitionJson)}
                          </span>
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Clock3 className="h-3 w-3 shrink-0" />
                          <span className="min-w-0 truncate">
                            {scheduleSummary(automation.version?.definitionJson)}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="max-w-full truncate rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {formatScope(automation.version?.definitionJson.scope)}
                        </span>
                        <span className="max-w-full truncate rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {describeAction(automation.version?.definitionJson.action)}
                        </span>
                        {automation.lastRun ? (
                          <span
                            className={`flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[11px] ${statusTone(automation.lastRun.status)}`}
                          >
                            <StatusIcon status={automation.lastRun.status} />
                            {automation.lastRun.status}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <RunActivity counts={automation.recentRunCounts} />
                        <span className="min-w-0 truncate">
                          {budgetSummary(automation.version?.definitionJson.policy)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>v{automation.version?.version ?? "-"}</span>
                        <span className="tabular-nums">
                          {automation.recentRunCounts.running} running
                        </span>
                        <span className="tabular-nums">
                          {automation.recentRunCounts.failed} failed
                        </span>
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-background px-4 py-7 text-center">
                <Workflow className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">
                  {filter.trim() ? "No matching automations" : "No saved automations"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {filter.trim()
                    ? "Clear the filter or choose a template below."
                    : "Choose a template below to create the first one."}
                </p>
              </div>
            )}

            <div
              className={`mt-4 border-t border-border pt-3 ${
                !selectedAutomation && filteredAutomations.length === 0 && !filter.trim()
                  ? "lg:hidden"
                  : ""
              }`}
            >
              <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                Templates
              </div>
              <div className="space-y-2">
                {data.templates.map((template) => (
                  <Button
                    key={template.id}
                    type="button"
                    variant="ghost"
                    onClick={() => createTemplate(template.id)}
                    disabled={busy === `template:${template.id}`}
                    className="group h-auto w-full justify-start whitespace-normal rounded-md border border-border/70 bg-background px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-muted/50 disabled:opacity-60"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border bg-muted/30 text-muted-foreground">
                        <TemplateGlyph templateId={template.id} className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium">
                            {template.name}
                          </span>
                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </div>
                        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                          {template.description}
                        </p>
                        <p className="mt-2 truncate text-[11px] text-muted-foreground/80">
                          {templateSignal(template)}
                        </p>
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <main
          className={`min-h-0 overflow-y-auto bg-background ${
            !selectedAutomation && !showBuilder ? "hidden lg:block" : ""
          }`}
        >
          {error ? (
            <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {showBuilder ? (
            <AutomationBuilder
              mode="create"
              builder={builder}
              definition={builderDefinition}
              catalog={catalog}
              catalogLoading={catalogLoading}
              busy={busy}
              attachedSessionId={attachedSessionId}
              onBuilderChange={setBuilder}
              onSubmit={createBuiltAutomation}
              onCancel={() => setShowBuilder(false)}
            />
          ) : !selectedAutomation ? (
            <div className="min-h-full p-6">
              <div className="mx-auto max-w-5xl py-10">
                <div className="mb-6 flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground">
                    <Workflow className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-xl font-semibold">Create an automation route</h2>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                      Start with a template, then tune the trigger, policy, agent,
                      and durable outputs before enabling it.
                    </p>
                  </div>
                </div>

                <div className="mb-5 grid gap-3 md:grid-cols-3">
                  <div className="rounded-md border bg-muted/10 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <Route className="h-3.5 w-3.5" />
                      Event router
                    </div>
                    <p className="mt-2 text-sm">Typed event matching with dedupe.</p>
                  </div>
                  <div className="rounded-md border bg-muted/10 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Policy snapshot
                    </div>
                    <p className="mt-2 text-sm">Autonomy, tools, budget, approvals.</p>
                  </div>
                  <div className="rounded-md border bg-muted/10 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <Clock3 className="h-3.5 w-3.5" />
                      Durable runs
                    </div>
                    <p className="mt-2 text-sm">Workflow steps, retries, hooks, queues.</p>
                  </div>
                </div>

                <div className="grid gap-3 xl:grid-cols-2">
                  {data.templates.map((template) => (
                    <Button
                      key={template.id}
                      type="button"
                      variant="ghost"
                      onClick={() => createTemplate(template.id)}
                      disabled={busy === `template:${template.id}`}
                      className="group h-auto justify-start whitespace-normal rounded-md border bg-background p-4 text-left transition-colors hover:border-primary/30 hover:bg-muted/40 disabled:opacity-60"
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground">
                          <TemplateGlyph templateId={template.id} className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <span className="truncate text-sm font-semibold">
                              {template.name}
                            </span>
                            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                            {template.description}
                          </p>
                          <p className="mt-3 truncate rounded border bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground">
                            {templateSignal(template)}
                          </p>
                        </div>
                      </div>
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 p-4">
              <section className="border-b border-border pb-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-lg font-semibold">
                        {selectedAutomation.name}
                      </h2>
                      <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {selectedVersion?.version
                          ? `v${selectedVersion.version}`
                          : "draft"}
                      </span>
                    </div>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                      {selectedAutomation.description ?? "No description"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {selectedAutomation.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <Switch
                      checked={selectedAutomation.enabled}
                      onCheckedChange={toggleEnabled}
                      disabled={busy === "toggle"}
                    />
                  </div>
                </div>
              </section>

              <Tabs
                key={selectedAutomation.id}
                defaultValue="configure"
                className="space-y-4"
              >
                <TabsList>
                  <TabsTrigger value="configure">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Configure
                  </TabsTrigger>
                  <TabsTrigger value="runs">
                    <Clock3 className="h-3.5 w-3.5" />
                    Runs
                  </TabsTrigger>
                  <TabsTrigger value="editor">
                    <FileJson2 className="h-3.5 w-3.5" />
                    Definition
                  </TabsTrigger>
                  <TabsTrigger value="test">
                    <TestTube2 className="h-3.5 w-3.5" />
                    Test
                  </TabsTrigger>
                  <TabsTrigger value="state">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    State
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="configure">
                  {editBuilderDefinition ? (
                    <AutomationBuilder
                      mode="edit"
                      builder={editBuilder}
                      definition={editBuilderDefinition}
                      catalog={catalog}
                      catalogLoading={catalogLoading}
                      busy={busy}
                      attachedSessionId={attachedSessionId}
                      onBuilderChange={setEditBuilder}
                      onSubmit={saveConfiguredAutomation}
                      onCancel={resetEditBuilder}
                    />
                  ) : (
                    <div className="rounded-md border p-4 text-sm text-muted-foreground">
                      Loading definition...
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="runs" className="space-y-4">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
                    <div className="overflow-hidden rounded-md border">
                      <div className="grid grid-cols-[1fr_8rem_9rem] border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                        <span>Run</span>
                        <span>Status</span>
                        <span>Created</span>
                      </div>
                      {detailLoading ? (
                        <div className="p-4 text-sm text-muted-foreground">Loading runs...</div>
                      ) : detail?.runs.length ? (
                        detail.runs.map((run) => (
                          <Button
                            key={run.id}
                            type="button"
                            variant="ghost"
                            onClick={() => loadRun(run.id)}
                            className="grid h-auto w-full grid-cols-[1fr_8rem_9rem] items-center justify-normal rounded-none border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/50"
                          >
                            <span className="min-w-0 truncate font-mono text-xs">
                              {run.id}
                            </span>
                            <span className={`flex items-center gap-1.5 text-xs ${statusTone(run.status)}`}>
                              <StatusIcon status={run.status} />
                              {run.status}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatDate(run.createdAt)}
                            </span>
                          </Button>
                        ))
                      ) : (
                        <div className="p-4 text-sm text-muted-foreground">No runs yet.</div>
                      )}
                    </div>

                    <RunDetailPanel
                      run={runDetail}
                      busy={busy}
                      onApproval={decideApproval}
                    />
                  </div>
                </TabsContent>

                <TabsContent value="editor" className="space-y-3">
                  <DefinitionSummary
                    definition={parsedEditorDefinition.definition}
                    parseError={parsedEditorDefinition.error}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Code2 className="h-4 w-4 text-muted-foreground" />
                      Versioned Definition JSON
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={saveDefinition}
                      disabled={busy === "save"}
                    >
                      {busy === "save" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      Save
                    </Button>
                  </div>
                  <Textarea
                    value={editorText}
                    onChange={(event) => setEditorText(event.target.value)}
                    spellCheck={false}
                    className="min-h-[34rem] resize-y font-mono text-xs leading-relaxed"
                  />
                  <section className="space-y-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-muted-foreground">
                        Diff Before Save
                      </span>
                      <span className="text-muted-foreground">
                        {definitionChanged ? "Unsaved changes" : "No changes"}
                      </span>
                    </div>
                    <DiffBlock lines={definitionDiff} changed={definitionChanged} />
                  </section>
                </TabsContent>

                <TabsContent value="test" className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">Manual Event</p>
                      <p className="text-xs text-muted-foreground">
                        Preview matching or emit an append-only event that starts the router workflow.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={dryRunTest}
                        disabled={busy === "dry-run"}
                      >
                        {busy === "dry-run" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <TestTube2 className="h-3.5 w-3.5" />
                        )}
                        Dry Run
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={runTest}
                        disabled={busy === "test"}
                      >
                        {busy === "test" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                        Emit Test
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    value={testText}
                    onChange={(event) => setTestText(event.target.value)}
                    spellCheck={false}
                    className="min-h-72 resize-y font-mono text-xs leading-relaxed"
                  />
                  {testPreview ? (
                    <JsonBlock label="Dry Run Preview" value={testPreview} />
                  ) : null}
                </TabsContent>

                <TabsContent value="state" className="space-y-3">
                  <JsonBlock label="State" value={detail?.state ?? []} />
                  <JsonBlock label="Correlations" value={detail?.correlations ?? []} />
                </TabsContent>
              </Tabs>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

function AutomationBuilder({
  mode,
  builder,
  definition,
  catalog,
  catalogLoading,
  busy,
  attachedSessionId,
  onBuilderChange,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  builder: AutomationBuilderState;
  definition: AutomationDefinitionJson;
  catalog: AutomationBuilderCatalog;
  catalogLoading: boolean;
  busy: string | null;
  attachedSessionId: string | null | undefined;
  onBuilderChange: Dispatch<SetStateAction<AutomationBuilderState>>;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const submitBusyKey = mode === "edit" ? "builder-edit" : "builder";
  const submitLabel = mode === "edit" ? "Save changes" : "Create";
  const cancelLabel = mode === "edit" ? "Reset" : "Cancel";
  const update = <Key extends keyof AutomationBuilderState>(
    key: Key,
    value: AutomationBuilderState[Key],
  ) => {
    onBuilderChange((current) => ({ ...current, [key]: value }));
  };
  const selectedTrigger = selectedBuilderTrigger(builder);
  const selectedTriggerIndex = selectedTrigger
    ? builder.triggers.findIndex((trigger) => trigger.id === selectedTrigger.id)
    : -1;
  const eventSelectionValues = builder.triggers
    .filter((trigger) => trigger.kind === "event")
    .map((trigger) => eventSelectionKey(trigger.eventSource, trigger.eventType));
  const selectTrigger = (triggerId: string) => {
    onBuilderChange((current) =>
      withSelectedTriggerFields({ ...current, selectedTriggerId: triggerId }),
    );
  };
  const selectEventTriggerGroup = () => {
    onBuilderChange((current) =>
      withSelectedTriggerFields({
        ...current,
        triggerKind: "event",
        selectedTriggerId: EVENT_TRIGGER_GROUP_ID,
      }),
    );
  };
  const selectTriggerKind = (kind: BuilderTriggerKind) => {
    onBuilderChange((current) => {
      if (kind === "event") {
        return withSelectedTriggerFields({
          ...current,
          triggerKind: "event",
          selectedTriggerId: EVENT_TRIGGER_GROUP_ID,
        });
      }
      return {
        ...current,
        triggerKind: kind,
        selectedTriggerId: "",
        schedulePresetId: DEFAULT_SCHEDULE_PRESET_ID,
        pollCode: DEFAULT_POLL_CODE,
      };
    });
  };
  const addConfiguredTrigger = () => {
    if (builder.triggerKind === "event") {
      selectEventTriggerGroup();
      return;
    }
    onBuilderChange((current) => {
      const trigger = {
        ...defaultBuilderTrigger(
          current.triggerKind,
          nextTriggerId(current.triggers),
        ),
        schedulePresetId: current.schedulePresetId,
        pollCode: current.pollCode,
      };
      return withSelectedTriggerFields({
        ...current,
        triggers: [...current.triggers, trigger],
        selectedTriggerId: trigger.id,
      });
    });
  };
  const removeSelectedTrigger = () => {
    if (!selectedTrigger) {
      return;
    }
    onBuilderChange((current) => {
      const nextTriggers = current.triggers.filter(
        (trigger) => trigger.id !== selectedTrigger.id,
      );
      const nextSelected =
        nextTriggers[Math.max(0, selectedTriggerIndex - 1)] ??
        nextTriggers[0] ??
        null;
      return withSelectedTriggerFields({
        ...current,
        triggers: nextTriggers,
        selectedTriggerId: nextSelected?.id ?? "",
      });
    });
  };
  const updateSelectedTrigger = (patch: Partial<BuilderTrigger>) => {
    if (!selectedTrigger) {
      return;
    }
    onBuilderChange((current) =>
      withSelectedTriggerFields({
        ...current,
        triggers: current.triggers.map((trigger) =>
          trigger.id === selectedTrigger.id ? { ...trigger, ...patch } : trigger,
        ),
      }),
    );
  };
  const updateEventSelections = (values: string[]) => {
    onBuilderChange((current) => {
      const currentEvents = current.triggers.filter(
        (trigger) => trigger.kind === "event",
      );
      const otherTriggers = current.triggers.filter(
        (trigger) => trigger.kind !== "event",
      );
      const usedTriggers = [...otherTriggers, ...currentEvents];
      const eventTriggers = values.flatMap((value) => {
        const parsed = parseEventSelectionKey(value);
        if (!parsed) {
          return [];
        }
        const existing = currentEvents.find(
          (trigger) =>
            trigger.eventSource === parsed.source &&
            trigger.eventType === parsed.type,
        );
        if (existing) {
          return [existing];
        }
        const created = {
          ...defaultBuilderTrigger("event", nextTriggerId(usedTriggers)),
          eventSource: parsed.source,
          eventType: parsed.type,
        };
        usedTriggers.push(created);
        return [created];
      });
      const nextTriggers = [...eventTriggers, ...otherTriggers];
      return withSelectedTriggerFields({
        ...current,
        triggerKind: "event",
        triggers: nextTriggers,
        selectedTriggerId: EVENT_TRIGGER_GROUP_ID,
      });
    });
  };
  const updateEmitEventSource = (sourceId: string) => {
    const source = catalog.eventSources.find((item) => item.id === sourceId);
    onBuilderChange((current) => ({
      ...current,
      emitEventSource: sourceId,
      emitEventType: source?.events[0]?.id ?? current.emitEventType,
    }));
  };
  const updateRepo = (value: string) => {
    if (value === "__none__") {
      onBuilderChange((current) => ({ ...current, repoOwner: "", repoName: "" }));
      return;
    }
    const [owner = "", repo = ""] = value.split("/", 2);
    onBuilderChange((current) => ({
      ...current,
      repoOwner: owner,
      repoName: repo,
    }));
  };

  const selectedEmitSource =
    catalog.eventSources.find((source) => source.id === builder.emitEventSource) ??
    catalog.eventSources.find((source) => source.id === "automation") ??
    catalog.eventSources[0];
  const sourceOptions = catalog.eventSources.map((source) => ({
    id: source.id,
    label: source.label,
    description: source.description,
    badge: `${source.events.length} events`,
  }));
  const emitEventTypeOptions =
    selectedEmitSource?.events.map((event) => ({
      ...event,
      group: selectedEmitSource.label,
    })) ?? [];
  const scheduleOptions = catalog.schedulePresets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
  }));
  const actionOptions = catalog.actions.map((action) => ({
    ...action,
    group: "Actions",
  }));
  const agentOptions: SearchableCatalogOption[] = [
    {
      id: "__standard__",
      label: "Standard agent",
      description: "Use the base runtime without a saved agent profile.",
      group: "Agents",
    },
    ...catalog.agents.map((agent) => ({
      id: agent.id,
      label: agent.isDefault ? `${agent.name} (default)` : agent.name,
      description: [
        agent.description,
        agent.skills.length ? `Skills: ${agent.skills.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      badge: agent.model,
      group: "Agents",
      keywords: [agent.id, ...agent.skills, ...agent.tools],
    })),
  ];
  const repoOptions: SearchableCatalogOption[] = [
    {
      id: "__none__",
      label: "No repository",
      description: "Start a chat without mounting a repository.",
      group: "Repositories",
    },
    ...catalog.repos.map((repo) => ({
      id: repo.fullName,
      label: repo.fullName,
      description: [
        repo.description ?? (repo.private ? "Private repository" : "Repository"),
        repo.branch ? `Default branch: ${repo.branch}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      badge: repo.private ? "private" : "public",
      group: repo.owner,
      keywords: [repo.owner, repo.name, repo.cloneUrl ?? "", repo.branch ?? ""],
    })),
  ];
  const skillOptions = catalog.skills.map((skill) => ({
    id: skill.id,
    label: skill.name,
    description: skill.description,
    badge: skill.userInvocable === false ? "model-only" : undefined,
    group: skill.agent ?? "Skills",
    keywords: [skill.id, ...(skill.allowedTools ?? [])],
  }));
  const builtInToolOptions = catalog.builtInTools.map((tool) => {
    const allowed = isBuiltInToolAllowedForAutonomy(builder.autonomy, tool.id);
    return {
      id: tool.id,
      label: tool.label,
      description: tool.description,
      badge: allowed ? undefined : "blocked",
      group: allowed ? "Allowed by autonomy" : "Blocked by autonomy",
      keywords: [tool.id, ...tool.allowedByAutonomy],
    };
  });
  const executorToolOptions: SearchableCatalogOption[] = [
    ...catalog.executorSources.map((source) => ({
      id: source.pattern,
      label: source.label,
      description: source.description,
      badge: `${source.toolCount} tools`,
      group: "Executor sources",
      keywords: [source.id, source.pattern],
    })),
    ...catalog.executorTools.map((tool) => ({
      id: tool.pattern,
      label: tool.label,
      description: tool.description,
      badge: tool.sourceId,
      group: tool.group ?? "Executor tools",
      keywords: [tool.id, tool.pattern, tool.sourceId ?? ""],
    })),
  ];
  const selectedRepoValue =
    builder.repoOwner && builder.repoName
      ? `${builder.repoOwner}/${builder.repoName}`
      : "__none__";
  const agentValue = builder.agentName || "__standard__";
  const editingTrigger =
    selectedTrigger?.kind === builder.triggerKind ? selectedTrigger : null;
  const activeEventTrigger = builder.triggers.find(
    (trigger) => trigger.kind === "event",
  );
  const activeEventValue = activeEventTrigger
    ? eventSelectionKey(activeEventTrigger.eventSource, activeEventTrigger.eventType)
    : eventSelectionKey(DEFAULT_EVENT_SOURCE, DEFAULT_EVENT_TYPE);
  const scheduleValue =
    editingTrigger &&
    (editingTrigger.kind === "schedule" || editingTrigger.kind === "poll")
      ? editingTrigger.schedulePresetId
      : builder.schedulePresetId;
  const pollCodeValue =
    editingTrigger?.kind === "poll" ? editingTrigger.pollCode : builder.pollCode;

  return (
    <div className="min-h-full bg-background p-4 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Automation Builder
            </div>
            <h2 className="mt-1 text-xl font-semibold">
              {mode === "edit" ? "Edit automation route" : "Build a custom route"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {mode === "edit"
                ? "Tune the same durable automation artifact used by new routes. Advanced fields remain available in the JSON tab."
                : "Compose the durable automation artifact directly. The generated definition stays editable in the JSON tab after creation."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onSubmit}
              disabled={busy === submitBusyKey}
            >
              {busy === submitBusyKey ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {submitLabel}
            </Button>
          </div>
        </div>

        {catalog.errors.length > 0 ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {catalog.errors.join(" ")}
          </div>
        ) : null}

        <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 space-y-4">
            <BuilderSection
              icon={<ClipboardList className="h-4 w-4" />}
              title="Basics"
              description="Name, scope, and rollout state."
            >
              <div className="grid gap-3 md:grid-cols-2">
                <BuilderField label="Name">
                  <Input
                    value={builder.name}
                    onChange={(event) => update("name", event.target.value)}
                    placeholder="PR review helper"
                  />
                </BuilderField>
                <BuilderField label="Scope">
                  <div className="flex h-9 items-center rounded-md border bg-muted/20 px-3 text-sm text-muted-foreground">
                    current user
                  </div>
                </BuilderField>
              </div>
              <BuilderField label="Description">
                <Input
                  value={builder.description}
                  onChange={(event) => update("description", event.target.value)}
                  placeholder="What this automation watches and what it should do"
                />
              </BuilderField>
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/10 px-3 py-2">
                <span>
                  <span className="block text-sm font-medium">
                    {mode === "edit" ? "Enabled" : "Enable after create"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {mode === "edit"
                      ? "Save changes to update the rollout state."
                      : "Leave disabled while you are still tuning policy and tests."}
                  </span>
                </span>
                <Switch
                  checked={builder.enabled}
                  onCheckedChange={(checked) => update("enabled", checked)}
                />
              </div>
            </BuilderSection>

            <BuilderSection
              icon={<Route className="h-4 w-4" />}
              title="Trigger"
              description="Choose what enters the event router."
            >
              <TriggerPillList
                triggers={builder.triggers}
                selectedTriggerId={builder.selectedTriggerId}
                catalog={catalog}
                onSelectEventGroup={selectEventTriggerGroup}
                onSelect={selectTrigger}
              />
              <TriggerKindTabs
                kinds={catalog.triggerKinds}
                activeKind={builder.triggerKind}
                onSelect={selectTriggerKind}
              />

              {builder.triggerKind === "event" ? (
                <EventTriggerMultiSelect
                  sources={catalog.eventSources}
                  value={eventSelectionValues}
                  activeValue={activeEventValue}
                  onValueChange={updateEventSelections}
                  onActiveValueChange={selectEventTriggerGroup}
                />
              ) : null}

              {builder.triggerKind === "schedule" ||
              builder.triggerKind === "poll" ? (
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <BuilderField label="Cadence">
                    <SearchableCatalogPicker
                      options={scheduleOptions}
                      value={scheduleValue}
                      onValueChange={(value) => {
                        if (editingTrigger) {
                          updateSelectedTrigger({ schedulePresetId: value });
                          return;
                        }
                        update("schedulePresetId", value);
                      }}
                      placeholder="Choose a cadence"
                      searchPlaceholder="Filter cadences"
                    />
                  </BuilderField>
                  {editingTrigger ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={removeSelectedTrigger}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  ) : (
                    <Button type="button" onClick={addConfiguredTrigger}>
                      <Plus className="h-3.5 w-3.5" />
                      Add {builder.triggerKind}
                    </Button>
                  )}
                </div>
              ) : null}

              {builder.triggerKind === "poll" ? (
                <BuilderField label="Poll evaluator">
                  <Textarea
                    value={pollCodeValue}
                    onChange={(event) => {
                      if (editingTrigger) {
                        updateSelectedTrigger({ pollCode: event.target.value });
                        return;
                      }
                      update("pollCode", event.target.value);
                    }}
                    spellCheck={false}
                    className="min-h-28 font-mono text-xs"
                  />
                </BuilderField>
              ) : null}

              {builder.triggerKind === "manual" ? (
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/10 px-3 py-2">
                  <span className="text-sm font-medium">Manual test trigger</span>
                  {editingTrigger ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={removeSelectedTrigger}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  ) : (
                    <Button type="button" size="sm" onClick={addConfiguredTrigger}>
                      <Plus className="h-3.5 w-3.5" />
                      Add manual
                    </Button>
                  )}
                </div>
              ) : null}
            </BuilderSection>

            <BuilderSection
              icon={<Send className="h-4 w-4" />}
              title="Action"
              description="Choose the durable driver that runs after a match."
            >
              <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                {actionOptions.map((action) => (
                  <BuilderOptionButton
                    key={action.id}
                    active={builder.actionKind === action.id}
                    icon={builderActionIcon(action.id)}
                    label={action.label}
                    description={action.description ?? ""}
                    onClick={() =>
                      update("actionKind", action.id as BuilderActionKind)
                    }
                  />
                ))}
              </div>

              {builder.actionKind === "notify" ? (
                <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
                  <BuilderField label="Destination">
                    <SearchableCatalogPicker
                      options={catalog.notifyDestinations.map((destination) => ({
                        ...destination,
                        group: "Destinations",
                      }))}
                      value={builder.notifyDestination}
                      onValueChange={(value) =>
                        update(
                          "notifyDestination",
                          value as AutomationBuilderState["notifyDestination"],
                        )
                      }
                      placeholder="Choose destination"
                      searchPlaceholder="Filter destinations"
                    />
                  </BuilderField>
                  <BuilderField label="Target">
                    <Input
                      value={builder.notifyTarget}
                      onChange={(event) =>
                        update("notifyTarget", event.target.value)
                      }
                      placeholder="Optional URL, channel, repo, or issue"
                    />
                  </BuilderField>
                  <div className="md:col-span-2">
                    <BuilderField label="Message">
                      <Textarea
                        value={builder.notifyMessage}
                        onChange={(event) =>
                          update("notifyMessage", event.target.value)
                        }
                        className="min-h-24"
                      />
                    </BuilderField>
                  </div>
                </div>
              ) : null}

              {builder.actionKind === "startSession" ||
              builder.actionKind === "messageSession" ? (
                <div className="space-y-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <BuilderField label="Agent profile">
                      <SearchableCatalogPicker
                        options={agentOptions}
                        value={agentValue}
                        onValueChange={(value) =>
                          update(
                            "agentName",
                            value === "__standard__" ? "" : value,
                          )
                        }
                        placeholder={
                          catalogLoading ? "Loading agents" : "Choose an agent"
                        }
                        searchPlaceholder="Filter agents"
                      />
                    </BuilderField>
                    <BuilderField label="Repository">
                      <SearchableCatalogPicker
                        options={repoOptions}
                        value={selectedRepoValue}
                        onValueChange={updateRepo}
                        placeholder={
                          catalogLoading ? "Loading repositories" : "Choose a repo"
                        }
                        searchPlaceholder="Filter repositories"
                      />
                    </BuilderField>
                  </div>
                  <BuilderField label="Skills">
                    <SearchableCatalogPicker
                      multiple
                      options={skillOptions}
                      value={builder.skillIds}
                      onValueChange={(value) => update("skillIds", value)}
                      placeholder={
                        catalogLoading ? "Loading skills" : "Add local skills"
                      }
                      searchPlaceholder="Filter skills"
                      emptyLabel="No local skills found."
                    />
                  </BuilderField>
                  <BuilderField label="Agent prompt">
                    <Textarea
                      value={builder.prompt}
                      onChange={(event) => update("prompt", event.target.value)}
                      className="min-h-32"
                    />
                  </BuilderField>
                </div>
              ) : null}

              {builder.actionKind === "runFunction" ? (
                <BuilderField label="Function code">
                  <Textarea
                    value={builder.functionCode}
                    onChange={(event) => update("functionCode", event.target.value)}
                    spellCheck={false}
                    className="min-h-32 font-mono text-xs"
                  />
                </BuilderField>
              ) : null}

              {builder.actionKind === "monitor" ? (
                <BuilderField label="Monitor prompt">
                  <Textarea
                    value={builder.prompt}
                    onChange={(event) => update("prompt", event.target.value)}
                    className="min-h-32"
                  />
                </BuilderField>
              ) : null}

              {builder.actionKind === "emitEvent" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <BuilderField label="Event source">
                    <SearchableCatalogPicker
                      options={sourceOptions}
                      value={builder.emitEventSource}
                      onValueChange={updateEmitEventSource}
                      placeholder="Choose a source"
                      searchPlaceholder="Filter sources"
                    />
                  </BuilderField>
                  <BuilderField label="Event type">
                    <SearchableCatalogPicker
                      options={emitEventTypeOptions}
                      value={builder.emitEventType}
                      onValueChange={(value) => update("emitEventType", value)}
                      placeholder="Choose an event"
                      searchPlaceholder="Filter events"
                    />
                  </BuilderField>
                </div>
              ) : null}
            </BuilderSection>

            <BuilderSection
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Policy"
              description="Set the permission envelope before this runs."
            >
              <div className="grid gap-3 md:grid-cols-2">
                <BuilderField label="Autonomy">
                  <SearchableCatalogPicker
                    options={catalog.autonomyLevels.map((autonomy) => ({
                      ...autonomy,
                      group: "Autonomy",
                    }))}
                    value={builder.autonomy}
                    onValueChange={(value) =>
                      update("autonomy", value as BuilderAutonomy)
                    }
                    placeholder="Choose autonomy"
                    searchPlaceholder="Filter autonomy levels"
                  />
                </BuilderField>
                <BuilderField label="Max model steps">
                  <Input
                    value={builder.maxModelSteps}
                    inputMode="numeric"
                    onChange={(event) =>
                      update("maxModelSteps", event.target.value)
                    }
                  />
                </BuilderField>
              </div>
              <BuilderField label="Built-in tools">
                <SearchableCatalogPicker
                  multiple
                  options={builtInToolOptions}
                  value={builder.builtInTools}
                  onValueChange={(value) => update("builtInTools", value)}
                  placeholder="Choose built-in tools"
                  searchPlaceholder="Filter tools"
                />
              </BuilderField>
              <BuilderField label="Executor tools">
                <SearchableCatalogPicker
                  multiple
                  options={executorToolOptions}
                  value={builder.executorTools}
                  onValueChange={(value) => update("executorTools", value)}
                  placeholder={
                    catalogLoading
                      ? "Loading executor tools"
                      : "Choose executor sources or tools"
                  }
                  searchPlaceholder="Filter executor tools"
                  emptyLabel="No executor tools are configured yet."
                />
              </BuilderField>
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/10 px-3 py-2">
                <span>
                  <span className="block text-sm font-medium">Require approval</span>
                  <span className="block text-xs text-muted-foreground">
                    Pause the Workflow on a durable hook before action execution.
                  </span>
                </span>
                <Switch
                  checked={builder.requireApproval}
                  onCheckedChange={(checked) => update("requireApproval", checked)}
                />
              </div>
            </BuilderSection>
          </div>

          <aside className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
            <div className="rounded-md border bg-muted/10 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <Settings2 className="h-3.5 w-3.5" />
                Route Summary
              </div>
              <div className="mt-3 space-y-2 text-sm">
                <SummaryRow label="Trigger">
                  {triggerSummary(definition)}
                </SummaryRow>
                <SummaryRow label="Action">
                  {describeAction(definition.action)}
                </SummaryRow>
                <SummaryRow label="Scope">{formatScope(definition.scope)}</SummaryRow>
                <SummaryRow label="Policy">
                  {textValue(definition.policy.autonomy)} /{" "}
                  {budgetSummary(definition.policy)}
                </SummaryRow>
              </div>
            </div>
            <JsonBlock label="Generated Definition" value={definition} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function BuilderSection({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border bg-background p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function BuilderField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function TriggerPillList({
  triggers,
  selectedTriggerId,
  catalog,
  onSelectEventGroup,
  onSelect,
}: {
  triggers: BuilderTrigger[];
  selectedTriggerId: string;
  catalog: AutomationBuilderCatalog;
  onSelectEventGroup: () => void;
  onSelect: (triggerId: string) => void;
}) {
  const eventTriggers = triggers.filter((trigger) => trigger.kind === "event");
  const otherTriggers = triggers.filter((trigger) => trigger.kind !== "event");
  const hasTriggers = eventTriggers.length > 0 || otherTriggers.length > 0;
  return (
    <div className="rounded-md border bg-muted/5 p-3">
      <div className="flex flex-wrap gap-2">
        {hasTriggers ? (
          <>
            {eventTriggers.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={onSelectEventGroup}
                className={cn(
                  "h-auto max-w-full justify-start gap-2 rounded-full px-2.5 py-1.5 text-left text-xs",
                  selectedTriggerId === EVENT_TRIGGER_GROUP_ID
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/40",
                )}
              >
                <span
                  className={
                    selectedTriggerId === EVENT_TRIGGER_GROUP_ID
                      ? "text-primary"
                      : "text-muted-foreground"
                  }
                >
                  {builderTriggerIcon("event")}
                </span>
                <span className="min-w-0 truncate font-medium">
                  Events ({eventTriggers.length})
                </span>
              </Button>
            ) : null}
            {otherTriggers.map((trigger) => {
            const active = trigger.id === selectedTriggerId;
            return (
              <Button
                key={trigger.id}
                type="button"
                variant="outline"
                onClick={() => onSelect(trigger.id)}
                className={cn(
                  "h-auto max-w-full justify-start gap-2 rounded-full px-2.5 py-1.5 text-left text-xs",
                  active
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/40",
                )}
              >
                <span className={active ? "text-primary" : "text-muted-foreground"}>
                  {builderTriggerIcon(trigger.kind)}
                </span>
                <span className="min-w-0 truncate font-medium">
                  {triggerPillLabel(trigger, catalog)}
                </span>
              </Button>
            );
            })}
          </>
        ) : (
          <span className="rounded-full border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
            No triggers
          </span>
        )}
      </div>
    </div>
  );
}

function TriggerKindTabs({
  kinds,
  activeKind,
  onSelect,
}: {
  kinds: AutomationBuilderCatalog["triggerKinds"];
  activeKind: BuilderTriggerKind;
  onSelect: (kind: BuilderTriggerKind) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/10 p-1">
      {kinds.map((kind) => {
        const active = kind.id === activeKind;
        return (
          <Button
            key={kind.id}
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => onSelect(kind.id as BuilderTriggerKind)}
          >
            {builderTriggerIcon(kind.id)}
            {kind.label}
          </Button>
        );
      })}
    </div>
  );
}

function EventTriggerMultiSelect({
  sources,
  value,
  activeValue,
  onValueChange,
  onActiveValueChange,
}: {
  sources: AutomationBuilderCatalog["eventSources"];
  value: string[];
  activeValue: string;
  onValueChange: (value: string[]) => void;
  onActiveValueChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [familyFilter, setFamilyFilter] = useState("all");
  const valueSet = useMemo(() => new Set(value), [value]);
  const eventOptions = useMemo(
    () =>
      sources.flatMap((source) =>
        source.events.map((event) => ({
          id: eventSelectionKey(source.id, event.id),
          sourceId: source.id,
          sourceLabel: source.label,
          sourceDescription: source.description,
          eventId: event.id,
          eventLabel: event.label,
          eventDescription: event.description,
          family: eventFamily(event.id),
          keywords: [
            source.id,
            source.label,
            source.description ?? "",
            event.id,
            event.label,
            event.description ?? "",
            ...(event.keywords ?? []),
          ],
        })),
      ),
    [sources],
  );
  const sourceFilters = [
    { id: "all", label: "All sources" },
    ...sources.map((source) => ({ id: source.id, label: source.label })),
  ];
  const familyFilters = [
    { id: "all", label: "All events" },
    ...Array.from(new Set(eventOptions.map((option) => option.family)))
      .sort()
      .map((family) => ({ id: family, label: eventFamilyLabel(family) })),
  ];
  const visibleOptions = eventOptions.filter((option) => {
    if (sourceFilter !== "all" && option.sourceId !== sourceFilter) {
      return false;
    }
    if (familyFilter !== "all" && option.family !== familyFilter) {
      return false;
    }
    if (!query.trim()) {
      return true;
    }
    return fuzzyMatches(option.keywords.join(" "), query);
  });
  const groupedOptions = sources
    .map((source) => ({
      source,
      options: visibleOptions.filter((option) => option.sourceId === source.id),
    }))
    .filter((group) => group.options.length > 0);

  const toggleValue = (optionValue: string) => {
    if (valueSet.has(optionValue)) {
      onValueChange(value.filter((item) => item !== optionValue));
      return;
    }
    onValueChange([...value, optionValue]);
    onActiveValueChange(optionValue);
  };

  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="space-y-3 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search events"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {sourceFilters.map((filter) => (
            <FilterPill
              key={filter.id}
              active={sourceFilter === filter.id}
              label={filter.label}
              onClick={() => setSourceFilter(filter.id)}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {familyFilters.map((filter) => (
            <FilterPill
              key={filter.id}
              active={familyFilter === filter.id}
              label={filter.label}
              onClick={() => setFamilyFilter(filter.id)}
            />
          ))}
        </div>
      </div>
      <div className="max-h-72 overflow-auto border-t">
        {groupedOptions.length > 0 ? (
          groupedOptions.map(({ source, options }) => (
            <div key={source.id} className="border-b last:border-b-0">
              <div className="sticky top-0 z-10 bg-muted/80 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground backdrop-blur">
                {source.label}
              </div>
              <div className="divide-y">
                {options.map((option) => {
                  const selected = valueSet.has(option.id);
                  const active = option.id === activeValue;
                  return (
                    <Button
                      key={option.id}
                      type="button"
                      variant="ghost"
                      onClick={() => toggleValue(option.id)}
                      className={cn(
                        "h-auto w-full items-start justify-start gap-3 rounded-none px-3 py-2 text-left hover:bg-muted/40",
                        active ? "bg-primary/5" : "",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background",
                        )}
                      >
                        {selected ? <CheckCircle2 className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="min-w-0 break-words text-sm font-medium">
                            {option.eventLabel}
                          </span>
                          <span className="rounded border px-1 py-0.5 text-[10px] uppercase leading-none tracking-normal text-muted-foreground">
                            {option.family}
                          </span>
                        </span>
                        <span className="mt-0.5 block break-words text-xs leading-4 text-muted-foreground">
                          {option.sourceLabel} / {option.eventId}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <div className="px-3 py-6 text-sm text-muted-foreground">
            No matching events
          </div>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className={cn(
        "h-7 rounded-full px-2.5 py-1 text-xs",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted/40",
      )}
    >
      {label}
    </Button>
  );
}

function BuilderOptionButton({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={`h-auto min-h-20 flex-col items-start justify-start whitespace-normal rounded-md border p-3 text-left transition-colors ${
        active
          ? "border-primary/40 bg-primary/10"
          : "bg-muted/10 hover:bg-muted/40"
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className={active ? "text-primary" : "text-muted-foreground"}>
          {icon}
        </span>
        {label}
      </span>
      <span className="mt-1 block text-xs leading-4 text-muted-foreground">
        {description}
      </span>
    </Button>
  );
}

function DiffBlock({
  lines,
  changed,
}: {
  lines: DiffLine[];
  changed: boolean;
}) {
  if (!changed) {
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        The saved definition and editor contents are identical.
      </div>
    );
  }

  return (
    <div className="max-h-72 overflow-auto rounded-md border bg-muted/20 py-2 font-mono text-xs leading-relaxed">
      {lines.map((line, index) => {
        const prefix =
          line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
        const tone =
          line.kind === "add"
            ? "bg-emerald-500/10 text-emerald-700"
            : line.kind === "remove"
            ? "bg-red-500/10 text-red-700"
            : "text-muted-foreground";
        return (
          <div key={`${index}:${line.kind}`} className={`flex gap-2 px-3 ${tone}`}>
            <span className="w-4 shrink-0 select-none text-right">{prefix}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {line.text || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DefinitionSummary({
  definition,
  parseError,
}: {
  definition: AutomationDefinitionJson | null;
  parseError: string | null;
}) {
  if (parseError) {
    return (
      <section className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertCircle className="h-4 w-4" />
          Invalid definition JSON
        </div>
        <p className="mt-1 break-words text-xs text-destructive/80">{parseError}</p>
      </section>
    );
  }

  if (!definition) {
    return null;
  }

  const triggers = Array.isArray(definition.triggers)
    ? definition.triggers.filter(isRecord)
    : [];
  const conditions = Array.isArray(definition.conditions)
    ? definition.conditions.filter(isRecord)
    : [];
  const outputs = Array.isArray(definition.outputs)
    ? definition.outputs.filter(isRecord)
    : [];
  const policy = isRecord(definition.policy) ? definition.policy : {};
  const budget = isRecord(policy.budget) ? policy.budget : {};
  const rateLimit = isRecord(policy.rateLimit) ? policy.rateLimit : null;
  const network = isRecord(policy.network) ? policy.network : null;
  const secrets = isRecord(policy.secrets) ? policy.secrets : null;
  const builtInTools = splitBuiltInToolsByAutonomy(policy);
  const approvals = Array.isArray(policy.approvals)
    ? policy.approvals.filter(isRecord)
    : [];
  const action = isRecord(definition.action) ? definition.action : undefined;
  const actionAgent = action && isRecord(action.agent) ? action.agent : undefined;
  const policyBudget = Object.entries(budget).map(([key, value]) => {
    const display = key.toLowerCase().includes("duration")
      ? formatMs(value)
      : textValue(value);
    return `${key}: ${display}`;
  });
  const sourceMounts = isRecord(definition.tools)
    ? Object.keys(definition.tools)
    : [];
  const stateKeys = isRecord(definition.state)
    ? Object.keys(definition.state)
    : [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Route className="h-4 w-4 text-muted-foreground" />
          Structured Definition
        </div>
        <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {definition.enabled === false ? "disabled" : "enabled"}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <SummarySection
          icon={<ShieldCheck className="h-4 w-4 text-muted-foreground" />}
          title="Scope And Identity"
        >
          <SummaryRow label="Scope">{formatScope(definition.scope)}</SummaryRow>
          <SummaryRow label="Owner">{formatOwner(definition.owner)}</SummaryRow>
          <SummaryRow label="Identity">
            {formatIdentity(definition.identity)}
          </SummaryRow>
          <SummaryRow label="Version">
            {definition.version ? `v${definition.version}` : "draft"}
          </SummaryRow>
        </SummarySection>

        <SummarySection
          icon={<Clock3 className="h-4 w-4 text-muted-foreground" />}
          title="Triggers"
        >
          <SummaryList
            items={triggers.map(describeTrigger)}
            empty="No triggers configured"
          />
        </SummarySection>

        <SummarySection
          icon={<ListChecks className="h-4 w-4 text-muted-foreground" />}
          title="Conditions"
        >
          <SummaryList
            items={conditions.map(describeCondition)}
            empty="No conditions configured"
          />
        </SummarySection>

        <SummarySection
          icon={<Bot className="h-4 w-4 text-muted-foreground" />}
          title="Agent And Action"
        >
          <SummaryRow label="Agent">
            {describeAgent(definition.agent ?? actionAgent)}
          </SummaryRow>
          <SummaryRow label="Action">{describeAction(action)}</SummaryRow>
          <SummaryRow label="Correlation">
            {compactJson(definition.correlation ?? { key: "correlation" })}
          </SummaryRow>
          <SummaryRow label="Concurrency">
            {compactJson(definition.concurrency ?? { key: "correlation", onConflict: "queue" })}
          </SummaryRow>
        </SummarySection>

        <SummarySection
          icon={<Wrench className="h-4 w-4 text-muted-foreground" />}
          title="Tools And Sources"
        >
          <SummaryRow label="Executor">
            <ChipList items={stringArray(policy.executorTools)} />
          </SummaryRow>
          <SummaryRow label="Built-in">
            <ChipList items={builtInTools.allowed} />
          </SummaryRow>
          <SummaryRow label="Blocked">
            <ChipList items={builtInTools.blocked} empty="none" />
          </SummaryRow>
          <SummaryRow label="Mounts">
            <ChipList items={sourceMounts} />
          </SummaryRow>
          <SummaryRow label="Network">
            {network
              ? compactJson({
                  allow: network.allow,
                  deny: network.deny,
                })
              : "default"}
          </SummaryRow>
        </SummarySection>

        <SummarySection
          icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
          title="Policy And Approvals"
        >
          <SummaryRow label="Autonomy">
            {textValue(policy.autonomy, "read-only")}
          </SummaryRow>
          <SummaryRow label="Memory">{textValue(policy.memory, "none")}</SummaryRow>
          <SummaryRow label="Budget">
            <ChipList items={policyBudget} empty="no budget cap" />
          </SummaryRow>
          <SummaryRow label="Rate limit">
            {rateLimit
              ? `${textValue(rateLimit.max, "max")} per ${formatMs(rateLimit.windowMs)}`
              : "none"}
          </SummaryRow>
          <SummaryRow label="Secrets">
            <ChipList
              items={secrets ? stringArray(secrets.allow) : []}
              empty="none"
            />
          </SummaryRow>
          <SummaryRow label="Approvals">
            <SummaryList
              items={approvals.map((approval) =>
                `${textValue(approval.when, "before-run")}: ${textValue(approval.reason, "approval required")}`,
              )}
              empty="No approvals configured"
            />
          </SummaryRow>
        </SummarySection>

        <SummarySection
          icon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
          title="Outputs"
        >
          <SummaryList
            items={outputs.map(outputLabel)}
            empty="No outputs configured"
          />
        </SummarySection>

        <SummarySection
          icon={<Database className="h-4 w-4 text-muted-foreground" />}
          title="State And Memory"
        >
          <SummaryRow label="State keys">
            <ChipList items={stateKeys} empty="none" />
          </SummaryRow>
          <SummaryRow label="Memory mode">
            {textValue(policy.memory, "none")}
          </SummaryRow>
        </SummarySection>
      </div>
    </section>
  );
}

function SummarySection({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-md border bg-muted/10 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        {icon}
        <span>{title}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  );
}

function SummaryList({
  items,
  empty,
}: {
  items: string[];
  empty: string;
}) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">{empty}</span>;
  }

  return (
    <ol className="space-y-1">
      {items.map((item, index) => (
        <li key={`${index}:${item}`} className="flex min-w-0 gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function ChipList({
  items,
  empty = "none",
}: {
  items: string[];
  empty?: string;
}) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">{empty}</span>;
  }

  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item}
          className="max-w-full truncate rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          {item}
        </span>
      ))}
    </span>
  );
}

function RunDetailPanel({
  run,
  busy,
  onApproval,
}: {
  run: RunDetail | null;
  busy: string | null;
  onApproval: (approvalId: string, approved: boolean) => void;
}) {
  if (!run) {
    return (
      <div className="rounded-md border p-4 text-sm text-muted-foreground">
        Select a run to inspect timeline, artifacts, approvals, and outbox entries.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs">{run.id}</span>
        <span className={`flex items-center gap-1.5 text-xs ${statusTone(run.status)}`}>
          <StatusIcon status={run.status} />
          {run.status}
        </span>
      </div>
      {run.sessionId && run.chatId ? (
        <a
          href={`/sessions/${run.sessionId}/chats/${run.chatId}`}
          className="block truncate rounded border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Open attached session
        </a>
      ) : null}

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <RunMeta label="Eve session" value={run.eveSessionId ?? "not started"} />
        <RunMeta label="Correlation" value={run.correlationKey ?? "none"} />
        <RunMeta label="Started" value={formatDate(run.startedAt)} />
        <RunMeta label="Finished" value={formatDate(run.finishedAt)} />
      </div>
      {run.lastError ? (
        <div className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {run.lastError}
        </div>
      ) : null}

      {run.approvals.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">Approvals</h3>
          {run.approvals.map((approval) => (
            <div key={approval.id} className="rounded border p-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium">{approval.kind}</span>
                <span>{approval.status}</span>
              </div>
              {approval.status === "requested" ? (
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy === `approval:${approval.id}`}
                    onClick={() => onApproval(approval.id, true)}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy === `approval:${approval.id}`}
                    onClick={() => onApproval(approval.id, false)}
                  >
                    Deny
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <Timeline events={run.timeline} />
      <JsonBlock label="Event" value={run.event} />
      <JsonBlock label="Invocation" value={run.invocation} />
      <JsonBlock label="Policy Snapshot" value={run.policySnapshotJson} />
      <JsonBlock label="Agent Snapshot" value={run.agentSnapshotJson} />
      <JsonBlock label="Artifacts" value={run.artifacts} />
      <JsonBlock label="Outbox" value={run.outbox} />
    </div>
  );
}

function RunMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border bg-muted/20 px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="min-w-0 truncate font-mono">{value}</div>
    </div>
  );
}

function Timeline({
  events,
}: {
  events: RunDetail["timeline"];
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">Timeline</h3>
      <div className="space-y-2">
        {events.length > 0 ? (
          events.map((event) => (
            <div key={event.id} className="rounded border px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium">{event.type}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatDate(event.timestamp)}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 break-words font-mono text-[11px] text-muted-foreground">
                {compactJson(event.payloadJson)}
              </p>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">No timeline events.</p>
        )}
      </div>
    </section>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{label}</h3>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}
