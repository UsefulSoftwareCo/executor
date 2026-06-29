import { useCallback } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Data, Effect, Option, Schema } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import { createFileRoute } from "@tanstack/react-router";

import { ResumeApprovalPage, ResumeApprovalPageView } from "../pages/resume-approval";
import { getExecutorServerAuthorizationHeader } from "../api/server-connection";
import type { ElicitationAction } from "../components/elicitation-approval";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    mcp_session_id: Schema.optional(Schema.String),
  }),
);
const LocalMcpResumeCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  text: Schema.String,
  structured: Schema.Unknown,
  isError: Schema.Boolean,
});
const LocalMcpResumePaused = Schema.Struct({
  status: Schema.Literal("paused"),
  text: Schema.String,
  structured: Schema.Unknown,
});
const LocalMcpResumeResult = Schema.Union([LocalMcpResumeCompleted, LocalMcpResumePaused]);
const decodeLocalMcpResumeResult = Schema.decodeUnknownOption(LocalMcpResumeResult);

class LocalMcpResumeError extends Data.TaggedError("LocalMcpResumeError")<{
  readonly message: string;
}> {}

const McpPausedExecutionInfo = Schema.Struct({
  text: Schema.String,
  structured: Schema.Unknown,
});
const decodeMcpPausedExecutionInfo = Schema.decodeUnknownOption(McpPausedExecutionInfo);

// Paused-execution detail for the in-process / Cloudflare hosts, fetched
// session-scoped: the MCP paused execution lives in its session's engine, so it
// is resolved through `/api/mcp-sessions/:id/...`, not the session-less
// `/api/executions/:id` (which hits a different engine and can't see it). Cloud
// serves the equivalent through its own route + Durable Object RPC.
const mcpPausedExecutionAtom = Atom.family(
  (key: { readonly mcpSessionId: string; readonly executionId: string }) =>
    Atom.make(
      Effect.gen(function* () {
        // `/api/mcp-sessions/*` is bearer-gated. Attach the bearer (standalone
        // web reads it from localStorage; desktop injects it at the session
        // layer, so this is null and we send none) — otherwise this 401s on the
        // single-user local server and the page shows "unavailable".
        const authorization = getExecutorServerAuthorizationHeader();
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(
              `/api/mcp-sessions/${encodeURIComponent(key.mcpSessionId)}/executions/${encodeURIComponent(key.executionId)}`,
              authorization ? { headers: { authorization } } : undefined,
            ),
          catch: () => new LocalMcpResumeError({ message: "Failed to load the paused execution." }),
        });
        if (!response.ok) {
          return yield* new LocalMcpResumeError({
            message: `Paused execution unavailable (${response.status}).`,
          });
        }
        const body = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () => new LocalMcpResumeError({ message: "Paused response was not valid JSON." }),
        });
        const decoded = decodeMcpPausedExecutionInfo(body);
        if (Option.isNone(decoded)) {
          return yield* new LocalMcpResumeError({
            message: "Paused response had an unexpected shape.",
          });
        }
        return decoded.value;
      }),
    ),
);

type LocalMcpResumeInput = {
  readonly mcpSessionId: string;
  readonly executionId: string;
  readonly action: ElicitationAction;
  readonly content?: Record<string, unknown>;
};

const resumeLocalMcpExecution = Atom.fn<LocalMcpResumeInput>()((input) =>
  Effect.gen(function* () {
    // `/api/mcp-sessions/*` is bearer-gated like the rest of /api. Attach the
    // bearer the same way the typed client does (standalone web reads it from
    // localStorage; on desktop the connection carries no auth and the main
    // process injects the header, so this is null and we send none).
    const authorization = getExecutorServerAuthorizationHeader();
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `/api/mcp-sessions/${encodeURIComponent(input.mcpSessionId)}/executions/${encodeURIComponent(input.executionId)}/resume`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authorization ? { authorization } : {}),
            },
            body: JSON.stringify(
              input.action === "accept"
                ? { action: input.action, content: input.content ?? {} }
                : { action: input.action },
            ),
          },
        ),
      catch: () => new LocalMcpResumeError({ message: "Failed to submit approval." }),
    });

    if (!response.ok) {
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => "",
      }).pipe(Effect.orElseSucceed(() => ""));
      return yield* new LocalMcpResumeError({
        message: body || `Approval request failed (${response.status}).`,
      });
    }

    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new LocalMcpResumeError({ message: "Approval response was not valid JSON." }),
    });
    const result = decodeLocalMcpResumeResult(body);
    if (Option.isNone(result)) {
      return yield* new LocalMcpResumeError({
        message: "Approval response had an unexpected shape.",
      });
    }
    return result.value;
  }),
);

export const Route = createFileRoute("/{-$orgSlug}/resume/$executionId")({
  validateSearch: SearchParams,
  component: RouteComponent,
});

function RouteComponent() {
  const { executionId } = Route.useParams();
  const { mcp_session_id: mcpSessionId } = Route.useSearch();
  if (mcpSessionId) {
    return <LocalMcpResumeApproval executionId={executionId} mcpSessionId={mcpSessionId} />;
  }
  return <ResumeApprovalPage executionId={executionId} />;
}

function LocalMcpResumeApproval(props: { executionId: string; mcpSessionId: string }) {
  const paused = useAtomValue(
    mcpPausedExecutionAtom({ mcpSessionId: props.mcpSessionId, executionId: props.executionId }),
  );
  const doResume = useAtomSet(resumeLocalMcpExecution, { mode: "promiseExit" });
  const resume = useCallback(
    (executionId: string, action: ElicitationAction, content?: Record<string, unknown>) =>
      doResume({
        mcpSessionId: props.mcpSessionId,
        executionId,
        action,
        content,
      }),
    [doResume, props.mcpSessionId],
  );

  return (
    <ResumeApprovalPageView
      executionId={props.executionId}
      paused={paused}
      resume={resume}
      unavailableMessage="This paused execution is no longer available. It may have already been resumed, or the MCP session may have expired."
    />
  );
}
