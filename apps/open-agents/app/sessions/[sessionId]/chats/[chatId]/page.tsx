import { canAccess } from "@open-agents/authz";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { DiffsProvider } from "@/components/diffs-provider";
import { toWebAgentMessagesFromEvents } from "@/lib/chat/eve-message-projection";
import {
  getChatById,
  getChatSummariesBySessionId,
  getEveChatSessionSnapshot,
} from "@/lib/db/sessions";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";
import { getUserPreferences } from "@/lib/db/user-preferences";
import {
  buildSessionChatModelOptions,
  withMissingModelOption,
} from "@/lib/model-options";
import {
  filterModelVariantsForSession,
  filterModelsForSession,
  sanitizeSelectedModelIdForSession,
  sanitizeUserPreferencesForSession,
} from "@/lib/model-access";
import {
  isManagedTemplateTrialUser,
  MANAGED_TEMPLATE_TRIAL_CODE_EDITOR_ERROR,
} from "@/lib/managed-template-trial";
import { getAllVariants } from "@/lib/model-variants";
import { fetchAvailableLanguageModelsWithContext } from "@/lib/models-with-context";
import { getServerSession } from "@/lib/session/get-server-session";
import { getInitialIsOnlyChatInSession } from "./only-chat-in-session";
import { SessionChatContent } from "./session-chat-content";
import { SessionChatProvider } from "./session-chat-context";

export const maxDuration = 120;

interface SessionChatPageProps {
  params: Promise<{ sessionId: string; chatId: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOptimisticChatId(chatId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    chatId,
  );
}

const OPTIMISTIC_CHAT_RETRY_DELAY_MS = 100;
const OPTIMISTIC_CHAT_RETRY_ATTEMPTS = 50;

async function getInitialModels() {
  try {
    return await fetchAvailableLanguageModelsWithContext();
  } catch {
    return [];
  }
}

async function getChatByIdWithRetry(
  chatId: string,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof getChatById>>> {
  const maxAttempts = isOptimisticChatId(chatId)
    ? OPTIMISTIC_CHAT_RETRY_ATTEMPTS
    : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const chat = await getChatById(chatId);
    if (chat && chat.sessionId === sessionId) {
      return chat;
    }
    if (attempt < maxAttempts) {
      await sleep(OPTIMISTIC_CHAT_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

export async function generateMetadata({
  params,
}: SessionChatPageProps): Promise<Metadata> {
  const { sessionId } = await params;
  const sessionRecord = await getSessionByIdCached(sessionId);

  return {
    title: sessionRecord?.title ?? `Session ${sessionId}`,
    description: "Review session progress, chats, and outputs.",
  };
}

export default async function SessionChatPage({
  params,
}: SessionChatPageProps) {
  const { sessionId, chatId } = await params;

  // Start independent fetches in parallel
  const sessionPromise = getServerSession();
  const sessionRecordPromise = getSessionByIdCached(sessionId);

  // Server-side auth check
  const session = await sessionPromise;
  if (!session?.user) {
    redirect("/");
  }

  // Fetch session record
  const sessionRecord = await sessionRecordPromise;
  if (!sessionRecord) {
    notFound();
  }

  const canReadSession = await canAccess(
    { kind: "user", userId: session.user.id },
    { scopeKind: sessionRecord.scopeKind, scopeId: sessionRecord.scopeId },
    "read",
  );
  if (!canReadSession) {
    redirect("/");
  }

  const requestHost = (await headers()).get("host") ?? "";

  // Fetch chat, Eve snapshot, models, and preferences in parallel
  const [
    chat,
    eveChatSnapshot,
    initialModels,
    rawPreferences,
    sessionChats,
  ] =
    await Promise.all([
      getChatByIdWithRetry(chatId, sessionId),
      getEveChatSessionSnapshot(chatId),
      getInitialModels(),
      getUserPreferences(session.user.id),
      getChatSummariesBySessionId(sessionId, session.user.id),
    ]);

  if (!chat) {
    if (isOptimisticChatId(chatId)) {
      redirect(`/sessions/${sessionId}`);
    }
    notFound();
  }

  const initialMessages = toWebAgentMessagesFromEvents(eveChatSnapshot.events);
  const messageDurationMap: Record<string, number> = {};
  const messageStartedAtMap: Record<string, string> = {};
  const lastUserMessageSentAt = null;
  const codeEditorDisabledReason = isManagedTemplateTrialUser(
    session,
    requestHost,
  )
    ? MANAGED_TEMPLATE_TRIAL_CODE_EDITOR_ERROR
    : null;
  const preferences = sanitizeUserPreferencesForSession(
    rawPreferences,
    session,
    requestHost,
  );
  const modelVariants = filterModelVariantsForSession(
    getAllVariants(preferences.modelVariants),
    session,
    requestHost,
  );
  const filteredModels = filterModelsForSession(
    initialModels,
    session,
    requestHost,
  );
  const chatModelId =
    sanitizeSelectedModelIdForSession(
      chat.modelId,
      modelVariants,
      session,
      requestHost,
    ) ?? chat.modelId;
  const initialModelOptions = withMissingModelOption(
    buildSessionChatModelOptions(filteredModels, modelVariants),
    chatModelId,
  );

  const initialIsOnlyChatInSession = getInitialIsOnlyChatInSession(
    sessionChats,
    chat.id,
  );

  return (
    <DiffsProvider>
      <SessionChatProvider
        session={sessionRecord}
        chat={{ ...chat, modelId: chatModelId }}
        initialMessages={initialMessages}
        initialEveEvents={eveChatSnapshot.events}
        initialEveSession={eveChatSnapshot.session}
        initialModelOptions={initialModelOptions}
        actorUserId={session.user.id}
      >
        <SessionChatContent
          initialIsOnlyChatInSession={initialIsOnlyChatInSession}
          messageDurationMap={messageDurationMap}
          messageStartedAtMap={messageStartedAtMap}
          lastUserMessageSentAt={lastUserMessageSentAt}
          codeEditorDisabledReason={codeEditorDisabledReason}
        />
      </SessionChatProvider>
    </DiffsProvider>
  );
}
