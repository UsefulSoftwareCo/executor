import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { Effect, Predicate } from "effect";

import {
  McpAuthProvider,
  jsonRpcErrorBody,
  defaultMcpResource,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
  type AuthOutcome,
  type McpResource,
} from "@executor-js/host-mcp";
import { requestBodyFromRequest } from "@executor-js/host-mcp/tool-server-v2";
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

import { wrapMcpSseResponse } from "../observability/memory-metrics";
import { WorkerTelemetryLive } from "../observability/telemetry";
import { cloudMcpAuth } from "./auth-provider";
import { makeCloudModernMcpServerBuilder } from "./session-durable-object";
import { parseTraceparent } from "./traceparent";

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
  // Unavailable: a transient auth-infra failure (JWKS blip OR a WorkOS
  // membership-lookup 429/5xx/timeout). Both are retryable, so advertise a
  // Retry-After so the client (and any polite retry layer) backs off instead of
  // hammering (same rendering as the shared envelope's Unavailable branch).
  // Crucially, this path NEVER reaches the session-destroy branch below — a
  // transient failure must not condemn a live session.
  //
  // Note this 503 shares JSON-RPC code -32001 with the terminated-session 404
  // ("Session timed out, please reconnect"); that is intentional — -32001 is
  // the generic auth/session envelope code, and the HTTP STATUS is the
  // discriminator clients act on: 503 = retry the SAME session id, 404 = the
  // id is dead, reconnect.
  return jsonRpcErrorBody(503, -32001, outcome.message, {
    retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
  });
};

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    const outcome = yield* auth.authenticate(request);
    return { auth, outcome };
  }).pipe(Effect.provide(cloudMcpAuth));

// The earlier shared envelope ran the MCP auth path inside the Effect app, whose
// HttpMiddleware provided the OTEL tracer — that is where the `mcp.request`
// span (client fingerprint, rpc method, auth outcome) exported from. This
// handler dispatches from the raw worker entry instead, so a bare
// `Effect.runPromise` leaves every span in Effect's no-op default tracer and
// they silently never export. Run each program under the worker telemetry
// layer, parented to the edge `http.server` span server.ts stamps onto the
// forwarded request's traceparent — which also makes `currentPropagationHeaders`
// (via Effect.currentParentSpan) ferry that same trace into the session DO
// instead of letting the DO start a fresh root per request.
const runTraced = <A>(request: Request, program: Effect.Effect<A>): Promise<A> => {
  const parsed = parseTraceparent(
    request.headers.get("traceparent"),
    request.headers.get("tracestate"),
  );
  return Effect.runPromise(
    (parsed ? OtelTracer.withSpanContext(program, parsed) : program).pipe(
      Effect.provide(WorkerTelemetryLive),
    ),
  );
};

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
        artifactsEnabled: readArtifactsEnabled(request),
        resource,
        webOrigin: new URL(request.url).origin,
      },
      propagation,
    };
  });

export const makeCloudMcpAgentHandler = () => {
  const modern = makeMcpModernRequestRouter();
  const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);

  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return mcpCorsPreflightResponse(request.headers.get("access-control-request-headers"));
    }
    // Preserve the old envelope's JSON-RPC 405 before authenticating, so
    // unsupported methods never reach the session engine.
    if (!ALLOWED_METHODS.has(request.method)) {
      return jsonRpcResponse(405, -32001, "Method not allowed");
    }
    const sessionId = request.headers.get("mcp-session-id");

    const { auth, outcome } = await runTraced(request, authenticate(request));
    if (!Predicate.isTagged(outcome, "Authenticated")) {
      // Destroying a live session on auth grounds requires a POSITIVE
      // determination that access is genuinely gone — only `Forbidden` carries
      // that (valid bearer, org absent/revoked). `Unavailable` (transient WorkOS
      // / JWKS failure) and `Unauthorized` (retry with a fresh token) must leave
      // the session intact, so the condemn path is gated on `Forbidden` alone.
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
      const resource = resourceFromPath(request);
      const props = await runTraced(
        request,
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
        builder: makeCloudModernMcpServerBuilder(props.session),
        sessions: env.MCP_SESSION,
        executionOwners: mcpExecutionOwnerDirectoryFromNamespace(env.MCP_EXECUTION_OWNER),
      });
    }

    if (!sessionId && request.method === "DELETE") {
      // Matches the old envelope's contract (@modelcontextprotocol/sdk's
      // `WebStandardStreamableHTTPServerTransport.handleDeleteRequest`): 200,
      // not 204 — see e2e/cloud/mcp-protocol.test.ts.
      return new Response(null, {
        status: 200,
        headers: { "access-control-allow-origin": "*" },
      });
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
        // yet. Same envelope as the post-destroy race below: the client must
        // treat the id as dead and reconnect.
        return jsonRpcResponse(404, -32001, "Session timed out, please reconnect");
      }
      if (owner === "forbidden") {
        return jsonRpcResponse(403, -32003, "MCP session does not belong to the current bearer");
      }
    }

    const resource = resourceFromPath(request);
    const propagation = await runTraced(request, currentPropagationHeaders(request));
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
    let response: Response;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: a condemned DO abort can reject its direct fetch
    try {
      response = await target.fetch(forwarded);
    } catch (error) {
      // `_cf_scheduleDestroy` (called above via DELETE) marks the DO
      // condemned and schedules its alarm; the alarm's storage wipe then
      // `ctx.abort("destroyed")`s the isolate. A request that lands after the
      // alarm has already fired — same DO, same tick budget as the DELETE in
      // tests — throws that abort reason out of `stub.fetch` instead of the
      // DO ever getting to answer. Map it to the old envelope's reconnect
      // error for a dead session (e2e/cloud/mcp-protocol.test.ts expects the
      // client to be told to reconnect, matching a timed-out session).
      // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: the abort reason is a plain runtime Error whose message IS the signal
      if (Predicate.isError(error) && error.message === "destroyed") {
        return jsonRpcResponse(404, -32001, "Session timed out, please reconnect");
      }
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: rethrow anything that isn't the condemned-DO abort to the Workers runtime unchanged
      throw error;
    }
    return withMcpResponseHeaders(wrapMcpSseResponse(request, env, response));
  };
};
