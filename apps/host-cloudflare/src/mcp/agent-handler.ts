import { Effect, Predicate } from "effect";

import {
  McpAuthProvider,
  jsonRpcErrorBody,
  defaultMcpResource,
  type AuthOutcome,
  type Principal,
} from "@executor-js/host-mcp";
import { requestBodyFromRequest } from "@executor-js/host-mcp/tool-server";
import {
  currentPropagationHeaders,
  readArtifactsEnabled,
  readElicitationMode,
  withMcpResponseHeaders,
  withPropagationHeaders,
  withVerifiedIdentityHeaders,
} from "@executor-js/cloudflare/mcp/do-headers";
import type { McpSessionProps } from "@executor-js/cloudflare/mcp/agent-durable-object";
import {
  classifyMcpProtocolEra,
  makeMcpModernRequestRouter,
  mcpCorsPreflightResponse,
  requireMcpRequestStateKey,
} from "@executor-js/cloudflare/mcp/modern-request-router";
import { mcpExecutionOwnerDirectoryFromNamespace } from "@executor-js/cloudflare/mcp/execution-owner-directory";
import { createMcpSessionStub, mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { cloudflareAccessMcpAuth } from "./auth";
import { makeCloudflareModernMcpServerBuilder } from "./session-durable-object";

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
        // host-cloudflare only routes the bare `/mcp` endpoint to the session
        // Durable Object (see worker.ts), so it always serves the default
        // resource.
        resource: defaultMcpResource,
        webOrigin: new URL(request.url).origin,
      },
      propagation,
    };
  });

export const makeCloudflareMcpAgentHandler = (config: CloudflareConfig) => {
  const modern = makeMcpModernRequestRouter();
  return async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return mcpCorsPreflightResponse(request.headers.get("access-control-request-headers"));
    }
    const sessionId = request.headers.get("mcp-session-id");

    const { auth, outcome } = await Effect.runPromise(authenticate(request, config));
    if (!Predicate.isTagged(outcome, "Authenticated")) {
      if (Predicate.isTagged(outcome, "Forbidden") && sessionId) {
        const session = mcpSessionStub(env.MCP_SESSION, sessionId);
        await Effect.runPromise(
          Effect.ignore(
            session ? Effect.tryPromise(() => session._cf_scheduleDestroy()) : Effect.void,
          ),
        );
      }
      return renderAuthError(auth, request, outcome);
    }

    const parsedBody = await Effect.runPromise(requestBodyFromRequest(request));
    const era = await classifyMcpProtocolEra(request, parsedBody);
    if (era === "modern") {
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
      return modern.fetch({
        request: forwarded,
        parsedBody,
        principal: outcome.principal,
        resource: defaultMcpResource,
        props,
        requestStateSigningKey: requireMcpRequestStateKey(env.MCP_REQUEST_STATE_KEY),
        builder: makeCloudflareModernMcpServerBuilder(env, config, props.session),
        sessions: env.MCP_SESSION,
        executionOwners: mcpExecutionOwnerDirectoryFromNamespace(env.MCP_EXECUTION_OWNER),
      });
    }

    if (!sessionId && request.method === "DELETE") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    }

    const existingSession = sessionId ? mcpSessionStub(env.MCP_SESSION, sessionId) : null;
    if (sessionId && !existingSession) {
      return jsonRpcResponse(404, -32001, "Session not found");
    }
    if (existingSession) {
      const owner = await existingSession.validateMcpSessionOwner({
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

    const propagation = await Effect.runPromise(currentPropagationHeaders(request));
    const forwarded = withPropagationHeaders(
      withVerifiedIdentityHeaders(
        request,
        {
          accountId: outcome.principal.accountId,
          organizationId: outcome.principal.organizationId,
        },
        defaultMcpResource,
      ),
      propagation,
    );
    const target = existingSession ?? createMcpSessionStub(env.MCP_SESSION).stub;
    return withMcpResponseHeaders(await target.fetch(forwarded));
  };
};
