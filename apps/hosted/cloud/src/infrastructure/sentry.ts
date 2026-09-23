/** Bind public Sentry configuration and private build-only upload credentials. */
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Output from "alchemy/Output";
import * as Command from "alchemy/Command";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Schema } from "effect";
import type { SentryOutput } from "./sentry-output.ts";

/** Disabled stages do not read Sentry state or require management credentials. */
export const sentryBindings = Effect.gen(function* () {
  const dev = (yield* AlchemyContext).dev;
  const localPort = dev
    ? yield* Config.Number("SENTRY_LOCAL_TEST_PORT").pipe(Config.option)
    : Option.none();
  if (Option.isSome(localPort)) {
    const port = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    )(localPort.value).pipe(Effect.orDie);
    return {
      env: {
        EXECUTOR_SENTRY: Output.asOutput({
          localTest: true,
          dsn: `http://synthetic@127.0.0.1:${port}/1`,
          browserDsn: `http://synthetic@127.0.0.1:${port}/1`,
          tunnel: "/api/fedcba9876543210/submit",
          environment: "test-local",
          release: yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION"),
        }),
      },
      build: {
        PUBLIC_SENTRY_DSN: `http://synthetic@127.0.0.1:${port}/1`,
        PUBLIC_SENTRY_TUNNEL: "/api/fedcba9876543210/submit",
        PUBLIC_EXECUTOR_ENVIRONMENT: "test-local",
        PUBLIC_EXECUTOR_RELEASE: yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION"),
      },
    };
  }
  const enabled = !dev && (yield* Config.Boolean("SENTRY_ENABLED").pipe(Config.withDefault(false)));
  if (!enabled) return { env: { EXECUTOR_SENTRY: Output.asOutput(null) }, build: {} };
  const environment = yield* Stage;
  const release = yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION");
  const output = yield* Output.stackRef<SentryOutput>("executor-next-sentry");
  // Command children inherit the op-run environment; never persist the management token in resource props.
  yield* Config.Redacted("SENTRY_AUTH_TOKEN");
  const url = yield* Config.NonEmptyString("SENTRY_URL");
  return {
    env: {
      EXECUTOR_SENTRY: output.pipe(
        Output.map((value) => ({
          dsn: value.cloudDsn,
          browserDsn: value.browserDsn,
          tunnel: value.browserTunnel,
          environment,
          release,
        })),
      ),
    },
    build: {
      PUBLIC_SENTRY_TUNNEL: output.pipe(Output.map((value) => value.browserTunnel)),
      PUBLIC_SENTRY_DSN: output.pipe(Output.map((value) => value.browserDsn)),
      PUBLIC_EXECUTOR_ENVIRONMENT: environment,
      PUBLIC_EXECUTOR_RELEASE: release,
      VITE_SENTRY_TUNNEL: output.pipe(Output.map((value) => value.browserTunnel)),
      VITE_SENTRY_DSN: output.pipe(Output.map((value) => value.browserDsn)),
      VITE_EXECUTOR_ENVIRONMENT: environment,
      VITE_EXECUTOR_RELEASE: release,
      SENTRY_ORG: output.pipe(Output.map((value) => value.organization)),
      SENTRY_PROJECT: output.pipe(Output.map((value) => value.browserProject)),
      SENTRY_URL: url,
      SENTRY_RELEASE: release,
    },
  };
});

/** Upload the exact Rolldown artifacts deployed by Alchemy, matched by release and module path. */
export const uploadCloudSourceMaps = (
  worker: "api" | "app-pages",
  bundle: Output.Output<unknown>,
) =>
  Effect.gen(function* () {
    if (
      (yield* AlchemyContext).dev ||
      !(yield* Config.Boolean("SENTRY_ENABLED").pipe(Config.withDefault(false)))
    )
      return;
    const output = yield* Output.stackRef<SentryOutput>("executor-next-sentry");
    yield* Config.Redacted("SENTRY_AUTH_TOKEN");
    yield* Command.Exec(worker === "api" ? "SentryCloudSourceMaps" : "SentryAppPagesSourceMaps", {
      command: `bunx --no-install sentry-cli sourcemaps upload --url-prefix / .generated/sentry-worker/${worker}`,
      env: {
        SENTRY_URL: yield* Config.NonEmptyString("SENTRY_URL"),
        SENTRY_ORG: output.pipe(Output.map((value) => value.organization)),
        SENTRY_PROJECT: output.pipe(Output.map((value) => value.cloudProject)),
        SENTRY_RELEASE: yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION"),
        EXECUTOR_BUNDLE: bundle.pipe(Output.map((value) => JSON.stringify(value))),
      },
    });
  });
