import { Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";
import { FeedbackUnavailable } from "@executor-js/telemetry/product-analytics";

const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
);

export interface TelemetryRelaySettings {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
}

type BindingReader = (name: string) => Effect.Effect<unknown>;

const bindingText = (value: unknown) => {
  const plain = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  return typeof plain === "string" ? plain.trim() : "";
};

const RelayUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }),
);

export const readTelemetryRelaySettings = (read: BindingReader) =>
  Effect.gen(function* () {
    const url = bindingText(yield* read("EXECUTOR_TELEMETRY_RELAY_URL"));
    const token = bindingText(yield* read("EXECUTOR_TELEMETRY_RELAY_TOKEN"));
    if (url === "" && token === "") return undefined;
    if (url === "" || token === "") return yield* Effect.die("Telemetry relay needs URL and token");
    const valid = yield* Schema.decodeUnknownEffect(RelayUrl)(url).pipe(Effect.orDie);
    return {
      url: new URL(valid).href.replace(/\/+$/u, ""),
      token: Redacted.make(token),
    } satisfies TelemetryRelaySettings;
  });

export const readRelayAnalyticsOptOut = (
  read: BindingReader,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    if (request.headers.dnt === "1") return true;
    for (const name of ["DO_NOT_TRACK", "EXECUTOR_DISABLE_ANALYTICS"]) {
      const value = bindingText(yield* read(name)).toLowerCase();
      if (!["", "0", "false", "no", "off"].includes(value)) return true;
    }
    return false;
  });

export interface RelayEvent {
  readonly event: string;
  readonly account_id: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, string>>;
}

const identifier = (value: unknown) =>
  typeof value === "string"
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Identifier)(value))
    : undefined;

const propertiesFor = (
  event: string,
  properties: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string>> | undefined => {
  const appId = identifier(properties.app_id);
  const serviceId = identifier(properties.service_id);
  switch (event) {
    case "cloud_signup_completed":
    case "invitation_sent":
    case "invitation_accepted":
    case "account_connected":
      return {};
    case "app_installed":
      return appId === undefined ? undefined : { app_id: appId };
    case "account_connection_failed":
    case "tool_execution_completed":
      return appId === undefined ? {} : { app_id: appId };
    case "tool_search_empty":
      return serviceId === undefined ? {} : { service_id: serviceId };
    default:
      return undefined;
  }
};

export const relayEvent = (input: {
  readonly event: string;
  readonly accountId: string;
  readonly timestamp: string;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}): RelayEvent | undefined => {
  const accountId = identifier(input.accountId);
  const properties = propertiesFor(input.event, input.properties);
  if (accountId === undefined || properties === undefined) return undefined;
  return {
    event: input.event,
    account_id: accountId,
    timestamp: input.timestamp,
    properties,
  };
};

const post = (settings: TelemetryRelaySettings, path: "analytics" | "feedback", body: unknown) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${settings.url}/${path}`).pipe(
        HttpClientRequest.bearerToken(settings.token),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail("Telemetry relay rejected the request");
  }).pipe(
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provide(FetchHttpClient.layer),
  );

export const sendRelayAnalytics = (
  settings: TelemetryRelaySettings,
  events: ReadonlyArray<RelayEvent>,
) => (events.length === 0 ? Effect.void : post(settings, "analytics", { events }));

export const sendRelayFeedback = (
  settings: TelemetryRelaySettings,
  feedback: { readonly message: string; readonly accountId: string },
) => {
  const accountId = identifier(feedback.accountId);
  if (accountId === undefined) return Effect.fail(new FeedbackUnavailable());
  return post(settings, "feedback", {
    message: feedback.message,
    account_id: accountId,
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(() => new FeedbackUnavailable()),
  );
};
