import type { McpResource } from "@executor-js/host-mcp";

import type { IncomingPropagationHeaders, McpElicitationMode } from "./do-headers";

// ---------------------------------------------------------------------------
// The injection seams shared between the worker-side DO dispatcher and the
// DO-side base class. A host (cloud / host-cloudflare) supplies its own DO
// namespace + runtime builder; everything else is platform-generic.
// ---------------------------------------------------------------------------

/** What the worker tells the session DO at creation (owner + elicitation mode). */
export interface McpSessionInit {
  readonly organizationId: string;
  readonly userId: string;
  readonly resource: McpResource;
  readonly elicitationMode: McpElicitationMode;
  /** Public origin of the create request (`https://host`), so the DO derives a
   *  web base URL zero-config when the host configures no static one. */
  readonly webOrigin?: string;
}

/**
 * The RPC surface the worker calls on a session-DO stub. The DO base class
 * (McpSessionDOBase) implements these; a host's concrete DO subclass inherits
 * them. The worker dispatcher only depends on this interface, not the class.
 */
export interface McpSessionDOStub {
  init(meta: McpSessionInit, propagation: IncomingPropagationHeaders): Promise<void>;
  handleRequest(request: Request): Promise<Response>;
  clearSession(propagation: IncomingPropagationHeaders): Promise<void>;
}
