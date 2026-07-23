import { Effect, Layer } from "effect";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { jsonRpcErrorBody } from "./envelope";
import type { McpBuildServer } from "./in-memory-session-store";
import { McpSessionStore, defaultMcpResource, type McpDispatchResult } from "./seams";

/** A request-isolated MCP store for hosts that cannot retain process memory. */
export interface StatelessMcpSessionStore {
  readonly store: McpSessionStore["Service"];
  readonly close: () => Promise<void>;
}

const buildFailureResponse = (): Response =>
  jsonRpcErrorBody(500, -32603, "Internal server error", { cors: false });

/**
 * Build a fresh MCP server and transport for every POST. The transport omits a
 * session id, so clients never attempt to address process-local state on a
 * later request. Stateful resume and browser approval are therefore unavailable.
 */
export const makeStatelessMcpSessionStore = (
  buildServer: McpBuildServer,
): StatelessMcpSessionStore => {
  const dispatch: McpSessionStore["Service"]["dispatch"] = ({
    request,
    principal,
    resource,
    sessionId,
  }): Effect.Effect<McpDispatchResult> => {
    if (sessionId) return Effect.succeed("not-found");

    return buildServer(principal, {
      resource: resource ?? defaultMcpResource,
      stateless: true,
      elicitationMode: { mode: "model" },
    }).pipe(
      Effect.flatMap(({ mcpServer }) =>
        Effect.promise(async () => {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          await mcpServer.connect(transport);
          // JSON mode lets us materialize the response before closing the
          // request-scoped server, avoiding a dangling stream after teardown.
          const response = await transport.handleRequest(request);
          const body = await response.arrayBuffer();
          return new Response(body.byteLength === 0 ? null : body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }).pipe(
          Effect.ensuring(
            Effect.ignore(
              Effect.tryPromise({ try: () => mcpServer.close(), catch: () => undefined }),
            ),
          ),
        ),
      ),
      Effect.catchTag("McpEngineBuildError", () => Effect.succeed(buildFailureResponse())),
    );
  };

  return {
    store: {
      supportsServerSentEvents: false,
      dispatch,
      dispose: () => Effect.void,
    },
    close: () => Promise.resolve(),
  };
};

/** Layer wrapping a stateless store for the shared MCP serving envelope. */
export const statelessMcpSessionsLayer = (
  built: StatelessMcpSessionStore,
): Layer.Layer<McpSessionStore> => Layer.succeed(McpSessionStore)(built.store);
