/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: Drizzle repository functions reject to route/workflow adapters, and transaction callbacks rely on thrown rollback failures */
import "server-only";

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getAgentDefinition, listLocalSkillFilesForPatterns } from "@/lib/agents/repository";
import { db } from "@/lib/db/client";
import { getIsEveChatStreaming } from "@/lib/db/sessions";
import {
  blockedBuiltInToolsForAutomationPolicy,
  filterBuiltInToolsForAutomationPolicy,
} from "./policy";
import {
  automationApprovals,
  automationArtifacts,
  automationCorrelations,
  automationDefinitions,
  automationEvents,
  automationInvocations,
  automationMessageQueue,
  automationOutbox,
  automationRunAttempts,
  automationRuns,
  automationState,
  automationTimelineEvents,
  automationVersions,
  chats,
  type AutomationDefinition as AutomationDefinitionRow,
  type AutomationEvent as AutomationEventRow,
  type AutomationInvocation,
  type AutomationRun,
  type AutomationVersion as AutomationVersionRow,
  type NewAutomationRun,
} from "@/lib/db/schema";
import {
  hashAutomationDefinition,
  parseAutomationDefinition,
  parseAutomationEventInput,
  stableStringify,
  type AutomationAction,
  type AutomationDefinition,
  type AutomationDefinitionInput,
  type AutomationEventInput,
  type AutomationPolicy,
  type ConditionDefinition,
  type TriggerDefinition,
} from "./types";
import { extractAgentSkillPatterns, resolveAgentReference } from "./agent-spec";

type JsonRecord = Record<string, unknown>;

export type AutomationListItem = AutomationDefinitionRow & {
  version: AutomationVersionRow | null;
  lastRun: AutomationRun | null;
  recentRunCounts: {
    succeeded: number;
    failed: number;
    skipped: number;
    blocked: number;
    running: number;
  };
};

export type AutomationRunDetail = AutomationRun & {
  automation: AutomationDefinitionRow | null;
  version: AutomationVersionRow | null;
  invocation: AutomationInvocation | null;
  event: AutomationEventRow | null;
  timeline: Array<typeof automationTimelineEvents.$inferSelect>;
  artifacts: Array<typeof automationArtifacts.$inferSelect>;
  approvals: Array<typeof automationApprovals.$inferSelect>;
  outbox: Array<typeof automationOutbox.$inferSelect>;
};

export type AutomationExecutionContext = {
  run: AutomationRun;
  event: AutomationEventRow;
  automation: AutomationDefinitionRow;
  version: AutomationVersionRow;
  invocation: AutomationInvocation;
  definition: AutomationDefinition;
};

type MatchResult = {
  invocationId: string;
  automationId: string;
  automationVersionId: string;
  status: "matched" | "skipped" | "duplicate" | "blocked";
  reason?: string;
};

function snapshotChecksum(value: unknown): string {
  let left = 5381;
  let right = 52711;
  const text = stableStringify(value);
  const modulo = 4_294_967_296;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = (left * 33 + code) % modulo;
    right = (right * 65_599 + code) % modulo;
  }

  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

async function snapshotAgentProfile(
  label: "automation" | "action",
  agent: AutomationDefinition["agent"],
): Promise<JsonRecord | null> {
  const slug = resolveAgentReference(agent);
  if (!slug) {
    return agent ? { label, spec: agent, resolved: false } : null;
  }

  const resolved = await getAgentDefinition(slug);
  if (!resolved) {
    return { label, spec: agent, slug, resolved: false };
  }

  const snapshot = {
    slug: resolved.slug,
    name: resolved.name,
    description: resolved.description,
    path: resolved.path,
    model: resolved.model,
    tools: resolved.tools,
    repos: resolved.repos,
    skills: resolved.skills,
    systemPrompt: resolved.systemPrompt,
  };

  return {
    label,
    spec: agent,
    slug,
    resolved: true,
    checksum: snapshotChecksum(snapshot),
    snapshot,
  };
}

async function buildSkillSnapshots(patterns: string[]): Promise<JsonRecord[]> {
  if (patterns.length === 0) {
    return [];
  }

  const matched = await listLocalSkillFilesForPatterns(patterns);
  return matched.map(({ skill, files }) => {
    const fileSnapshots = files.map((file) => ({
      relativePath: file.relativePath,
      checksum: snapshotChecksum(file.content),
    }));
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      checksum: snapshotChecksum({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        files: fileSnapshots,
      }),
      files: fileSnapshots,
    };
  });
}

async function buildAgentSnapshot(definition: AutomationDefinition): Promise<JsonRecord> {
  const actionAgent =
    definition.action.kind === "startSession" ||
    definition.action.kind === "messageSession"
      ? definition.action.agent
      : undefined;
  const agentProfiles = (
    await Promise.all([
      snapshotAgentProfile("automation", definition.agent),
      snapshotAgentProfile("action", actionAgent),
    ])
  ).filter((entry): entry is JsonRecord => entry !== null);
  const profileSkills = agentProfiles.flatMap((profile) => {
    const snapshot = isRecord(profile.snapshot) ? profile.snapshot : {};
    const skills = snapshot.skills;
    return Array.isArray(skills)
      ? skills.filter((entry): entry is string => typeof entry === "string")
      : [];
  });
  const skillNames = [
      ...new Set([
      ...extractAgentSkillPatterns(definition.agent),
      ...extractAgentSkillPatterns(actionAgent),
      ...profileSkills,
    ]),
  ];
  let skillSnapshots: JsonRecord[] = [];
  let skillSnapshotError: string | null = null;
  try {
    skillSnapshots = await buildSkillSnapshots(skillNames);
  } catch {
    skillSnapshotError = "Failed to snapshot local skills";
  }

  return {
    automationAgent: definition.agent ?? null,
    actionAgent: actionAgent ?? null,
    agentProfiles,
    skills: skillNames.map((name) => ({ name, source: "agent-profile" })),
    skillSnapshots,
    skillSnapshotError,
    builtInTools: filterBuiltInToolsForAutomationPolicy(definition.policy),
    blockedBuiltInTools: blockedBuiltInToolsForAutomationPolicy(
      definition.policy,
    ),
    executorTools: definition.policy.executorTools,
    policyAutonomy: definition.policy.autonomy,
    memory: definition.policy.memory,
  };
}

type PreparedRun =
  | {
      status: "prepared";
      run: AutomationRun;
      event: AutomationEventRow;
      automation: AutomationDefinitionRow;
      version: AutomationVersionRow;
      definition: AutomationDefinition;
    }
  | {
      status: "skipped" | "blocked";
      run: AutomationRun;
      reason: string;
    };

const ROUTE_STARTED_RUN_STATUSES = [
  "pending",
  "running",
  "needs_review",
] as const;

export function getAutomationApprovalToken(approvalId: string): string {
  return `automation-approval:${approvalId}`;
}

export function getAutomationScheduleStateKey(
  automationId: string,
  triggerIndex: number,
): string {
  return `${automationId}:trigger:${triggerIndex}`;
}

export async function listAutomationsForUser(
  userId: string,
): Promise<AutomationListItem[]> {
  const definitions = await db
    .select()
    .from(automationDefinitions)
    .where(
      or(
        and(
          eq(automationDefinitions.scopeKind, "user"),
          eq(automationDefinitions.scopeId, userId),
        ),
        and(
          eq(automationDefinitions.ownerKind, "user"),
          eq(automationDefinitions.ownerId, userId),
        ),
      ),
    )
    .orderBy(desc(automationDefinitions.updatedAt));

  if (definitions.length === 0) {
    return [];
  }

  const versionIds = definitions
    .map((definition) => definition.currentVersionId)
    .filter((id): id is string => typeof id === "string");
  const automationIds = definitions.map((definition) => definition.id);

  const [versions, lastRuns, runCounts] = await Promise.all([
    versionIds.length
      ? db
          .select()
          .from(automationVersions)
          .where(inArray(automationVersions.id, versionIds))
      : [],
    automationIds.length
      ? db
          .selectDistinctOn([automationRuns.automationId], {
            run: automationRuns,
          })
          .from(automationRuns)
          .where(inArray(automationRuns.automationId, automationIds))
          .orderBy(automationRuns.automationId, desc(automationRuns.createdAt))
      : [],
    automationIds.length
      ? db
          .select({
            automationId: automationRuns.automationId,
            status: automationRuns.status,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(automationRuns)
          .where(inArray(automationRuns.automationId, automationIds))
          .groupBy(automationRuns.automationId, automationRuns.status)
      : [],
  ]);

  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const lastRunsByAutomationId = new Map(
    lastRuns.map(({ run }) => [run.automationId, run]),
  );
  const countsByAutomationId = new Map<
    string,
    AutomationListItem["recentRunCounts"]
  >();

  for (const row of runCounts) {
    const current =
      countsByAutomationId.get(row.automationId) ??
      ({
        succeeded: 0,
        failed: 0,
        skipped: 0,
        blocked: 0,
        running: 0,
      } satisfies AutomationListItem["recentRunCounts"]);

    if (row.status === "succeeded" || row.status === "succeeded_with_findings") {
      current.succeeded += row.count;
    } else if (row.status === "failed" || row.status === "timed_out") {
      current.failed += row.count;
    } else if (row.status === "skipped") {
      current.skipped += row.count;
    } else if (row.status === "blocked" || row.status === "needs_review") {
      current.blocked += row.count;
    } else if (row.status === "running" || row.status === "pending") {
      current.running += row.count;
    }

    countsByAutomationId.set(row.automationId, current);
  }

  return definitions.map((definition) => ({
    ...definition,
    version: definition.currentVersionId
      ? (versionsById.get(definition.currentVersionId) ?? null)
      : null,
    lastRun: lastRunsByAutomationId.get(definition.id) ?? null,
    recentRunCounts:
      countsByAutomationId.get(definition.id) ??
      ({
        succeeded: 0,
        failed: 0,
        skipped: 0,
        blocked: 0,
        running: 0,
      } satisfies AutomationListItem["recentRunCounts"]),
  }));
}

export async function getAutomationForUser(params: {
  automationId: string;
  userId: string;
}) {
  const [definition] = await db
    .select()
    .from(automationDefinitions)
    .where(eq(automationDefinitions.id, params.automationId))
    .limit(1);

  if (!definition || !canReadAutomation(definition, params.userId)) {
    return null;
  }

  const [version, runs, stateRows, correlations] = await Promise.all([
    definition.currentVersionId
      ? db.query.automationVersions.findFirst({
          where: eq(automationVersions.id, definition.currentVersionId),
        })
      : Promise.resolve(null),
    db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, params.automationId))
      .orderBy(desc(automationRuns.createdAt))
      .limit(30),
    db
      .select()
      .from(automationState)
      .where(eq(automationState.automationId, params.automationId)),
    db
      .select()
      .from(automationCorrelations)
      .where(eq(automationCorrelations.automationId, params.automationId))
      .orderBy(desc(automationCorrelations.updatedAt))
      .limit(30),
  ]);

  return {
    automation: definition,
    version: version ?? null,
    runs,
    state: stateRows,
    correlations,
  };
}

export async function getAutomationRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<AutomationRunDetail | null> {
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.id, params.runId))
    .limit(1);
  if (!run) {
    return null;
  }

  const [automation] = await db
    .select()
    .from(automationDefinitions)
    .where(eq(automationDefinitions.id, run.automationId))
    .limit(1);
  if (automation && !canReadAutomation(automation, params.userId)) {
    return null;
  }

  const [version, invocation, timeline, artifacts, approvals, outbox] =
    await Promise.all([
      db.query.automationVersions.findFirst({
        where: eq(automationVersions.id, run.automationVersionId),
      }),
      db.query.automationInvocations.findFirst({
        where: eq(automationInvocations.id, run.invocationId),
      }),
      db
        .select()
        .from(automationTimelineEvents)
        .where(eq(automationTimelineEvents.runId, run.id))
        .orderBy(asc(automationTimelineEvents.timestamp)),
      db
        .select()
        .from(automationArtifacts)
        .where(eq(automationArtifacts.runId, run.id))
        .orderBy(asc(automationArtifacts.createdAt)),
      db
        .select()
        .from(automationApprovals)
        .where(eq(automationApprovals.runId, run.id))
        .orderBy(asc(automationApprovals.requestedAt)),
      db
        .select()
        .from(automationOutbox)
        .where(eq(automationOutbox.runId, run.id))
        .orderBy(asc(automationOutbox.createdAt)),
    ]);

  const event = invocation
    ? await db.query.automationEvents.findFirst({
        where: eq(automationEvents.id, invocation.eventId),
      })
    : null;

  return {
    ...run,
    automation: automation ?? null,
    version: version ?? null,
    invocation: invocation ?? null,
    event: event ?? null,
    timeline,
    artifacts,
    approvals,
    outbox,
  };
}

export async function getAutomationExecutionContext(
  runId: string,
): Promise<AutomationExecutionContext | null> {
  const run = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });
  if (!run) {
    return null;
  }

  const [invocation, automation, version] = await Promise.all([
    db.query.automationInvocations.findFirst({
      where: eq(automationInvocations.id, run.invocationId),
    }),
    db.query.automationDefinitions.findFirst({
      where: eq(automationDefinitions.id, run.automationId),
    }),
    db.query.automationVersions.findFirst({
      where: eq(automationVersions.id, run.automationVersionId),
    }),
  ]);
  if (!invocation || !automation || !version) {
    return null;
  }

  const event = await db.query.automationEvents.findFirst({
    where: eq(automationEvents.id, invocation.eventId),
  });
  if (!event) {
    return null;
  }

  return {
    run,
    event,
    automation,
    version,
    invocation,
    definition: parseAutomationDefinition(version.definitionJson),
  };
}

export async function linkAutomationRunToSessionChat(params: {
  runId: string;
  sessionId: string;
  chatId: string;
}) {
  const [run] = await db
    .update(automationRuns)
    .set({
      sessionId: params.sessionId,
      chatId: params.chatId,
    })
    .where(eq(automationRuns.id, params.runId))
    .returning();

  return run ?? null;
}

export async function upsertAutomationDefinition(params: {
  userId: string;
  definition: AutomationDefinitionInput;
  changeSummary?: string;
}): Promise<{
  automation: AutomationDefinitionRow;
  version: AutomationVersionRow;
}> {
  const parsed = parseAutomationDefinition(params.definition);
  const now = new Date();
  const automationId = parsed.id ?? nanoid();
  const existing = await db.query.automationDefinitions.findFirst({
    where: eq(automationDefinitions.id, automationId),
  });

  if (existing && !canWriteAutomation(existing, params.userId)) {
    throw new Error("Unauthorized automation update");
  }

  const versionNumber = await getNextVersionNumber(automationId);
  const scope =
    parsed.scope.kind === "user"
      ? { kind: "user" as const, id: params.userId }
      : parsed.scope;
  const definition: AutomationDefinition = {
    ...parsed,
    id: automationId,
    version: versionNumber,
    scope,
    owner:
      parsed.owner.kind === "user"
        ? { kind: "user", id: params.userId }
        : parsed.owner,
    identity:
      parsed.identity.kind === "user"
        ? { kind: "user", userId: params.userId }
        : parsed.identity,
  };
  const versionId = nanoid();
  const definitionHash = hashAutomationDefinition(definition);

  return db.transaction(async (tx) => {
    const [automation] = await tx
      .insert(automationDefinitions)
      .values({
        id: automationId,
        currentVersionId: versionId,
        scopeKind: definition.scope.kind,
        scopeId: definition.scope.id,
        ownerKind: definition.owner.kind,
        ownerId: definition.owner.id,
        name: definition.name,
        description: definition.description,
        enabled: definition.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: automationDefinitions.id,
        set: {
          currentVersionId: versionId,
          scopeKind: definition.scope.kind,
          scopeId: definition.scope.id,
          ownerKind: definition.owner.kind,
          ownerId: definition.owner.id,
          name: definition.name,
          description: definition.description,
          enabled: definition.enabled,
          updatedAt: now,
        },
      })
      .returning();

    if (!automation) {
      throw new Error("Failed to save automation definition");
    }

    const [version] = await tx
      .insert(automationVersions)
      .values({
        id: versionId,
        automationId,
        version: versionNumber,
        definitionJson: definition,
        definitionHash,
        createdBy: params.userId,
        changeSummary: params.changeSummary,
      })
      .returning();

    if (!version) {
      throw new Error("Failed to save automation version");
    }

    return { automation, version };
  });
}

async function getNextVersionNumber(automationId: string): Promise<number> {
  const [result] = await db
    .select({ maxVersion: sql<number | null>`MAX(${automationVersions.version})::int` })
    .from(automationVersions)
    .where(eq(automationVersions.automationId, automationId));

  return (result?.maxVersion ?? 0) + 1;
}

function canReadAutomation(
  definition: AutomationDefinitionRow,
  userId: string,
): boolean {
  return (
    (definition.scopeKind === "user" && definition.scopeId === userId) ||
    (definition.ownerKind === "user" && definition.ownerId === userId)
  );
}

function canWriteAutomation(
  definition: AutomationDefinitionRow,
  userId: string,
): boolean {
  return definition.ownerKind === "user" && definition.ownerId === userId;
}

export async function emitAutomationEvent(input: AutomationEventInput): Promise<{
  event: AutomationEventRow;
  inserted: boolean;
}> {
  const parsed = parseAutomationEventInput(input);
  const now = new Date();
  const occurredAt = parsed.occurredAt ? new Date(parsed.occurredAt) : now;
  const receivedAt = parsed.receivedAt ? new Date(parsed.receivedAt) : now;

  const [inserted] = await db
    .insert(automationEvents)
    .values({
      id: parsed.id ?? nanoid(),
      source: parsed.source,
      type: parsed.type,
      version: parsed.version,
      scopeKind: parsed.scope.kind,
      scopeId: parsed.scope.id,
      subjectKind: parsed.subject.kind,
      subjectId: parsed.subject.id,
      subjectUrl: parsed.subject.url,
      repoOwner: parsed.subject.repo?.owner,
      repoName: parsed.subject.repo?.name,
      actorJson: parsed.actor,
      trust: parsed.trust,
      connectorId: parsed.connectorId,
      installationId: parsed.installationId,
      occurredAt,
      receivedAt,
      dedupeKey: parsed.dedupeKey,
      correlationKey: parsed.correlationKey,
      payloadJson: parsed.payload,
      rawPayloadRef: parsed.rawPayloadRef,
      linksJson: parsed.links,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    return { event: inserted, inserted: true };
  }

  const [existing] = await db
    .select()
    .from(automationEvents)
    .where(
      and(
        eq(automationEvents.source, parsed.source),
        eq(automationEvents.scopeKind, parsed.scope.kind),
        eq(automationEvents.scopeId, parsed.scope.id),
        eq(automationEvents.dedupeKey, parsed.dedupeKey),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Failed to read deduplicated automation event");
  }

  return { event: existing, inserted: false };
}

export async function getAutomationEventById(eventId: string) {
  return db.query.automationEvents.findFirst({
    where: eq(automationEvents.id, eventId),
  });
}

export async function matchAutomationsForEvent(
  eventId: string,
): Promise<MatchResult[]> {
  const event = await getAutomationEventById(eventId);
  if (!event) {
    return [];
  }

  const candidates = await getCandidateAutomationsForEvent(event);
  const results: MatchResult[] = [];

  for (const candidate of candidates) {
    if (!candidate.currentVersionId) {
      continue;
    }

    const version = await db.query.automationVersions.findFirst({
      where: eq(automationVersions.id, candidate.currentVersionId),
    });
    if (!version) {
      continue;
    }

    const definition = parseAutomationDefinition(version.definitionJson);
    const triggerMatch = definition.triggers.some((trigger, triggerIndex) =>
      triggerMatchesEvent(trigger, event, candidate.id, triggerIndex),
    );

    if (!triggerMatch) {
      continue;
    }

    const conditionFailure = await evaluatePreRunConditions(
      definition.conditions,
      event,
      definition,
      candidate,
    );
    const status = conditionFailure ? "skipped" : "matched";
    const reason = conditionFailure ?? undefined;

    const [invocation] = await db
      .insert(automationInvocations)
      .values({
        id: nanoid(),
        eventId,
        automationId: candidate.id,
        automationVersionId: version.id,
        status,
        reason,
      })
      .onConflictDoNothing()
      .returning();

    if (invocation) {
      results.push({
        invocationId: invocation.id,
        automationId: candidate.id,
        automationVersionId: version.id,
        status,
        reason,
      });
      continue;
    }

    const existing = await db.query.automationInvocations.findFirst({
      where: and(
        eq(automationInvocations.eventId, eventId),
        eq(automationInvocations.automationId, candidate.id),
        eq(automationInvocations.automationVersionId, version.id),
      ),
    });
    if (existing) {
      results.push({
        invocationId: existing.id,
        automationId: existing.automationId,
        automationVersionId: existing.automationVersionId,
        status: "duplicate",
        reason: "Invocation already exists for this event and automation version",
      });
    }
  }

  return results;
}

async function getCandidateAutomationsForEvent(event: AutomationEventRow) {
  return db
    .select()
    .from(automationDefinitions)
    .where(
      and(
        eq(automationDefinitions.enabled, true),
        eq(automationDefinitions.scopeKind, event.scopeKind),
        eq(automationDefinitions.scopeId, event.scopeId),
      ),
    );
}

function triggerMatchesEvent(
  trigger: TriggerDefinition,
  event: AutomationEventRow,
  automationId: string,
  triggerIndex: number,
): boolean {
  if (trigger.kind === "event") {
    const sourceMatches =
      !trigger.source || trigger.source === "*" || trigger.source === event.source;
    const typeMatches =
      trigger.type === "*" ||
      trigger.type === event.type ||
      (trigger.type.endsWith(".*") &&
        event.type.startsWith(trigger.type.slice(0, -1)));
    return sourceMatches && typeMatches;
  }

  if (trigger.kind === "schedule") {
    return (
      event.source === "schedule" &&
      event.subjectKind === "schedule" &&
      event.subjectId === getAutomationScheduleStateKey(automationId, triggerIndex)
    );
  }

  if (trigger.kind === "poll") {
    return (
      event.source === "schedule" &&
      event.subjectKind === "poll" &&
      event.subjectId === getAutomationScheduleStateKey(automationId, triggerIndex)
    );
  }

  return event.source === "manual";
}

async function evaluatePreRunConditions(
  conditions: ConditionDefinition[],
  event: AutomationEventRow,
  definition: AutomationDefinition,
  automation: AutomationDefinitionRow,
): Promise<string | null> {
  for (const condition of conditions) {
    if (condition.kind === "field") {
      const actual = getEventPath(event, condition.path);
      if (!fieldConditionMatches(actual, condition.op, condition.value)) {
        return `Condition ${condition.path} ${condition.op} did not match`;
      }
      continue;
    }

    if (condition.kind === "function") {
      const functionFailure = await evaluateFunctionCondition({
        condition,
        definition,
        automation,
        event,
      });
      if (functionFailure) {
        return functionFailure;
      }
    }
  }

  return null;
}

function resolveConditionIdentityUserId(definition: AutomationDefinition): string {
  if (definition.identity.kind === "user") {
    return definition.identity.userId;
  }
  if (definition.owner.kind === "user") {
    return definition.owner.id;
  }
  return "automation-bot";
}

function eventRowToJson(event: AutomationEventRow): JsonRecord {
  return {
    id: event.id,
    source: event.source,
    type: event.type,
    version: event.version,
    scope: { kind: event.scopeKind, id: event.scopeId },
    subject: {
      kind: event.subjectKind,
      id: event.subjectId,
      url: event.subjectUrl,
      repo: event.repoOwner
        ? { provider: "github", owner: event.repoOwner, name: event.repoName }
        : undefined,
    },
    actor: event.actorJson,
    trust: event.trust,
    connectorId: event.connectorId,
    installationId: event.installationId,
    occurredAt: event.occurredAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    dedupeKey: event.dedupeKey,
    correlationKey: event.correlationKey,
    payload: event.payloadJson,
    links: event.linksJson,
  };
}

function buildConditionCode(params: {
  condition: Extract<ConditionDefinition, { kind: "function" }>;
  definition: AutomationDefinition;
  automation: AutomationDefinitionRow;
  event: AutomationEventRow;
}): string {
  return [
    `const automation = ${JSON.stringify({
      id: params.automation.id,
      name: params.automation.name,
      version: params.definition.version,
      scope: params.definition.scope,
    })};`,
    `const event = ${JSON.stringify(eventRowToJson(params.event))};`,
    `const condition = ${JSON.stringify(params.condition)};`,
    `const now = ${JSON.stringify(new Date().toISOString())};`,
    params.condition.ref.code,
  ].join("\n");
}

function extractConditionResult(result: {
  structured?: Record<string, unknown>;
  text: string;
}): unknown {
  return result.structured?.result ?? result.structured ?? result.text;
}

function interpretConditionResult(value: unknown): string | null {
  if (typeof value === "boolean") {
    return value ? null : "Condition function returned false";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value ? null : "Condition function returned an empty result";
  }

  const result = value as { ok?: unknown; reason?: unknown };
  if (result.ok === false) {
    return typeof result.reason === "string"
      ? result.reason
      : "Condition function returned ok=false";
  }
  if (result.ok === true) {
    return null;
  }
  return "Condition function returned an unsupported result";
}

async function evaluateFunctionCondition(params: {
  condition: Extract<ConditionDefinition, { kind: "function" }>;
  definition: AutomationDefinition;
  automation: AutomationDefinitionRow;
  event: AutomationEventRow;
}): Promise<string | null> {
  const { createOpenAgentsExecutorRuntime } = await import(
    "@/lib/executor/runtime"
  );
  const { Effect } = await import("effect");
  const { ElicitationResponse } = await import("@executor-js/sdk");
  const executor = await createOpenAgentsExecutorRuntime({
    userId: resolveConditionIdentityUserId(params.definition),
    automationId: params.automation.id,
    automationName: params.automation.name,
    executorToolPatterns: params.definition.policy.executorTools,
    onElicitation: () =>
      Effect.succeed(ElicitationResponse.make({ action: "decline" })),
  });
  const result = await executor.execute(buildConditionCode(params));
  if (result.isError) {
    return result.text
      ? `Condition function failed: ${result.text}`
      : "Condition function failed";
  }
  return interpretConditionResult(extractConditionResult(result));
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
  if (op === "in") {
    return Array.isArray(expected) && expected.includes(actual);
  }
  return false;
}

function getEventPath(event: AutomationEventRow, path: string): unknown {
  const root: JsonRecord = {
    source: event.source,
    type: event.type,
    scope: { kind: event.scopeKind, id: event.scopeId },
    subject: {
      kind: event.subjectKind,
      id: event.subjectId,
      url: event.subjectUrl,
      repo: event.repoOwner
        ? { provider: "github", owner: event.repoOwner, name: event.repoName }
        : undefined,
    },
    trust: event.trust,
    correlationKey: event.correlationKey,
    payload: event.payloadJson,
  };

  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return (current as JsonRecord)[part];
  }, root);
}

export async function prepareAutomationRun(params: {
  invocationId: string;
  eveSessionId: string;
}): Promise<PreparedRun> {
  const invocation = await db.query.automationInvocations.findFirst({
    where: eq(automationInvocations.id, params.invocationId),
  });
  if (!invocation) {
    throw new Error("Automation invocation not found");
  }

  const [event, automation, version] = await Promise.all([
    db.query.automationEvents.findFirst({
      where: eq(automationEvents.id, invocation.eventId),
    }),
    db.query.automationDefinitions.findFirst({
      where: eq(automationDefinitions.id, invocation.automationId),
    }),
    db.query.automationVersions.findFirst({
      where: eq(automationVersions.id, invocation.automationVersionId),
    }),
  ]);

  if (!event || !automation || !version) {
    throw new Error("Automation invocation references missing rows");
  }

  const definition = parseAutomationDefinition(version.definitionJson);
  const existingRun = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.invocationId, invocation.id),
  });

  if (existingRun) {
    return {
      status:
        existingRun.status === "skipped" || existingRun.status === "blocked"
          ? existingRun.status
          : "prepared",
      run: existingRun,
      event,
      automation,
      version,
      definition,
      reason: existingRun.lastError ?? invocation.reason ?? "already prepared",
    } as PreparedRun;
  }

  if (invocation.status !== "matched") {
    const run = await createRun({
      invocation,
      event,
      definition,
      eveSessionId: params.eveSessionId,
      status: invocation.status === "blocked" ? "blocked" : "skipped",
      lastError: invocation.reason ?? `Invocation ${invocation.status}`,
    });
    return {
      status: run.status === "blocked" ? "blocked" : "skipped",
      run,
      reason: run.lastError ?? "Invocation did not match",
    };
  }

  const rateLimitFailure = await evaluateRateLimitConditions(
    definition,
    event,
  );
  if (rateLimitFailure) {
    const run = await createRun({
      invocation,
      event,
      definition,
      eveSessionId: params.eveSessionId,
      status: "skipped",
      lastError: rateLimitFailure,
    });
    return { status: "skipped", run, reason: rateLimitFailure };
  }

  const concurrencyFailure = await evaluateConcurrencyPolicy(definition, event);
  if (concurrencyFailure) {
    const run = await createRun({
      invocation,
      event,
      definition,
      eveSessionId: params.eveSessionId,
      status: concurrencyFailure.status,
      lastError: concurrencyFailure.reason,
    });
    return {
      status: concurrencyFailure.status === "blocked" ? "blocked" : "skipped",
      run,
      reason: concurrencyFailure.reason,
    };
  }

  const run = await createRun({
    invocation,
    event,
    definition,
    eveSessionId: params.eveSessionId,
    status: "running",
  });

  await db.insert(automationRunAttempts).values({
    id: nanoid(),
    runId: run.id,
    attemptNumber: 1,
    status: "running",
    startedAt: new Date(),
  });

  await appendAutomationTimeline({
    runId: run.id,
    type: "automation.run.started",
    visibility: "router",
    payload: {
      automationId: automation.id,
      automationVersionId: version.id,
      eventId: event.id,
    },
  });

  return { status: "prepared", run, event, automation, version, definition };
}

async function createRun(params: {
  invocation: AutomationInvocation;
  event: AutomationEventRow;
  definition: AutomationDefinition;
  eveSessionId: string;
  status: NewAutomationRun["status"];
  lastError?: string;
}) {
  const now = new Date();
  const correlationKey = resolveCorrelationKey(params.definition, params.event);
  const agentSnapshot = await buildAgentSnapshot(params.definition);
  const [run] = await db
    .insert(automationRuns)
    .values({
      id: nanoid(),
      invocationId: params.invocation.id,
      automationId: params.invocation.automationId,
      automationVersionId: params.invocation.automationVersionId,
      eveSessionId: params.eveSessionId,
      correlationKey,
      status: params.status,
      policySnapshotJson: params.definition.policy,
      agentSnapshotJson: agentSnapshot,
      startedAt:
        params.status === "running" ||
        params.status === "blocked" ||
        params.status === "skipped"
          ? now
          : null,
      finishedAt:
        params.status === "blocked" || params.status === "skipped" ? now : null,
      lastError: params.lastError,
    })
    .returning();

  if (!run) {
    throw new Error("Failed to create automation run");
  }

  return run;
}

function resolveCorrelationKey(
  definition: AutomationDefinition,
  event: AutomationEventRow,
): string | null {
  const action = definition.action;
  if (definition.correlation.key === "none") {
    return null;
  }
  if (definition.correlation.key === "event") {
    return event.id;
  }
  if (definition.correlation.key === "subject") {
    return `${event.subjectKind}:${event.subjectId}`;
  }
  if (event.correlationKey) {
    return event.correlationKey;
  }
  if (action.kind === "messageSession" && action.correlation === "event") {
    return event.id;
  }
  return `${event.subjectKind}:${event.subjectId}`;
}

async function evaluateRateLimitConditions(
  definition: AutomationDefinition,
  event: AutomationEventRow,
): Promise<string | null> {
  const rateLimitConditions = definition.conditions.filter(
    (condition): condition is Extract<ConditionDefinition, { kind: "rate-limit" }> =>
      condition.kind === "rate-limit",
  );
  const policyRateLimit = definition.policy.rateLimit;
  const checks = [
    ...rateLimitConditions.map((condition) => ({
      key: condition.key,
      max: condition.max,
      windowMs: condition.windowMs,
    })),
    ...(policyRateLimit
      ? [
          {
            key:
              policyRateLimit.key ??
              resolveCorrelationKey(definition, event) ??
              definition.id ??
              "automation",
            max: policyRateLimit.max,
            windowMs: policyRateLimit.windowMs,
          },
        ]
      : []),
  ];

  for (const check of checks) {
    const limited = await consumeRateLimit({
      automationId: definition.id ?? "",
      key: check.key,
      max: check.max,
      windowMs: check.windowMs,
    });
    if (limited) {
      return `Rate limit exceeded for ${check.key}`;
    }
  }

  return null;
}

async function consumeRateLimit(params: {
  automationId: string;
  key: string;
  max: number;
  windowMs: number;
}): Promise<boolean> {
  if (!params.automationId) {
    return false;
  }

  const now = Date.now();
  const stateKey = `rate:${params.key}`;
  return db.transaction(async (tx) => {
    const existing = await tx.query.automationState.findFirst({
      where: and(
        eq(automationState.automationId, params.automationId),
        eq(automationState.scope, "automation"),
        eq(automationState.key, stateKey),
      ),
    });

    const current = isRecord(existing?.stateJson)
      ? (existing.stateJson as { windowStart?: unknown; count?: unknown })
      : {};
    const windowStart =
      typeof current.windowStart === "number" ? current.windowStart : now;
    const count = typeof current.count === "number" ? current.count : 0;
    const inWindow = now - windowStart < params.windowMs;
    const nextWindowStart = inWindow ? windowStart : now;
    const nextCount = inWindow ? count + 1 : 1;

    if (nextCount > params.max) {
      return true;
    }

    await tx
      .insert(automationState)
      .values({
        automationId: params.automationId,
        scope: "automation",
        key: stateKey,
        stateJson: {
          windowStart: nextWindowStart,
          count: nextCount,
        },
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [automationState.automationId, automationState.scope, automationState.key],
        set: {
          stateJson: {
            windowStart: nextWindowStart,
            count: nextCount,
          },
          updatedAt: new Date(),
        },
      });

    return false;
  });
}

async function evaluateConcurrencyPolicy(
  definition: AutomationDefinition,
  event: AutomationEventRow,
): Promise<{ status: "skipped" | "blocked"; reason: string } | null> {
  const key = resolveConcurrencyKey(definition, event);
  if (!key) {
    return null;
  }

  const [existing] = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, definition.id ?? ""),
        eq(automationRuns.correlationKey, key),
        inArray(automationRuns.status, ROUTE_STARTED_RUN_STATUSES),
      ),
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  if (definition.concurrency.onConflict === "skip") {
    return { status: "skipped", reason: `Run already active for ${key}` };
  }

  if (definition.concurrency.onConflict === "cancel-older") {
    await db
      .update(automationRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        lastError: "Cancelled by newer automation run",
      })
      .where(eq(automationRuns.id, existing.id));
    return null;
  }

  if (definition.concurrency.onConflict === "coalesce") {
    return { status: "skipped", reason: `Coalesced into active run ${existing.id}` };
  }

  return null;
}

function resolveConcurrencyKey(
  definition: AutomationDefinition,
  event: AutomationEventRow,
): string | null {
  if (definition.concurrency.key === "event") {
    return event.id;
  }
  if (definition.concurrency.key === "subject") {
    return `${event.subjectKind}:${event.subjectId}`;
  }
  if (definition.concurrency.key === "correlation") {
    return resolveCorrelationKey(definition, event);
  }
  return resolveCorrelationKey(definition, event);
}

export async function createAutomationApproval(params: {
  approvalId?: string;
  runId: string;
  kind: string;
  request: JsonRecord;
  hookToken?: string;
}) {
  const approvalId = params.approvalId ?? nanoid();
  const hookToken = params.hookToken ?? getAutomationApprovalToken(approvalId);
  const [approval] = await db
    .insert(automationApprovals)
    .values({
      id: approvalId,
      runId: params.runId,
      kind: params.kind,
      status: "requested",
      requestJson: params.request,
      workflowHookToken: hookToken,
    })
    .returning();

  if (!approval) {
    throw new Error("Failed to create automation approval");
  }

  await db
    .update(automationRuns)
    .set({ status: "needs_review" })
    .where(eq(automationRuns.id, params.runId));

  await appendAutomationTimeline({
    runId: params.runId,
    type: "automation.approval.requested",
    visibility: "user",
    payload: {
      approvalId: approval.id,
      kind: params.kind,
      request: params.request,
    },
  });

  return approval;
}

export async function getAutomationApprovalForUser(params: {
  approvalId: string;
  userId: string;
}) {
  const approval = await db.query.automationApprovals.findFirst({
    where: eq(automationApprovals.id, params.approvalId),
  });
  if (!approval) {
    return null;
  }

  const run = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, approval.runId),
  });
  if (!run) {
    return null;
  }

  const automation = await db.query.automationDefinitions.findFirst({
    where: eq(automationDefinitions.id, run.automationId),
  });
  if (!automation || !canReadAutomation(automation, params.userId)) {
    return null;
  }

  return { approval, run, automation };
}

export async function recordAutomationApprovalDecision(params: {
  approvalId: string;
  approved: boolean;
  decidedBy: string;
  decision: JsonRecord;
}) {
  const now = new Date();
  const [approval] = await db
    .update(automationApprovals)
    .set({
      status: params.approved ? "approved" : "denied",
      decisionJson: params.decision,
      decidedAt: now,
      decidedBy: params.decidedBy,
    })
    .where(eq(automationApprovals.id, params.approvalId))
    .returning();

  if (approval) {
    await appendAutomationTimeline({
      runId: approval.runId,
      type: "automation.approval.decided",
      visibility: "user",
      payload: {
        approvalId: approval.id,
        approved: params.approved,
        decidedBy: params.decidedBy,
      },
    });
  }

  return approval ?? null;
}

export async function expireAutomationApproval(params: {
  approvalId: string;
  reason: string;
}) {
  const [approval] = await db
    .update(automationApprovals)
    .set({
      status: "expired",
      decidedAt: new Date(),
      decisionJson: { reason: params.reason },
    })
    .where(
      and(
        eq(automationApprovals.id, params.approvalId),
        eq(automationApprovals.status, "requested"),
      ),
    )
    .returning();

  if (approval) {
    await appendAutomationTimeline({
      runId: approval.runId,
      type: "automation.approval.expired",
      visibility: "user",
      payload: {
        approvalId: approval.id,
        reason: params.reason,
      },
    });
  }

  return approval ?? null;
}

export async function finalizeAutomationRun(params: {
  runId: string;
  status: AutomationRun["status"];
  result?: unknown;
  error?: string;
}) {
  const now = new Date();
  const [run] = await db
    .update(automationRuns)
    .set({
      status: params.status,
      finishedAt: now,
      lastError: params.error,
    })
    .where(eq(automationRuns.id, params.runId))
    .returning();

  await db
    .update(automationRunAttempts)
    .set({
      status: params.status,
      finishedAt: now,
      errorJson: params.error ? { message: params.error } : undefined,
    })
    .where(
      and(
        eq(automationRunAttempts.runId, params.runId),
        isNull(automationRunAttempts.finishedAt),
      ),
    );

  await appendAutomationTimeline({
    runId: params.runId,
    type:
      params.status === "failed"
        ? "automation.run.failed"
        : "automation.run.finished",
    visibility: "router",
    payload: {
      status: params.status,
      result: params.result,
      error: params.error,
    },
  });

  if (
    run &&
    (params.status === "succeeded" || params.status === "succeeded_with_findings")
  ) {
    await db
      .update(automationState)
      .set({
        lastSuccessfulRunId: params.runId,
        updatedAt: now,
      })
      .where(eq(automationState.automationId, run.automationId));
  }

  return run ?? null;
}

export async function markAutomationRunRunning(runId: string) {
  const [run] = await db
    .update(automationRuns)
    .set({
      status: "running",
      lastError: null,
    })
    .where(eq(automationRuns.id, runId))
    .returning();

  if (run) {
    await appendAutomationTimeline({
      runId,
      type: "automation.run.resumed",
      visibility: "router",
      payload: { status: "running" },
    });
  }

  return run ?? null;
}

export async function appendAutomationTimeline(params: {
  runId: string;
  type: string;
  payload: unknown;
  visibility?: "trace" | "router" | "user";
}) {
  await db.insert(automationTimelineEvents).values({
    id: nanoid(),
    runId: params.runId,
    type: params.type,
    payloadJson: params.payload,
    visibility: params.visibility ?? "trace",
  });
}

export async function createAutomationArtifact(params: {
  runId: string;
  name: string;
  kind: string;
  data: unknown;
  schema?: unknown;
}) {
  const [artifact] = await db
    .insert(automationArtifacts)
    .values({
      id: nanoid(),
      runId: params.runId,
      name: params.name,
      kind: params.kind,
      schemaJson: params.schema,
      dataJson: params.data,
    })
    .returning();

  return artifact ?? null;
}

export async function createAutomationOutbox(params: {
  runId?: string | null;
  destination: string;
  payload: unknown;
  status?: "pending" | "sent" | "failed" | "cancelled";
  lastError?: string;
}) {
  const [row] = await db
    .insert(automationOutbox)
    .values({
      id: nanoid(),
      runId: params.runId ?? null,
      destination: params.destination,
      payloadJson: params.payload,
      status: params.status ?? "pending",
      attempts: params.status === "sent" ? 1 : 0,
      lastError: params.lastError,
    })
    .returning();

  return row ?? null;
}

export async function upsertAutomationCorrelation(params: {
  automationId: string;
  correlationKey: string;
  subjectKind: string;
  subjectId: string;
  sessionId?: string | null;
  chatId?: string | null;
  externalThreadId?: string | null;
  state?: unknown;
}) {
  const [correlation] = await db
    .insert(automationCorrelations)
    .values({
      automationId: params.automationId,
      correlationKey: params.correlationKey,
      subjectKind: params.subjectKind,
      subjectId: params.subjectId,
      sessionId: params.sessionId ?? null,
      chatId: params.chatId ?? null,
      externalThreadId: params.externalThreadId ?? null,
      stateJson: params.state ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        automationCorrelations.automationId,
        automationCorrelations.correlationKey,
      ],
      set: {
        sessionId: params.sessionId ?? null,
        chatId: params.chatId ?? null,
        externalThreadId: params.externalThreadId ?? null,
        stateJson: params.state ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();

  return correlation ?? null;
}

export async function getAutomationCorrelation(params: {
  automationId: string;
  correlationKey: string;
}) {
  return db.query.automationCorrelations.findFirst({
    where: and(
      eq(automationCorrelations.automationId, params.automationId),
      eq(automationCorrelations.correlationKey, params.correlationKey),
    ),
  });
}

export async function enqueueAutomationMessage(params: {
  runId: string;
  sessionId: string;
  chatId: string;
  userId: string;
  message: unknown;
  reason?: string;
}) {
  const [item] = await db
    .insert(automationMessageQueue)
    .values({
      id: nanoid(),
      runId: params.runId,
      sessionId: params.sessionId,
      chatId: params.chatId,
      userId: params.userId,
      messageJson: params.message,
      status: "queued",
      lastError: params.reason,
    })
    .returning();

  await appendAutomationTimeline({
    runId: params.runId,
    type: "automation.message.queued",
    visibility: "user",
    payload: {
      queueItemId: item?.id,
      sessionId: params.sessionId,
      chatId: params.chatId,
      reason: params.reason,
    },
  });

  return item ?? null;
}

export async function claimNextAutomationQueuedMessage(chatId: string) {
  if (await getIsEveChatStreaming(chatId)) {
    return null;
  }

  return db.transaction(async (tx) => {
    const [chat] = await tx
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    if (!chat) {
      return null;
    }

    const [item] = await tx
      .select()
      .from(automationMessageQueue)
      .where(
        and(
          eq(automationMessageQueue.chatId, chatId),
          eq(automationMessageQueue.status, "queued"),
        ),
      )
      .orderBy(asc(automationMessageQueue.createdAt))
      .limit(1);
    if (!item) {
      return null;
    }

    const [claimed] = await tx
      .update(automationMessageQueue)
      .set({
        status: "claimed",
        claimedAt: new Date(),
      })
      .where(
        and(
          eq(automationMessageQueue.id, item.id),
          eq(automationMessageQueue.status, "queued"),
        ),
      )
      .returning();

    return claimed ?? null;
  });
}

export async function markAutomationQueuedMessageStarted(params: {
  queueItemId: string;
  eveSessionId: string;
}) {
  await db
    .update(automationMessageQueue)
    .set({
      status: "started",
      startedEveSessionId: params.eveSessionId,
    })
    .where(eq(automationMessageQueue.id, params.queueItemId));
}

export async function markAutomationQueuedMessageFailed(params: {
  queueItemId: string;
  error: string;
}) {
  await db
    .update(automationMessageQueue)
    .set({
      status: "failed",
      lastError: params.error,
    })
    .where(eq(automationMessageQueue.id, params.queueItemId));
}

export async function getAutomationsWithDueSchedules(now = new Date()) {
  const definitions = await db
    .select()
    .from(automationDefinitions)
    .where(eq(automationDefinitions.enabled, true));
  const due: Array<{
    automation: AutomationDefinitionRow;
    version: AutomationVersionRow;
    definition: AutomationDefinition;
    trigger: TriggerDefinition;
    triggerIndex: number;
    nextDueAt: Date | null;
    state: JsonRecord;
  }> = [];

  for (const automation of definitions) {
    if (!automation.currentVersionId) {
      continue;
    }
    const version = await db.query.automationVersions.findFirst({
      where: eq(automationVersions.id, automation.currentVersionId),
    });
    if (!version) {
      continue;
    }
    const definition = parseAutomationDefinition(version.definitionJson);
    for (const [triggerIndex, trigger] of definition.triggers.entries()) {
      if (trigger.kind !== "schedule" && trigger.kind !== "poll") {
        continue;
      }
      const schedule = trigger.schedule;
      const stateKey = getAutomationScheduleStateKey(automation.id, triggerIndex);
      const state = await db.query.automationState.findFirst({
        where: and(
          eq(automationState.automationId, automation.id),
          eq(automationState.scope, "trigger"),
          eq(automationState.key, stateKey),
        ),
      });
      const stateJson = isRecord(state?.stateJson) ? state.stateJson : {};
      const nextDueAtRaw = stateJson.nextDueAt;
      if (nextDueAtRaw === null) {
        continue;
      }
      const nextDueAt =
        typeof nextDueAtRaw === "string"
          ? new Date(nextDueAtRaw)
          : getInitialDueAt(schedule, now);

      if (Number.isNaN(nextDueAt.getTime()) || nextDueAt > now) {
        continue;
      }

      due.push({
        automation,
        version,
        definition,
        trigger,
        triggerIndex,
        nextDueAt: computeNextDueAt(schedule, nextDueAt),
        state: stateJson,
      });
    }
  }

  return due;
}

export async function recordScheduleTick(params: {
  automationId: string;
  triggerIndex: number;
  nextDueAt: Date | null;
  emittedEventId?: string;
  state?: JsonRecord;
}) {
  await db
    .insert(automationState)
    .values({
      automationId: params.automationId,
      scope: "trigger",
      key: getAutomationScheduleStateKey(params.automationId, params.triggerIndex),
      stateJson: {
        ...(params.state ?? {}),
        nextDueAt: params.nextDueAt?.toISOString() ?? null,
        lastEmittedEventId: params.emittedEventId,
      },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [automationState.automationId, automationState.scope, automationState.key],
      set: {
        stateJson: {
          ...(params.state ?? {}),
          nextDueAt: params.nextDueAt?.toISOString() ?? null,
          lastEmittedEventId: params.emittedEventId,
        },
        updatedAt: new Date(),
      },
    });
}

function getInitialDueAt(
  schedule: Extract<TriggerDefinition, { kind: "schedule" | "poll" }>["schedule"],
  now: Date,
): Date {
  if (schedule.kind === "once") {
    return new Date(schedule.dueAt);
  }
  if (schedule.kind === "interval") {
    return schedule.anchorAt ? new Date(schedule.anchorAt) : now;
  }
  return now;
}

function computeNextDueAt(
  schedule: Extract<TriggerDefinition, { kind: "schedule" | "poll" }>["schedule"],
  currentDueAt: Date,
): Date | null {
  if (schedule.kind === "once") {
    return null;
  }
  if (schedule.kind === "interval") {
    return new Date(currentDueAt.getTime() + schedule.everyMs);
  }

  // Minimal cron support for the first build: advance minute-level ticks.
  // The editor labels this as preview support until a full cron parser lands.
  return new Date(currentDueAt.getTime() + 60_000);
}

export function renderPromptTemplate(params: {
  template: string;
  event: AutomationEventRow;
  runId: string;
}): string {
  const eventPayload =
    typeof params.event.payloadJson === "string"
      ? params.event.payloadJson
      : JSON.stringify(params.event.payloadJson, null, 2);
  return params.template
    .replaceAll("{{event.id}}", params.event.id)
    .replaceAll("{{event.type}}", params.event.type)
    .replaceAll("{{event.source}}", params.event.source)
    .replaceAll("{{event.subject.kind}}", params.event.subjectKind)
    .replaceAll("{{event.subject.id}}", params.event.subjectId)
    .replaceAll("{{event.correlationKey}}", params.event.correlationKey ?? "")
    .replaceAll("{{run.id}}", params.runId)
    .replaceAll("{{event.payload}}", eventPayload);
}

export function getRunIdentityUserId(
  definition: AutomationDefinition,
  fallbackUserId: string | null,
): string {
  if (definition.identity.kind === "user") {
    return definition.identity.userId;
  }
  return fallbackUserId ?? definition.owner.id;
}

export function requiresBeforeRunApproval(policy: AutomationPolicy): boolean {
  if (policy.autonomy === "production") {
    return true;
  }
  return policy.approvals.some(
    (approval) => approval.required && approval.when === "before-run",
  );
}

export function getBeforeRunApprovalRule(policy: AutomationPolicy) {
  return policy.approvals.find(
    (approval) => approval.required && approval.when === "before-run",
  );
}

export function getActionKind(action: AutomationAction): AutomationAction["kind"] {
  return action.kind;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
