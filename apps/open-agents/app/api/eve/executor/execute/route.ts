import { z } from "zod";
import { createOpenAgentsExecutorRuntime } from "@/lib/executor/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const executeRequestSchema = z.object({
  code: z.string(),
  executorToolPatterns: z.array(z.string()).optional(),
});

async function resolveOpenAgentsUserId(request: Request): Promise<string | null> {
  const userId = request.headers.get("x-open-agents-user-id")?.trim();
  if (request.headers.get("x-open-agents-authenticator") !== "slack-webhook") {
    return userId || null;
  }

  const slackUserId = request.headers.get("x-open-agents-slack-user-id")?.trim();
  if (!slackUserId) {
    return null;
  }

  const { getSlackUserLinkBySlackIdentity } = await import(
    "@/lib/db/slack-user-links"
  );
  const link = await getSlackUserLinkBySlackIdentity({
    slackTeamId: request.headers.get("x-open-agents-slack-team-id"),
    slackUserId,
  });

  return link?.userId ?? null;
}

const nextEveExecutorRequestId = () =>
  `eve-executor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function logEveExecutorResponse(input: {
  requestId: string;
  status: number;
  durationMs: number;
  userId?: string;
  sessionId?: string;
  codeChars?: number;
  patternCount?: number;
}) {
  const user = input.userId ? `user=${input.userId}` : "user=anonymous";
  const session = input.sessionId ? ` session=${input.sessionId}` : "";
  const code = input.codeChars === undefined ? "" : ` codeChars=${input.codeChars}`;
  const patterns = input.patternCount === undefined ? "" : ` patterns=${input.patternCount}`;
  console.info(
    `[eve-executor ${input.requestId}] POST /api/eve/executor/execute -> ${input.status} in ${input.durationMs}ms ${user}${session}${code}${patterns}`,
  );
}

function logEveExecutorFailure(input: {
  requestId: string;
  durationMs: number;
  userId?: string;
  sessionId?: string;
  codeChars?: number;
  patternCount?: number;
  phase: "runtime" | "execute";
  error: unknown;
}) {
  const user = input.userId ? `user=${input.userId}` : "user=anonymous";
  const session = input.sessionId ? ` session=${input.sessionId}` : "";
  const code = input.codeChars === undefined ? "" : ` codeChars=${input.codeChars}`;
  const patterns = input.patternCount === undefined ? "" : ` patterns=${input.patternCount}`;
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  console.error(
    `[eve-executor ${input.requestId}] ${input.phase} failed in ${input.durationMs}ms ${user}${session}${code}${patterns}: ${errorMessage}`,
  );
  if (input.error instanceof Error && input.error.stack) {
    console.error(`[eve-executor ${input.requestId}] stack:\n${input.error.stack}`);
  }
}

export async function POST(request: Request) {
  const requestId = nextEveExecutorRequestId();
  const startedAt = performance.now();
  const userId = await resolveOpenAgentsUserId(request);
  const sessionId = request.headers.get("x-open-agents-session-id")?.trim() || undefined;

  const respond = (response: Response, details?: { codeChars?: number; patternCount?: number }) => {
    logEveExecutorResponse({
      requestId,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      userId: userId ?? undefined,
      sessionId,
      codeChars: details?.codeChars,
      patternCount: details?.patternCount,
    });
    return response;
  };

  if (!userId) {
    return respond(Response.json({ error: "Missing OpenAgents user id" }, { status: 401 }));
  }

  // oxlint-disable-next-line executor/no-promise-catch -- boundary: invalid JSON maps to the stable 400 executor request response
  const body = await request.json().catch(() => null);
  const parsed = executeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return respond(Response.json({ error: "Invalid executor request" }, { status: 400 }));
  }

  let executor: Awaited<ReturnType<typeof createOpenAgentsExecutorRuntime>>;
  try {
    executor = await createOpenAgentsExecutorRuntime({
      userId,
      sessionId,
      executorToolPatterns: parsed.data.executorToolPatterns,
    });
  } catch (error) {
    logEveExecutorFailure({
      requestId,
      durationMs: Math.round(performance.now() - startedAt),
      userId,
      sessionId,
      codeChars: parsed.data.code.length,
      patternCount: parsed.data.executorToolPatterns?.length ?? 0,
      phase: "runtime",
      error,
    });
    return respond(Response.json({ error: "Executor runtime failed" }, { status: 500 }), {
      codeChars: parsed.data.code.length,
      patternCount: parsed.data.executorToolPatterns?.length ?? 0,
    });
  }

  let result: Awaited<ReturnType<typeof executor.execute>>;
  try {
    result = await executor.execute(parsed.data.code);
  } catch (error) {
    logEveExecutorFailure({
      requestId,
      durationMs: Math.round(performance.now() - startedAt),
      userId,
      sessionId,
      codeChars: parsed.data.code.length,
      patternCount: parsed.data.executorToolPatterns?.length ?? 0,
      phase: "execute",
      error,
    });
    return respond(Response.json({ error: "Executor execution failed" }, { status: 500 }), {
      codeChars: parsed.data.code.length,
      patternCount: parsed.data.executorToolPatterns?.length ?? 0,
    });
  }

  return respond(Response.json(result), {
    codeChars: parsed.data.code.length,
    patternCount: parsed.data.executorToolPatterns?.length ?? 0,
  });
}
