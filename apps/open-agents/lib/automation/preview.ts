/* oxlint-disable executor/no-try-catch-or-throw -- boundary: dry-run previews validate user-authored trigger and condition expressions without starting workflows */
import type {
  AutomationDefinition,
  AutomationEventInput,
  ConditionDefinition,
  NormalizedAutomationEventInput,
  TriggerDefinition,
} from "./types";
import { parseAutomationEventInput } from "./types";
import {
  blockedBuiltInToolsForAutomationPolicy,
  filterBuiltInToolsForAutomationPolicy,
} from "./policy";

type JsonRecord = Record<string, unknown>;

export type AutomationDryRunPreview = {
  event: NormalizedAutomationEventInput;
  triggerResults: Array<{
    index: number;
    trigger: TriggerDefinition;
    matched: boolean;
    reason: string;
  }>;
  conditionResults: Array<{
    index: number;
    condition: ConditionDefinition;
    passed: boolean | null;
    reason: string;
  }>;
  actionKind: AutomationDefinition["action"]["kind"];
  mountedTools: {
    builtInTools: string[];
    blockedBuiltInTools: string[];
    executorTools: string[];
    autonomy: AutomationDefinition["policy"]["autonomy"];
    memory: AutomationDefinition["policy"]["memory"];
    network?: AutomationDefinition["policy"]["network"];
  };
  policySnapshot: AutomationDefinition["policy"];
  approvalRequired: boolean;
  wouldStart: boolean;
  outcome: "start" | "needs_approval" | "skip";
  reason: string;
};

type PreviewOptions = {
  automationId: string;
  definition: AutomationDefinition;
  event: AutomationEventInput;
  userId?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getEventPath(
  event: NormalizedAutomationEventInput,
  path: string,
): unknown {
  const root: JsonRecord = {
    source: event.source,
    type: event.type,
    scope: event.scope,
    subject: event.subject,
    actor: event.actor,
    trust: event.trust,
    connectorId: event.connectorId,
    installationId: event.installationId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    dedupeKey: event.dedupeKey,
    correlationKey: event.correlationKey,
    payload: event.payload,
    rawPayloadRef: event.rawPayloadRef,
    links: event.links,
  };

  return path.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[part];
  }, root);
}

function wildcardTypeMatches(pattern: string, actual: string): boolean {
  return (
    pattern === "*" ||
    pattern === actual ||
    (pattern.endsWith(".*") && actual.startsWith(pattern.slice(0, -1)))
  );
}

function triggerMatchesPreview(params: {
  automationId: string;
  index: number;
  trigger: TriggerDefinition;
  event: NormalizedAutomationEventInput;
}): { matched: boolean; reason: string } {
  const { trigger, event, automationId, index } = params;
  if (trigger.kind === "event") {
    const sourceMatches =
      !trigger.source || trigger.source === "*" || trigger.source === event.source;
    const typeMatches = wildcardTypeMatches(trigger.type, event.type);
    return {
      matched: sourceMatches && typeMatches,
      reason: sourceMatches && typeMatches
        ? "event source and type match"
        : `expected ${trigger.source ?? "*"}:${trigger.type}, got ${event.source}:${event.type}`,
    };
  }

  if (trigger.kind === "manual") {
    return {
      matched: event.source === "manual",
      reason:
        event.source === "manual"
          ? "manual event"
          : `expected manual source, got ${event.source}`,
    };
  }

  const expectedSubject = `${automationId}:trigger:${index}`;
  if (trigger.kind === "schedule") {
    const matched =
      event.source === "schedule" &&
      event.subject.kind === "schedule" &&
      event.subject.id === expectedSubject;
    return {
      matched,
      reason: matched
        ? "schedule wake event"
        : `expected schedule subject ${expectedSubject}`,
    };
  }

  const matched =
    event.source === "schedule" &&
    event.subject.kind === "poll" &&
    event.subject.id === expectedSubject;
  return {
    matched,
    reason: matched ? "poll wake event" : `expected poll subject ${expectedSubject}`,
  };
}

function fieldConditionMatches(
  actual: unknown,
  op: "eq" | "contains" | "matches" | "in",
  expected: unknown,
): boolean {
  if (op === "eq") {
    return actual === expected;
  }
  if (op === "contains") {
    return String(actual ?? "").includes(String(expected ?? ""));
  }
  if (op === "matches") {
    if (typeof expected !== "string") {
      return false;
    }
    try {
      return new RegExp(expected).test(String(actual ?? ""));
    } catch {
      return false;
    }
  }
  return Array.isArray(expected) && expected.includes(actual);
}

function extractConditionResult(result: {
  structured?: Record<string, unknown>;
  text: string;
}): unknown {
  return result.structured?.result ?? result.structured ?? result.text;
}

function interpretFunctionConditionResult(value: unknown): {
  passed: boolean | null;
  reason: string;
} {
  if (typeof value === "boolean") {
    return {
      passed: value,
      reason: value
        ? "function condition returned true"
        : "function condition returned false",
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      passed: value ? true : false,
      reason: value
        ? "function condition returned a truthy result"
        : "function condition returned an empty result",
    };
  }

  const result = value as { ok?: unknown; reason?: unknown };
  if (result.ok === true) {
    return {
      passed: true,
      reason:
        typeof result.reason === "string"
          ? result.reason
          : "function condition returned ok=true",
    };
  }
  if (result.ok === false) {
    return {
      passed: false,
      reason:
        typeof result.reason === "string"
          ? result.reason
          : "function condition returned ok=false",
    };
  }
  return {
    passed: null,
    reason: "function condition returned an unsupported result",
  };
}

function buildConditionCode(params: {
  automationId: string;
  definition: AutomationDefinition;
  event: NormalizedAutomationEventInput;
  condition: Extract<ConditionDefinition, { kind: "function" }>;
}): string {
  return [
    `const automation = ${JSON.stringify({
      id: params.automationId,
      name: params.definition.name,
      version: params.definition.version,
      scope: params.definition.scope,
    })};`,
    `const event = ${JSON.stringify(params.event)};`,
    `const condition = ${JSON.stringify(params.condition)};`,
    `const now = ${JSON.stringify(new Date().toISOString())};`,
    params.condition.ref.code,
  ].join("\n");
}

async function evaluateFunctionConditionPreview(params: {
  automationId: string;
  userId: string | undefined;
  definition: AutomationDefinition;
  event: NormalizedAutomationEventInput;
  condition: Extract<ConditionDefinition, { kind: "function" }>;
}): Promise<{ passed: boolean | null; reason: string }> {
  if (!params.userId) {
    return {
      passed: null,
      reason: "function condition needs a user identity for dry-run execution",
    };
  }
  const { createOpenAgentsExecutorRuntime } = await import(
    "@/lib/executor/runtime"
  );
  const { Effect } = await import("effect");
  const { ElicitationResponse } = await import("@executor-js/sdk");
  const executor = await createOpenAgentsExecutorRuntime({
    userId: params.userId,
    automationId: params.automationId,
    automationName: params.definition.name,
    executorToolPatterns: params.definition.policy.executorTools,
    onElicitation: () =>
      Effect.succeed(ElicitationResponse.make({ action: "decline" })),
  });
  const result = await executor.execute(buildConditionCode(params));
  if (result.isError) {
    return {
      passed: false,
      reason: result.text
        ? `function condition failed: ${result.text}`
        : "function condition failed",
    };
  }
  return interpretFunctionConditionResult(extractConditionResult(result));
}

async function conditionPreview(
  condition: ConditionDefinition,
  event: NormalizedAutomationEventInput,
  options: {
    automationId: string;
    userId?: string;
    definition: AutomationDefinition;
  },
): Promise<{ passed: boolean | null; reason: string }> {
  if (condition.kind === "field") {
    const actual = getEventPath(event, condition.path);
    const passed = fieldConditionMatches(actual, condition.op, condition.value);
    return {
      passed,
      reason: passed
        ? `${condition.path} ${condition.op} matched`
        : `${condition.path} ${condition.op} did not match`,
    };
  }

  if (condition.kind === "rate-limit") {
    return {
      passed: true,
      reason: `rate limit ${condition.key} would be checked without consuming dry-run capacity`,
    };
  }

  return evaluateFunctionConditionPreview({
    automationId: options.automationId,
    userId: options.userId,
    definition: options.definition,
    event,
    condition,
  });
}

export async function buildAutomationDryRunPreview({
  automationId,
  definition,
  event,
  userId,
}: PreviewOptions): Promise<AutomationDryRunPreview> {
  const normalizedEvent = parseAutomationEventInput(event);
  const triggerResults = definition.triggers.map((trigger, index) => ({
    index,
    trigger,
    ...triggerMatchesPreview({
      automationId,
      index,
      trigger,
      event: normalizedEvent,
    }),
  }));
  const triggerMatched =
    triggerResults.length === 0 ||
    triggerResults.some((result) => result.matched);
  const conditionResults = await Promise.all(
    definition.conditions.map(async (condition, index) => ({
      index,
      condition,
      ...(await conditionPreview(condition, normalizedEvent, {
        automationId,
        userId,
        definition,
      })),
    })),
  );
  const conditionFailed = conditionResults.find(
    (result) => result.passed === false || result.passed === null,
  );
  const approvalRequired = definition.policy.approvals.some(
    (approval) => approval.required,
  );
  const wouldStart = triggerMatched && !conditionFailed;

  return {
    event: normalizedEvent,
    triggerResults,
    conditionResults,
    actionKind: definition.action.kind,
    mountedTools: {
      builtInTools: filterBuiltInToolsForAutomationPolicy(definition.policy),
      blockedBuiltInTools:
        blockedBuiltInToolsForAutomationPolicy(definition.policy),
      executorTools: definition.policy.executorTools,
      autonomy: definition.policy.autonomy,
      memory: definition.policy.memory,
      network: definition.policy.network,
    },
    policySnapshot: definition.policy,
    approvalRequired,
    wouldStart,
    outcome: wouldStart ? (approvalRequired ? "needs_approval" : "start") : "skip",
    reason: !triggerMatched
      ? "No trigger matched this event"
      : conditionFailed
      ? conditionFailed.reason
      : approvalRequired
      ? "Matching run would ask for approval before continuing"
      : "Matching run would start the durable automation workflow",
  };
}
