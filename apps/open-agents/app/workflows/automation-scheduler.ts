/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-json-parse -- boundary: scheduler poll evaluator handles user-code string output and Workflow retry failure semantics */
import { getStepMetadata } from "workflow";
import { start } from "workflow/api";
import { automationRouterWorkflow } from "./automation-router";

type AutomationScopeKind =
  | "system"
  | "user"
  | "thread"
  | "session"
  | "repo"
  | "automation"
  | "external-thread";

type EventScope = {
  kind: Exclude<AutomationScopeKind, "external-thread">;
  id: string;
};

type ScheduleDefinition =
  | { kind: "interval"; everyMs: number; anchorAt?: string }
  | { kind: "once"; dueAt: string }
  | { kind: "cron"; expression: string; timezone?: string };

type PollTrigger = {
  kind: "poll";
  schedule: ScheduleDefinition;
  evaluator: {
    code: string;
    timeoutMs?: number;
  };
};

type AutomationDefinitionLike = {
  id?: string;
  name: string;
  scope: {
    kind: AutomationScopeKind;
    id: string;
  };
  owner: {
    kind: string;
    id: string;
  };
  identity: {
    kind: string;
    userId?: string;
  };
  policy: {
    executorTools: string[];
  };
};

type SchedulerEmission = {
  eventIds: string[];
  checked: number;
  emitted: number;
  skippedPolls: number;
  blockedPolls: number;
};

function toEventScope(
  definition: AutomationDefinitionLike,
): EventScope {
  if (definition.scope.kind === "external-thread") {
    return { kind: "user", id: definition.owner.id };
  }
  return { kind: definition.scope.kind, id: definition.scope.id };
}

function resolveIdentityUserId(definition: AutomationDefinitionLike): string {
  if (definition.identity.kind === "user") {
    return definition.identity.userId ?? "automation-bot";
  }
  if (definition.owner.kind === "user") {
    return definition.owner.id;
  }
  return "automation-bot";
}

function extractPollResult(result: {
  structured?: Record<string, unknown>;
  text: string;
  isError?: boolean;
}) {
  const structuredResult = result.structured?.result;
  if (structuredResult !== undefined) {
    return structuredResult;
  }

  try {
    return JSON.parse(result.text);
  } catch {
    return result.text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldEmitPollEvent(value: unknown): boolean {
  if (isRecord(value) && typeof value.status === "string") {
    return value.status === "emit";
  }
  if (value === false || value === null || value === undefined) {
    return false;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "emit" in value
  ) {
    return (value as { emit?: unknown }).emit !== false;
  }
  return true;
}

function getPollPayload(value: unknown): unknown {
  if (isRecord(value)) {
    if ("payload" in value) {
      return value.payload ?? {};
    }
    if ("state" in value || "events" in value || "status" in value) {
      return {};
    }
  }
  return value ?? {};
}

function getPollState(
  value: unknown,
  previousState: Record<string, unknown>,
): Record<string, unknown> {
  if (isRecord(value) && isRecord(value.state)) {
    return value.state;
  }
  const existingState = previousState.pollState;
  return isRecord(existingState) ? existingState : {};
}

function getPollNextDueAt(value: unknown, fallback: Date | null): Date | null {
  if (isRecord(value) && typeof value.nextDueAt === "string") {
    const nextDueAt = new Date(value.nextDueAt);
    if (!Number.isNaN(nextDueAt.getTime())) {
      return nextDueAt;
    }
  }
  return fallback;
}

function getPollBlockedReason(value: unknown): string | null {
  if (!isRecord(value) || value.status !== "blocked") {
    return null;
  }
  return typeof value.reason === "string" ? value.reason : "Poll evaluator blocked";
}

function buildPollCode(params: {
  definition: AutomationDefinitionLike;
  trigger: PollTrigger;
  triggerIndex: number;
  nowIso: string;
  state: Record<string, unknown>;
}) {
  return [
    `const automation = ${JSON.stringify({
      id: params.definition.id,
      name: params.definition.name,
      scope: params.definition.scope,
    })};`,
    `const trigger = ${JSON.stringify({
      index: params.triggerIndex,
      schedule: params.trigger.schedule,
    })};`,
    `const state = ${JSON.stringify(params.state)};`,
    `const now = ${JSON.stringify(params.nowIso)};`,
    params.trigger.evaluator.code,
  ].join("\n");
}

function toPollEventInputs(params: {
  value: unknown;
  definition: AutomationDefinitionLike;
  stateKey: string;
  trigger: PollTrigger;
  triggerIndex: number;
  nowIso: string;
  metadataStepId: string;
  automationId: string;
}): Array<Record<string, unknown>> {
  if (isRecord(params.value) && Array.isArray(params.value.events)) {
    return params.value.events.filter(isRecord).map((event, index) => ({
      source: typeof event.source === "string" ? event.source : "poll",
      type: typeof event.type === "string" ? event.type : "automation.poll.event",
      scope: isRecord(event.scope) ? event.scope : toEventScope(params.definition),
      subject: isRecord(event.subject)
        ? event.subject
        : { kind: "poll", id: params.stateKey },
      actor: isRecord(event.actor)
        ? event.actor
        : { kind: "system", id: "automation-scheduler" },
      occurredAt:
        typeof event.occurredAt === "string" ? event.occurredAt : params.nowIso,
      dedupeKey:
        typeof event.dedupeKey === "string"
          ? event.dedupeKey
          : `${params.stateKey}:${params.nowIso}:${params.metadataStepId}:${index}`,
      correlationKey:
        typeof event.correlationKey === "string"
          ? event.correlationKey
          : `${params.automationId}:${params.triggerIndex}`,
      trust:
        event.trust === "partner" || event.trust === "public"
          ? event.trust
          : "internal",
      connectorId:
        typeof event.connectorId === "string" ? event.connectorId : undefined,
      installationId:
        typeof event.installationId === "string" ? event.installationId : undefined,
      payload: event.payload ?? {},
      rawPayloadRef:
        typeof event.rawPayloadRef === "string" ? event.rawPayloadRef : undefined,
      links: Array.isArray(event.links) ? event.links : undefined,
    }));
  }

  return [
    {
      source: "schedule",
      type: "automation.poll.due",
      scope: toEventScope(params.definition),
      subject: {
        kind: "poll",
        id: params.stateKey,
      },
      actor: {
        kind: "system",
        id: "automation-scheduler",
      },
      occurredAt: params.nowIso,
      dedupeKey: `${params.stateKey}:${params.nowIso}:${params.metadataStepId}`,
      correlationKey: `${params.automationId}:${params.triggerIndex}`,
      trust: "internal",
      payload: {
        scheduledAt: params.nowIso,
        triggerIndex: params.triggerIndex,
        schedule: params.trigger.schedule,
        result: getPollPayload(params.value),
      },
    },
  ];
}

async function emitDueScheduleEventsStep(nowIso: string): Promise<SchedulerEmission> {
  "use step";
  const {
    emitAutomationEvent,
    getAutomationsWithDueSchedules,
    recordScheduleTick,
  } = await import("@/lib/automation/store");
  const metadata = getStepMetadata();
  const now = new Date(nowIso);
  const due = await getAutomationsWithDueSchedules(now);
  const eventIds: string[] = [];
  let skippedPolls = 0;
  let blockedPolls = 0;

  for (const item of due) {
    if (item.trigger.kind !== "schedule" && item.trigger.kind !== "poll") {
      continue;
    }
    const trigger = item.trigger;
    const stateKey = `${item.automation.id}:trigger:${item.triggerIndex}`;
    let payload: unknown = {
      scheduledAt: nowIso,
      triggerIndex: item.triggerIndex,
      schedule: trigger.schedule,
    };
    let shouldEmit = true;
    let nextDueAt = item.nextDueAt;
    let pollState: Record<string, unknown> | undefined;
    let pollBlockedReason: string | null = null;
    let pollEventInputs: Array<Record<string, unknown>> | null = null;

    if (trigger.kind === "poll") {
      const { createOpenAgentsExecutorRuntime } = await import(
        "@/lib/executor/runtime"
      );
      const executor = await createOpenAgentsExecutorRuntime({
        userId: resolveIdentityUserId(item.definition),
        automationId: item.automation.id,
        automationName: item.automation.name,
        executorToolPatterns: item.definition.policy.executorTools,
      });
      const pollResult = await executor.execute(
        buildPollCode({
          definition: item.definition,
          trigger,
          triggerIndex: item.triggerIndex,
          nowIso,
          state: isRecord(item.state.pollState) ? item.state.pollState : {},
        }),
      );
      if (pollResult.isError) {
        throw new Error(pollResult.text || "Poll evaluator failed");
      }
      const value = extractPollResult(pollResult);
      shouldEmit = shouldEmitPollEvent(value);
      nextDueAt = getPollNextDueAt(value, item.nextDueAt);
      pollState = getPollState(value, item.state);
      pollBlockedReason = getPollBlockedReason(value);
      pollEventInputs = shouldEmit
        ? toPollEventInputs({
            value,
            definition: item.definition,
            stateKey,
            trigger,
            triggerIndex: item.triggerIndex,
            nowIso,
            metadataStepId: metadata.stepId,
            automationId: item.automation.id,
          })
        : null;
      payload = {
        scheduledAt: nowIso,
        triggerIndex: item.triggerIndex,
        schedule: trigger.schedule,
        result: getPollPayload(value),
      };
    }

    let emittedEventId: string | undefined;
    if (pollBlockedReason) {
      blockedPolls += 1;
    } else if (shouldEmit) {
      const eventInputs =
        pollEventInputs ??
        [
          {
            source: "schedule",
            type:
              trigger.kind === "poll"
                ? "automation.poll.due"
                : "automation.schedule.due",
            scope: toEventScope(item.definition),
            subject: {
              kind: trigger.kind === "poll" ? "poll" : "schedule",
              id: stateKey,
            },
            actor: {
              kind: "system",
              id: "automation-scheduler",
            },
            occurredAt: nowIso,
            dedupeKey: `${stateKey}:${nowIso}:${metadata.stepId}`,
            correlationKey: `${item.automation.id}:${item.triggerIndex}`,
            trust: "internal",
            payload,
          },
        ];
      for (const eventInput of eventInputs) {
        const result = await emitAutomationEvent({
          source:
            typeof eventInput.source === "string" ? eventInput.source : "schedule",
          type:
            typeof eventInput.type === "string"
              ? eventInput.type
              : "automation.schedule.due",
          scope: isRecord(eventInput.scope)
            ? (eventInput.scope as { kind: EventScope["kind"]; id: string })
            : toEventScope(item.definition),
          subject: isRecord(eventInput.subject)
            ? (eventInput.subject as { kind: string; id: string })
            : {
                kind: trigger.kind === "poll" ? "poll" : "schedule",
                id: stateKey,
              },
          actor: isRecord(eventInput.actor)
            ? eventInput.actor
            : {
                kind: "system",
                id: "automation-scheduler",
              },
          occurredAt:
            typeof eventInput.occurredAt === "string"
              ? eventInput.occurredAt
              : nowIso,
          dedupeKey:
            typeof eventInput.dedupeKey === "string"
              ? eventInput.dedupeKey
              : `${stateKey}:${nowIso}:${metadata.stepId}`,
          correlationKey:
            typeof eventInput.correlationKey === "string"
              ? eventInput.correlationKey
              : `${item.automation.id}:${item.triggerIndex}`,
          trust:
            eventInput.trust === "partner" || eventInput.trust === "public"
              ? eventInput.trust
              : "internal",
          connectorId:
            typeof eventInput.connectorId === "string"
              ? eventInput.connectorId
              : undefined,
          installationId:
            typeof eventInput.installationId === "string"
              ? eventInput.installationId
              : undefined,
          payload: eventInput.payload ?? payload,
          rawPayloadRef:
            typeof eventInput.rawPayloadRef === "string"
              ? eventInput.rawPayloadRef
              : undefined,
          links: Array.isArray(eventInput.links)
            ? (eventInput.links as Array<{ label: string; url: string }>)
            : undefined,
        });
        emittedEventId = result.event.id;
        eventIds.push(result.event.id);
      }
    } else {
      skippedPolls += 1;
    }

    await recordScheduleTick({
      automationId: item.automation.id,
      triggerIndex: item.triggerIndex,
      nextDueAt,
      emittedEventId,
      state: {
        ...(pollState ? { pollState } : {}),
        ...(pollBlockedReason ? { blockedReason: pollBlockedReason } : {}),
        lastStatus: pollBlockedReason
          ? "blocked"
          : shouldEmit
          ? "emit"
          : "skip",
      },
    });
  }

  return {
    eventIds,
    checked: due.length,
    emitted: eventIds.length,
    skippedPolls,
    blockedPolls,
  };
}

emitDueScheduleEventsStep.maxRetries = 3;

async function startRouterRunsStep(eventIds: string[]) {
  "use step";
  const runs = await Promise.all(
    eventIds.map((eventId) => start(automationRouterWorkflow, [eventId])),
  );
  return runs.map((run) => run.runId);
}

startRouterRunsStep.maxRetries = 3;

export async function automationSchedulerWorkflow(nowIso = new Date().toISOString()) {
  "use workflow";

  const emission = await emitDueScheduleEventsStep(nowIso);
  const routerRunIds = await startRouterRunsStep(emission.eventIds);

  return {
    ...emission,
    routerRunIds,
  };
}
