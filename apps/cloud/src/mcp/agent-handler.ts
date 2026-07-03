import { Effect, Predicate } from "effect";

import {
  McpAuthProvider,
  jsonRpcErrorBody,
  defaultMcpResource,
  type AuthOutcome,
  type McpResource,
} from "@executor-js/host-mcp";
import {
  currentPropagationHeaders,
  readElicitationMode,
  withVerifiedIdentityHeaders,
} from "@executor-js/cloudflare/mcp/do-headers";
import type { McpSessionProps } from "@executor-js/cloudflare/mcp/agent-durable-object";

import { wrapMcpSseResponse } from "../observability/memory-metrics";
import { cloudMcpAuth } from "./auth-provider";
import { McpSessionDOSqlite } from "./session-durable-object";

interface McpAgentSessionStub {
  readonly validateMcpSessionOwner: (identity: {
    readonly accountId: string;
    readonly organizationId: string;
  }) => Promise<"ok" | "not_found" | "forbidden">;
  readonly _cf_scheduleDestroy: () => Promise<void>;
}

const corsPreflightResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "content-type, authorization, mcp-session-id, accept, mcp-protocol-version",
      "access-control-expose-headers": "mcp-session-id, WWW-Authenticate",
    },
  });

const jsonRpcResponse = (
  status: number,
  code: number,
  message: string,
  challenge?: string,
): Response =>
  challenge === undefined
    ? jsonRpcErrorBody(status, code, message)
    : jsonRpcErrorBody(status, code, message, { challenge });

const renderAuthError = (
  auth: McpAuthProvider["Service"],
  request: Request,
  outcome: Exclude<AuthOutcome, { readonly _tag: "Authenticated" }>,
): Response => {
  if (Predicate.isTagged(outcome, "Unauthorized")) {
    return jsonRpcResponse(
      401,
      -32001,
      "Unauthorized",
      outcome.challenge ?? `Bearer resource_metadata="${auth.resourceMetadataUrl(request)}"`,
    );
  }
  if (Predicate.isTagged(outcome, "Forbidden")) {
    return jsonRpcResponse(403, outcome.code ?? -32001, outcome.message);
  }
  return jsonRpcResponse(503, -32001, outcome.message);
};

const sessionStub = (env: Env, sessionId: string): McpAgentSessionStub =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: Workers types expose only DurableObjectStub, but RPC methods are generated from the bound DO class.
  env.MCP_SESSION.get(
    env.MCP_SESSION.idFromName(`streamable-http:${sessionId}`),
  ) as unknown as McpAgentSessionStub;

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    const outcome = yield* auth.authenticate(request);
    return { auth, outcome };
  }).pipe(Effect.provide(cloudMcpAuth));

// The MCP resource the request targets. `server.ts` routes both the bare `/mcp`
// and `/mcp/toolkits/<slug>` to this handler (`prepareMcpOrgScope` strips the org
// selector but keeps the toolkit segment), so a session minted on a toolkit path
// scopes its tool catalog to that toolkit.
const resourceFromPath = (request: Request): McpResource => {
  const segments = new URL(request.url).pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 3 && segments[0] === "mcp" && segments[1] === "toolkits" && segments[2]) {
    return { kind: "toolkit", slug: segments[2] };
  }
  return defaultMcpResource;
};

const propsForPrincipal = (
  request: Request,
  principal: Extract<AuthOutcome, { readonly _tag: "Authenticated" }>["principal"],
  resource: McpResource,
): Effect.Effect<McpSessionProps> =>
  Effect.gen(function* () {
    const propagation = yield* currentPropagationHeaders(request);
    return {
      session: {
        organizationId: principal.organizationId,
        userId: principal.accountId,
        elicitationMode: readElicitationMode(request),
        resource,
        webOrigin: new URL(request.url).origin,
      },
      propagation,
    };
  });

export const makeCloudMcpAgentHandler = () => {
  const serveOptions = { binding: "MCP_SESSION", transport: "streamable-http" } as const;
  const serve = McpSessionDOSqlite.serve("/mcp", serveOptions);
  const serveToolkit = McpSessionDOSqlite.serve("/mcp/toolkits/:slug", serveOptions);

  const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);

  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    if (request.method === "OPTIONS") return corsPreflightResponse();
    if (!ALLOWED_METHODS.has(request.method)) {
      return jsonRpcResponse(405, -32001, "Method not allowed");
    }
    const sessionId = request.headers.get("mcp-session-id");

    const { auth, outcome } = await Effect.runPromise(authenticate(request));
    if (!Predicate.isTagged(outcome, "Authenticated")) {
      if (Predicate.isTagged(outcome, "Forbidden") && sessionId) {
        await Effect.runPromise(
          Effect.ignore(Effect.tryPromise(() => sessionStub(env, sessionId)._cf_scheduleDestroy())),
        );
      }
      return renderAuthError(auth, request, outcome);
    }

    if (!sessionId && request.method === "DELETE") {
      return new Response(null, { status: 200, headers: { "access-control-allow-origin": "*" } });
    }

    if (sessionId) {
      const owner = await sessionStub(env, sessionId).validateMcpSessionOwner({
        accountId: outcome.principal.accountId,
        organizationId: outcome.principal.organizationId,
      });
      if (owner === "not_found") {
        return jsonRpcResponse(404, -32001, "Session not found");
      }
      if (owner === "forbidden") {
        return jsonRpcResponse(403, -32003, "MCP session does not belong to the current bearer");
      }
    }

    const resource = resourceFromPath(request);
    const props = await Effect.runPromise(propsForPrincipal(request, outcome.principal, resource));
    (ctx as ExecutionContext & { props?: McpSessionProps }).props = props;
    const forwarded = withVerifiedIdentityHeaders(
      request,
      {
        accountId: outcome.principal.accountId,
        organizationId: outcome.principal.organizationId,
      },
      resource,
    );
    const target = resource.kind === "toolkit" ? serveToolkit : serve;
    let response: Response;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: the agents SDK aborts the isolate instead of returning a response for a condemned session
    try {
      response = await target.fetch(forwarded, env, ctx);
    } catch (error) {
      // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: the abort reason is a plain runtime Error whose message is the signal
      if (Predicate.isError(error) && error.message === "destroyed") {
        return jsonRpcResponse(404, -32001, "Session timed out, please reconnect");
      }
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: preserve unexpected Workers runtime failures
      throw error;
    }
    if (request.method === "DELETE" && response.status === 204) {
      return new Response(null, { status: 200, headers: response.headers });
    }
    return wrapMcpSseResponse(request, env, response);
  };
};
