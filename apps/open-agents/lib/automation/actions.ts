/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: automation action drivers handle Vercel Workflow thrown retry/fatal errors and external Promise APIs */
import "server-only";

import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { FatalError, RetryableError } from "workflow";
import { ElicitationResponse } from "@executor-js/sdk";
import { nanoid } from "nanoid";
import type { WebAgentUIMessage } from "@/app/types";
import { startAutomationMessageQueueDrain } from "@/app/workflows/automation-message-queue";
import { getAgentDefinition } from "@/lib/agents/repository";
import { isEveChatEventStreaming, getLatestEveChatEvent } from "@/lib/db/eve-chat-sessions";
import { runEveChatMessageTurn } from "@/lib/chat/eve-runtime";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";
import { db } from "@/lib/db/client";
import { chats, users, type Chat, type Session } from "@/lib/db/schema";
import { createSessionWithInitialChat, getChatById, getSessionById } from "@/lib/db/sessions";
import { createOpenAgentsExecutorRuntime } from "@/lib/executor/runtime";
import { filterBuiltInToolsForAutomationPolicy } from "./policy";
import {
  appendAutomationTimeline,
  createAutomationArtifact,
  createAutomationOutbox,
  emitAutomationEvent,
  enqueueAutomationMessage,
  getAutomationCorrelation,
  getAutomationExecutionContext,
  linkAutomationRunToSessionChat,
  renderPromptTemplate,
  upsertAutomationCorrelation,
  type AutomationExecutionContext,
} from "./store";
import type {
  AutomationAction,
  AutomationDefinition,
  AutomationEventInput,
  NormalizedAutomationEventInput,
} from "./types";
import { extractAgentSkillPatterns, resolveAgentReference } from "./agent-spec";

type JsonRecord = Record<string, unknown>;

export type AutomationActionExecutionResult = {
  status: "succeeded" | "succeeded_with_findings" | "needs_review" | "failed";
  summary: string;
  data?: unknown;
  emittedEventIds?: string[];
};

type ExecuteAutomationActionOptions = {
  idempotencyKey: string;
  attempt: number;
};

const AUTOMATION_BOT_USER_ID = "automation-bot";

function getBaseUrl(): string {
  return (
    process.env.OPEN_AGENTS_PUBLIC_URL ??
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    "http://localhost:3000"
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRetryAfterMs(value: string | undefined): number | Date | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1_000, Math.floor(seconds * 1000));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[part];
  }, root);
}

function eventToJson(context: AutomationExecutionContext): JsonRecord {
  const { event } = context;
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

function buildTemplateContext(context: AutomationExecutionContext): JsonRecord {
  return {
    event: eventToJson(context),
    run: {
      id: context.run.id,
      status: context.run.status,
      correlationKey: context.run.correlationKey,
      sessionId: context.run.sessionId,
      chatId: context.run.chatId,
    },
    automation: {
      id: context.automation.id,
      name: context.automation.name,
      version: context.version.version,
    },
    payload: context.event.payloadJson,
  };
}

function interpolateString(template: string, context: JsonRecord): unknown {
  const wholeMatch = template.match(/^{{\s*([^}]+?)\s*}}$/);
  if (wholeMatch?.[1]) {
    const raw = getPath(context, wholeMatch[1].trim());
    return raw === undefined ? "" : raw;
  }

  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_match, path: string) => {
    const value = getPath(context, path.trim());
    if (value === undefined || value === null) {
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function interpolateJson(value: unknown, context: JsonRecord): unknown {
  if (typeof value === "string") {
    return interpolateString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateJson(entry, context));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, interpolateJson(entryValue, context)]),
    );
  }
  return value;
}

function truncateTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function buildUserMessage(prefix: string, text: string): WebAgentUIMessage {
  return {
    id: `${prefix}-${nanoid(8)}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function resolveRepoBinding(
  action: Extract<AutomationAction, { kind: "startSession" | "messageSession" }>,
  context: AutomationExecutionContext,
) {
  return {
    repoOwner: action.repo.owner ?? context.event.repoOwner ?? undefined,
    repoName: action.repo.name ?? context.event.repoName ?? undefined,
    cloneUrl: action.repo.cloneUrl,
    branch: action.repo.branch,
  };
}

function resolveIdentityUserId(definition: AutomationDefinition): {
  userId: string;
  synthetic: boolean;
} {
  if (definition.identity.kind === "user") {
    return { userId: definition.identity.userId, synthetic: false };
  }
  if (definition.owner.kind === "user") {
    return { userId: definition.owner.id, synthetic: false };
  }
  return { userId: AUTOMATION_BOT_USER_ID, synthetic: true };
}

async function ensureSyntheticAutomationUser(userId: string): Promise<void> {
  if (userId !== AUTOMATION_BOT_USER_ID) {
    return;
  }

  await db
    .insert(users)
    .values({
      id: userId,
      username: "automation-bot",
      email: "automation-bot@open-agents.local",
      name: "Automation Bot",
      emailVerified: true,
    })
    .onConflictDoNothing();
}

function readOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

type EveAgentOptionsContext = {
  customInstructions?: string;
  model?: string;
  subagentModel?: string;
};

function buildAgentOptions(
  definition: AutomationDefinition,
  actionAgent: AutomationDefinition["agent"] | undefined,
): EveAgentOptionsContext {
  const agent = actionAgent ?? definition.agent;
  const options: EveAgentOptionsContext = {};

  if (agent?.kind === "inline") {
    const inline = agent.definition;
    const customInstructions = readOptionalString(inline, "customInstructions");
    if (customInstructions) {
      options.customInstructions = customInstructions;
    }
    const model = readOptionalString(inline, "model");
    if (model) {
      options.model = model;
    }
    const subagentModel = readOptionalString(inline, "subagentModel");
    if (subagentModel) {
      options.subagentModel = subagentModel;
    }
  }

  if (agent?.kind === "extend" && isRecord(agent.override)) {
    const customInstructions = readOptionalString(agent.override, "customInstructions");
    if (customInstructions) {
      options.customInstructions = customInstructions;
    }
  }

  return options;
}

function getRouterVisibleLifecycleEvents(definition: AutomationDefinition): string[] {
  return [
    ...new Set(
      definition.outputs.flatMap((output) =>
        output.kind === "automation-event" && Array.isArray(output.events) ? output.events : [],
      ),
    ),
  ];
}

async function createChatForSession(params: {
  sessionId: string;
  title: string;
  modelId?: string | null;
}): Promise<Chat> {
  const [chat] = await db
    .insert(chats)
    .values({
      id: nanoid(),
      sessionId: params.sessionId,
      title: params.title,
      modelId: params.modelId ?? APP_DEFAULT_MODEL_ID,
    })
    .returning();

  if (!chat) {
    throw new FatalError("Failed to create automation chat");
  }
  return chat;
}

async function createAutomationSession(params: {
  context: AutomationExecutionContext;
  action: Extract<AutomationAction, { kind: "startSession" | "messageSession" }>;
  userId: string;
  prompt: string;
}): Promise<{ session: Session; chat: Chat; isNew: true }> {
  const repo = resolveRepoBinding(params.action, params.context);
  const agentName = resolveAgentReference(params.action.agent ?? params.context.definition.agent);
  const agent = agentName ? await getAgentDefinition(agentName) : null;
  const workspaceRepos =
    !repo.repoOwner && !repo.repoName && !repo.cloneUrl && agent?.repos.length ? agent.repos : [];
  const title = truncateTitle(
    `${params.context.automation.name}: ${params.context.event.subjectId}`,
  );

  const result = await createSessionWithInitialChat({
    session: {
      id: nanoid(),
      userId: params.userId,
      scopeKind: "user",
      scopeId: params.userId,
      title,
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
      cloneUrl: repo.cloneUrl,
      branch: repo.branch,
      isNewBranch: Boolean(repo.repoOwner && repo.repoName && !repo.branch),
      agentName: agent?.slug ?? null,
      workspaceRepos,
    },
    initialChat: {
      id: nanoid(),
      title: truncateTitle(params.prompt),
      modelId: agent?.model ?? APP_DEFAULT_MODEL_ID,
    },
  });

  return { ...result, isNew: true };
}

async function runAutomationChatTurn(params: {
  context: AutomationExecutionContext;
  session: Session;
  chat: Chat;
  message: WebAgentUIMessage;
  action: Extract<AutomationAction, { kind: "startSession" | "messageSession" }>;
}) {
  const agentOptions = buildAgentOptions(params.context.definition, params.action.agent);

  const latestEvent = await getLatestEveChatEvent(params.chat.id);
  if (isEveChatEventStreaming(latestEvent)) {
    throw new RetryableError("Chat is already processing another Eve turn", {
      retryAfter: "15s",
    });
  }

  const result = await runEveChatMessageTurn({
    chatId: params.chat.id,
    clientContext: {
      automation: {
        id: params.context.automation.id,
        name: params.context.automation.name,
        runId: params.context.run.id,
        versionId: params.context.version.id,
        eventId: params.context.event.id,
        correlationKey: params.context.run.correlationKey ?? params.context.event.correlationKey,
        eventScope: {
          kind: params.context.event.scopeKind,
          id: params.context.event.scopeId,
        },
        routerVisibleEvents: getRouterVisibleLifecycleEvents(params.context.definition),
        policy: params.context.definition.policy,
        agent: params.context.definition.agent,
        localSkillPatterns: extractAgentSkillPatterns(
          params.action.agent ?? params.context.definition.agent,
        ),
      },
      agentOptions,
      maxSteps: params.context.definition.policy.budget.maxModelSteps ?? 500,
      autoCommitEnabled:
        params.action.kind === "startSession" ? params.action.autoCommit : undefined,
      autoCreatePrEnabled: params.action.kind === "startSession" ? params.action.autoPr : undefined,
    },
    message: params.message,
    requestUrl: `${getBaseUrl()}/api/automations/runs/${params.context.run.id}`,
    sessionId: params.session.id,
    toolProfile: filterBuiltInToolsForAutomationPolicy(params.context.definition.policy),
  });

  await appendAutomationTimeline({
    runId: params.context.run.id,
    type: "automation.chat.eve.completed",
    visibility: "user",
    payload: {
      eveSessionId: result.sessionId,
      sessionId: params.session.id,
      chatId: params.chat.id,
      messageId: params.message.id,
    },
  });

  await startAutomationMessageQueueDrain(params.chat.id);

  return result.sessionId;
}

function resolveMessageCorrelationKey(
  action: Extract<AutomationAction, { kind: "messageSession" }>,
  context: AutomationExecutionContext,
): string {
  if (action.correlation === "event") {
    return context.event.id;
  }
  if (action.correlation === "correlation") {
    return (
      context.run.correlationKey ??
      context.event.correlationKey ??
      `${context.event.subjectKind}:${context.event.subjectId}`
    );
  }
  return `${context.event.subjectKind}:${context.event.subjectId}`;
}

async function resolveMessageTarget(params: {
  context: AutomationExecutionContext;
  action: Extract<AutomationAction, { kind: "messageSession" }>;
  userId: string;
  prompt: string;
}) {
  const correlationKey = resolveMessageCorrelationKey(params.action, params.context);
  const existingCorrelation = await getAutomationCorrelation({
    automationId: params.context.automation.id,
    correlationKey,
  });

  if (existingCorrelation?.sessionId && existingCorrelation.chatId) {
    const [session, chat] = await Promise.all([
      getSessionById(existingCorrelation.sessionId),
      getChatById(existingCorrelation.chatId),
    ]);
    if (session && chat) {
      return { session, chat, correlationKey, isNew: false };
    }
  }

  if (!params.action.createIfMissing) {
    throw new FatalError("No correlated session exists for messageSession");
  }

  const target =
    params.context.event.scopeKind === "session"
      ? await resolveAttachedSessionTarget(params)
      : await createAutomationSession(params);

  await upsertAutomationCorrelation({
    automationId: params.context.automation.id,
    correlationKey,
    subjectKind: params.context.event.subjectKind,
    subjectId: params.context.event.subjectId,
    sessionId: target.session.id,
    chatId: target.chat.id,
    state: {
      source: "messageSession",
      createdByRunId: params.context.run.id,
    },
  });

  return { ...target, correlationKey };
}

async function resolveAttachedSessionTarget(params: {
  context: AutomationExecutionContext;
  action: Extract<AutomationAction, { kind: "startSession" | "messageSession" }>;
  userId: string;
  prompt: string;
}) {
  const session = await getSessionById(params.context.event.scopeId);
  if (!session || session.userId !== params.userId) {
    return createAutomationSession(params);
  }

  const chat = await createChatForSession({
    sessionId: session.id,
    title: truncateTitle(params.prompt),
  });
  return { session, chat, isNew: true as const };
}

async function runStartSessionAction(
  context: AutomationExecutionContext,
): Promise<AutomationActionExecutionResult> {
  const action = context.definition.action;
  if (action.kind !== "startSession") {
    throw new FatalError("Automation action is not startSession");
  }

  const prompt = renderPromptTemplate({
    template: action.prompt.text,
    event: context.event,
    runId: context.run.id,
  });
  const identity = resolveIdentityUserId(context.definition);
  await ensureSyntheticAutomationUser(identity.userId);

  const target =
    action.mode === "thread-attached" && context.event.scopeKind === "session"
      ? await resolveAttachedSessionTarget({
          context,
          action,
          userId: identity.userId,
          prompt,
        })
      : await createAutomationSession({
          context,
          action,
          userId: identity.userId,
          prompt,
        });

  await linkAutomationRunToSessionChat({
    runId: context.run.id,
    sessionId: target.session.id,
    chatId: target.chat.id,
  });

  const correlationKey =
    context.run.correlationKey ?? `${context.event.subjectKind}:${context.event.subjectId}`;
  await upsertAutomationCorrelation({
    automationId: context.automation.id,
    correlationKey,
    subjectKind: context.event.subjectKind,
    subjectId: context.event.subjectId,
    sessionId: target.session.id,
    chatId: target.chat.id,
    state: {
      source: "startSession",
      createdByRunId: context.run.id,
    },
  });

  const message = buildUserMessage("automation", prompt);
  const eveSessionId = await runAutomationChatTurn({
    context,
    session: target.session,
    chat: target.chat,
    message,
    action,
  });

  await createAutomationArtifact({
    runId: context.run.id,
    name: "started-session",
    kind: "session",
    data: {
      sessionId: target.session.id,
      chatId: target.chat.id,
      eveSessionId,
      isNew: target.isNew,
    },
  });

  return {
    status: "succeeded",
    summary: `Started Eve chat session ${eveSessionId}`,
    data: {
      sessionId: target.session.id,
      chatId: target.chat.id,
      eveSessionId,
      isNew: target.isNew,
    },
  };
}

async function runMessageSessionAction(
  context: AutomationExecutionContext,
): Promise<AutomationActionExecutionResult> {
  const action = context.definition.action;
  if (action.kind !== "messageSession") {
    throw new FatalError("Automation action is not messageSession");
  }

  const prompt = renderPromptTemplate({
    template: action.prompt.text,
    event: context.event,
    runId: context.run.id,
  });
  const identity = resolveIdentityUserId(context.definition);
  await ensureSyntheticAutomationUser(identity.userId);

  const target = await resolveMessageTarget({
    context,
    action,
    userId: identity.userId,
    prompt,
  });
  await linkAutomationRunToSessionChat({
    runId: context.run.id,
    sessionId: target.session.id,
    chatId: target.chat.id,
  });

  const message = buildUserMessage("automation", prompt);
  const latestEvent = await getLatestEveChatEvent(target.chat.id);
  if (isEveChatEventStreaming(latestEvent)) {
    const queueItem = await enqueueAutomationMessage({
      runId: context.run.id,
      sessionId: target.session.id,
      chatId: target.chat.id,
      userId: identity.userId,
      message,
      reason: "Active Eve chat turn",
    });

    return {
      status: "succeeded",
      summary: `Queued message for active chat ${target.chat.id}`,
      data: {
        sessionId: target.session.id,
        chatId: target.chat.id,
        queueItemId: queueItem?.id,
        correlationKey: target.correlationKey,
      },
    };
  }

  const eveSessionId = await runAutomationChatTurn({
    context,
    session: target.session,
    chat: target.chat,
    message,
    action,
  });

  return {
    status: "succeeded",
    summary: `Messaged Eve chat session ${eveSessionId}`,
    data: {
      sessionId: target.session.id,
      chatId: target.chat.id,
      eveSessionId,
      correlationKey: target.correlationKey,
    },
  };
}

function buildFunctionCode(context: AutomationExecutionContext, userCode: string) {
  const automationContext = {
    event: eventToJson(context),
    run: {
      id: context.run.id,
      correlationKey: context.run.correlationKey,
      sessionId: context.run.sessionId,
      chatId: context.run.chatId,
    },
    automation: {
      id: context.automation.id,
      name: context.automation.name,
      version: context.version.version,
    },
  };

  return [
    `const automation = ${JSON.stringify(automationContext.automation)};`,
    `const event = ${JSON.stringify(automationContext.event)};`,
    `const run = ${JSON.stringify(automationContext.run)};`,
    userCode,
  ].join("\n");
}

async function runFunctionAction(
  context: AutomationExecutionContext,
): Promise<AutomationActionExecutionResult> {
  const action = context.definition.action;
  if (action.kind !== "runFunction") {
    throw new FatalError("Automation action is not runFunction");
  }

  const identity = resolveIdentityUserId(context.definition);
  await ensureSyntheticAutomationUser(identity.userId);

  const executor = await createOpenAgentsExecutorRuntime({
    userId: identity.userId,
    sessionId: context.run.sessionId ?? undefined,
    automationId: context.automation.id,
    automationName: context.automation.name,
    automationRunId: context.run.id,
    executorToolPatterns: context.definition.policy.executorTools,
    onElicitation: () => Effect.succeed(ElicitationResponse.make({ action: "decline" })),
  });
  const result = await executor.execute(buildFunctionCode(context, action.function.code));

  await createAutomationArtifact({
    runId: context.run.id,
    name: "function-result",
    kind: result.isError ? "function-error" : "function-result",
    data: result.structured ?? { text: result.text },
  });

  if (result.isError) {
    return {
      status: "failed",
      summary: result.text || "Function failed",
      data: result.structured,
    };
  }

  return {
    status: "succeeded",
    summary: "Function completed",
    data: result.structured ?? { text: result.text },
  };
}

function buildChildAutomationEvent(
  context: AutomationExecutionContext,
  raw: unknown,
  index: number,
): AutomationEventInput {
  const interpolated = interpolateJson(raw, buildTemplateContext(context));
  if (!isRecord(interpolated)) {
    throw new FatalError("emitEvent entries must be objects");
  }

  const scope = parseEventScope(interpolated.scope, context);
  const subject = parseEventSubject(interpolated.subject, context);

  return {
    source: typeof interpolated.source === "string" ? interpolated.source : "automation",
    type: typeof interpolated.type === "string" ? interpolated.type : "automation.event",
    version: typeof interpolated.version === "number" ? interpolated.version : 1,
    scope,
    subject,
    actor: {
      kind: "automation",
      id: context.automation.id,
      name: context.automation.name,
    },
    occurredAt: new Date().toISOString(),
    dedupeKey:
      typeof interpolated.dedupeKey === "string"
        ? interpolated.dedupeKey
        : `${context.run.id}:emit:${index}`,
    correlationKey:
      typeof interpolated.correlationKey === "string"
        ? interpolated.correlationKey
        : (context.run.correlationKey ?? context.event.correlationKey ?? undefined),
    trust: "internal",
    payload: interpolated.payload ?? interpolated,
    links: Array.isArray(interpolated.links)
      ? (interpolated.links as Array<{ label: string; url: string }>)
      : undefined,
  } satisfies AutomationEventInput;
}

function parseEventScope(
  value: unknown,
  context: AutomationExecutionContext,
): NormalizedAutomationEventInput["scope"] {
  if (isRecord(value) && typeof value.kind === "string" && typeof value.id === "string") {
    if (
      value.kind === "system" ||
      value.kind === "user" ||
      value.kind === "thread" ||
      value.kind === "session" ||
      value.kind === "repo" ||
      value.kind === "automation"
    ) {
      return { kind: value.kind, id: value.id };
    }
  }
  return { kind: context.event.scopeKind, id: context.event.scopeId };
}

function parseEventSubject(
  value: unknown,
  context: AutomationExecutionContext,
): NormalizedAutomationEventInput["subject"] {
  if (isRecord(value) && typeof value.kind === "string" && typeof value.id === "string") {
    const repo = isRecord(value.repo)
      ? {
          provider: "github" as const,
          owner: typeof value.repo.owner === "string" ? value.repo.owner : "",
          name: typeof value.repo.name === "string" ? value.repo.name : "",
        }
      : undefined;
    return {
      kind: value.kind,
      id: value.id,
      url: typeof value.url === "string" ? value.url : undefined,
      repo: repo?.owner && repo.name ? repo : undefined,
    };
  }

  const repo =
    context.event.repoOwner && context.event.repoName
      ? {
          provider: "github" as const,
          owner: context.event.repoOwner,
          name: context.event.repoName,
        }
      : undefined;

  return {
    kind: context.event.subjectKind,
    id: context.event.subjectId,
    url: context.event.subjectUrl ?? undefined,
    repo,
  };
}

async function runEmitEventAction(
  context: AutomationExecutionContext,
): Promise<AutomationActionExecutionResult> {
  const action = context.definition.action;
  if (action.kind !== "emitEvent") {
    throw new FatalError("Automation action is not emitEvent");
  }

  const emittedEventIds: string[] = [];
  for (const [index, entry] of action.events.entries()) {
    const eventInput = buildChildAutomationEvent(context, entry, index);
    const result = await emitAutomationEvent(eventInput);
    emittedEventIds.push(result.event.id);
  }

  await createAutomationArtifact({
    runId: context.run.id,
    name: "emitted-events",
    kind: "events",
    data: { eventIds: emittedEventIds },
  });

  return {
    status: "succeeded",
    summary: `Emitted ${emittedEventIds.length} event${emittedEventIds.length === 1 ? "" : "s"}`,
    emittedEventIds,
  };
}

async function postWebhookNotification(params: {
  url: string;
  idempotencyKey: string;
  payload: unknown;
}) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = HttpClientRequest.post(params.url).pipe(
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.setHeader("x-open-agents-idempotency-key", params.idempotencyKey),
        HttpClientRequest.bodyJsonUnsafe(params.payload),
      );
      const response = yield* client.execute(request);
      const bodyText = yield* response.text;
      return {
        status: response.status,
        headers: { ...response.headers },
        bodyText,
      };
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
}

async function runNotifyAction(
  context: AutomationExecutionContext,
  options: ExecuteAutomationActionOptions,
): Promise<AutomationActionExecutionResult> {
  const action = context.definition.action;
  if (action.kind !== "notify") {
    throw new FatalError("Automation action is not notify");
  }

  const templateContext = buildTemplateContext(context);
  const message = String(interpolateString(action.message, templateContext));
  const payload = interpolateJson(action.payload ?? {}, templateContext);
  const outboxPayload = {
    destination: action.destination,
    target: action.target,
    message,
    payload,
    event: eventToJson(context),
    automation: {
      id: context.automation.id,
      name: context.automation.name,
      runId: context.run.id,
    },
  };

  if (action.destination !== "webhook" || !action.target) {
    const outbox = await createAutomationOutbox({
      runId: context.run.id,
      destination: action.destination,
      payload: outboxPayload,
      status: "pending",
    });
    await createAutomationArtifact({
      runId: context.run.id,
      name: "notification",
      kind: "notification",
      data: { outboxId: outbox?.id, ...outboxPayload },
    });
    return {
      status: "succeeded",
      summary: `Queued ${action.destination} notification`,
      data: { outboxId: outbox?.id },
    };
  }

  let response: Awaited<ReturnType<typeof postWebhookNotification>>;
  try {
    response = await postWebhookNotification({
      url: action.target,
      idempotencyKey: options.idempotencyKey,
      payload: outboxPayload,
    });
  } catch (error) {
    throw new RetryableError(`Webhook notification transport failed: ${toErrorMessage(error)}`, {
      retryAfter: `${Math.min(options.attempt * 10, 120)}s`,
    });
  }

  if (response.status === 429) {
    throw new RetryableError("Webhook notification was rate limited", {
      retryAfter: parseRetryAfterMs(response.headers["retry-after"]) ?? 60_000,
    });
  }
  if (response.status >= 500) {
    throw new RetryableError(`Webhook notification failed with HTTP ${response.status}`, {
      retryAfter: `${Math.min(options.attempt * 15, 180)}s`,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new FatalError(
      `Webhook notification failed with HTTP ${response.status}: ${response.bodyText}`,
    );
  }

  const outbox = await createAutomationOutbox({
    runId: context.run.id,
    destination: action.destination,
    payload: outboxPayload,
    status: "sent",
  });
  await createAutomationArtifact({
    runId: context.run.id,
    name: "notification",
    kind: "notification",
    data: {
      outboxId: outbox?.id,
      status: response.status,
      bodyText: response.bodyText,
    },
  });

  return {
    status: "succeeded",
    summary: `Sent webhook notification with HTTP ${response.status}`,
    data: { outboxId: outbox?.id, status: response.status },
  };
}

async function runMonitorAction(
  context: AutomationExecutionContext,
): Promise<AutomationActionExecutionResult> {
  const action = context.definition.action;
  if (action.kind !== "monitor") {
    throw new FatalError("Automation action is not monitor");
  }

  const prompt = renderPromptTemplate({
    template: action.prompt.text,
    event: context.event,
    runId: context.run.id,
  });
  await createAutomationArtifact({
    runId: context.run.id,
    name: "monitor-observation",
    kind: "monitor",
    data: {
      prompt,
      childAction: action.childAction ?? null,
      event: eventToJson(context),
    },
  });

  return {
    status: "succeeded_with_findings",
    summary: "Recorded monitor observation",
    data: { prompt },
  };
}

export async function executeAutomationAction(
  runId: string,
  options: ExecuteAutomationActionOptions,
): Promise<AutomationActionExecutionResult> {
  const context = await getAutomationExecutionContext(runId);
  if (!context) {
    throw new FatalError(`Automation run ${runId} was not found`);
  }

  await appendAutomationTimeline({
    runId,
    type: "automation.action.started",
    visibility: "router",
    payload: {
      actionKind: context.definition.action.kind,
      idempotencyKey: options.idempotencyKey,
      attempt: options.attempt,
    },
  });

  if (context.definition.action.kind === "startSession") {
    return runStartSessionAction(context);
  }
  if (context.definition.action.kind === "messageSession") {
    return runMessageSessionAction(context);
  }
  if (context.definition.action.kind === "runFunction") {
    return runFunctionAction(context);
  }
  if (context.definition.action.kind === "emitEvent") {
    return runEmitEventAction(context);
  }
  if (context.definition.action.kind === "notify") {
    return runNotifyAction(context, options);
  }
  return runMonitorAction(context);
}
