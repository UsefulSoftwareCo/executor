#!/usr/bin/env node
import "./implementation/e2e-process.ts";
import {
  appsCommand,
  describeAppFailure,
  encodeAppFailure,
  LocalServerUnavailable,
  renderAppFailure,
} from "@executor-js/app-management/cli";
import { toolCommands } from "@executor-js/app-management/tools-cli";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Config, Console, Effect, Option, Runtime, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import {
  ServiceFailed,
  ServiceSettingInvalid,
  serviceCommand,
  serviceGetCommand,
  servicePairCommand,
  serviceRestartCommand,
  serviceRotateKeyCommand,
  serviceSetCommand,
  serviceStartCommand,
  serviceStatusCommand,
  serviceStopCommand,
  serviceUnsetCommand,
} from "./contracts/service.ts";
import {
  PairFailed,
  executorCommand,
  serveCommand,
  UpgradeFailed,
  upgradeCommand,
} from "./contracts/startup.ts";
import { LocalConfigurationError } from "./contracts/auth.ts";
import { exitLine } from "./implementation/exit-line.ts";
import { processOutput } from "./implementation/process-output.ts";
import { outdatedCli } from "./implementation/update-notice.ts";
import { ensure, standalone } from "./implementation/service-client.ts";
import { readSettings, serviceDirectory } from "./implementation/service-files.ts";

const loaded = <M, A, E, R>(
  load: () => Promise<M>,
  run: (module: M) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.flatMap(Effect.promise(load), run);
const launcher = () => import("./implementation/launcher.ts");
const serverProcess = () => import("./implementation/server-process.ts");
const settings = () => import("./implementation/service-settings.ts");
const bootstrap = () => import("./implementation/bootstrap.ts");
const pairing = () => import("./implementation/pair.ts");
const upgrader = () => import("./implementation/upgrade.ts");

const entry = process.env.EXECUTOR_LAUNCHER ?? process.argv[1];
const launcherNode =
  process.env.EXECUTOR_LAUNCHER_NODE ??
  (process.versions.bun === undefined ? process.versions.node : undefined);
const explained = Schema.is(
  Schema.Union([
    LocalConfigurationError,
    PairFailed,
    UpgradeFailed,
    ServiceFailed,
    ServiceSettingInvalid,
  ]),
);

const localServer = Effect.gen(function* () {
  const supplied = yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
  const directory = yield* serviceDirectory;
  const service =
    (yield* readSettings(directory)).disabled === true
      ? yield* standalone
      : yield* ensure(directory, { version: "ignore" });
  return { url: service.url, token: Option.getOrElse(supplied, () => service.password) };
}).pipe(
  Effect.mapError((error) =>
    explained(error) ? new LocalServerUnavailable({ message: error.message }) : error,
  ),
);

const cli = executorCommand.pipe(
  Command.withHandler((options) =>
    loaded(launcher, ({ launch }) => processOutput.serve(launch(options, process.platform, entry))),
  ),
  Command.withSubcommands([
    appsCommand(process.platform, localServer),
    ...toolCommands(process.platform, localServer),
    serveCommand.pipe(
      Command.withHandler(({ service, stdio }) =>
        Effect.gen(function* () {
          if (service && stdio)
            return yield* new CliError.UserError({ cause: "Use --service or --stdio, not both." });
          if (!service && !stdio) processOutput.last(exitLine);
          return yield* loaded(serverProcess, ({ serveProcess }) =>
            processOutput.serve(
              serveProcess({
                mode: service ? "service" : stdio ? "stdio" : "foreground",
                platform: process.platform,
                ...(entry === undefined ? {} : { entry }),
              }),
            ),
          );
        }),
      ),
    ),
    serviceCommand.pipe(
      Command.withSubcommands([
        serviceStartCommand.pipe(
          Command.withHandler(() => loaded(settings, (m) => m.serviceStart)),
        ),
        serviceStopCommand.pipe(Command.withHandler(() => loaded(settings, (m) => m.serviceStop))),
        serviceRestartCommand.pipe(
          Command.withHandler(() => loaded(settings, (m) => m.serviceRestart)),
        ),
        serviceStatusCommand.pipe(
          Command.withHandler(() => loaded(settings, (m) => m.serviceStatus)),
        ),
        serviceGetCommand.pipe(
          Command.withHandler((input) => loaded(settings, (m) => m.serviceGet(input))),
        ),
        serviceSetCommand.pipe(
          Command.withHandler((input) =>
            loaded(settings, (m) => m.serviceSet(process.platform, input)),
          ),
        ),
        serviceUnsetCommand.pipe(
          Command.withHandler((input) =>
            loaded(settings, (m) => m.serviceUnset(process.platform, input)),
          ),
        ),
        servicePairCommand.pipe(Command.withHandler(() => loaded(pairing, (m) => m.pair))),
        serviceRotateKeyCommand.pipe(
          Command.withHandler(() =>
            loaded(bootstrap, (m) => m.rotateApiKey(process.platform)).pipe(
              Effect.andThen(
                Console.log(
                  "Rotated the local API key. Run `executor service restart` to use it, then update clients that used the previous key.",
                ),
              ),
            ),
          ),
        ),
      ]),
    ),
    upgradeCommand.pipe(
      Command.withHandler((options) =>
        loaded(upgrader, ({ upgrade }) =>
          upgrade(options, {
            entry,
            node: launcherNode,
            executable: process.execPath,
            platform: process.platform,
            arch: process.arch,
          }),
        ),
      ),
    ),
  ]),
);

NodeRuntime.runMain(
  Command.run(cli, { version: process.env.EXECUTOR_BUILD_VERSION ?? "0.0.0-dev" }).pipe(
    Effect.scoped,
    Effect.raceFirst(processOutput.closed),
    Effect.catch((error) => {
      if (CliError.isCliError(error)) return Effect.fail(error);
      const described = explained(error) ? undefined : describeAppFailure(error);
      return Effect.gen(function* () {
        const update = described === undefined ? undefined : yield* outdatedCli(entry);
        const failure =
          described === undefined || update === undefined ? described : { ...described, update };
        yield* Console.error(
          explained(error)
            ? error.message
            : failure === undefined
              ? "Executor could not start. Check the configured keys and whether the port is already in use."
              : renderAppFailure(failure),
        );
        if (failure !== undefined && !process.stdout.isTTY)
          yield* Console.log(encodeAppFailure(failure));
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      });
    }),
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
        ? Effect.void
        : Effect.logError(cause),
    ),
    Effect.provideService(Console.Console, processOutput.console),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true, teardown: processOutput.teardown },
);
