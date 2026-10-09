/**
 * Run one command against the suite's loopback npm registry, which serves the `apps` package
 * staged from this checkout and forwards every other request to the public registry; see
 * support/npm-registry.ts. Release packaging uses it so installing an archive resolves the `apps`
 * version this checkout ships before that version is published.
 *
 * Usage: `node e2e/with-npm-registry.ts -- <command> [args...]` after `bun run apps:build` and
 * `bun run e2e:apps`. Exits 1 and reports the command's exit code when it fails.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { localNpmRegistry } from "./support/npm-registry.ts";

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  message: Schema.String,
}) {}

NodeRuntime.runMain(
  Effect.gen(function* () {
    const separator = process.argv.indexOf("--");
    const [command, ...args] = separator === -1 ? [] : process.argv.slice(separator + 1);
    if (command === undefined)
      return yield* new CommandFailed({ message: "Usage: with-npm-registry.ts -- <command>" });
    const registry = yield* localNpmRegistry;
    yield* Console.log(`Serving apps@${registry.version} from this checkout at ${registry.url}`);
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* processes.exitCode(
      ChildProcess.make(command, args, {
        env: { NPM_CONFIG_REGISTRY: registry.url, BUN_CONFIG_REGISTRY: registry.url },
        extendEnv: true,
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (code !== 0) return yield* new CommandFailed({ message: `${command} exited ${code}` });
  }).pipe(Effect.scoped, Effect.provide([FetchHttpClient.layer, NodeServices.layer])),
);
