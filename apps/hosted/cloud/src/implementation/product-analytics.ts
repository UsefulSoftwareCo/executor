/** Request-owned analytics and explicitly submitted feedback sent to PostHog. */
import { heroPreviewCookie, readHeroVisitor } from "@executor-js/marketing/experiments";
import { evaluateHeroFlag } from "./hero-experiment.ts";
import { FeedbackUnavailable, type Feedback } from "../contracts/feedback.ts";
import type { ToolCallResult, ToolResumeResult } from "@executor-js/sdk/core";
import type { Executor } from "@executor-js/sdk/core";
import {
  CurrentUserId,
  CurrentOrganization,
  ProductAnalytics,
  recordUsage,
  observeUsage,
  usageFailure,
  type UsageEvent,
  type UsageProperties,
} from "@executor-js/hosted-server";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { Clock, Context, Effect, Exit, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const Settings = Schema.Struct({
  token: Schema.String,
  host: Schema.String,
  path: Schema.String.check(Schema.isPattern(/^\/api\/[a-f0-9]{16}$/)),
  environment: Schema.String,
  release: Schema.String,
  internalUserIds: Schema.optional(Schema.Array(Schema.String)),
});
type Settings = typeof Settings.Type;
type EventName =
  | UsageEvent
  | "feedback_submitted"
  | "cloud_signup_completed"
  | "cloud_login_completed"
  | "analytics_events_dropped"
  | "$identify";
type Properties = Readonly<Record<string, string | number | boolean>>;
interface Event {
  readonly event: EventName;
  readonly properties: Properties;
  readonly distinct_id: string;
  readonly timestamp: string;
}
const Analytics = Context.Reference<{
  readonly add: (event: Event) => void;
  readonly submit: (event: Event) => Effect.Effect<void, FeedbackUnavailable>;
}>("cloud/Analytics", {
  defaultValue: () => ({
    add: () => {},
    submit: () => Effect.fail(new FeedbackUnavailable()),
  }),
});

/** Called only after Better Auth creates a new verified user, never on returning sign-in. */
export const recordCloudSignup = (userId: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const cookies = request.headers.cookie ?? "";
    const preview = cookies.split(";").some((part) => part.trim() === `${heroPreviewCookie}=1`);
    const visitor = preview ? undefined : readHeroVisitor(cookies);
    const analytics = yield* Analytics;
    if (visitor !== undefined)
      analytics.add({
        event: "$identify",
        distinct_id: userId,
        timestamp: new Date().toISOString(),
        properties: { $anon_distinct_id: visitor },
      });
    analytics.add({
      event: "cloud_signup_completed",
      distinct_id: userId,
      timestamp: new Date().toISOString(),
      properties: {},
    });
  });

/** Count successful session creation without recording login credentials or callback URLs. */
export const recordCloudLogin = (userId: string) =>
  Effect.flatMap(Analytics, (analytics) =>
    Effect.sync(() =>
      analytics.add({
        event: "cloud_login_completed",
        distinct_id: userId,
        timestamp: new Date().toISOString(),
        properties: {},
      }),
    ),
  );

/** Submit only the declared feedback text, with identity derived from the authenticated request. */
export const submitFeedback = (feedback: Feedback) =>
  Effect.gen(function* () {
    const actor = yield* CurrentUserId;
    const organization = yield* CurrentOrganization;
    if (actor === undefined) return yield* new FeedbackUnavailable();
    const analytics = yield* Analytics;
    yield* analytics.submit({
      event: "feedback_submitted",
      distinct_id: actor,
      timestamp: new Date().toISOString(),
      properties: { message: feedback.message, organization_id: organization.organization },
    });
  });

const readSettings = (read: Effect.Effect<unknown>) =>
  Effect.gen(function* () {
    const value = yield* read;
    if (value === undefined || value === null) return undefined;
    return yield* Schema.decodeUnknownEffect(
      Schema.Union([Settings, Schema.fromJsonString(Settings)]),
    )(Redacted.isRedacted(value) ? Redacted.value(value) : value).pipe(Effect.orDie);
  });

/** Drain one bounded batch through the owning request's Alchemy finalizer. */
export const withProductAnalytics = <A, E, R>(
  handler: Effect.Effect<A, E, R>,
  settings: Effect.Effect<Settings | undefined>,
) =>
  Effect.gen(function* () {
    const config = yield* settings;
    if (!config) return yield* handler;
    const events: Event[] = [];
    let dropped = 0;
    const add = (event: Event) => {
      if (events.length < 1000) events.push(event);
      else dropped++;
    };
    const client = yield* HttpClient.HttpClient;
    const send = (batch: readonly Event[]) =>
      client
        .execute(
          HttpClientRequest.post(`${config.host}/batch/`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              api_key: config.token,
              batch: batch.map((event) => ({
                ...event,
                properties: {
                  ...event.properties,
                  product_version: "v2",
                  environment: config.environment,
                  release: config.release,
                  executor_test: config.environment.startsWith("test-"),
                  executor_internal: config.internalUserIds?.includes(event.distinct_id) === true,
                  ...(event.properties.actor_type === "automation"
                    ? { $process_person_profile: false }
                    : {
                        $set: {
                          executor_internal:
                            config.internalUserIds?.includes(event.distinct_id) === true,
                        },
                        $process_person_profile: true,
                      }),
                },
              })),
            }),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.void
              : Effect.fail(response.status),
          ),
          Effect.timeout("3 seconds"),
          Effect.asVoid,
        );
    yield* Effect.addFinalizer(() =>
      events.length === 0
        ? Effect.void
        : send(
            dropped === 0
              ? events
              : [
                  ...events,
                  {
                    event: "analytics_events_dropped",
                    distinct_id: "analytics-exporter",
                    timestamp: new Date().toISOString(),
                    properties: { dropped_events: dropped },
                  },
                ],
          ).pipe(Effect.catch(() => Effect.logWarning("PostHog batch export failed"))),
    );
    return yield* handler.pipe(
      Effect.provideService(Analytics, {
        submit: (event) => send([event]).pipe(Effect.mapError(() => new FeedbackUnavailable())),
        add,
      }),
      Effect.provideService(ProductAnalytics, {
        enabled: true,
        capture: (event) =>
          add({
            event: event.event,
            distinct_id: event.userId,
            timestamp: new Date().toISOString(),
            properties: {
              ...event.context,
              ...event.properties,
              ...(event.organizationId === undefined
                ? {}
                : { organization_id: event.organizationId }),
            },
          }),
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

/** Background work has its own identity and never counts as an active human. */
export const recordBackgroundUsage = (
  event: "schedule_run_completed" | "workflow_attempt_completed",
  identity: string,
  properties: UsageProperties,
) =>
  Effect.flatMap(Analytics, (analytics) =>
    Effect.sync(() =>
      analytics.add({
        event,
        distinct_id: `automation:${identity}`,
        timestamp: new Date().toISOString(),
        properties: {
          ...properties,
          source: event === "schedule_run_completed" ? "schedule" : "workflow",
          actor_type: "automation",
        },
      }),
    ),
  );

/** Instrument completed tool work while keeping approval pauses out of completion counts. */
const observeTool = <A extends ToolCallResult | ToolResumeResult, E, R>(
  properties: UsageProperties,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    yield* recordUsage("tool_execution_started", properties);
    return yield* work.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const timed = {
            ...properties,
            duration_ms: Math.max(0, (yield* Clock.currentTimeMillis) - started),
          };
          if (Exit.isFailure(exit)) {
            yield* recordUsage("tool_execution_completed", {
              ...timed,
              ...usageFailure(exit.cause),
            });
            return;
          }
          const status = exit.value.status;
          if (status !== "approval-required") {
            yield* recordUsage("tool_execution_completed", {
              ...timed,
              status,
              ok: status === "completed",
              outcome:
                status === "completed"
                  ? "success"
                  : status === "cancelled"
                    ? "cancelled"
                    : "failure",
            });
          } else {
            yield* recordUsage("tool_approval_requested", { ...timed, status });
          }
        }),
      ),
    );
  });

/** Product host boundaries cover API/MCP work and private app queries without inspecting payloads. */
export const withExecutorAnalytics = (executor: Executor): Executor => ({
  ...executor,
  tools: {
    ...executor.tools,
    call: (input, options) =>
      observeTool(
        { app_id: input.app, tool_name: input.tool },
        executor.tools.call(input, options),
      ),
    resume: (input, options) =>
      observeTool({ resumed: true }, executor.tools.resume(input, options)),
  },
  appData: {
    ...executor.appData,
    query: (input) =>
      observeUsage(
        "app_query_completed",
        { app_id: input.app, operation: input.name },
        executor.appData.query(input),
      ),
    mutate: (input) =>
      observeUsage(
        "app_mutation_completed",
        { app_id: input.app, operation: input.name },
        executor.appData.mutate(input),
      ),
    subscribe: (input) =>
      observeUsage(
        "app_subscription_started",
        { app_id: input.app, operation: input.name },
        executor.appData.subscribe(input),
      ),
  },
  accountConnections: {
    ...executor.accountConnections,
    submit: (input) =>
      executor.accountConnections.submit(input).pipe(
        Effect.tap((account) =>
          recordUsage("account_connected", {
            method: "credentials",
            account_id: account.id,
            provider_id: account.provider,
          }),
        ),
      ),
    completeOAuth: (input) =>
      executor.accountConnections.completeOAuth(input).pipe(
        Effect.tap((account) =>
          recordUsage("account_connected", {
            method: "oauth",
            account_id: account.id,
            provider_id: account.provider,
          }),
        ),
      ),
  },
  apps: {
    ...executor.apps,
    deploy: (input) =>
      executor.apps.deploy(input).pipe(
        Effect.tap((result) =>
          recordUsage("app_deployed", {
            app_id: result.app.id,
            deployment_id: result.deployment.id,
          }),
        ),
      ),
  },
});

/** Fixed upstreams and an explicit header allowlist prevent forwarding product credentials. */
export const postHogUpstream = (
  request: Request,
  config: Pick<Settings, "host" | "path">,
): Request | undefined => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${config.path}/`)) return undefined;
  const path = url.pathname.slice(config.path.length);
  if (
    !/^\/(?:push|e\/?|i\/v0\/e\/?|batch\/?|flags\/?|decide\/?|array\/.*|static\/.*|surveys\/?|capture\/?|s\/.*)$/.test(
      path,
    )
  )
    return undefined;
  const upstream = new URL(config.host);
  if (path.startsWith("/static/"))
    upstream.hostname = upstream.hostname.replace(".i.posthog.com", "-assets.i.posthog.com");
  upstream.pathname = path === "/push" ? "/e/" : path;
  upstream.search = path === "/push" ? "?ip=0" : url.search;
  const headers = new Headers();
  for (const name of ["content-type", "content-encoding", "accept", "user-agent"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(upstream, {
    method: request.method,
    headers,
    ...(request.body ? { body: request.body, duplex: "half" } : {}),
    redirect: "manual",
  });
};

/** Serve the public SDK endpoints through the managed first-party path shared by both browser builds. */
const postHogProxy = (settings: Effect.Effect<Settings | undefined>) =>
  Effect.gen(function* () {
    const config = yield* settings;
    if (!config) return HttpServerResponse.empty({ status: 404 });
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "OPTIONS")
      return HttpServerResponse.empty({ status: 405 });
    const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    const upstream = postHogUpstream(web, config);
    if (!upstream) return HttpServerResponse.empty({ status: 404 });
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(upstream, { signal }),
      catch: () => new Error("PostHog proxy failed"),
    }).pipe(Effect.timeout("10 seconds"), Effect.option);
    if (Option.isNone(response)) return HttpServerResponse.empty({ status: 502 });
    const headers = new Headers(response.value.headers);
    headers.delete("set-cookie");
    return HttpServerResponse.fromWeb(
      new Response(response.value.body, { status: response.value.status, headers }),
    );
  });

/** Capture the Alchemy runtime accessor during initialization, then read bindings per request. */
export const cloudAnalytics = Effect.gen(function* () {
  const context = yield* CurrentRuntimeContext;
  const settings = readSettings(
    context ? context.get<unknown>("EXECUTOR_POSTHOG") : Effect.succeed(undefined),
  );
  return {
    proxy: postHogProxy(settings),
    hero: (visitor: string) =>
      Effect.flatMap(settings, (config) =>
        config === undefined ? Effect.succeed(undefined) : evaluateHeroFlag(config, visitor),
      ),
    wrap: <A, E, R>(handler: Effect.Effect<A, E, R>) => withProductAnalytics(handler, settings),
  };
});
