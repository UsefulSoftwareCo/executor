/** Request-owned analytics and explicitly submitted feedback sent to PostHog. */
import { heroPreviewCookie, readHeroVisitor } from "@executor-js/marketing/experiments";
import { evaluateHeroFlag } from "./hero-experiment.ts";
import { FeedbackUnavailable, type Feedback } from "../contracts/feedback.ts";
import type { Executor } from "@executor-js/sdk/core";
import { CurrentUserId, CurrentOrganization } from "@executor-js/hosted-server";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { Cause, Context, Effect, Option, Redacted, Schema } from "effect";
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
});
type Settings = typeof Settings.Type;
type EventName =
  | "tool_execution_completed"
  | "account_connected"
  | "app_deployed"
  | "feedback_submitted"
  | "cloud_signup_completed"
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

const record = (event: EventName, properties: Properties) =>
  Effect.gen(function* () {
    const actor = yield* CurrentUserId;
    if (actor === undefined) return;
    const organization = yield* Effect.serviceOption(CurrentOrganization);
    const analytics = yield* Analytics;
    analytics.add({
      event,
      distinct_id: actor,
      timestamp: new Date().toISOString(),
      properties: {
        ...properties,
        ...(Option.isSome(organization)
          ? { organization_id: organization.value.organization }
          : {}),
      },
    });
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
                  $process_person_profile: event.event === "$identify",
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
        : send(events).pipe(Effect.catch(() => Effect.logWarning("PostHog batch export failed"))),
    );
    return yield* handler.pipe(
      Effect.provideService(Analytics, {
        submit: (event) => send([event]).pipe(Effect.mapError(() => new FeedbackUnavailable())),
        add: (event) => {
          if (events.length < 100) events.push(event);
        },
      }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

/** Instrument product operations at the host boundary, including MCP calls and resumptions. */
export const withExecutorAnalytics = (executor: Executor): Executor => ({
  ...executor,
  tools: {
    ...executor.tools,
    call: (input, options) =>
      executor.tools.call(input, options).pipe(
        Effect.tap((result) =>
          result.status === "completed"
            ? record("tool_execution_completed", {
                app_id: input.app,
                tool_name: input.tool,
                ok: true,
              })
            : Effect.void,
        ),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : record("tool_execution_completed", {
                app_id: input.app,
                tool_name: input.tool,
                ok: false,
              }),
        ),
      ),
    resume: (input, options) =>
      executor.tools.resume(input, options).pipe(
        Effect.tap((result) => {
          switch (result.status) {
            case "completed":
              return record("tool_execution_completed", { resumed: true, ok: true });
            case "failed":
              return record("tool_execution_completed", { resumed: true, ok: false });
            case "denied":
            case "cancelled":
            case "already-consumed":
              return Effect.void;
          }
        }),
      ),
  },
  accountConnections: {
    ...executor.accountConnections,
    submit: (input) =>
      executor.accountConnections
        .submit(input)
        .pipe(Effect.tap(() => record("account_connected", { method: "credentials" }))),
    completeOAuth: (input) =>
      executor.accountConnections
        .completeOAuth(input)
        .pipe(Effect.tap(() => record("account_connected", { method: "oauth" }))),
  },
  apps: {
    ...executor.apps,
    deploy: (input) =>
      executor.apps.deploy(input).pipe(Effect.tap(() => record("app_deployed", {}))),
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
