import type { ResumeResponse } from "@executor-js/execution";

import type {
  IncomingTraceHeaders,
  McpApprovalOwner,
  McpSessionApprovalResult,
  McpSessionModelResumeResult,
  McpSessionResumeApprovalResult,
} from "./agent-session-durable-object";
import { mcpSessionDurableObjectName } from "./execution-owner-directory";

export interface McpSessionNamespace<Id> {
  readonly idFromName: (name: string) => Id;
  readonly get: (id: Id) => unknown;
}

export interface McpSessionStub {
  readonly validateMcpSessionOwner: (
    identity: McpApprovalOwner,
  ) => Promise<"ok" | "not_found" | "forbidden">;
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
