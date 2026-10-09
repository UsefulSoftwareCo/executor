/**
 * Anonymous product analytics for the CLI, desktop and self-host. Hosts record explicit events; each
 * event's schema is its allowlist, so a property it does not declare is never sent. Delivery is a
 * bounded in-memory batch to PostHog's `/batch/` endpoint and never affects product operations.
 */
import { Cause, Config, Effect, Exit, Option, Queue, Schema, Semaphore } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/** Feedback text: at least one non-whitespace character and at most 10,000 characters. */
export const FeedbackMessage = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(10_000),
  Schema.isPattern(/\S/u),
);

/** Explicit feedback text; arbitrary event properties and caller identities are not accepted. */
export const Feedback = Schema.Struct({ message: FeedbackMessage });
export type Feedback = typeof Feedback.Type;

/** Feedback could not be confirmed: ingestion failed, rejected the batch or timed out. */
export const FeedbackUnavailable = ApiError.define({
  tag: "FeedbackUnavailable",
  status: 503,
  message: "Executor could not confirm that the feedback was received. Try again later.",
});
export type FeedbackUnavailable = typeof FeedbackUnavailable.Type;

/**
 * The operator turned analytics off, or this build has no analytics destination. A 4xx status
 * reaches agents with its explanation; generated app clients hide 5xx response bodies.
 */
export class FeedbackDisabled extends Schema.TaggedError<FeedbackDisabled>()(
  "FeedbackDisabled",
  { message: Schema.Literal("Feedback is disabled on this instance.") },
  { httpApiStatus: 409 },
) {}

/** The error returned whenever this instance does not send feedback. */
export const feedbackDisabled = () =>
  new FeedbackDisabled({ message: "Feedback is disabled on this instance." });

/** The product that sent an event. Cloud has its own request-owned exporter. */
export const AnalyticsProduct = Schema.Literals(["cli", "desktop", "self-host"]);
export type AnalyticsProduct = typeof AnalyticsProduct.Type;

const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u));
/** An anonymous install ID: a random UUID minted once per data directory. */
export const InstallId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
);
/** A registrable domain, or `private` for local, tunnel and shared-platform hosts. */
export const RootDomain = Schema.String.check(
  Schema.isPattern(/^(?:private|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63})$/u),
);
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }));
const Duration = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1e12 }));
/** Fixed API group, endpoint and MCP operation names; never an author's query or tool name. */
const RouteName = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u));

const usage = {
  source: Schema.optional(
    Schema.Literals(["dashboard", "api", "mcp", "app_ui", "schedule", "workflow", "unknown"]),
  ),
  client_name: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
};
const completion = {
  outcome: Schema.optional(Schema.Literals(["success", "failure", "cancelled"])),
  ok: Schema.optional(Schema.Boolean),
  duration_ms: Schema.optional(Duration),
  error_type: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z][A-Za-z0-9]{0,79}$/u))),
  status_code: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
};

/**
 * Every event and the only properties it may carry. Decoding drops undeclared properties, so
 * names, inputs, outputs, URLs, raw IDs and error messages cannot reach the batch.
 */
export const analyticsEvents = {
  instance_started: Schema.Struct({
    product: AnalyticsProduct,
    version: Token,
    channel: Schema.Literals(["latest", "beta", "development"]),
    os: Token,
    arch: Token,
    apps: Schema.optional(Count),
    accounts: Schema.optional(Count),
    users: Schema.optional(Count),
    organizations: Schema.optional(Count),
  }),
  product_operation_started: Schema.Struct({ ...usage, area: RouteName, operation: RouteName }),
  product_operation_completed: Schema.Struct({
    ...usage,
    area: RouteName,
    operation: RouteName,
    ...completion,
  }),
  tool_execution_started: Schema.Struct({ ...usage, resumed: Schema.optional(Schema.Boolean) }),
  tool_execution_completed: Schema.Struct({
    ...usage,
    resumed: Schema.optional(Schema.Boolean),
    ...completion,
  }),
  tool_approval_requested: Schema.Struct({
    ...usage,
    resumed: Schema.optional(Schema.Boolean),
    duration_ms: Schema.optional(Duration),
  }),
  account_connected: Schema.Struct({
    ...usage,
    auth_kind: Schema.Literals(["credentials", "oauth"]),
  }),
  app_deployed: Schema.Struct(usage),
  app_viewed: Schema.Struct(usage),
  app_query_completed: Schema.Struct({ ...usage, ...completion }),
  app_mutation_completed: Schema.Struct({ ...usage, ...completion }),
  app_subscription_started: Schema.Struct({ ...usage, ...completion }),
  schedule_run_completed: Schema.Struct({
    source: Schema.optional(Schema.Literal("schedule")),
    ...completion,
  }),
  feedback_submitted: Schema.Struct({ message: FeedbackMessage }),
} as const;

type Events = typeof analyticsEvents;
/** An event name with an allowlist. */
export type AnalyticsEventName = keyof Events;
/** The typed properties a host may record for an event. */
export type AnalyticsProperties<Name extends AnalyticsEventName> = Events[Name]["Type"];

const isEventName = (name: string): name is AnalyticsEventName =>
  Object.hasOwn(analyticsEvents, name);

/** Keep only the declared properties of a known event; anything else is not recorded. */
const allowlisted = (name: string, properties: unknown) =>
  isEventName(name)
    ? Schema.decodeUnknownOption(analyticsEvents[name] as Schema.Decoder<object>)(properties).pipe(
        Option.map((value) => ({ name, properties: value })),
      )
    : Option.none();

const ErrorTag = Schema.Struct({
  _tag: Schema.String.check(Schema.isPattern(/^[A-Z][A-Za-z0-9]{0,79}$/u)),
});

/** A failed or cancelled exit as an outcome and a bounded error tag, never a message or cause. */
export const failureProperties = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterrupts(cause)) return { outcome: "cancelled" as const, ok: false };
  const tag = Cause.findErrorOption(cause).pipe(
    Option.flatMap(Schema.decodeUnknownOption(ErrorTag)),
  );
  return {
    outcome: "failure" as const,
    ok: false,
    error_type: Option.isSome(tag) ? tag.value._tag : "UnhandledFailure",
  };
};

/** A tool call's terminal outcome. A completed call that reports a tool error is a failure. */
export const toolCompletion = (result: {
  readonly status: string;
  readonly toolError?: boolean | undefined;
}) => {
  const failed = result.status === "completed" && result.toolError === true;
  return {
    ok: result.status === "completed" && !failed,
    outcome:
      result.status === "completed"
        ? failed
          ? ("failure" as const)
          : ("success" as const)
        : result.status === "cancelled"
          ? ("cancelled" as const)
          : ("failure" as const),
    ...(failed ? { error_type: "McpToolError" } : {}),
  };
};

/** Properties sent with every event from this installation. */
export interface CommonProperties {
  readonly install_id: string;
  readonly product: AnalyticsProduct;
  readonly version: string;
  /** Self-host only: the registrable domain of its public origin, or `private`. */
  readonly root_domain?: string;
}

/** Release channel of an `EXECUTOR_BUILD_VERSION`; source and test builds are `development`. */
export const releaseChannelOf = (version: string) =>
  /^2\.\d+\.\d+-beta\.\d+$/.test(version)
    ? ("beta" as const)
    : /^2\.\d+\.\d+$/.test(version)
      ? ("latest" as const)
      : ("development" as const);

/** Normalize a platform name to the vocabulary the event allows. */
export const platformToken = (value: string) =>
  Option.isSome(Schema.decodeUnknownOption(Token)(value)) ? value : "unknown";

// consoledonottrack.com: any value other than an explicit false turns analytics off.
const truthy = (value: string) =>
  !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());

/** `DO_NOT_TRACK` or `EXECUTOR_DISABLE_ANALYTICS` turns off every event, including feedback. */
export const analyticsOptedOut = Effect.gen(function* () {
  for (const name of ["DO_NOT_TRACK", "EXECUTOR_DISABLE_ANALYTICS"]) {
    const value = yield* Config.String(name).pipe(Config.option);
    if (Option.isSome(value) && truthy(value.value)) return true;
  }
  return false;
});

/** Where batches go and how often a partial batch is sent. */
export interface AnalyticsDestination {
  readonly host: string;
  readonly key: string;
  readonly flushInterval: "1 second" | "10 seconds";
}

const IngestionHost = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }),
);

/**
 * Resolve the destination, or none. Release builds bake `EXECUTOR_POSTHOG_PUBLIC_KEY` and
 * `EXECUTOR_POSTHOG_HOST`; other builds send nothing. Under `NODE_ENV=test` only the loopback
 * collector on `EXECUTOR_ANALYTICS_TEST_PORT` is used, so tests never reach PostHog.
 */
export const analyticsDestination = Effect.gen(function* () {
  if (yield* analyticsOptedOut) return undefined;
  const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("production"));
  if (environment === "test") {
    const port = yield* Config.Number("EXECUTOR_ANALYTICS_TEST_PORT").pipe(Config.option);
    if (Option.isNone(port) || !Number.isInteger(port.value) || port.value < 1) return undefined;
    return {
      host: `http://127.0.0.1:${port.value}`,
      key: "synthetic-ingestion-key",
      flushInterval: "1 second",
    } satisfies AnalyticsDestination;
  }
  const key = (yield* Config.String("EXECUTOR_POSTHOG_PUBLIC_KEY").pipe(
    Config.withDefault(""),
  )).trim();
  const host = (yield* Config.String("EXECUTOR_POSTHOG_HOST").pipe(Config.withDefault(""))).trim();
  if (key === "" || Option.isNone(Schema.decodeUnknownOption(IngestionHost)(host)))
    return undefined;
  return {
    host: host.replace(/\/+$/, ""),
    key,
    flushInterval: "10 seconds",
  } satisfies AnalyticsDestination;
}).pipe(Effect.catch(() => Effect.succeed(undefined)));

/** The one-line notice servers print when analytics are on. */
export const analyticsNotice =
  "Executor sends anonymous usage analytics. Set DO_NOT_TRACK=1 or EXECUTOR_DISABLE_ANALYTICS=1 to turn them off.";

interface Pending {
  readonly uuid: string;
  readonly event: AnalyticsEventName;
  readonly properties: object;
  readonly timestamp: string;
  /** A product user, resolved to a distinct ID only while sending; never stored in a batch. */
  readonly user: string | undefined;
}

/** Records events for one host process. */
export interface AnalyticsSender {
  /** Buffer an event. An unknown event, or a property outside its allowlist, is dropped. */
  readonly capture: (event: string, properties: unknown, user?: string) => void;
  /** Send one event now and wait for ingestion to accept it. */
  readonly submit: (
    event: AnalyticsEventName,
    properties: unknown,
    user?: string,
  ) => Effect.Effect<void, FeedbackUnavailable>;
}

const bufferLimit = 1_000;
const batchSize = 100;

/**
 * Own the buffer and its delivery for the current scope: send on an interval, when a batch fills,
 * and once more at shutdown. A failed batch returns to the front of the bounded buffer.
 */
export const makeAnalyticsSender = (options: {
  readonly destination: AnalyticsDestination;
  readonly common: CommonProperties;
  /** Self-host pseudonymizes users; without it every event uses the install ID. */
  readonly distinctId?: (user: string) => Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const { destination, common, distinctId } = options;
    const buffer: Pending[] = [];
    const wake = yield* Queue.dropping<void>(1);
    const gate = yield* Semaphore.make(1);
    const pending = (event: string, properties: unknown, user: string | undefined) =>
      allowlisted(event, properties).pipe(
        Option.map((allowed): Pending => ({
          uuid: crypto.randomUUID(),
          event: allowed.name,
          properties: allowed.properties,
          timestamp: new Date().toISOString(),
          user,
        })),
      );
    const post = (batch: readonly Pending[]) =>
      Effect.gen(function* () {
        const events = yield* Effect.forEach(batch, (event) =>
          (event.user === undefined || distinctId === undefined
            ? Effect.succeed(common.install_id)
            : distinctId(event.user)
          ).pipe(
            Effect.map((distinct_id) => ({
              uuid: event.uuid,
              event: event.event,
              distinct_id,
              timestamp: event.timestamp,
              properties: {
                ...event.properties,
                ...common,
                $process_person_profile: false,
                $geoip_disable: true,
                $lib: "executor-server",
              },
            })),
          ),
        );
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${destination.host}/batch/`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ api_key: destination.key, batch: events }),
          ),
        );
        if (response.status < 200 || response.status >= 300)
          return yield* Effect.fail(new FeedbackUnavailable());
      }).pipe(
        // PostHog is a third party: no client span or trace headers leave with the request.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provide(FetchHttpClient.layer),
      );
    const flush = gate.withPermits(1)(
      Effect.gen(function* () {
        while (buffer.length > 0) {
          const batch = buffer.splice(0, batchSize);
          const exit = yield* post(batch).pipe(Effect.timeout("10 seconds"), Effect.exit);
          if (Exit.isFailure(exit)) {
            buffer.unshift(...batch);
            if (buffer.length > bufferLimit) buffer.splice(bufferLimit);
            return yield* Effect.logDebug("Product analytics batch was not delivered");
          }
        }
      }),
    );
    // Added before the loop, so it runs after the loop is interrupted at shutdown.
    yield* Effect.addFinalizer(() => flush.pipe(Effect.timeout("3 seconds"), Effect.ignore));
    yield* Effect.forever(
      Queue.take(wake).pipe(Effect.timeoutOption(destination.flushInterval), Effect.andThen(flush)),
    ).pipe(Effect.forkScoped);
    const sender: AnalyticsSender = {
      capture: (event, properties, user) => {
        const next = pending(event, properties, user);
        if (Option.isNone(next) || buffer.length >= bufferLimit) return;
        buffer.push(next.value);
        if (buffer.length >= batchSize) Queue.offerUnsafe(wake, undefined);
      },
      submit: (event, properties, user) =>
        Effect.gen(function* () {
          const next = pending(event, properties, user);
          if (Option.isNone(next)) return yield* new FeedbackUnavailable();
          const exit = yield* post([next.value]).pipe(Effect.timeout("5 seconds"), Effect.exit);
          if (Exit.isFailure(exit)) return yield* new FeedbackUnavailable();
        }),
    };
    return sender;
  });
