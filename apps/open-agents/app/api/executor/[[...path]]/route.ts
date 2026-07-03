import { AuthzError, requireSessionAccess } from "@open-agents/authz";
import { getSessionById } from "@/lib/db/sessions";
import { handleExecutorApiRequest } from "@/lib/executor/runtime";
import { getServerSession } from "@/lib/session/get-server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

const nextExecutorApiRequestId = () =>
  `executor-api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function logExecutorApiResponse(input: {
  requestId: string;
  method: string;
  executorPath: string;
  status: number;
  durationMs: number;
  userId?: string;
  sessionId?: string;
}) {
  const scope = input.sessionId
    ? `session=${input.sessionId}`
    : `user=${input.userId ?? "anonymous"}`;
  console.info(
    `[executor-api ${input.requestId}] ${input.method} ${input.executorPath} -> ${input.status} in ${input.durationMs}ms ${scope}`,
  );
}

function resolveExecutorPath(path: string[]): {
  executorPath: string;
  sessionId?: string;
} {
  if (path[0] === "session" && path[1]) {
    const remaining = path.slice(2);
    return {
      sessionId: decodeURIComponent(path[1]),
      executorPath: `/${remaining.join("/")}`,
    };
  }

  return {
    executorPath: `/${path.join("/")}`,
  };
}

async function handler(request: Request, context: RouteContext) {
  const requestId = nextExecutorApiRequestId();
  const startedAt = performance.now();
  const { path = [] } = await context.params;
  const { executorPath, sessionId } = resolveExecutorPath(path);

  let userId: string | undefined;

  const respond = (response: Response) => {
    logExecutorApiResponse({
      requestId,
      method: request.method,
      executorPath,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      userId,
      sessionId,
    });
    return response;
  };

  const authSession = await getServerSession();
  if (!authSession?.user) {
    return respond(Response.json({ error: "Not authenticated" }, { status: 401 }));
  }
  userId = authSession.user.id;

  let sessionTitle: string | undefined;
  if (sessionId) {
    const sessionRecord = await getSessionById(sessionId);
    if (!sessionRecord) {
      return respond(Response.json({ error: "Session not found" }, { status: 404 }));
    }
    try {
      await requireSessionAccess({ kind: "user", userId: authSession.user.id }, sessionId, "write");
    } catch (error) {
      if (error instanceof AuthzError) {
        return respond(Response.json({ error: "Forbidden" }, { status: error.status }));
      }
      throw error;
    }
    sessionTitle = sessionRecord.title;
  }

  const response = await handleExecutorApiRequest(request, {
    userId: authSession.user.id,
    sessionId,
    sessionTitle,
    executorPath,
  });
  return respond(response);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
