/** Product analytics are optional host capabilities. Cloud and self-host install their own sinks. */
import { Cause, Clock, Context, Effect, Exit, Option, Schema } from "effect";
import {
  feedbackDisabled,
  type FeedbackDisabled,
  type FeedbackUnavailable,
} from "@executor-js/telemetry/product-analytics";
import { CurrentUserId } from "./auth.ts";
import { CurrentOrganization } from "./organization.ts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";

/** Explicit metadata only. Never add request bodies, URLs, credentials, or operation results. */
export interface UsageProperties {
  readonly event_id?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly operation_id?: string;
  readonly area?: string;
  readonly operation?: string;
  readonly app_id?: string;
  readonly deployment_id?: string;
  readonly account_id?: string;
  readonly provider_id?: string;
  readonly tool_name?: string;
  readonly method?: string;
  readonly status?: string;
  readonly outcome?: "success" | "failure" | "cancelled";
  readonly ok?: boolean;
  readonly resumed?: boolean;
  readonly duration_ms?: number;
  readonly error_type?: string;
  readonly error_reason?: string;
  readonly error_report?: string;
  readonly status_code?: number;
  readonly result_count?: number;
  readonly run_id?: string;
  readonly schedule_id?: string;
}

/** Stable product events; detailed API features use area and operation rather than dynamic event names. */
export type UsageEvent =
  | "product_operation_started"
  | "product_operation_completed"
  | "tool_execution_started"
  | "tool_execution_completed"
  | "tool_approval_requested"
  | "account_connected"
  | "app_deployed"
  | "app_viewed"
  | "app_query_completed"
  | "app_mutation_completed"
  | "app_subscription_started"
  | "workflow_attempt_completed"
  | "schedule_run_completed";

/** The transport supplies verified client identity, never a caller-controlled analytics payload. */
export interface UsageContext {
  readonly source: "dashboard" | "api" | "mcp" | "app_ui" | "schedule" | "workflow" | "unknown";
  readonly client_id?: string;
  readonly client_name?: string;
  readonly app_id?: string;
  readonly tool_name?: string;
}

/** Request-local attribution is inherited by nested product operations. */
export const CurrentUsage = Context.Reference<UsageContext>("hosted/CurrentUsage", {
  defaultValue: () => ({ source: "unknown" }),
});

/**
 * The host's sink. Cloud installs one per request; self-host installs its process sink unless the
 * operator opted out. The default performs no collection or network I/O and refuses feedback.
 */
export const ProductAnalytics = Context.Reference<{
  readonly enabled: boolean;
  readonly capture: (event: {
    readonly event: UsageEvent;
    readonly userId: string;
    readonly organizationId?: string;
    readonly context: UsageContext;
    readonly properties: UsageProperties;
  }) => void;
  /** Send explicitly submitted feedback and wait for ingestion to accept it. */
  readonly submitFeedback: (feedback: {
    readonly message: string;
    readonly userId: string;
    readonly organizationId: string;
  }) => Effect.Effect<void, FeedbackUnavailable | FeedbackDisabled>;
}>("hosted/ProductAnalytics", {
  defaultValue: () => ({
    enabled: false,
    capture: () => {},
    submitFeedback: () => Effect.fail(feedbackDisabled()),
  }),
});

/** Record only authenticated activity with the current resolved organization. */
export const recordUsage = (event: UsageEvent, properties: UsageProperties = {}) =>
  Effect.gen(function* () {
    const sink = yield* ProductAnalytics;
    if (!sink.enabled) return;
    const userId = yield* CurrentUserId;
    if (userId === undefined) return;
    const organization = yield* Effect.serviceOption(CurrentOrganization);
    const span = yield* Effect.currentSpan.pipe(Effect.option);
    sink.capture({
      event,
      userId,
      ...(Option.isSome(organization) ? { organizationId: organization.value.organization } : {}),
      context: yield* CurrentUsage,
      properties: {
        ...properties,
        event_id: crypto.randomUUID(),
        ...(Option.isNone(span)
          ? {}
          : {
              trace_id: span.value.traceId,
              span_id: span.value.spanId,
              operation_id: span.value.spanId,
            }),
      },
    });
  });

const ErrorTag = Schema.Struct({
  _tag: Schema.String.check(Schema.isPattern(/^[A-Z][A-Za-z0-9]{0,79}$/u)),
});
const ErrorReason = Schema.Struct({
  reason: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/u)),
});

/** Export bounded error discriminators only, never a message, cause, or other serialized field. */
export const usageFailure = (cause: Cause.Cause<unknown>): UsageProperties => {
  if (Cause.hasInterrupts(cause)) return { outcome: "cancelled", ok: false };
  const failure = Cause.findErrorOption(cause);
  const error = failure.pipe(Option.flatMap(Schema.decodeUnknownOption(ErrorTag)));
  const reason = failure.pipe(Option.flatMap(Schema.decodeUnknownOption(ErrorReason)));
  return {
    outcome: "failure",
    ok: false,
    error_type: Option.isSome(error) ? error.value._tag : "UnhandledFailure",
    ...(Option.isSome(reason) ? { error_reason: reason.value.reason } : {}),
    // A report is curated safe evidence for failures the Executor team must fix.
    ...Option.match(failure, {
      onNone: () => ({}),
      onSome: (value) =>
        UserFacingError.is(value) && value.report !== undefined
          ? { error_report: value.report.slice(0, 300) }
          : {},
    }),
  };
};

/** Observe the caller's actual exit without changing its result, failure, or cancellation. */
export const observeUsage = <A, E, R>(
  event: UsageEvent,
  properties: UsageProperties,
  effect: Effect.Effect<A, E, R>,
  result?: (value: A) => UsageProperties,
) =>
  Effect.gen(function* () {
    if (!(yield* ProductAnalytics).enabled) return yield* effect;
    const started = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* recordUsage(event, {
            ...properties,
            duration_ms: Math.max(0, (yield* Clock.currentTimeMillis) - started),
            ...(Exit.isSuccess(exit)
              ? { outcome: "success" as const, ok: true, ...result?.(exit.value) }
              : usageFailure(exit.cause)),
          });
        }),
      ),
    );
  });

type ProductOperation = UsageProperties & { readonly area: string; readonly operation: string };

const productOperationSpan = (properties: ProductOperation) =>
  Effect.withSpan("product.operation", {
    attributes: {
      "executor.product.area": properties.area,
      "executor.product.operation": properties.operation,
    },
  });

/** Count attempted and finished operations separately so failures and abandoned work remain visible. */
export const observeProductOperation = <A, E, R>(
  properties: ProductOperation,
  effect: Effect.Effect<A, E, R>,
  result?: (value: A) => UsageProperties,
) =>
  recordUsage("product_operation_started", properties).pipe(
    Effect.andThen(observeUsage("product_operation_completed", properties, effect, result)),
    productOperationSpan(properties),
  );

/**
 * Trace a read without product analytics. Dashboard refetches and MCP discovery repeat
 * constantly and do not represent product use; failures still reach tracing and error reporting.
 */
export const traceProductRead = <A, E, R>(
  properties: ProductOperation,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(productOperationSpan(properties));

/** Safe HTTP methods are reads; every other method is recorded as a product operation. */
export const isReadMethod = (method: string) => method === "GET" || method === "HEAD";
