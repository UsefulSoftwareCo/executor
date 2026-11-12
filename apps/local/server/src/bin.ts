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
  serviceRestartCommand,
  serviceSetCommand,
  serviceStartCommand,
  serviceStatusCommand,
  serviceStopCommand,
  serviceUnsetCommand,
} from "./contracts/service.ts";
import {
  LegacyCommand,
  PairFailed,
  executorCommand,
  legacyCommands,
  legacyServiceCommands,
  pairCommand,
  rotateKeyCommand,
  serveCommand,
  UpgradeFailed,
  upgradeCommand,
} from "./contracts/startup.ts";
import { LocalConfigurationError, rotateApiKey } from "./implementation/bootstrap.ts";
import { launch } from "./implementation/launcher.ts";
import { outdatedCli } from "./implementation/update-notice.ts";
import { pair } from "./implementation/pair.ts";
import { processOutput } from "./implementation/process-output.ts";
import { serveProcess } from "./implementation/server-process.ts";
import { ensure, standalone } from "./implementation/service-client.ts";
import { readSettings, serviceDirectory } from "./implementation/service-files.ts";
import {
  serviceGet,
  serviceRestart,
  serviceSet,
  serviceStart,
  serviceStatus,
  serviceStop,
  serviceUnset,
} from "./implementation/service-settings.ts";
import { upgrade } from "./implementation/upgrade.ts";

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
    LegacyCommand,
    UpgradeFailed,
    ServiceFailed,
    ServiceSettingInvalid,
  ]),
);

/**
 * App commands without --host or EXECUTOR_HOST use the background server, started if needed, or
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
  Command.withHandler((options) => processOutput.serve(launch(options, process.platform, entry))),
  Command.withSubcommands([
    appsCommand(process.platform, localServer),
    serveCommand.pipe(
      Command.withHandler(({ service, stdio }) =>
        Effect.gen(function* () {
          if (service && stdio)
            return yield* new CliError.UserError({ cause: "Use --service or --stdio, not both." });
          return yield* processOutput.serve(
            serveProcess({
              mode: service ? "service" : stdio ? "stdio" : "foreground",
              platform: process.platform,
              ...(entry === undefined ? {} : { entry }),
            }),
          );
        }),
      ),
    ),
    serviceCommand.pipe(
      Command.withSubcommands([
        serviceStartCommand.pipe(Command.withHandler(() => serviceStart)),
        serviceStopCommand.pipe(Command.withHandler(() => serviceStop)),
        serviceRestartCommand.pipe(Command.withHandler(() => serviceRestart)),
        serviceStatusCommand.pipe(Command.withHandler(() => serviceStatus)),
        serviceGetCommand.pipe(Command.withHandler(serviceGet)),
        serviceSetCommand.pipe(Command.withHandler((input) => serviceSet(process.platform, input))),
        serviceUnsetCommand.pipe(
          Command.withHandler((input) => serviceUnset(process.platform, input)),
        ),
        ...legacyServiceCommands.map((legacy) =>
          legacy.pipe(
            Command.withHandler(() =>
              Effect.fail(new LegacyCommand({ command: `service ${legacy.name}` })),
            ),
          ),
        ),
      ]),
    ),
    pairCommand.pipe(Command.withHandler(() => pair)),
    upgradeCommand.pipe(
      Command.withHandler((options) =>
        upgrade(options, {
          entry,
          node: launcherNode,
          executable: process.execPath,
          platform: process.platform,
          arch: process.arch,
        }),
      ),
    ),
    rotateKeyCommand.pipe(
      Command.withHandler(() =>
        rotateApiKey(process.platform).pipe(
          Effect.andThen(
            Console.log(
              "Rotated the local API key. Run `executor service restart` to use it, then update clients that used the previous key.",
            ),
          ),
        ),
      ),
    ),
    ...legacyCommands.map((legacy) =>
      legacy.pipe(
        Command.withHandler(() => Effect.fail(new LegacyCommand({ command: legacy.name }))),
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
    // Operational failures retain the launcher's sanitized message. An apps command failure
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
