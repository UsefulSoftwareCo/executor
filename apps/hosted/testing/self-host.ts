/** Explicit local test server. Production's entry point never mounts these auth shortcuts. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { localTelemetry } from "@executor-js/telemetry/local";
import { Config, Console, Effect, Layer } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import { HttpRouter } from "effect/unstable/http";
import { selfHostRoutes } from "../self-host/src/main.ts";
import { selfHostDatabase } from "../self-host/src/database.ts";
import { developmentSettings, developmentSignIn } from "./development.ts";

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
            HttpRouter.add("POST", "/api/devtools/account", development.signIn),
            product,
          );
          return HttpRouter.serve(routes, { disableLogger: true }).pipe(
            Layer.provide(
              NodeHttpServer.layer(createServer, {
                host: target.hostname === "[::1]" ? "::1" : "127.0.0.1",
                port: target.port,
              }),
            ),
          );
        }),
      ).pipe(
        Layer.provide(selfHostDatabase),
        Layer.provide(localTelemetry(directory, "executor-selfhost-test")),
        Layer.provide(NodeHttpServer.layerHttpServices),
      );
      yield* Console.log(`Starting local test server at ${target.origin}/login`);
      yield* Layer.launch(server);
    }),
  ),
);

NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : Console.error(
            "The test server could not start. Use dev/test mode, an HTTP loopback origin with a free port, an explicit data directory, and built self-host web assets. Stop any server using that directory first.",
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
