import { useCallback } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Data, Effect, Option, Schema } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import { createFileRoute } from "@tanstack/react-router";
import {
  ResumeApprovalPage,
  ResumeApprovalPageView,
} from "@executor-js/react/pages/resume-approval";
import { pausedExecutionAtom } from "@executor-js/react/api/atoms";
import type { ElicitationAction } from "@executor-js/react/components/elicitation-approval";

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

type LocalMcpResumeInput = {
  readonly mcpSessionId: string;
  readonly executionId: string;
  readonly action: ElicitationAction;
  readonly content?: Record<string, unknown>;
};

const resumeLocalMcpExecution = Atom.fn<LocalMcpResumeInput>()((input) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `/api/mcp-sessions/${encodeURIComponent(input.mcpSessionId)}/executions/${encodeURIComponent(input.executionId)}/resume`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
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

export const Route = createFileRoute("/resume/$executionId")({
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
  const paused = useAtomValue(pausedExecutionAtom(props.executionId));
  const doResume = useAtomSet(resumeLocalMcpExecution, { mode: "promiseExit" });
  const resume = useCallback(
    (executionId: string, action: ElicitationAction, content?: Record<string, unknown>) =>
      doResume({ mcpSessionId: props.mcpSessionId, executionId, action, content }),
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
