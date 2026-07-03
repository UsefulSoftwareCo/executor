import { AuthzError, requireSessionAccess } from "@open-agents/authz";
import { notFound, redirect } from "next/navigation";
import { getAccessibleChatsBySessionId } from "@/lib/db/sessions";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";
import { getServerSession } from "@/lib/session/get-server-session";

interface SessionPageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { sessionId } = await params;

  const sessionPromise = getServerSession();
  const sessionRecordPromise = getSessionByIdCached(sessionId);

  const session = await sessionPromise;
  if (!session?.user) {
    redirect("/");
  }

  const sessionRecord = await sessionRecordPromise;
  if (!sessionRecord) {
    notFound();
  }

  const chats = await getAccessibleChatsBySessionId(sessionId, session.user.id);
  const targetChat = chats[0];

  if (targetChat) {
    redirect(`/sessions/${sessionId}/chats/${targetChat.id}`);
  }

  try {
    await requireSessionAccess({ kind: "user", userId: session.user.id }, sessionId, "read");
  } catch (error) {
    if (error instanceof AuthzError && error.status === 403) {
      redirect("/");
    }
    throw error;
  }

  notFound();
}
