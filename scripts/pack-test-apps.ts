/**
 * Pack the `apps` package staged by `apps:build` for the e2e registry, which serves it as the
 * version the hosts ship. Nothing is published.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const archive = yield* processes
      .string(
        ChildProcess.make(
          "bun",
          ["pm", "pack", "--ignore-scripts", "--destination", directory, "--quiet"],
          { cwd: "packages/apps/dist", stdout: "pipe", stderr: "ignore" },
        ),
      )
      .pipe(Effect.map((filename) => filename.trim()));
    yield* fs.makeDirectory(".local/test-runtime", { recursive: true });
    yield* fs.copyFile(archive, ".local/test-runtime/apps.tgz");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
