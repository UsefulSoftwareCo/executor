import { DurableObject } from "cloudflare:workers";
import { SpanKind, SpanStatusCode, context, trace, type SpanContext } from "@opentelemetry/api";
import type { ErrorEvent } from "@sentry/cloudflare";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "@opentelemetry/semantic-conventions";
import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";

import { isAppOwnedPath, servedByAppPlane } from "./app-paths";
import { marketingProxyRequest } from "./edge/marketing";
import { passthroughResponse } from "./edge/passthrough";
import { makeCloudMcpAgentHandler } from "./mcp/agent-handler";
import { classifyMcpPath, prepareMcpOrgScope } from "./mcp/mount";
import { parseTraceparent } from "./mcp/traceparent";
import { McpSessionDOSqlite as McpSessionDOBase } from "./mcp/session-durable-object";
import {
  beforeSendWithOtelCorrelation,
  captureCause,
  otelCorrelationContextFromOpenTelemetrySpan,
  SENTRY_EVENT_ID_ATTRIBUTE,
  tagCurrentSentryScopeWithOtelContext,
} from "./observability";
import { browserTracesResponse } from "./observability/browser-traces";
import { flushTracerProvider, installTracerProvider } from "./observability/telemetry";

// ---------------------------------------------------------------------------
// Sentry config
// ---------------------------------------------------------------------------

const sentryOptions = (env: Env) => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0,
  enableLogs: true,
  sendDefaultPii: true,
  skipOpenTelemetrySetup: true,
  beforeSend: (event: ErrorEvent) =>
    beforeSendWithOtelCorrelation(event, {
      logPayload: !env.SENTRY_DSN || env.SENTRY_OTEL_LOG_PAYLOAD === "true",
    }),
  // NOTE: do NOT enable `instrumentPrototypeMethods`. It walks the DO prototype
  // and reads every property — including accessors — to find methods to wrap,
  // which invokes the `sessionId` getter with `this` bound to the prototype
  // (where `ctx` is undefined) and throws during construction, 500ing every
  // session create / cold restore. The DO captures its own errors via the
  // `captureCause` seam (→ Sentry) instead.
});

// ---------------------------------------------------------------------------
// Durable Object — wrapped with Sentry so DO errors land in Sentry (inits the
// client inside the DO isolate, which plain `Sentry.captureException` cannot
// do on its own). OTEL is installed through Effect layers (observability/telemetry),
// not a global fetch wrapper.
// ---------------------------------------------------------------------------

export const McpSessionDOSqlite = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  McpSessionDOBase,
);

// Orphaned placeholder for the original key-value `McpSessionDO` class (migration
// v1). The live MCP session DO is now `McpSessionDOSqlite` (SQLite); the
// `MCP_SESSION` binding moved to it. Cloudflare won't delete `McpSessionDO` in the
// same deploy that moves its binding, so the class is left unbound and is kept
// exported here only to satisfy the migration. It can be removed in a later deploy
// (with a `deleted_classes: ["McpSessionDO"]` migration) now that nothing binds it.
export class McpSessionDO extends DurableObject {}

// Per-org execution rate-limit counter DO (abuse backstop; migration v3,
// `EXECUTION_RATE_LIMITER` binding). Plain counter, no Sentry wrapper needed:
// its callers already fail open and report errors themselves.
export { ExecutionRateLimiterDO } from "./engine/execution-rate-limit";

export { McpExecutionOwnerDirectoryDO } from "@executor-js/cloudflare/mcp/execution-owner-directory";

// ---------------------------------------------------------------------------
// Worker fetch handler
//
// We open a single `http.server <METHOD>` span at the worker boundary using
// the same WebTracerProvider that `observability/telemetry.ts` already installs for
// Effect-driven spans. This restores the per-request envelope span that was
// previously emitted by `@microlabs/otel-cf-workers` and lost in the alchemy
// migration — without the OTel-SDK version-conflict that package would now
// drag in (it pins `@opentelemetry/otlp-* ^0.200.0`, we ship ^0.214.0).
//
// App-owned paths (/api/* and /.well-known/* — see app-paths.ts) get their
// `http.server` span from Effect's HttpMiddleware tracer. `/mcp` is dispatched
// directly and uses `traceCloudMcpRequest` below so the agent handler can skip
// the entire span envelope for negative-cache hits. Other paths keep this
// worker span. Wrapping Effect-owned paths here too produced duplicate sibling
// spans per request.
//
// SimpleSpanProcessor exports synchronously at span end but the underlying
// `fetch()` to Axiom is fire-and-forget; the Worker may terminate before it
// completes. `ctx.waitUntil(flushTracerProvider())` keeps the isolate alive
// until the in-flight export resolves.
// ---------------------------------------------------------------------------

const rawFetchHandler = handler.fetch as (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

/**
 * Every entry into TanStack Start goes through here so `startGraphEntered`
 * reflects whether this isolate has already paid the lazy `loadEntries`
 * import — the cost that dominates a cold page request.
 */
const fetchHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Response | Promise<Response> => {
  markStartGraphEntered();
  return rawFetchHandler(request, env, ctx);
};

const tracer = trace.getTracer("executor-cloud-worker");

const traceparentValueFor = (spanContext: SpanContext): string =>
  `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 0xff).toString(16).padStart(2, "0")}`;

const withTraceparent = (request: Request, spanContext: SpanContext): Request => {
  const headers = new Headers(request.headers);
  headers.set("traceparent", traceparentValueFor(spanContext));
  return new Request(request, { headers });
};

const traceCloudMcpRequest = async (
  request: Request,
  _env: Env,
  ctx: ExecutionContext,
  handle: (tracedRequest: Request) => Promise<Response>,
): Promise<Response> => {
  if (!installTracerProvider()) return handle(request);

  const url = new URL(request.url);
  const inbound = parseTraceparent(request.headers.get("traceparent"), null);
  const parentContext = inbound
    ? trace.setSpanContext(context.active(), {
        traceId: inbound.traceId,
        spanId: inbound.spanId,
        traceFlags: inbound.traceFlags,
        isRemote: true,
      })
    : context.active();

  return tracer.startActiveSpan(
    `http.server ${request.method}`,
    { kind: SpanKind.SERVER },
    parentContext,
    async (span) => {
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, request.method);
      span.setAttribute(ATTR_URL_FULL, request.url);
      span.setAttribute(ATTR_URL_PATH, url.pathname);
      span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(/:$/, ""));
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; observe response/error for span status, keep trace export alive after the Agents bridge resolves or rejects
      try {
        const response = await handle(withTraceparent(request, span.spanContext()));
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        }
        return response;
      } catch (err) {
        // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- adapter boundary: Cloudflare's fetch callback throws untyped; normalized only for the OTel span record, the original error is rethrown below
        const cause = err instanceof Error ? err : String(err);
        span.recordException(cause);
        // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: same normalization as the recordException line above
        const message = typeof cause === "string" ? cause : cause.message;
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; preserve original error to Cloudflare runtime
        throw err;
      } finally {
        span.end();
        ctx.waitUntil(flushTracerProvider());
      }
    },
  );
};

const mcpAgentHandler = makeCloudMcpAgentHandler();

// ---------------------------------------------------------------------------
// Isolate lifecycle signals
// ---------------------------------------------------------------------------
//
// The Aug 2026 page-latency hunt kept stalling on one blind spot: every span we
// emit starts INSIDE the fetch handler, so nothing could distinguish "this
// isolate is cold and paying Start's lazy `loadEntries` import" from "this
// isolate came up slowly before our code ran at all". Both look like one slow
// span. These three attributes make the distinction queryable:
//
//   executor.isolate.request_seq  - 1 means this request is the isolate's
//                                   first; page requests measured 1.04 per
//                                   isolate, which is why nearly every one
//                                   pays the cold cost.
//   executor.start_graph.entered  - whether anything had already driven
//                                   TanStack Start in this isolate. /mcp and
//                                   the passthrough proxies return before
//                                   `fetchHandler`, so an isolate can serve
//                                   plenty of traffic and still be cold here.
// Measured with a temporary entry-lag probe correlated against `wrangler tail`
// event timestamps: a cold isolate (`request_seq` 1) spends **840-1844ms**
// coming up before our first line runs, while a reused one spends **0-2ms**.
// That startup is invisible to every span we emit, and it sits on top of the
// ~3.1s `loadEntries` import — together the 3-5s a signed-in page costs.
//
//   executor.isolate.id           - identifies the isolate itself, so reuse can
//                                   be counted directly instead of inferred.
//   executor.isolate.age_ms       - ms since this isolate served its first
//                                   request.
//
// The last two exist because the Aug 2026 hunt inferred "isolates stopped being
// reused" from a latency cutoff (requests slower than 1s were called cold) and
// then built a size-based theory on top of that proxy. The theory was wrong:
// reverting the offending packages restored production while moving the
// evaluated module closure by 0.02 MB (see scripts/start-closure.mjs). Grouping
// by isolate id answers "how many requests did this isolate serve, and were the
// slow ones its first?" directly, which no latency threshold can.
//
// All of it is cheap: two increments, one lazy uuid, and no I/O.
let isolateRequestSeq = 0;
let startGraphEntered = false;
// Minted on first request rather than at module scope: Workers reject random
// number generation during global-scope evaluation.
let isolateId: string | undefined;
let isolateFirstSeenAt = 0;

const identifyIsolate = (): { readonly id: string; readonly ageMs: number } => {
  if (isolateId === undefined) {
    isolateId = crypto.randomUUID();
    isolateFirstSeenAt = Date.now();
  }
  return { id: isolateId, ageMs: Date.now() - isolateFirstSeenAt };
};

const markStartGraphEntered = (): void => {
  startGraphEntered = true;
};

// ---------------------------------------------------------------------------
// Serving `/api/*` without entering TanStack Start.
// ---------------------------------------------------------------------------
//
// Everything under `/api` is the Effect app (`ExecutorApp.make`'s web handler)
// and uses no part of the router, React, or SSR. But it was dispatched from a
// Start *request middleware*, so reaching it meant paying Start's lazy
// `loadEntries` import of the whole server graph first. Measured on production
// 2026-08-19, splitting `/api/*` by whether the isolate had already loaded that
// graph: warm p50 **186ms**, cold p50 **2129ms**, with 28% of API requests cold.
// The dashboard fires many `/api/*` calls in parallel and waits for the slowest,
// so that cold tail is what the app actually feels like.
//
// So `/api` joins marketing, `/docs`, the PostHog proxy and `/mcp` at the Worker
// entry: classify and dispatch before anything touches Start. The evaluated
// closure for an API request drops from the full Start graph to the Worker's own
// (see `scripts/start-closure.mjs`).
//
// `servedByAppPlane` (./app-paths) decides which paths qualify — two under
// `/api` are claimed by Start's middleware first and must keep their old route.

// Instantiated on the first request that needs it and memoized per isolate,
// mirroring `start.ts`'s `getApp`. The import stays dynamic so an isolate that
// only serves pages or proxies never evaluates the app graph at all.
let appPlane: ReturnType<typeof import("./app").cloudApiHandler> | undefined;
let appGraphEntered = false;

const getAppPlane = async (): Promise<NonNullable<typeof appPlane>> => {
  if (appPlane === undefined) {
    const { cloudApiHandler } = await import("./app");
    appPlane = cloudApiHandler();
    appGraphEntered = true;
  }
  return appPlane;
};

const cloudflareHandler: ExportedHandler<Env> = {
  fetch: async (request, env, ctx) => {
    isolateRequestSeq += 1;

    // Public pages must not enter TanStack Start: its first-request dynamic
    // import loads the entire React + Effect server graph and can take seconds
    // on a cold isolate. Classify and service-bind marketing at the Worker
    // entry, before telemetry or fetchHandler touches that graph.
    const marketingRequest = marketingProxyRequest(request);
    const marketing: Fetcher | undefined = env.MARKETING;
    if (marketingRequest && marketing) return marketing.fetch(marketingRequest);

    // Same reasoning, same seam: `/docs` and the PostHog proxy forward to an
    // external origin and never touch the router, React, or the Effect app.
    // Left in Start's middleware they still paid its lazy `loadEntries` import
    // first — measured at p50 3.1s on a cold isolate, against p50 33ms for the
    // request's own work, on a Worker where 1,666 dispatches spread across
    // 1,608 isolates (so nearly every request is cold). Forward before Start.
    const passthroughPath = new URL(request.url).pathname;
    const passthrough = passthroughResponse(request, passthroughPath);
    if (passthrough) return passthrough;

    // Browser OTLP ingress — before the server span opens: exporter traffic
    // must never trace itself (the browser already excludes /v1/traces from
    // its own tracing for the same reason).
    const browserTraces = browserTracesResponse(request, env);
    if (browserTraces) return browserTraces;
    // The MCP dispatch is classified up front, independent of whether
    // telemetry installs — an unset `AXIOM_TOKEN` (tracer not installed) must
    // never take /mcp requests down with it. See `installTracerProvider`'s
    // early return below: the handler invokes it for uncached MCP traffic, and
    // this entry invokes it for non-MCP paths.
    const url = new URL(request.url);
    const mcpRoute = classifyMcpPath(url.pathname);
    if (mcpRoute?.kind === "mcp") {
      // The Cloudflare Agents MCP bridge needs the platform ExecutionContext
      // to pass authenticated session props into the hibernatable DO.
      // Discovery docs still flow through the app-level MCP envelope.
      const forwarded = prepareMcpOrgScope(request);
      // /mcp leaves the Effect app for the Agents bridge, so no downstream
      // HttpMiddleware.tracer opens the request envelope — this worker span is
      // THE `http.server` span for MCP traffic, and its context is stamped onto
      // the forwarded traceparent so the agent handler and session DO parent
      // under it instead of exporting orphaned roots.
      return traceCloudMcpRequest(forwarded, env, ctx, (tracedRequest) =>
        Promise.resolve(mcpAgentHandler(tracedRequest, env, ctx)),
      );
    }
    const tracingInstalled = installTracerProvider();
    // Join the caller's W3C trace when the request carries one — the web UI
    // sends traceparent on every API fetch, so the browser's spans and this
    // request share one trace id end to end. Same parsing the DO path does
    // in session-durable-object.ts.
    const inbound = parseTraceparent(request.headers.get("traceparent"), null);
    const parentContext = inbound
      ? trace.setSpanContext(context.active(), {
          traceId: inbound.traceId,
          spanId: inbound.spanId,
          traceFlags: inbound.traceFlags,
          isRemote: true,
        })
      : context.active();
    if (!tracingInstalled) {
      return fetchHandler(request, env, ctx);
    }
    // Effect-served paths bring their own http.server span (with traceparent
    // join) — a second SERVER span here would duplicate it (the header note).
    // What they do NOT cover is the time between this invocation starting and
    // the Effect router opening its span (Start dispatch, middleware, lazy
    // module graph): during the Aug 2026 regression that gap was seconds of
    // invisible wall time. `worker.dispatch` is an INTERNAL parent that
    // brackets the whole invocation; Effect's http.server span joins under it
    // via the injected traceparent, so gap = dispatch minus server span.
    if (isAppOwnedPath(url.pathname)) {
      return tracer.startActiveSpan(
        "worker.dispatch",
        { kind: SpanKind.INTERNAL },
        parentContext,
        async (span) => {
          span.setAttribute(ATTR_HTTP_REQUEST_METHOD, request.method);
          span.setAttribute(ATTR_URL_PATH, url.pathname);
          const isolate = identifyIsolate();
          span.setAttribute("executor.isolate.request_seq", isolateRequestSeq);
          span.setAttribute("executor.start_graph.entered", startGraphEntered);
          span.setAttribute("executor.isolate.id", isolate.id);
          span.setAttribute("executor.isolate.age_ms", isolate.ageMs);
          // Which plane served this: "app" skipped the Start graph entirely, so
          // `start_graph.entered` says nothing about it. `app_graph.entered`
          // is the app-plane analogue - false means this request paid for the
          // Effect graph's first evaluation in this isolate.
          const appPlaneRequest = servedByAppPlane(url.pathname, request.method);
          span.setAttribute("executor.dispatch.plane", appPlaneRequest ? "app" : "start");
          if (appPlaneRequest) span.setAttribute("executor.app_graph.entered", appGraphEntered);
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; observe response/error for span status, keep the flush alive past the response
          try {
            const traced = withTraceparent(request, span.spanContext());
            const response = appPlaneRequest
              ? await (await getAppPlane()).handler(prepareMcpOrgScope(traced))
              : await fetchHandler(traced, env, ctx);
            span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
            return response;
          } catch (err) {
            // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- adapter boundary: Cloudflare's fetch callback throws untyped; normalized only for the OTel span record, the original error is rethrown below
            const cause = err instanceof Error ? err : String(err);
            span.recordException(cause);
            // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: same normalization as the recordException line above
            const message = typeof cause === "string" ? cause : cause.message;
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; preserve original error to Cloudflare runtime
            throw err;
          } finally {
            span.end();
            // The flush still must outlive the request — Effect's
            // BatchSpanProcessor ships on a timer.
            ctx.waitUntil(flushTracerProvider());
          }
        },
      );
    }
    return tracer.startActiveSpan(
      `http.server ${request.method}`,
      { kind: SpanKind.SERVER },
      parentContext,
      async (span) => {
        const otelContext = otelCorrelationContextFromOpenTelemetrySpan(span);
        tagCurrentSentryScopeWithOtelContext(otelContext);
        span.setAttribute(ATTR_HTTP_REQUEST_METHOD, request.method);
        span.setAttribute(ATTR_URL_FULL, request.url);
        span.setAttribute(ATTR_URL_PATH, url.pathname);
        span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(/:$/, ""));
        // Adapter boundary: Cloudflare's fetch handler is a Promise-based
        // callback and the OTel span lifecycle needs to observe both the
        // resolved response and any thrown error before `span.end()`. Sentry's
        // outer wrapper still captures the exception; we only mark span status.
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary
        try {
          if (env.SENTRY_OTEL_VERIFY === "true" && url.pathname === "/__sentry-otel-verify") {
            // oxlint-disable-next-line executor/no-error-constructor -- boundary: synthetic verification needs an Error payload for Sentry grouping
            const eventId = captureCause(new Error("sentry otel verification"), otelContext) ?? "";
            if (eventId) span.setAttribute(SENTRY_EVENT_ID_ATTRIBUTE, eventId);
            span.setAttribute("sentry_otel.verify", true);
            span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, 500);
            span.setStatus({ code: SpanStatusCode.ERROR });
            return Response.json(
              {
                sentryEventId: eventId,
                otelTraceId: otelContext?.traceId ?? "",
                otelSpanId: otelContext?.spanId ?? "",
              },
              { status: 500 },
            );
          }
          const response = await fetchHandler(request, env, ctx);
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
          if (response.status >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
          }
          return response;
        } catch (err) {
          // Record the exception itself, not just the status bit: without it
          // these spans are ERROR with zero diagnostic content.
          // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- adapter boundary: Cloudflare's fetch callback throws untyped; normalized only for the OTel span record, the original error is rethrown below
          const cause = err instanceof Error ? err : String(err);
          span.recordException(cause);
          // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: same normalization as the recordException line above
          const message = typeof cause === "string" ? cause : cause.message;
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; preserve original error to Cloudflare runtime
          throw err;
        } finally {
          span.end();
          ctx.waitUntil(flushTracerProvider());
        }
      },
    );
  },
};

export default Sentry.withSentry(sentryOptions, cloudflareHandler);
