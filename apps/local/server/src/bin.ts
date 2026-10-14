#!/usr/bin/env node
// First, so the E2E runner's hooks own the clock before any other module reads it.
import "./implementation/e2e-process.ts";
import {
  appsCommand,
  describeAppFailure,
  encodeAppFailure,
  renderAppFailure,
} from "@executor-js/app-management/cli";
/** CLI composition root. Platform dependencies and raw process arguments stop here. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Option, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import {
  LegacyCommand,
  PairFailed,
  executorCommand,
  legacyCommands,
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
  Schema.Union([LocalConfigurationError, PairFailed, LegacyCommand, UpgradeFailed]),
);

const cli = executorCommand.pipe(
  Command.withHandler(({ bootstrapFd }) =>
    launch(Option.isSome(bootstrapFd) ? "desktop" : "browser", process.platform, entry),
  ),
  Command.withSubcommands([
    appsCommand(process.platform),
    serveCommand.pipe(Command.withHandler(() => launch("headless", process.platform, entry))),
    pairCommand.pipe(Command.withHandler(() => pair(process.platform))),
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
              "Rotated the local API key. Restart Executor to use it, then update clients that used the previous key.",
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
    Effect.provide(NodeServices.layer),
  ),
);
