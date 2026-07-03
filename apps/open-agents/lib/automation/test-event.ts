import type {
  AutomationDefinition,
  AutomationEventInput,
} from "./types";

type JsonRecord = Record<string, unknown>;

type BuildAutomationTestEventInputOptions = {
  automationId: string;
  userId: string;
  definition: AutomationDefinition;
  body?: unknown;
  now?: Date;
  dedupePrefix?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readRecord(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function toEventScope(scope: AutomationDefinition["scope"]): AutomationEventInput["scope"] {
  return {
    kind: scope.kind,
    id: scope.id,
  };
}

function materializeTriggerType(type: string): string {
  if (type === "*") {
    return "automation.manual.test";
  }
  if (type.endsWith(".*")) {
    return `${type.slice(0, -1)}test`;
  }
  return type;
}

function getDefaultEventTrigger(definition: AutomationDefinition) {
  return definition.triggers.find((trigger) => trigger.kind === "event");
}

function readScopeFromBody(body: JsonRecord | undefined): AutomationEventInput["scope"] | undefined {
  const scope = body ? readRecord(body, "scope") : undefined;
  const kind = scope ? readString(scope, "kind") : undefined;
  const id = scope ? readString(scope, "id") : undefined;
  return (kind === "user" || kind === "group" || kind === "org") && id
    ? {
        kind,
        id,
      }
    : undefined;
}

function readSubjectFromBody(
  body: JsonRecord | undefined,
  automationId: string,
) {
  const subject = body ? readRecord(body, "subject") : undefined;
  const repo = subject ? readRecord(subject, "repo") : undefined;
  return {
    kind:
      (subject ? readString(subject, "kind") : undefined) ??
      (body ? readString(body, "subjectKind") : undefined) ??
      "automation",
    id:
      (subject ? readString(subject, "id") : undefined) ??
      (body ? readString(body, "subjectId") : undefined) ??
      automationId,
    url: subject ? readString(subject, "url") : undefined,
    repo:
      repo &&
      readString(repo, "provider") === "github" &&
      readString(repo, "owner") &&
      readString(repo, "name")
        ? {
            provider: "github" as const,
            owner: readString(repo, "owner") ?? "",
            name: readString(repo, "name") ?? "",
          }
        : undefined,
  };
}

function readPayload(body: JsonRecord | undefined): unknown {
  if (!body) {
    return { note: "Manual test event" };
  }
  return body.payload ?? body;
}

function readActor(body: JsonRecord | undefined, userId: string): JsonRecord {
  return isRecord(body?.actor) ? body.actor : { kind: "user", id: userId };
}

export function buildAutomationTestEventInput({
  automationId,
  userId,
  definition,
  body,
  now = new Date(),
  dedupePrefix = "manual",
}: BuildAutomationTestEventInputOptions): AutomationEventInput {
  const record = isRecord(body) ? body : undefined;
  const defaultTrigger = getDefaultEventTrigger(definition);
  const defaultSource =
    defaultTrigger?.source && defaultTrigger.source !== "*"
      ? defaultTrigger.source
      : "manual";
  const defaultType = defaultTrigger
    ? materializeTriggerType(defaultTrigger.type)
    : "automation.manual.test";

  return {
    source: record ? readString(record, "source") ?? defaultSource : defaultSource,
    type: record ? readString(record, "type") ?? defaultType : defaultType,
    scope:
      readScopeFromBody(record) ?? toEventScope(definition.scope),
    subject: readSubjectFromBody(record, automationId),
    actor: readActor(record, userId),
    occurredAt: record
      ? readString(record, "occurredAt") ?? now.toISOString()
      : now.toISOString(),
    dedupeKey:
      record?.dedupeKey && typeof record.dedupeKey === "string"
        ? record.dedupeKey
        : `${dedupePrefix}:${automationId}:${now.getTime()}`,
    correlationKey:
      record
        ? readString(record, "correlationKey") ?? `${dedupePrefix}:${automationId}`
        : `${dedupePrefix}:${automationId}`,
    trust:
      record?.trust === "partner" || record?.trust === "public"
        ? record.trust
        : "internal",
    connectorId: record ? readString(record, "connectorId") : undefined,
    installationId: record ? readString(record, "installationId") : undefined,
    payload: readPayload(record),
    rawPayloadRef: record ? readString(record, "rawPayloadRef") : undefined,
    links: Array.isArray(record?.links)
      ? (record.links as AutomationEventInput["links"])
      : undefined,
  };
}
