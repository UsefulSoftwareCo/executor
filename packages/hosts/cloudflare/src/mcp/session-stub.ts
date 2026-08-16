import type { ResumeResponse } from "@executor-js/execution";

import type {
  IncomingTraceHeaders,
  McpApprovalOwner,
  McpSessionApprovalResult,
  McpSessionModelResumeResult,
  McpSessionResumeApprovalResult,
} from "./agent-session-durable-object";
import { modernMcpDurableObjectId, type McpExecutionOwnerRoute } from "./execution-owner-directory";

export interface McpSessionNamespace<Id> {
  readonly idFromString: (id: string) => Id;
  readonly get: (id: Id) => unknown;
}

/** Session namespace surface for unique sessionful and modern Durable Objects. */
export type McpOwnerSessionNamespace<Id> = McpSessionNamespace<Id>;

export interface McpSessionFactoryNamespace<Id> extends McpSessionNamespace<Id> {
  readonly newUniqueId: () => Id;
}

export interface McpSessionStub {
  readonly fetch: (request: Request) => Promise<Response>;
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
  // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers types expose only DurableObjectStub, but fetch and RPC methods are generated from the bound DO class.
  namespace.get(namespace.idFromString(sessionId)) as unknown as McpSessionStub;

/** Allocate one unique session DO and return its client-visible ID and stub. */
export const createMcpSessionStub = <Id>(
  namespace: McpSessionFactoryNamespace<Id>,
): { readonly sessionId: string; readonly stub: McpSessionStub } => {
  const id = namespace.newUniqueId();
  return {
    sessionId: String(id),
    // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers generates fetch and RPC methods from the bound DO class.
    stub: namespace.get(id) as unknown as McpSessionStub,
  };
};

/** Resolve an execution owner route to its unique modern or sessionful DO. */
export const mcpSessionStubForOwner = <Id>(
  namespace: McpOwnerSessionNamespace<Id>,
  owner: McpExecutionOwnerRoute,
): McpSessionStub => {
  const modernId = modernMcpDurableObjectId(owner);
  const id = namespace.idFromString(modernId ?? owner.sessionId);
  // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers generates this RPC surface from the bound DO class.
  return namespace.get(id) as unknown as McpSessionStub;
};
