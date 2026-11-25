import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Packed = Schema.NonEmptyArray(Schema.Struct({ filename: Schema.String }));

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const npm =
      process.platform === "win32"
        ? {
            command: process.execPath,
            prefix: [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")],
          }
        : { command: "npm", prefix: [] };
    const packed = yield* processes
      .string(
        ChildProcess.make(
          npm.command,
          [
            ...npm.prefix,
            "pack",
            "packages/apps/dist",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            directory,
          ],
          { stdout: "pipe", stderr: "ignore" },
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Packed))));
    yield* fs.makeDirectory(".local/test-runtime", { recursive: true });
    yield* fs.copyFile(path.join(directory, packed[0].filename), ".local/test-runtime/apps.tgz");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
