import { Effect, Layer, Predicate } from "effect";

import {
  McpAuthProvider,
  jsonRpcErrorBody,
  mcpModernDisabledResponse,
  defaultMcpResource,
  type AuthOutcome,
  type McpModernServerBuilder,
  type McpResource,
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

const DEAD_SESSION_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEAD_SESSION_CACHE_MAX_ENTRIES = 4_096;
const deadSessionExpiries = new Map<string, number>();
const timedOutSessionIds = new Set<string>();

type DeadSessionReason = "not_found" | "timed_out";

const isDeadSessionCached = (sessionId: string, now = Date.now()): boolean => {
  const expiry = deadSessionExpiries.get(sessionId);
  if (expiry === undefined) return false;
  if (expiry > now) return true;
  deadSessionExpiries.delete(sessionId);
  timedOutSessionIds.delete(sessionId);
  return false;
};

const cacheDeadSession = (sessionId: string, reason: DeadSessionReason, now = Date.now()): void => {
  deadSessionExpiries.delete(sessionId);
  if (deadSessionExpiries.size >= DEAD_SESSION_CACHE_MAX_ENTRIES) {
    const oldestSessionId = deadSessionExpiries.keys().next().value;
    if (oldestSessionId !== undefined) {
      deadSessionExpiries.delete(oldestSessionId);
      timedOutSessionIds.delete(oldestSessionId);
    }
  }
  deadSessionExpiries.set(sessionId, now + DEAD_SESSION_CACHE_TTL_MS);
  if (reason === "timed_out") timedOutSessionIds.add(sessionId);
  else timedOutSessionIds.delete(sessionId);
};

const cachedDeadSessionMessage = (sessionId: string): string =>
  timedOutSessionIds.has(sessionId) ? "Session timed out, please reconnect" : "Session not found";

/** Test-only access to reset and verify the isolate-local dead-session cache. */
export const cloudflareDeadSessionCacheForTest = {
  clear: (): void => {
    deadSessionExpiries.clear();
    timedOutSessionIds.clear();
  },
  remember: (sessionId: string, now?: number): void =>
    cacheDeadSession(sessionId, "not_found", now),
  has: isDeadSessionCached,
  size: (): number => deadSessionExpiries.size,
};

const jsonRpcResponse = (
  status: number,
  code: number,
  message: string,
  challenge?: string,
): Response =>
  challenge === undefined
    ? jsonRpcErrorBody(status, code, message)
    : jsonRpcErrorBody(status, code, message, { challenge });

/**
 * A dead session id answers by request method. POST/DELETE keep the 404 that
 * tells a compliant client to re-initialize. A standalone GET gets 405: the
 * v1 SDK treats that as "no SSE stream offered" and stops retrying quietly,
 * which breaks the reconnect loops of pre-cutover always-on deployments —
 * their GET-404 path never re-initialized, it just retried forever.
 */
const deadSessionResponse = (method: string, message: string): Response =>
  method === "GET"
    ? new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
        status: 405,
        headers: {
          "content-type": "application/json",
          allow: "POST, DELETE",
          "access-control-allow-origin": "*",
        },
      })
    : jsonRpcResponse(404, -32001, message);

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

const authenticate = (request: Request, authProvider: Layer.Layer<McpAuthProvider>) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    const outcome = yield* auth.authenticate(request);
    return { auth, outcome };
  }).pipe(Effect.provide(authProvider));

// The MCP resource the request targets. The worker entry routes both the bare
// `/mcp` endpoint and `/mcp/toolkits/<slug>` here; everything downstream keys
// off the resource this returns — the modern router caches one server per
// resource, and a session Durable Object pins the resource it was opened with
// for its entire lifetime (it rejects a later request carrying a different one).
const resourceFromPath = (request: Request): McpResource => {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 3 && segments[0] === "mcp" && segments[1] === "toolkits" && segments[2]) {
    return { kind: "toolkit", slug: segments[2] };
  }
  return defaultMcpResource;
};

const propsForPrincipal = (
  request: Request,
  principal: Principal,
  resource: McpResource,
): Effect.Effect<McpSessionProps> =>
  Effect.gen(function* () {
    const propagation = yield* currentPropagationHeaders(request);
    return {
      session: {
        organizationId: principal.organizationId,
        userId: principal.accountId,
        elicitationMode: readElicitationMode(request),
        artifactsEnabled: readArtifactsEnabled(request),
        resource,
        webOrigin: new URL(request.url).origin,
      },
      propagation,
    };
  });

interface CloudflareMcpAgentHandlerOptions {
  readonly makeModernServerBuilder: (
    env: CloudflareEnv,
    config: CloudflareConfig,
    session: McpSessionProps["session"],
  ) => McpModernServerBuilder["Service"];
  readonly authProvider?: Layer.Layer<McpAuthProvider>;
}

/** Build the standalone Cloudflare worker's authenticated MCP request handler. */
export const makeCloudflareMcpAgentHandler = (
  config: CloudflareConfig,
  options: CloudflareMcpAgentHandlerOptions,
) => {
  const authProvider = options.authProvider ?? cloudflareAccessMcpAuth(config);
  const modern = makeMcpModernRequestRouter();
  return async (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return mcpCorsPreflightResponse(request.headers.get("access-control-request-headers"));
    }
    const sessionId = request.headers.get("mcp-session-id");

    if (sessionId && isDeadSessionCached(sessionId)) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const { auth, outcome } = yield* authenticate(request, authProvider);
          return Predicate.isTagged(outcome, "Authenticated")
            ? deadSessionResponse(request.method, cachedDeadSessionMessage(sessionId))
            : renderAuthError(auth, request, outcome);
        }).pipe(Effect.withTracerEnabled(false)),
      );
    }

    const { auth, outcome } = await Effect.runPromise(authenticate(request, authProvider));
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

    // Both eras carry the resource the same way — stamped into the internal
    // identity header the session DO verifies — so it is resolved once here,
    // before the era split.
    const resource = resourceFromPath(request);
    const parsedBody = await Effect.runPromise(requestBodyFromRequest(request));
    const era = await classifyMcpProtocolEra(request, parsedBody);
    if (era === "modern") {
      if (env.MCP_2026_07_28_ENABLED === "false") {
        return mcpModernDisabledResponse();
      }
      const props = await Effect.runPromise(
        propsForPrincipal(request, outcome.principal, resource),
      );
      (ctx as ExecutionContext & { props?: McpSessionProps }).props = props;
      const forwarded = withVerifiedIdentityHeaders(
        request,
        {
          accountId: outcome.principal.accountId,
          organizationId: outcome.principal.organizationId,
        },
        resource,
      );
      return modern.fetch({
        request: forwarded,
        parsedBody,
        principal: outcome.principal,
        resource,
        props,
        requestStateSigningKey: requireMcpRequestStateKey(env.MCP_REQUEST_STATE_KEY),
        builder: options.makeModernServerBuilder(env, config, props.session),
        sessions: env.MCP_SESSION,
        executionOwners: mcpExecutionOwnerDirectoryFromNamespace(env.MCP_EXECUTION_OWNER),
      });
    }

    if (!sessionId && request.method === "DELETE") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    }

    const existingSession = sessionId ? mcpSessionStub(env.MCP_SESSION, sessionId) : null;
    if (sessionId && !existingSession) {
      return deadSessionResponse(request.method, "Session not found");
    }
    if (existingSession && sessionId) {
      const owner = await existingSession.validateMcpSessionOwner({
        accountId: outcome.principal.accountId,
        organizationId: outcome.principal.organizationId,
      });
      if (owner === "not_found") {
        cacheDeadSession(sessionId, "not_found");
        return deadSessionResponse(request.method, "Session not found");
      }
      if (owner === "terminated") {
        // DELETE-condemned but the deferred destroy alarm hasn't wiped storage
        // yet; the terminated id must read as dead immediately.
        cacheDeadSession(sessionId, "timed_out");
        return deadSessionResponse(request.method, "Session timed out, please reconnect");
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
        resource,
      ),
      propagation,
    );
    const target = existingSession ?? createMcpSessionStub(env.MCP_SESSION).stub;
    return withMcpResponseHeaders(await target.fetch(forwarded));
  };
};
