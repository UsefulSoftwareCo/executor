import { z } from "zod";
import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import { persistEveChatSessionPatch } from "@/lib/db/sessions";
import type { HandleMessageStreamEvent, SessionState } from "eve/client";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

const sessionStateSchema = z
  .object({
    continuationToken: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    streamIndex: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<SessionState>;

const streamEventSchema = z.custom<HandleMessageStreamEvent>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.length > 0,
);

const persistenceRequestSchema = z
  .object({
    events: z.array(streamEventSchema).default([]),
    firstStreamIndex: z.number().int().nonnegative().optional(),
    session: sessionStateSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.events.length > 0 && value.firstStreamIndex === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "firstStreamIndex is required when events are present",
        path: ["firstStreamIndex"],
      });
    }
  });

function runtimeModelId(events: HandleMessageStreamEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "session.started") {
      return event.data.runtime?.modelId;
    }
  }
}

function logEveRuntimeFailures(input: {
  appSessionId: string;
  chatId: string;
  events: HandleMessageStreamEvent[];
}): void {
  const modelId = runtimeModelId(input.events);

  for (const event of input.events) {
    if (
      event.type !== "step.failed" &&
      event.type !== "turn.failed" &&
      event.type !== "session.failed"
    ) {
      continue;
    }

    console.error("[Eve chat] runtime failure", {
      appSessionId: input.appSessionId,
      chatId: input.chatId,
      eventType: event.type,
      modelId,
      code: event.data.code,
      message: event.data.message,
      ...(event.type === "session.failed" ? { eveSessionId: event.data.sessionId } : {}),
      ...(event.type === "step.failed" || event.type === "turn.failed"
        ? {
            sequence: event.data.sequence,
            turnId: event.data.turnId,
          }
        : {}),
      ...(event.type === "step.failed" ? { stepIndex: event.data.stepIndex } : {}),
    });
  }
}

export async function POST(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId, chatId } = await context.params;
  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
    verb: "write",
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Invalid Eve persistence payload" },
      { status: 400 },
    );
  }

  const parsed = persistenceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid Eve persistence payload" },
      { status: 400 },
    );
  }

  const { events, firstStreamIndex, session } = parsed.data;
  if (events.length > 0) {
    logEveRuntimeFailures({ appSessionId: sessionId, chatId, events });
    await persistEveChatSessionPatch({
      chatId,
      events,
      firstStreamIndex: firstStreamIndex!,
      ...(session ? { session } : {}),
    });
  } else if (session) {
    await persistEveChatSessionPatch({ chatId, session });
  }

  return Response.json({
    success: true,
  });
}
