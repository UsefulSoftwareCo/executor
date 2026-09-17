import type { ResumeResponse } from "@executor-js/execution";
import type { McpResource } from "@executor-js/host-mcp";

import type {
  IncomingTraceHeaders,
  McpApprovalOwner,
  McpApprovalPrincipal,
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
    resource: McpResource,
  ) => Promise<"ok" | "not_found" | "forbidden" | "terminated">;
  readonly _cf_scheduleDestroy: () => Promise<void>;
  readonly getPausedExecutionForApproval: (
    executionId: string,
    identity: McpApprovalOwner,
    incoming?: IncomingTraceHeaders,
  ) => Promise<McpSessionApprovalResult>;
  readonly resumeExecutionForApproval: (
    executionId: string,
    identity: McpApprovalPrincipal,
    response: ResumeResponse,
    incoming?: IncomingTraceHeaders,
  ) => Promise<McpSessionResumeApprovalResult>;
  readonly resumeExecutionForModel: (
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
    incoming?: IncomingTraceHeaders,
  ) => Promise<McpSessionModelResumeResult>;
  /**
   * Ask this session's OWN Durable Object instance to tear down its resident
   * runtime because the isolate is over its cap. Routed through the stub
   * rather than called on an in-process reference so the teardown runs in
   * this session's own IoContext — see `requestSelfEviction` on the base
   * class for why that boundary matters.
   */
  readonly requestCapEviction: () => Promise<void>;
}

export const mcpSessionStub = <Id>(
  namespace: McpSessionNamespace<Id>,
  sessionId: string,
): McpSessionStub =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers types expose only DurableObjectStub, but RPC methods are generated from the bound DO class.
  namespace.get(
    namespace.idFromName(mcpSessionDurableObjectName(sessionId)),
  ) as unknown as McpSessionStub;
