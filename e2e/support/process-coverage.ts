import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Target } from "./platform.ts";

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
