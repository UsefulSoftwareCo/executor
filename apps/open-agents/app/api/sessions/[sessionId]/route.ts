import { after } from "next/server";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
} from "@/app/api/sessions/_lib/session-context";
import { deleteSession, updateSession } from "@/lib/db/sessions";
import { archiveSession } from "@/lib/sandbox/archive-session";
import { hasRuntimeSandboxState } from "@/lib/sandbox/utils";

interface UpdateSessionRequest {
  title?: string;
  status?: "running" | "completed" | "failed" | "archived";
  linesAdded?: number;
  linesRemoved?: number;
  prNumber?: number;
  prStatus?: "open" | "merged" | "closed";
}

export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId } = await params;
  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
    verb: "read",
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  return Response.json({ session: sessionContext.sessionRecord });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId } = await params;
  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
    verb: "write",
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }
  const existingSession = sessionContext.sessionRecord;

  let body: UpdateSessionRequest;
  try {
    body = (await req.json()) as UpdateSessionRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const shouldStopSandboxAfterArchive =
    body.status === "archived" && existingSession.status !== "archived";

  const shouldUnarchive = body.status === "running" && existingSession.status === "archived";

  if (shouldUnarchive && hasRuntimeSandboxState(existingSession.sandboxState)) {
    return Response.json(
      {
        error:
          "Sandbox is still being paused for this archived session. Please try unarchiving again in a few seconds.",
      },
      { status: 409 },
    );
  }

  const updatePayload: UpdateSessionRequest &
    Partial<{
      lifecycleState: "archived" | null;
      lifecycleError: null;
      sandboxExpiresAt: null;
      hibernateAfter: null;
    }> = { ...body };

  if (shouldUnarchive) {
    updatePayload.lifecycleState = null;
    updatePayload.lifecycleError = null;
  }

  const updatedSession = shouldStopSandboxAfterArchive
    ? (
        await archiveSession(sessionId, {
          currentSession: existingSession,
          update: updatePayload,
          logPrefix: "[Sessions]",
          scheduleBackgroundWork: after,
        })
      ).session
    : await updateSession(sessionId, updatePayload);

  if (!updatedSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  return Response.json({ session: updatedSession });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId } = await params;
  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
    verb: "admin",
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  await deleteSession(sessionId);
  return Response.json({ success: true });
}
