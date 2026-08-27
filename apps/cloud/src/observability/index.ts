// ---------------------------------------------------------------------------
// Cloud-app implementation of the shared `ErrorCapture` service. This is the
// only file in the cloud-app that imports `@sentry/cloudflare` for error
// capture — handlers, plugin SDKs, and storage code all stay
// Sentry-agnostic and request the `ErrorCapture` tag instead.
//
// `withObservability` (in @executor-js/api) wraps every handler effect; when
// it sees an unmapped cause it asks `ErrorCapture.captureException` for a
// trace id and fails with `InternalError({ traceId })`. The client gets
// the opaque id, we get the full cause + stack in Sentry.
// ---------------------------------------------------------------------------

import * as Sentry from "@sentry/cloudflare";
import type { ErrorEvent, Scope } from "@sentry/cloudflare";
import { Cause, Effect, Layer } from "effect";
import type * as Tracer from "effect/Tracer";

import { ErrorCapture } from "@executor-js/api";
import { stableGroupingFingerprint, type GroupingEvent } from "@executor-js/sdk/sentry-grouping";

// Drizzle/postgres-js include the failing SQL (params + bound values) in
// their error message. For OpenAPI source inserts that's 1MB+ of spec
// text which blows past terminal scrollback and hides the actual pg
// error. Sentry still receives the full, untruncated cause via
// `setExtra`; only the dev-console mirror is capped.
const MAX_CONSOLE_CAUSE_CHARS = 4_000;
const OTEL_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const OTEL_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

export const OTEL_TRACE_ID_TAG = "otel_trace_id";
export const OTEL_SPAN_ID_TAG = "otel_span_id";
export const SENTRY_EVENT_ID_ATTRIBUTE = "sentry.event_id";

/**
 * Set by the MCP session Durable Object when it has finished deciding what to
 * do about a cause — reported it, or classified it as an expected Cloudflare
 * platform reset and deliberately not reported it.
 *
 * `instrumentDurableObjectWithSentry` wraps the DO's entry points and captures
 * the same rejection again as it escapes, which is why one platform reset
 * opened two issues for the same event. The DO is the better owner — it has
 * the session, the org, the OTEL correlation and the classification — so its
 * claim wins and the auto-instrumentation's echo is dropped in `beforeSend`.
 * Nothing the DO does not claim is affected.
 */
export const DO_CAUSE_OWNER_TAG = "mcp.do.cause_owner";
export const DO_CAUSE_OWNER_VALUE = "durable_object";

export type OtelCorrelationContext = {
  readonly traceId: string;
  readonly spanId: string;
};

const truncate = (s: string): string =>
  s.length <= MAX_CONSOLE_CAUSE_CHARS
    ? s
    : `${s.slice(0, MAX_CONSOLE_CAUSE_CHARS)}\n…[truncated ${s.length - MAX_CONSOLE_CAUSE_CHARS} chars]`;

const validOtelContext = (context: OtelCorrelationContext): boolean =>
  OTEL_TRACE_ID_PATTERN.test(context.traceId) && OTEL_SPAN_ID_PATTERN.test(context.spanId);

export const otelCorrelationContextFromEffectSpan = (
  span: Tracer.Span,
): OtelCorrelationContext | null => {
  const context = { traceId: span.traceId, spanId: span.spanId };
  return validOtelContext(context) ? context : null;
};

export const otelCorrelationContextFromOpenTelemetrySpan = (span: {
  readonly spanContext: () => { readonly traceId: string; readonly spanId: string };
}): OtelCorrelationContext | null => {
  const { traceId, spanId } = span.spanContext();
  const context = { traceId, spanId };
  return validOtelContext(context) ? context : null;
};

export const addOtelCorrelationTags = <T extends { readonly tags?: Record<string, unknown> }>(
  event: T,
  context: OtelCorrelationContext | null,
): T => {
  if (!context) return event;
  return {
    ...event,
    tags: {
      ...event.tags,
      [OTEL_TRACE_ID_TAG]: context.traceId,
      [OTEL_SPAN_ID_TAG]: context.spanId,
    },
  };
};

export const tagSentryScopeWithOtelContext = (
  scope: Scope,
  context: OtelCorrelationContext | null,
): void => {
  if (!context) return;
  scope.setTag(OTEL_TRACE_ID_TAG, context.traceId);
  scope.setTag(OTEL_SPAN_ID_TAG, context.spanId);
};

export const tagCurrentSentryScopeWithOtelContext = (
  context: OtelCorrelationContext | null,
): void => {
  tagSentryScopeWithOtelContext(Sentry.getCurrentScope(), context);
};

const currentOtelContext = Effect.map(
  Effect.currentSpan,
  otelCorrelationContextFromEffectSpan,
).pipe(Effect.orElseSucceed(() => null));

export const tagCurrentSentryScopeWithCurrentOtelSpan: Effect.Effect<OtelCorrelationContext | null> =
  Effect.map(currentOtelContext, (context) => {
    tagCurrentSentryScopeWithOtelContext(context);
    return context;
  });

/**
 * True when this event is the auto-instrumentation's copy of a cause the
 * Durable Object already claimed.
 *
 * Both conditions matter. The tag alone would drop the DO's own report; the
 * mechanism alone would drop genuinely unhandled DO failures (an alarm crash,
 * say) that nothing else reports. Together they identify exactly the echo.
 */
const isClaimedDurableObjectEcho = (event: ErrorEvent): boolean => {
  if (event.tags?.[DO_CAUSE_OWNER_TAG] !== DO_CAUSE_OWNER_VALUE) return false;
  const mechanism = event.exception?.values?.[0]?.mechanism?.type;
  return typeof mechanism === "string" && mechanism.startsWith("auto.");
};

export const beforeSendWithOtelCorrelation = (
  event: ErrorEvent,
  options?: { readonly logPayload?: boolean },
): ErrorEvent | null => {
  if (isClaimedDurableObjectEcho(event)) return null;
  if (options?.logPayload) {
    console.info(
      JSON.stringify({
        event: "sentry_before_send_otel_correlation",
        sentry_event_id: event.event_id ?? "",
        otel_trace_id: String(event.tags?.[OTEL_TRACE_ID_TAG] ?? ""),
        otel_span_id: String(event.tags?.[OTEL_SPAN_ID_TAG] ?? ""),
      }),
    );
  }
  return event;
};

/**
 * The worker ships as content-hashed chunks and its frames are not resolved
 * back to source, so Sentry's default grouping keys on names like
 * `execution-rate-limit-<hash>` and re-opens every issue on the next deploy.
 * Pin a fingerprint with the hash normalized out; events with no hashed
 * grouping input are left on the default algorithm.
 */
export const withStableGroupingFingerprint = <T extends GroupingEvent>(event: T): T => {
  const fingerprint = stableGroupingFingerprint(event);
  return fingerprint ? { ...event, fingerprint: [...fingerprint] } : event;
};

/**
 * The single `beforeSend` the worker and its Durable Objects install.
 *
 * The two stages are independent and compose in this order: the capture-owner
 * pass decides WHETHER the event is reported at all (a cause the Durable
 * Object already claimed is dropped, and a dropped event is never
 * fingerprinted), and the grouping pass then decides HOW whatever survives is
 * grouped.
 */
export const beforeSendCloudEvent = (
  event: ErrorEvent,
  options?: { readonly logPayload?: boolean },
): ErrorEvent | null => {
  const reported = beforeSendWithOtelCorrelation(event, options);
  return reported === null ? null : withStableGroupingFingerprint(reported);
};

export const addCurrentOtelCorrelationTags = <
  T extends { readonly tags?: Record<string, unknown> },
>(
  event: T,
): Effect.Effect<T> =>
  Effect.map(currentOtelContext, (context) => addOtelCorrelationTags(event, context));

// Sentry's `captureException` can't serialize Effect's `CauseImpl` (it logs
// `'CauseImpl' captured as exception with keys: reasons, ~effect/Cause` and
// drops the real failure). `Cause.squash` isn't enough on its own: when an
// inner `runPromise` rejects with a CauseImpl from its own `causeSquash`
// (Effect v4's behaviour), `Effect.promise` re-wraps it as `Die(causeImpl)`,
// and `Cause.squash(outer)` then hands the CauseImpl straight back. Use
// `Cause.prettyErrors` instead — it always produces real `Error` instances,
// even for non-Error defects (including a CauseImpl defect, which gets
// wrapped via `causePrettyMessage`).
export const sentryPayloadForCause = (
  input: unknown,
): { primary: unknown; pretty: string | null } => {
  if (Cause.isCause(input)) {
    const pretty = Cause.pretty(input);
    const errors = Cause.prettyErrors(input);
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: Sentry captureException needs an Error-like primary payload for pretty Effect causes
    return { primary: errors[0] ?? new Error(pretty), pretty };
  }
  return { primary: input, pretty: null };
};

export const captureCause = (
  input: unknown,
  context: OtelCorrelationContext | null = null,
): string | undefined => {
  const { primary, pretty } = sentryPayloadForCause(input);
  tagCurrentSentryScopeWithOtelContext(context);
  return Sentry.captureException(primary, (scope) => {
    tagSentryScopeWithOtelContext(scope, context);
    if (pretty !== null) scope.setExtra("cause", pretty);
    return scope;
  });
};

export const captureCauseEffect = (input: unknown): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const context = yield* tagCurrentSentryScopeWithCurrentOtelSpan;
    const eventId = yield* Effect.sync(() => captureCause(input, context));
    if (eventId && context) {
      yield* Effect.annotateCurrentSpan(SENTRY_EVENT_ID_ATTRIBUTE, eventId);
    }
    return eventId;
  });

/**
 * Mark the current Sentry scope as "the Durable Object has already dealt with
 * this cause". Call it AFTER any `captureCauseEffect`, so the DO's own event —
 * captured against the scope as it was — is not itself mistaken for the echo.
 */
export const claimCauseHandledByDurableObject: Effect.Effect<void> = Effect.sync(() => {
  Sentry.getCurrentScope().setTag(DO_CAUSE_OWNER_TAG, DO_CAUSE_OWNER_VALUE);
});

export const ErrorCaptureLive: Layer.Layer<ErrorCapture> = Layer.succeed(
  ErrorCapture,
  ErrorCapture.of({
    captureException: (cause) =>
      Effect.gen(function* () {
        console.error("[api] unhandled cause:", truncate(Cause.pretty(cause)));
        return (yield* captureCauseEffect(cause)) ?? "";
      }),
  }),
);
