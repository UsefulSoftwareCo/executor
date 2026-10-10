/** Request-owned analytics and explicitly submitted feedback sent to PostHog. */
import { readSiteVisitor, siteVisitorCookie } from "@executor-js/marketing/site-visitor";
import { recordRoute } from "@executor-js/telemetry";
import { FeedbackUnavailable } from "@executor-js/telemetry/product-analytics";
import {
  ProductAnalytics,
  type UsageEvent,
  type UsageProperties,
} from "@executor-js/hosted-server";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { Context, Effect, Option, Redacted, Schema } from "effect";
import {
  Cookies,
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

const Settings = Schema.Struct({
  token: Schema.String,
  host: Schema.String,
  path: Schema.String.check(Schema.isPattern(/^\/api\/[a-f0-9]{16}$/u)),
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
}>("cloud/Analytics", {
  defaultValue: () => ({ add: () => {} }),
});

/** Called only after Better Auth creates a new verified user, never on returning sign-in. */
export const recordCloudSignup = (userId: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const visitor = readSiteVisitor(request.headers.cookie ?? "");
    const analytics = yield* Analytics;
    // Link the site visit that led here, so marketing attribution reaches the new account.
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

/** Prevent a later user on a shared browser from inheriting an identified site visitor. */
export const clearSiteVisitorOnSignOut =
  (cookieDomain?: string) => (response: HttpServerResponse.HttpServerResponse) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.method !== "POST" ||
        new URL(request.url, "http://localhost").pathname !== "/api/auth/sign-out" ||
        response.status < 200 ||
        response.status >= 300
      )
        return response;
      return yield* response.pipe(
        HttpServerResponse.expireCookie(siteVisitorCookie, {
          path: "/",
          ...(cookieDomain === undefined ? {} : { domain: cookieDomain }),
        }),
        Effect.orDie,
      );
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
        add,
      }),
      Effect.provideService(ProductAnalytics, {
        enabled: true,
        submitFeedback: (feedback) =>
          send([
            {
              event: "feedback_submitted",
              distinct_id: feedback.userId,
              timestamp: new Date().toISOString(),
              properties: { message: feedback.message, organization_id: feedback.organizationId },
            },
          ]).pipe(Effect.mapError(() => new FeedbackUnavailable())),
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
  Effect.gen(function* () {
    const analytics = yield* Analytics;
    const span = yield* Effect.currentSpan.pipe(Effect.option);
    analytics.add({
      event,
      distinct_id: `automation:${identity}`,
      timestamp: new Date().toISOString(),
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
        source: event === "schedule_run_completed" ? "schedule" : "workflow",
        actor_type: "automation",
      },
    });
  });

/**
 * The PostHog SDK endpoints the proxy forwards, each with the route its span records. The
 * `array`, `static` and `s` endpoints take a project key and file names in the rest of the path.
 */
const postHogEndpoints: ReadonlyArray<readonly [RegExp, `/${string}`]> = [
  [/^\/push$/, "/api/:channel/push"],
  [/^\/e\/?$/, "/api/:channel/e"],
  [/^\/i\/v0\/e\/?$/, "/api/:channel/i/v0/e"],
  [/^\/batch\/?$/, "/api/:channel/batch"],
  [/^\/flags\/?$/, "/api/:channel/flags"],
  [/^\/decide\/?$/, "/api/:channel/decide"],
  [/^\/array\/.*$/, "/api/:channel/array/*"],
  [/^\/static\/.*$/, "/api/:channel/static/*"],
  [/^\/surveys\/?$/, "/api/:channel/surveys"],
  [/^\/capture\/?$/, "/api/:channel/capture"],
  [/^\/s\/.*$/, "/api/:channel/s/*"],
];

/** Fixed upstreams and an explicit header allowlist prevent forwarding product credentials. */
export const postHogUpstream = (
  request: HttpServerRequest.HttpServerRequest,
  config: Pick<Settings, "host" | "path">,
):
  | { readonly request: HttpClientRequest.HttpClientRequest; readonly route: `/${string}` }
  | undefined => {
  const url = new URL(request.url, "https://posthog.internal");
  if (!url.pathname.startsWith(`${config.path}/`)) return undefined;
  const path = url.pathname.slice(config.path.length);
  const endpoint = postHogEndpoints.find(([pattern]) => pattern.test(path));
  if (endpoint === undefined) return undefined;
  const upstream = new URL(config.host);
  if (path.startsWith("/static/"))
    upstream.hostname = upstream.hostname.replace(".i.posthog.com", "-assets.i.posthog.com");
  upstream.pathname = path === "/push" ? "/e/" : path;
  upstream.search = path === "/push" ? "?ip=0" : url.search;
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "content-encoding", "accept", "user-agent"]) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  return {
    request: HttpClientRequest.make(request.method)(upstream, {
      headers,
      ...(request.method === "POST"
        ? { body: HttpBody.stream(request.stream, headers["content-type"]) }
        : {}),
    }),
    route: endpoint[1],
  };
};

/** Serve the public SDK endpoints through the managed first-party path shared by both browser builds. */
const postHogProxy = (settings: Effect.Effect<Settings | undefined>) =>
  Effect.gen(function* () {
    const config = yield* settings;
    if (!config) return HttpServerResponse.empty({ status: 404 });
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET" && request.method !== "POST" && request.method !== "OPTIONS")
      return HttpServerResponse.empty({ status: 405 });
    const upstream = postHogUpstream(request, config);
    if (!upstream) return HttpServerResponse.empty({ status: 404 });
    yield* recordRoute(upstream.route);
    const response = yield* HttpClient.execute(upstream.request).pipe(
      // PostHog is a third party: no client span or trace headers leave with the request.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout("10 seconds"),
      Effect.option,
    );
    if (Option.isNone(response)) return HttpServerResponse.empty({ status: 502 });
    return HttpServerResponse.fromClientResponse(response.value).pipe(
      HttpServerResponse.replaceCookies(Cookies.empty),
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
    wrap: <A, E, R>(handler: Effect.Effect<A, E, R>) => withProductAnalytics(handler, settings),
  };
});
