import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { Effect, Predicate } from "effect";

import {
  McpAuthProvider,
  jsonRpcErrorBody,
  defaultMcpResource,
  orgWriteAccessForPrincipal,
  withOrgWriteAccess,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
  type AuthOutcome,
  type McpResource,
} from "@executor-js/host-mcp";
import {
  currentPropagationHeaders,
  readArtifactsEnabled,
  readElicitationMode,
  readSearchToolsEnabled,
  withVerifiedIdentityHeaders,
} from "@executor-js/cloudflare/mcp/do-headers";
import type { McpSessionProps } from "@executor-js/cloudflare/mcp/agent-durable-object";
import { sessionOrgRoleMetadata } from "@executor-js/cloudflare/mcp/role-metadata";
import {
  classifyDurableObjectError,
  durableObjectFailureResponse,
  type DurableObjectFailure,
} from "@executor-js/cloudflare/mcp/durable-object-errors";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";

import { wrapMcpSseResponse } from "../observability/memory-metrics";
import { WorkerTelemetryLive } from "../observability/telemetry";
import { cloudMcpAuth } from "./auth-provider";
import { isMcpSessionMetaUnavailable } from "./session-meta";
import { McpSessionDOSqlite } from "./session-durable-object";
import { parseTraceparent } from "./traceparent";

const MCP_SESSION_UNAVAILABLE_MESSAGE = "Session storage temporarily unavailable - please retry";

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

/**
 * A Cloudflare *platform* Durable Object failure happened at one of this
 * handler's stub touchpoints. Record what kind it was — on an exported span and
 * in a structured log — so the production volume stays countable per cause
 * (deploy reset vs storage timeout vs destroyed session) now that it is no
 * longer a pile of 500s.
 *
 * Talking to a session DO means talking to a process the platform can reset out
 * from under us: a deploy, a storage timeout, a backend blip, the session's own
 * `ctx.abort("destroyed")`. None of those are application defects. An
 * unrecognized failure never reaches here and keeps escaping as before.
 */
const recordDurableObjectFailure = (
  failure: DurableObjectFailure,
  operation: string,
): Effect.Effect<void> =>
  Effect.sync(() => {
    console.warn(
      JSON.stringify({
        event: "mcp_durable_object_platform_failure",
        operation,
        resetKind: failure.kind,
        disposition: failure.disposition,
      }),
    );
  }).pipe(
    Effect.withSpan("mcp.do.platform_failure", {
      attributes: {
        "mcp.do.reset_kind": failure.kind,
        "mcp.do.reset_disposition": failure.disposition,
        "mcp.do.reset_operation": operation,
      },
    }),
  );

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    const outcome = yield* auth.authenticate(request);
    return { auth, outcome };
  }).pipe(Effect.provide(cloudMcpAuth));

// The pre-Agents envelope ran the MCP auth path inside the Effect app, whose
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
        // The org record the live membership check resolved microseconds ago,
        // handed to the session DO so it never opens a connection of its own to
        // re-read it. An unnamed org (no auth plane could resolve one) is
        // omitted rather than sent empty, so the DO can tell "not carried" from
        // "carried, and blank".
        ...(principal.organizationName ? { organizationName: principal.organizationName } : {}),
        ...(principal.organizationSlug ? { organizationSlug: principal.organizationSlug } : {}),
        ...sessionOrgRoleMetadata(principal),
        userId: principal.accountId,
        elicitationMode: readElicitationMode(request),
        artifactsEnabled: readArtifactsEnabled(request),
        searchToolsEnabled: readSearchToolsEnabled(request),
        resource,
        webOrigin: new URL(request.url).origin,
      },
      propagation,
    };
  });

export const makeCloudMcpAgentHandler = () => {
  const serveOptions = {
    binding: "MCP_SESSION",
    transport: "streamable-http",
  } as const;
  // The agents SDK builds an exact-match `URLPattern` from the path handed to
  // `serve` (see `createStreamingHttpHandler` in `agents/dist/mcp/index.js`) —
  // a single `/mcp` handler never matches `/mcp/toolkits/<slug>` and falls
  // through to its own internal 404. A second `serve` mounted on the
  // parameterized path picks it up (`URLPattern` supports `:slug` segments);
  // the auth/ownership/props logic above is unchanged and shared, only the
  // final dispatch target differs.
  const serve = McpSessionDOSqlite.serve("/mcp", serveOptions);
  const serveToolkit = McpSessionDOSqlite.serve("/mcp/toolkits/:slug", serveOptions);

  const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE", "OPTIONS"]);

  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    if (request.method === "OPTIONS") return corsPreflightResponse();
    // The old envelope (packages/hosts/mcp/src/envelope.ts) answered anything
    // outside GET/POST/DELETE/OPTIONS with a JSON-RPC 405; the agents SDK
    // handler only understands its own transport verbs and falls through to
    // a bare 404. Reject before authenticating so PUT/PATCH/etc never reach
    // the session engine.
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

    if (!sessionId && request.method === "DELETE") {
      // Matches the old envelope's contract (@modelcontextprotocol/sdk's
      // `WebStandardStreamableHTTPServerTransport.handleDeleteRequest`): 200,
      // not 204 — see e2e/cloud/mcp-protocol.test.ts.
      return new Response(null, {
        status: 200,
        headers: { "access-control-allow-origin": "*" },
      });
    }

    const resource = resourceFromPath(request);

    if (sessionId) {
      let owner: "ok" | "not_found" | "forbidden" | "terminated";
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: a Durable Object stub RPC rejects with a plain platform Error, never a typed failure
      try {
        owner = await mcpSessionStub(env.MCP_SESSION, sessionId).validateMcpSessionOwner(
          {
            accountId: outcome.principal.accountId,
            organizationId: outcome.principal.organizationId,
          },
          resource,
        );
      } catch (error) {
        // The sibling stub touchpoints in this handler are both guarded — the
        // `_cf_scheduleDestroy` call above with `Effect.ignore`, the
        // `target.fetch` below with a catch — and this one was not, so a session
        // whose DO had been destroyed or reset by the platform 500ed here before
        // any of that handling could run.
        const failure = classifyDurableObjectError(error);
        if (!failure) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: an unrecognized failure is a real defect and must reach the runtime unchanged
          throw error;
        }
        await runTraced(request, recordDurableObjectFailure(failure, "validate_session_owner"));
        return durableObjectFailureResponse(failure);
      }
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

    const props = await runTraced(request, propsForPrincipal(request, outcome.principal, resource));
    (ctx as ExecutionContext & { props?: McpSessionProps }).props = props;
    const forwarded = withOrgWriteAccess(
      withVerifiedIdentityHeaders(
        request,
        {
          accountId: outcome.principal.accountId,
          organizationId: outcome.principal.organizationId,
        },
        resource,
      ),
      orgWriteAccessForPrincipal(outcome.principal),
    );
    const target = resource.kind === "toolkit" ? serveToolkit : serve;
    let response: Response;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: the agents SDK aborts the isolate (throws) instead of returning a response for a condemned session
    try {
      response = await target.fetch(forwarded, env, ctx);
    } catch (error) {
      // `_cf_scheduleDestroy` (called above via DELETE) marks the DO
      // condemned and schedules its alarm; the alarm's `destroy()` then
      // `ctx.abort("destroyed")`s the isolate. A request that lands after the
      // alarm has already fired — same DO, same tick budget as the DELETE in
      // tests — throws that abort reason out of `serve.fetch` instead of the
      // DO ever getting to answer. Map it to the old envelope's reconnect
      // error for a dead session (e2e/cloud/mcp-protocol.test.ts expects the
      // client to be told to reconnect, matching a timed-out session).
      //
      // The same catch now also covers the rest of the platform's reset
      // vocabulary — a deploy, a storage timeout, a cancelled
      // blockConcurrencyWhile — which reaches here through the agents SDK's own
      // `getServerByName` retry and used to 500 identically.
      // The session DO could not reach the organization directory to name the
      // org (after its own bounded retry). Transient by construction, so it
      // gets the same retryable envelope a WorkOS blip gets on the auth path —
      // not an unclassified 500 the agents SDK then retries the whole DO
      // operation over, which is what turned a 10s connect timeout into a
      // half-minute client hang.
      //
      // Checked BEFORE the platform classifier: this is an application failure
      // that merely escapes through the same seam, and it names its own cause.
      // The classifier only recognizes the runtime's own reset vocabulary, so
      // the two never contend — the order just keeps it that way if either
      // vocabulary grows.
      if (isMcpSessionMetaUnavailable(error)) {
        return jsonRpcErrorBody(503, -32001, MCP_SESSION_UNAVAILABLE_MESSAGE, {
          retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
        });
      }
      const failure = classifyDurableObjectError(error);
      if (!failure) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: rethrow anything that isn't a recognized platform failure to the Workers runtime unchanged
        throw error;
      }
      await runTraced(request, recordDurableObjectFailure(failure, "session_fetch"));
      return durableObjectFailureResponse(failure);
    }
    // The agents SDK answers a bare DELETE with 204; the old envelope's
    // contract (see above) was 200 — rewrite for consistency.
    if (request.method === "DELETE" && response.status === 204) {
      return new Response(null, { status: 200, headers: response.headers });
    }
    return wrapMcpSseResponse(request, env, response);
  };
};
