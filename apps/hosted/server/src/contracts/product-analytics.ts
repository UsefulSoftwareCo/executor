import { Cause, Clock, Context, Effect, Exit, Option, Schema } from "effect";
import {
  feedbackDisabled,
  type FeedbackDisabled,
  type FeedbackUnavailable,
} from "@executor-js/telemetry/product-analytics";
import { CurrentUserId } from "./auth.ts";
import { CurrentOrganization } from "./organization.ts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";

export interface UsageProperties {
  readonly event_id?: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly operation_id?: string;
  readonly area?: string;
  readonly operation?: string;
  readonly app_id?: string;
  readonly version_id?: string;
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
  readonly grant_kind?: "mcp" | "api";
}

export type UsageEvent =
  | "product_operation_started"
  | "product_operation_completed"
  | "tool_execution_started"
  | "tool_execution_completed"
  | "tool_approval_requested"
  | "account_connected"
  | "agent_connected"
  | "app_deployed"
  | "app_viewed"
  | "app_query_completed"
  | "app_mutation_completed"
  | "app_subscription_started"
  | "workflow_attempt_completed"
  | "schedule_run_completed";

export interface UsageContext {
  readonly source: "dashboard" | "api" | "mcp" | "app_ui" | "schedule" | "workflow" | "unknown";
  readonly client_id?: string;
  readonly client_name?: string;
  readonly app_id?: string;
  readonly tool_name?: string;
}

export const CurrentUsage = Context.Reference<UsageContext>("hosted/CurrentUsage", {
  defaultValue: () => ({ source: "unknown" }),
});

export const ProductAnalytics = Context.Reference<{
  readonly enabled: boolean;
  readonly capture: (event: {
    readonly event: UsageEvent;
    readonly userId: string;
    readonly organizationId?: string;
    readonly context: UsageContext;
    readonly properties: UsageProperties;
  }) => void;
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
    ...Option.match(failure, {
      onNone: () => ({}),
      onSome: (value) =>
        UserFacingError.is(value) && value.report !== undefined
          ? { error_report: value.report.slice(0, 300) }
          : {},
    }),
  };
};

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

export const observeProductOperation = <A, E, R>(
  properties: ProductOperation,
  effect: Effect.Effect<A, E, R>,
  result?: (value: A) => UsageProperties,
) =>
  recordUsage("product_operation_started", properties).pipe(
    Effect.andThen(observeUsage("product_operation_completed", properties, effect, result)),
    productOperationSpan(properties),
  );

export const traceProductRead = <A, E, R>(
  properties: ProductOperation,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(productOperationSpan(properties));

export const isReadMethod = (method: string) => method === "GET" || method === "HEAD";
