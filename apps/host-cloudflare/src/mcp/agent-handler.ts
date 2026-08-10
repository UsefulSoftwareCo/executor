import { Effect, Predicate } from "effect";

import {
  McpAuthProvider,
  jsonRpcErrorBody,
  defaultMcpResource,
  isLegacyMcpRequest,
  mcpResourceKey,
  validateMcpRequestAuthority,
  type AuthOutcome,
  type Principal,
} from "@executor-js/host-mcp";
import {
  currentPropagationHeaders,
  readArtifactsEnabled,
  readElicitationMode,
  withVerifiedIdentityHeaders,
} from "@executor-js/cloudflare/mcp/do-headers";
import type { McpSessionProps } from "@executor-js/cloudflare/mcp/agent-durable-object";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { cloudflareAccessMcpAuth } from "./auth";
import { McpSessionDO } from "./session-durable-object";

const corsPreflightResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "content-type, authorization, mcp-session-id, accept, mcp-protocol-version, mcp-method, mcp-name",
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

const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "mcp-session-id, WWW-Authenticate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

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

const authenticate = (request: Request, config: CloudflareConfig) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    const outcome = yield* auth.authenticate(request);
    return { auth, outcome };
  }).pipe(Effect.provide(cloudflareAccessMcpAuth(config)));

const propsForPrincipal = (
  request: Request,
  principal: Principal,
): Effect.Effect<McpSessionProps> =>
  Effect.gen(function* () {
    const propagation = yield* currentPropagationHeaders(request);
    return {
      session: {
        organizationId: principal.organizationId,
        userId: principal.accountId,
        elicitationMode: readElicitationMode(request),
        artifactsEnabled: readArtifactsEnabled(request),
        // host-cloudflare only routes the bare `/mcp` endpoint to the Agent
        // bridge (see worker.ts), so the session always serves the default
        // resource.
        resource: defaultMcpResource,
        webOrigin: new URL(request.url).origin,
      },
      propagation,
    };
  });

export const makeCloudflareMcpAgentHandler = (config: CloudflareConfig) => {
  const serve = McpSessionDO.serve("/mcp", {
    binding: "MCP_SESSION",
    transport: "streamable-http",
  });
  const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);

  return async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    if (request.method === "OPTIONS") return corsPreflightResponse();
    if (!ALLOWED_METHODS.has(request.method)) {
      return jsonRpcResponse(405, -32001, "Method not allowed");
    }
    const authorityRejection = validateMcpRequestAuthority(request);
    if (authorityRejection) return authorityRejection;
    const sessionId = request.headers.get("mcp-session-id");

    const { auth, outcome } = await Effect.runPromise(authenticate(request, config));
    if (!Predicate.isTagged(outcome, "Authenticated")) {
      if (Predicate.isTagged(outcome, "Forbidden") && sessionId) {
        await Effect.runPromise(
          Effect.ignore(
            Effect.tryPromise(() =>
              mcpSessionStub(env.MCP_SESSION, sessionId)._cf_scheduleDestroy(),
            ),
          ),
        );
      }
      return renderAuthError(auth, request, outcome);
    }

    if (!(await isLegacyMcpRequest(request))) {
      if (env.MCP_2026_07_28_ENABLED === "false") {
        return jsonRpcResponse(503, -32022, "MCP 2026-07-28 support is disabled");
      }
      const props = await Effect.runPromise(propsForPrincipal(request, outcome.principal));
      const flowId = JSON.stringify([
        "modern",
        outcome.principal.accountId,
        outcome.principal.organizationId,
        mcpResourceKey(defaultMcpResource),
      ]);
      const response = await mcpSessionStub(env.MCP_SESSION, flowId).handleModernRequest(
        request,
        outcome.principal,
        props.session,
        props.propagation,
      );
      return withCors(response);
    }

    if (!sessionId && request.method === "DELETE") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    }

    if (sessionId) {
      const owner = await mcpSessionStub(env.MCP_SESSION, sessionId).validateMcpSessionOwner({
        accountId: outcome.principal.accountId,
        organizationId: outcome.principal.organizationId,
      });
      if (owner === "not_found") {
        return jsonRpcResponse(404, -32001, "Session not found");
      }
      if (owner === "terminated") {
        // DELETE-condemned but the deferred destroy alarm hasn't wiped storage
        // yet; the terminated id must read as dead immediately.
        return jsonRpcResponse(404, -32001, "Session timed out, please reconnect");
      }
      if (owner === "forbidden") {
        return jsonRpcResponse(403, -32003, "MCP session does not belong to the current bearer");
      }
    }

    const props = await Effect.runPromise(propsForPrincipal(request, outcome.principal));
    (ctx as ExecutionContext & { props?: McpSessionProps }).props = props;
    const forwarded = withVerifiedIdentityHeaders(
      request,
      {
        accountId: outcome.principal.accountId,
        organizationId: outcome.principal.organizationId,
      },
      defaultMcpResource,
    );
    return serve.fetch(forwarded, env, ctx);
  };
};
