import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  getLastUserMessageCreatedAtFromEventRows,
  toWebAgentMessagesWithTimingFromEventRows,
} from "@/lib/chat/eve-message-projection";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import {
  getChatById,
  getEveChatEventRows,
  getIsEveChatStreaming,
} from "@/lib/db/sessions";
import {
  getSessionByIdCached,
  getShareByIdCached,
} from "@/lib/db/sessions-cache";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { getAllVariants, MODEL_VARIANT_ID_PREFIX } from "@/lib/model-variants";
import { getServerSession } from "@/lib/session/get-server-session";
import { redactSharedEnvContent } from "./redact-shared-env-content";
import { SharedChatContent } from "./shared-chat-content";
import type { MessageWithTiming } from "./shared-chat-content";

interface SharedPageProps {
  params: Promise<{ shareId: string }>;
}

async function resolveSharedModelName(
  userId: string,
  modelId: string | null | undefined,
): Promise<string | null> {
  if (!modelId || !modelId.startsWith(MODEL_VARIANT_ID_PREFIX)) {
    return null;
  }

  try {
    const preferences = await getUserPreferences(userId);
    const variant = getAllVariants(preferences.modelVariants).find(
      (item) => item.id === modelId,
    );

    return variant?.name ?? null;
  } catch (error) {
    console.error("Failed to resolve shared model name:", error);
    return null;
  }
}

export async function generateMetadata({
  params,
}: SharedPageProps): Promise<Metadata> {
  const { shareId } = await params;
  const share = await getShareByIdCached(shareId);
  const sharedChat = share ? await getChatById(share.chatId) : null;

  return {
    title: sharedChat?.title ?? "Shared Chat",
    description: "A shared Open Agents chat.",
  };
}

export default async function SharedPage({ params }: SharedPageProps) {
  const { shareId } = await params;

  const viewerSessionPromise = getServerSession();
  const sharePromise = getShareByIdCached(shareId);

  const [viewerSession, share] = await Promise.all([
    viewerSessionPromise,
    sharePromise,
  ]);
  if (!share) {
    notFound();
  }

  const sharedChat = await getChatById(share.chatId);
  if (!sharedChat) {
    notFound();
  }

  const session = await getSessionByIdCached(sharedChat.sessionId);
  if (!session) {
    notFound();
  }

  // Fetch the user who owns this session (public profile info only)
  const sessionUser = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
    columns: {
      username: true,
      name: true,
      avatarUrl: true,
    },
  });

  const eventRows = await getEveChatEventRows(sharedChat.id);
  const messagesWithTiming: MessageWithTiming[] =
    toWebAgentMessagesWithTimingFromEventRows(eventRows).map((entry) => ({
      message: redactSharedEnvContent(entry.message),
      durationMs: entry.durationMs,
    }));

  // Derive streaming status and the timestamp of the last user message so the
  // shared page can show a live "in progress" timer without accessing the stream.
  const isStreaming = await getIsEveChatStreaming(sharedChat.id);
  const lastUserMessageSentAt =
    getLastUserMessageCreatedAtFromEventRows(eventRows)?.toISOString() ?? null;

  const { title, repoOwner, repoName, branch, cloneUrl, prNumber, prStatus } =
    session;
  const modelName = await resolveSharedModelName(
    session.userId,
    sharedChat.modelId,
  );
  const ownerSessionHref =
    viewerSession?.user?.id === session.userId
      ? `/sessions/${sharedChat.sessionId}/chats/${sharedChat.id}`
      : null;

  return (
    <SharedChatContent
      session={{
        title,
        repoOwner,
        repoName,
        branch,
        cloneUrl,
        prNumber,
        prStatus,
      }}
      chats={[{ chat: sharedChat, messagesWithTiming }]}
      modelId={sharedChat.modelId}
      modelName={modelName}
      sharedBy={
        sessionUser
          ? {
              username: sessionUser.username,
              name: sessionUser.name,
              avatarUrl: sessionUser.avatarUrl,
            }
          : null
      }
      ownerSessionHref={ownerSessionHref}
      isStreaming={isStreaming}
      lastUserMessageSentAt={lastUserMessageSentAt}
      shareId={shareId}
    />
  );
}
