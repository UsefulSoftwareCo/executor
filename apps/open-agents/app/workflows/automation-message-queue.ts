/* oxlint-disable executor/no-try-catch-or-throw -- boundary: Vercel Workflow start cancellation is best-effort cleanup around a Promise API */
import { start } from "workflow/api";
import type { WebAgentUIMessage } from "@/app/types";
import { getLatestEveChatEvent, isEveChatEventStreaming } from "@/lib/db/eve-chat-sessions";
import { runEveChatMessageTurn } from "@/lib/chat/eve-runtime";

type QueuedAutomationMessage = {
  id: string;
  runId: string | null;
  sessionId: string;
  chatId: string;
  userId: string;
  messageJson: unknown;
};

function isWebAgentMessage(value: unknown): value is WebAgentUIMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "role" in value &&
    "parts" in value
  );
}

function getBaseUrl(): string {
  return (
    process.env.OPEN_AGENTS_PUBLIC_URL ??
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    "http://localhost:3000"
  );
}

function getRouterVisibleLifecycleEvents(
  definition: NonNullable<
    Awaited<ReturnType<typeof import("@/lib/automation/store").getAutomationExecutionContext>>
  >["definition"],
): string[] {
  return [
    ...new Set(
      definition.outputs.flatMap((output) =>
        output.kind === "automation-event" && Array.isArray(output.events) ? output.events : [],
      ),
    ),
  ];
}

async function claimQueuedMessageStep(chatId: string) {
  "use step";
  const { claimNextAutomationQueuedMessage } = await import("@/lib/automation/store");
  return claimNextAutomationQueuedMessage(chatId);
}

async function startQueuedMessageStep(item: QueuedAutomationMessage) {
  "use step";
  const {
    getAutomationExecutionContext,
    markAutomationQueuedMessageFailed,
    markAutomationQueuedMessageStarted,
  } = await import("@/lib/automation/store");

  if (!isWebAgentMessage(item.messageJson)) {
    await markAutomationQueuedMessageFailed({
      queueItemId: item.id,
      error: "Queued automation message is malformed",
    });
    return { started: false, reason: "malformed-message" };
  }

  const context = item.runId ? await getAutomationExecutionContext(item.runId) : null;

  const latestEvent = await getLatestEveChatEvent(item.chatId);
  if (isEveChatEventStreaming(latestEvent)) {
    await markAutomationQueuedMessageFailed({
      queueItemId: item.id,
      error: "Chat became busy before queued Eve turn could start",
    });
    return { started: false, reason: "chat-busy" };
  }

  const result = await runEveChatMessageTurn({
    chatId: item.chatId,
    clientContext: {
      automation: context
        ? {
            id: context.automation.id,
            name: context.automation.name,
            runId: context.run.id,
            versionId: context.version.id,
            eventId: context.event.id,
            correlationKey: context.run.correlationKey ?? context.event.correlationKey,
            eventScope: {
              kind: context.event.scopeKind,
              id: context.event.scopeId,
            },
            routerVisibleEvents: getRouterVisibleLifecycleEvents(context.definition),
            policy: context.definition.policy,
            agent: context.definition.agent,
          }
        : undefined,
      maxSteps: context?.definition.policy.budget.maxModelSteps ?? 500,
    },
    message: item.messageJson,
    requestUrl: `${getBaseUrl()}/api/automations/message-queue/${item.id}`,
    sessionId: item.sessionId,
  });

  await markAutomationQueuedMessageStarted({
    queueItemId: item.id,
    eveSessionId: result.sessionId,
  });

  await startAutomationMessageQueueDrain(item.chatId);

  return { started: true, eveSessionId: result.sessionId };
}

startQueuedMessageStep.maxRetries = 3;

export async function automationMessageQueueWorkflow(chatId: string) {
  "use workflow";

  const item = await claimQueuedMessageStep(chatId);
  if (!item) {
    return { started: false, reason: "empty-or-busy" };
  }

  return startQueuedMessageStep(item);
}

export async function startAutomationMessageQueueDrain(chatId: string) {
  "use step";
  const run = await start(automationMessageQueueWorkflow, [chatId]);
  return run.runId;
}
