import { useCallback } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import {
  ResumeApprovalPage,
  ResumeApprovalPageView,
} from "@executor-js/react/pages/resume-approval";

import { mcpPausedExecutionAtom, resumeMcpExecution } from "../web/mcp-resume-atoms";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    mcp_session_id: Schema.optional(Schema.String),
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
    return <CloudMcpResumeApproval executionId={executionId} mcpSessionId={mcpSessionId} />;
  }
  return <ResumeApprovalPage executionId={executionId} />;
}

function CloudMcpResumeApproval(props: { executionId: string; mcpSessionId: string }) {
  const paused = useAtomValue(mcpPausedExecutionAtom(props.mcpSessionId, props.executionId));
  const doResume = useAtomSet(resumeMcpExecution, { mode: "promiseExit" });
  const resume = useCallback(
    (
      executionId: string,
      action: "accept" | "decline" | "cancel",
      content?: Record<string, unknown>,
    ) =>
      doResume({
        params: {
          mcpSessionId: props.mcpSessionId,
          executionId,
        },
        payload: action === "accept" ? { action, content: content ?? {} } : { action },
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
