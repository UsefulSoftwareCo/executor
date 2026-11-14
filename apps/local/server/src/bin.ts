#!/usr/bin/env node
// First, so the E2E runner's hooks own the clock before any other module reads it.
import "./implementation/e2e-process.ts";
import {
  appsCommand,
  describeAppFailure,
  encodeAppFailure,
  LocalServerUnavailable,
  renderAppFailure,
} from "@executor-js/app-management/cli";
import { toolCommands } from "@executor-js/app-management/tools-cli";
/** CLI composition root. Platform dependencies and raw process arguments stop here. */
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

/**
 * A command's implementation, loaded when that command runs. Help, argument errors and other
 * commands then start without the server, the launcher or the upgrader.
 */
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

// The file that started the CLI shows how it was installed: the npm launcher, or the release
// executable itself, names itself in EXECUTOR_LAUNCHER; otherwise it is the script Node started.
const entry = process.env.EXECUTOR_LAUNCHER ?? process.argv[1];
// The Node.js the npm launcher runs on. The release executable carries its own runtime, so a
// standalone install needs no Node at all.
const launcherNode =
  process.env.EXECUTOR_LAUNCHER_NODE ??
  (process.versions.bun === undefined ? process.versions.node : undefined);
/** Failures whose message is written for the person running the command. */
const explained = Schema.is(
  Schema.Union([
    LocalConfigurationError,
    PairFailed,
    UpgradeFailed,
    ServiceFailed,
    ServiceSettingInvalid,
  ]),
);

/**
 * Client commands without a named or remembered host use the background server, started if needed, or
 * a private server for the command when the service is disabled. They send its password, or
 * EXECUTOR_API_KEY when that is set. A local server that cannot start fails the command the way
 * its other failures do, with the reason as JSON on stdout for programs.
 */
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
          // A foreground server says how long its stop took, as its last line on stderr. It is the
          // only mode that logs there (`server-process.ts`): a private `--stdio` server's stderr is
          // copied to the command that started it, which asked for no server, and a background
          // server's goes to the command that started it until it is ready.
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
    // A reader that closed the pipe, or output that cannot be written, ends a command that is not
    // serving.
    Effect.raceFirst(processOutput.closed),
    // Effect CLI renders argument errors and supplies the exit status for help.
    // Operational failures retain the launcher's sanitized message. A failed apps or tool command
    // states the host's code, status, message and recovery, and also prints them as JSON on
    // stdout when a program, not a terminal, reads it.
    Effect.catch((error) => {
      if (CliError.isCliError(error)) return Effect.fail(error);
      const described = explained(error) ? undefined : describeAppFailure(error);
      return Effect.gen(function* () {
        // A failed apps command also says when this CLI is out of date.
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
    // runMain's own report of an unhandled failure, written through the console below.
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
