import type { ResumeResponse } from "@executor-js/execution";

import type {
  IncomingTraceHeaders,
  McpApprovalOwner,
  McpSessionApprovalResult,
  McpSessionModelResumeResult,
  McpSessionResumeApprovalResult,
} from "./agent-session-durable-object";
import {
  modernMcpDurableObjectId,
  mcpSessionDurableObjectName,
  type McpExecutionOwnerRoute,
} from "./execution-owner-directory";

export interface McpSessionNamespace<Id> {
  readonly idFromName: (name: string) => Id;
  readonly get: (id: Id) => unknown;
}

/** Session namespace surface that can address both named legacy and unique modern DOs. */
export interface McpOwnerSessionNamespace<Id> extends McpSessionNamespace<Id> {
  readonly idFromString: (id: string) => Id;
}

export interface McpSessionStub {
  readonly validateMcpSessionOwner: (
    identity: McpApprovalOwner,
  ) => Promise<"ok" | "not_found" | "forbidden" | "terminated">;
  readonly _cf_scheduleDestroy: () => Promise<void>;
  readonly getPausedExecutionForApproval: (
    executionId: string,
    identity: McpApprovalOwner,
    incoming?: IncomingTraceHeaders,
  ) => Promise<McpSessionApprovalResult>;
  readonly resumeExecutionForApproval: (
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
    incoming?: IncomingTraceHeaders,
  ) => Promise<McpSessionResumeApprovalResult>;
  readonly resumeExecutionForModel: (
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
    incoming?: IncomingTraceHeaders,
  ) => Promise<McpSessionModelResumeResult>;
}

export const mcpSessionStub = <Id>(
  namespace: McpSessionNamespace<Id>,
  sessionId: string,
): McpSessionStub =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers types expose only DurableObjectStub, but RPC methods are generated from the bound DO class.
  namespace.get(
    namespace.idFromName(mcpSessionDurableObjectName(sessionId)),
  ) as unknown as McpSessionStub;

/** Resolve an execution owner route to its legacy named or modern unique DO. */
export const mcpSessionStubForOwner = <Id>(
  namespace: McpOwnerSessionNamespace<Id>,
  owner: McpExecutionOwnerRoute,
): McpSessionStub => {
  const modernId = modernMcpDurableObjectId(owner);
  const id = modernId
    ? namespace.idFromString(modernId)
    : namespace.idFromName(mcpSessionDurableObjectName(owner.sessionId));
  // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers generates this RPC surface from the bound DO class.
  return namespace.get(id) as unknown as McpSessionStub;
};
