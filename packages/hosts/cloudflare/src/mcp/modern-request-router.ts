import { Effect, Exit, Option, Schema } from "effect";
import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
  type McpRequestContext,
} from "@modelcontextprotocol/server";

import {
  jsonRpcErrorBody,
  mcpResourceKey,
  type McpModernServerBuilder,
  type McpResource,
  type Principal,
} from "@executor-js/host-mcp";
import {
  appsEnabledForClientCapabilities,
  clientCapabilitiesFromRequestBody,
  mcpRequestStatePrincipal,
  verifyNativeRequestState,
} from "@executor-js/host-mcp/tool-server";

import type { McpSessionProps } from "./agent-session-durable-object";
import type { McpExecutionOwnerDirectory } from "./execution-owner-directory";
import { mcpSessionStubForOwner } from "./session-stub";

const MCP_CORS_EXPOSED_HEADERS = "mcp-session-id, mcp-protocol-version, WWW-Authenticate";
const MCP_CORS_ALLOWED_HEADERS =
  "content-type, authorization, mcp-session-id, accept, mcp-protocol-version, mcp-method, mcp-name";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const ModernToolsCallMethod = Schema.Struct({ method: Schema.Literal("tools/call") });
const ModernToolCall = Schema.Struct({
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.String,
    arguments: Schema.optional(UnknownRecord),
    requestState: Schema.optional(Schema.String),
  }),
});
type ModernToolCall = typeof ModernToolCall.Type;
const decodeModernToolsCallMethod = Schema.decodeUnknownOption(ModernToolsCallMethod);
const decodeModernToolCall = Schema.decodeUnknownOption(ModernToolCall);

interface ModernRequestInputs {
  readonly builder: McpModernServerBuilder["Service"];
  readonly parsedBody: unknown;
  readonly principal: Principal;
  readonly requestStateSigningKey: string;
}

/** Durable Object namespace surface required by modern execution routing. */
export interface McpModernSessionNamespace<Id> {
  readonly newUniqueId: () => Id;
  readonly idFromName: (name: string) => Id;
  readonly idFromString: (id: string) => Id;
  readonly get: (id: Id) => unknown;
}

/** Worker-callable modern RPC exposed by the MCP session Durable Object. */
export interface McpModernSessionStub {
  readonly serveModernMcp: (
    request: Request,
    props: McpSessionProps,
    parsedBody: unknown,
  ) => Promise<Response>;
}

/** Inputs needed to dispatch one authenticated modern MCP request. */
export interface McpModernRequestDispatch<Id> {
  readonly request: Request;
  readonly parsedBody: unknown;
  readonly principal: Principal;
  readonly resource: McpResource;
  readonly props: McpSessionProps;
  readonly requestStateSigningKey: string;
  readonly builder: McpModernServerBuilder["Service"];
  readonly sessions: McpModernSessionNamespace<Id>;
  readonly executionOwners: McpExecutionOwnerDirectory | null;
}

/** Resource-cached worker router for authenticated 2026-07-28 requests. */
export interface McpModernRequestRouter {
  readonly fetch: <Id>(input: McpModernRequestDispatch<Id>) => Promise<Response>;
  readonly close: () => Promise<void>;
}

/** Validate the shared request-state secret at the first modern request boundary. */
export const requireMcpRequestStateKey = (value: string | undefined): string => {
  if (value !== undefined && new TextEncoder().encode(value).byteLength >= 32) return value;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- composition boundary: modern MCP cannot safely serve or route continuation state without a deployment-provided HMAC key
  throw new Error(
    "MCP_REQUEST_STATE_KEY must be set to a secret of at least 32 bytes before serving MCP 2026-07-28 requests",
  );
};

/** Build the MCP preflight response, echoing dynamic modern header names. */
export const mcpCorsPreflightResponse = (requestedHeaders?: string | null): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        requestedHeaders && requestedHeaders.trim() !== ""
          ? requestedHeaders
          : MCP_CORS_ALLOWED_HEADERS,
      "access-control-expose-headers": MCP_CORS_EXPOSED_HEADERS,
    },
  });

/** Classify an already-parsed request with the SDK's canonical era predicate. */
export const classifyMcpProtocolEra = (
  request: Request,
  parsedBody: unknown,
): Promise<"legacy" | "modern"> =>
  isLegacyRequest(request, parsedBody).then((legacy) => (legacy ? "legacy" : "modern"));

const withModernMcpCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", MCP_CORS_EXPOSED_HEADERS);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const toModernSessionStub = (stub: unknown): McpModernSessionStub =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers generates the RPC surface from the bound Durable Object class, while the portable namespace type exposes unknown.
  stub as unknown as McpModernSessionStub;

const stubForOwner = <Id>(
  sessions: McpModernSessionNamespace<Id>,
  owner: { readonly sessionId: string },
): McpModernSessionStub | null => {
  const stub = mcpSessionStubForOwner(sessions, owner);
  return stub ? toModernSessionStub(stub) : null;
};

const freshStub = <Id>(sessions: McpModernSessionNamespace<Id>): McpModernSessionStub =>
  toModernSessionStub(sessions.get(sessions.newUniqueId()));

const resumeExecutionId = (call: ModernToolCall): string | null => {
  if (call.params.name !== "resume") return null;
  const executionId = call.params.arguments?.executionId;
  return typeof executionId === "string" && executionId.length > 0 ? executionId : null;
};

/** Build the shared worker-side modern handler and DO-affinity router. */
export const makeMcpModernRequestRouter = (): McpModernRequestRouter => {
  const handlers = new Map<string, McpHttpHandler>();
  const requestInputs = new WeakMap<Request, ModernRequestInputs>();

  const handlerFor = (resource: McpResource): McpHttpHandler => {
    const resourceKey = mcpResourceKey(resource);
    const cached = handlers.get(resourceKey);
    if (cached) return cached;

    const handler = createMcpHandler(
      (context: McpRequestContext) => {
        const request = context.requestInfo;
        const inputs = request ? requestInputs.get(request) : undefined;
        if (!request || !inputs) {
          // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: the third-party factory Promise has no typed failure channel; absent request context is an SDK defect
          return Effect.runPromise(Effect.die("Modern MCP request has no authenticated context"));
        }
        const capabilities = clientCapabilitiesFromRequestBody(inputs.parsedBody);
        return Effect.runPromise(
          inputs.builder.build(inputs.principal, {
            resource,
            appsEnabled: appsEnabledForClientCapabilities(capabilities),
            requestStateSigningKey: inputs.requestStateSigningKey,
            requestStatePrincipal: mcpRequestStatePrincipal(inputs.principal),
          }),
        );
      },
      { legacy: "reject" },
    );
    handlers.set(resourceKey, handler);
    return handler;
  };

  const serveWorker = async <Id>(input: McpModernRequestDispatch<Id>): Promise<Response> => {
    requestInputs.set(input.request, {
      builder: input.builder,
      parsedBody: input.parsedBody,
      principal: input.principal,
      requestStateSigningKey: input.requestStateSigningKey,
    });
    return handlerFor(input.resource).fetch(input.request, { parsedBody: input.parsedBody });
  };

  const serveDo = <Id>(
    stub: McpModernSessionStub,
    input: McpModernRequestDispatch<Id>,
  ): Promise<Response> => stub.serveModernMcp(input.request, input.props, input.parsedBody);

  return {
    fetch: async (input) => {
      if (Option.isNone(decodeModernToolsCallMethod(input.parsedBody))) {
        return withModernMcpCors(await serveWorker(input));
      }

      const decoded = decodeModernToolCall(input.parsedBody);
      if (Option.isNone(decoded)) {
        return withModernMcpCors(await serveDo(freshStub(input.sessions), input));
      }

      const call = decoded.value;
      let executionId = resumeExecutionId(call);
      if (call.params.name === "execute" && call.params.requestState !== undefined) {
        const verified = await Effect.runPromiseExit(
          verifyNativeRequestState({
            state: call.params.requestState,
            method: call.method,
            requestStateSigningKey: input.requestStateSigningKey,
            requestStatePrincipal: mcpRequestStatePrincipal(input.principal),
          }),
        );
        if (Exit.isFailure(verified)) {
          return withModernMcpCors(await serveWorker(input));
        }
        executionId = verified.value.executionId;
      }

      if (executionId === null) {
        return withModernMcpCors(await serveDo(freshStub(input.sessions), input));
      }

      const owner = input.executionOwners
        ? await Effect.runPromise(input.executionOwners.get(executionId))
        : null;
      if (!owner) {
        return withModernMcpCors(await serveWorker(input));
      }
      if (
        owner.accountId !== input.principal.accountId ||
        owner.organizationId !== input.principal.organizationId
      ) {
        return withModernMcpCors(
          jsonRpcErrorBody(403, -32003, "MCP execution does not belong to the current bearer"),
        );
      }
      const ownerStub = stubForOwner(input.sessions, owner.owner);
      return withModernMcpCors(
        ownerStub ? await serveDo(ownerStub, input) : await serveWorker(input),
      );
    },
    close: () =>
      Promise.all(Array.from(handlers.values(), (handler) => handler.close())).then(
        () => undefined,
      ),
  };
};
