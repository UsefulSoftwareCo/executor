/** Explicit local test server. Production's entry point never mounts these auth shortcuts. */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { localTelemetry } from "@executor-js/telemetry/local";
import { Config, ConfigProvider, Console, Effect, Layer, Option } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import { HttpRouter } from "effect/unstable/http";
import { selfHostRoutes } from "../self-host/src/main.ts";
import { selfHostDatabase } from "../self-host/src/database.ts";
import { selfHostConfiguration } from "../self-host/src/implementation/bootstrap.ts";
import { devAppName, freePort } from "../../../scripts/dev-host.ts";
import { developmentSettings, developmentSignIn } from "./development.ts";

/**
 * Zero-config defaults; explicit settings win. The hostname is per checkout so browser
 * cookies stay separate, the port is free for this run, and the self-host bootstrap keeps
 * generated keys in the data directory.
 */
const testServerConfiguration = Effect.gen(function* () {
  const base = yield* ConfigProvider.ConfigProvider;
  const origin = yield* Config.String("BETTER_AUTH_URL").pipe(Config.option);
  const defaults = ConfigProvider.fromUnknown({
    NODE_ENV: "development",
    EXECUTOR_DATA_DIR: ".local/test-accounts/self-host/data",
    ...(Option.isNone(origin)
      ? {
          BETTER_AUTH_URL: `http://${devAppName("self-host-test")}.localhost:${yield* Effect.promise(freePort)}`,
        }
      : {}),
  });
  return yield* selfHostConfiguration.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      base.pipe(ConfigProvider.orElse(defaults)),
    ),
  );
});

const command = Command.make("test-self-host", {
  organization: Flag.String("organization").pipe(Flag.withDefault("agent-tests")),
}).pipe(
  Command.withHandler(({ organization }) =>
    Effect.gen(function* () {
      const target = yield* developmentSettings;
      const directory = yield* Config.NonEmptyString("EXECUTOR_DATA_DIR");
      const server = Layer.unwrap(
        Effect.gen(function* () {
          const development = yield* developmentSignIn(target, organization);
          const product = yield* selfHostRoutes;
          const routes = Layer.mergeAll(
            HttpRouter.add("GET", "/api/devtools", development.status),
            HttpRouter.add("POST", "/api/devtools/operator", development.signIn),
            product,
          );
          return HttpRouter.serve(routes, { disableLogger: true }).pipe(
            Layer.provide(
              BunHttpServer.layer({
                hostname: target.hostname === "[::1]" ? "::1" : "127.0.0.1",
                port: target.port,
              }),
            ),
          );
        }),
      ).pipe(
        Layer.provide(selfHostDatabase),
        Layer.provide(localTelemetry(directory, "executor-selfhost-test")),
        Layer.provide(BunHttpServer.layerHttpServices),
      );
      yield* Console.log(`Starting local test server at ${target.origin}/login`);
      yield* Layer.launch(server);
    }).pipe(Effect.provideServiceEffect(ConfigProvider.ConfigProvider, testServerConfiguration)),
  ),
);

BunRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(BunServices.layer),
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : Console.error(
            "The test server could not start. Use dev/test mode, an HTTP loopback origin with a free port, and built self-host web assets. Stop any server using that data directory first.",
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 1;
              }),
            ),
          ),
    ),
  ),
);
