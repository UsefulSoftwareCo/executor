/** Read persistent PostHog stack outputs and bind only ingestion settings into the app. */
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Redacted, Schema, Option } from "effect";
import type { PostHogOutput } from "./posthog-output.ts";
import { productionSiteTelemetry } from "../contracts/edge-paths.ts";
import { pinnedInProduction } from "./site-telemetry.ts";

/** Bind the optional relay outside PostHog's enablement gate. */
const telemetryRelayBindings = (dev: boolean) =>
  Effect.gen(function* () {
    const configuredUrl = yield* Config.String("EXECUTOR_TELEMETRY_RELAY_URL").pipe(Config.option);
    const configuredToken = yield* Config.Redacted("EXECUTOR_TELEMETRY_RELAY_TOKEN").pipe(
      Config.option,
    );
    const urlText = Option.getOrElse(configuredUrl, () => "").trim();
    const tokenText = Option.match(configuredToken, {
      onNone: () => "",
      onSome: Redacted.value,
    }).trim();
    if (urlText === "" && tokenText === "") return {};
    if (urlText === "" || tokenText === "")
      return yield* Effect.die("Telemetry relay requires both URL and token");
    const url = URL.parse(urlText);
    const local =
      url !== null && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    if (
      url === null ||
      (url.protocol !== "https:" && !(dev && local)) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return yield* Effect.die("Telemetry relay URL must be HTTPS without credentials or query");
    const doNotTrack = yield* Config.String("DO_NOT_TRACK").pipe(Config.option);
    const disableAnalytics = yield* Config.String("EXECUTOR_DISABLE_ANALYTICS").pipe(Config.option);
    return {
      EXECUTOR_TELEMETRY_RELAY_URL: Output.asOutput(url.href.replace(/\/+$/u, "")),
      EXECUTOR_TELEMETRY_RELAY_TOKEN: Output.asOutput(Redacted.make(tokenText)),
      ...(Option.isSome(doNotTrack) ? { DO_NOT_TRACK: Output.asOutput(doNotTrack.value) } : {}),
      ...(Option.isSome(disableAnalytics)
        ? { EXECUTOR_DISABLE_ANALYTICS: Output.asOutput(disableAnalytics.value) }
        : {}),
    };
  });

/** The browser and server use the same project and deployment identity. */
export const postHogBindings = Effect.gen(function* () {
  const dev = (yield* AlchemyContext).dev;
  const relay = yield* telemetryRelayBindings(dev);
  const localPort = dev
    ? yield* Config.Number("POSTHOG_LOCAL_TEST_PORT").pipe(Config.option)
    : Option.none();
  if (Option.isSome(localPort)) {
    const port = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    )(localPort.value).pipe(Effect.orDie);
    const host = `http://127.0.0.1:${port}`;
    return {
      env: {
        ...relay,
        EXECUTOR_POSTHOG: Output.asOutput(
          Redacted.make(
            JSON.stringify({
              token: "synthetic-ingestion-key",
              host,
              path: "/api/0123456789abcdef",
              environment: "test-local",
              release: "fixture",
            }),
          ),
        ),
      },
      build: {},
      analyticsProxy: Output.asOutput<string | null>("/api/0123456789abcdef"),
    };
  }
  const enabled =
    !dev && (yield* Config.Boolean("POSTHOG_ENABLED").pipe(Config.withDefault(false)));
  if (!enabled)
    return {
      env: { ...relay, EXECUTOR_POSTHOG: Output.asOutput(null) },
      build: {},
      analyticsProxy: Output.asOutput<string | null>(null),
    };
  const environment = yield* Stage;
  const release = yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION");
  const internalUserIds = (yield* Config.String("POSTHOG_INTERNAL_USER_IDS").pipe(
    Config.withDefault(""),
  ))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const output = yield* Output.stackRef<PostHogOutput>("executor-next-posthog");
  const proxyPath = output.pipe(
    Output.map((value) => value.proxyPath),
    Output.mapEffect(
      pinnedInProduction(
        environment,
        "The PostHog proxy path (executor-next-posthog proxyPath)",
        productionSiteTelemetry.analyticsProxy,
      ),
    ),
  );
  return {
    env: {
      ...relay,
      EXECUTOR_POSTHOG: Output.all(
        output.pipe(Output.map((value) => value.apiToken)),
        output.pipe(Output.map((value) => value.apiHost)),
        proxyPath,
      ).pipe(
        Output.map(([token, host, path]) =>
          Redacted.make(
            JSON.stringify({
              token: Redacted.value(token),
              host,
              path,
              environment,
              release,
              internalUserIds,
            }),
          ),
        ),
      ),
    },
    build: {
      PUBLIC_POSTHOG_KEY: output.pipe(Output.map((value) => value.apiToken)),
      PUBLIC_POSTHOG_PATH: proxyPath,
      PUBLIC_POSTHOG_HOST: output.pipe(Output.map((value) => value.uiHost)),
      PUBLIC_EXECUTOR_ENVIRONMENT: environment,
      PUBLIC_EXECUTOR_RELEASE: release,
      VITE_POSTHOG_KEY: output.pipe(Output.map((value) => value.apiToken)),
      VITE_POSTHOG_PATH: proxyPath,
      VITE_POSTHOG_HOST: output.pipe(Output.map((value) => value.uiHost)),
      VITE_EXECUTOR_ENVIRONMENT: environment,
    },
    analyticsProxy: proxyPath,
  };
});
