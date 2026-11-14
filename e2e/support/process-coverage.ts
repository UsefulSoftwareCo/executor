/**
 * `E2E_COVERAGE=1` profiles the processes a local scenario starts itself, as well as its managed
 * server: the CLI commands it runs (`executor pair`, `upgrade`, `service`, `apps`, the Executor 1
 * commands) and the background servers they start, which inherit the variable. Each writes Node's
 * V8 coverage into the scenario's coverage directory, which `e2e/coverage.ts collect` reads with
 * the managed server's. A command that names its own `NODE_V8_COVERAGE`, as the managed server
 * does, keeps it.
 */
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Target } from "./platform.ts";

/** Adds the variable to a command; a command with no environment otherwise inherits the runner's. */
const profiled = (command: ChildProcess.Command, directory: string): ChildProcess.Command => {
  if (command._tag !== "StandardCommand") return command;
  const { env, extendEnv } = command.options;
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    ...(env === undefined
      ? { env: { NODE_V8_COVERAGE: directory }, extendEnv: true }
      : { env: { NODE_V8_COVERAGE: directory, ...env }, extendEnv }),
  });
};

/** The case's process spawner, which profiles every process a local scenario starts. */
export const processCoverageLayer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner,
      target = yield* Target,
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    if (
      !(yield* Config.Boolean("E2E_COVERAGE").pipe(Config.withDefault(false))) ||
      target.metadata.target !== "local" ||
      target.scenarioId === undefined
    )
      return spawner;
    const scenario = path.join(
      target.evidenceDirectory ?? target.directory,
      "coverage",
      target.scenarioId,
    );
    const directory = path.join(scenario, "processes");
    const prepare = Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true });
      if (!(yield* fs.exists(path.join(scenario, "scenario.json"))))
        yield* fs.writeFileString(
          path.join(scenario, "scenario.json"),
          JSON.stringify({ target: target.metadata.target, title: target.scenarioLabel }),
        );
    }).pipe(Effect.orDie);
    return ChildProcessSpawner.make((command) =>
      prepare.pipe(Effect.andThen(spawner.spawn(profiled(command, directory)))),
    );
  }),
);
