/** Read persistent PostHog stack outputs and bind only ingestion settings into the app. */
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Redacted, Schema, Option } from "effect";
import type { PostHogOutput } from "./posthog-output.ts";

/** The browser and server use the same project and deployment identity. */
export const postHogBindings = Effect.gen(function* () {
  const dev = (yield* AlchemyContext).dev;
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
    };
  }
  const enabled =
    !dev && (yield* Config.Boolean("POSTHOG_ENABLED").pipe(Config.withDefault(false)));
  if (!enabled) return { env: { EXECUTOR_POSTHOG: Output.asOutput(null) }, build: {} };
  const environment = yield* Stage;
  const release = yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION");
  const internalUserIds = (yield* Config.String("POSTHOG_INTERNAL_USER_IDS").pipe(
    Config.withDefault(""),
  ))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const output = yield* Output.stackRef<PostHogOutput>("executor-next-posthog");
  return {
    env: {
      EXECUTOR_POSTHOG: Output.all(
        output.pipe(Output.map((value) => value.apiToken)),
        output.pipe(Output.map((value) => value.apiHost)),
        output.pipe(Output.map((value) => value.proxyPath)),
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
      PUBLIC_POSTHOG_PATH: output.pipe(Output.map((value) => value.proxyPath)),
      PUBLIC_POSTHOG_HOST: output.pipe(Output.map((value) => value.uiHost)),
      PUBLIC_EXECUTOR_ENVIRONMENT: environment,
      PUBLIC_EXECUTOR_RELEASE: release,
      VITE_POSTHOG_KEY: output.pipe(Output.map((value) => value.apiToken)),
      VITE_POSTHOG_PATH: output.pipe(Output.map((value) => value.proxyPath)),
      VITE_POSTHOG_HOST: output.pipe(Output.map((value) => value.uiHost)),
      VITE_EXECUTOR_ENVIRONMENT: environment,
      VITE_EXECUTOR_RELEASE: release,
    },
  };
});
