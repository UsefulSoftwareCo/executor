/** A separate CI step recovers cleanup after GitHub kills a cancelled test process. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const Environment = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(/^e2e-[a-z0-9]{1,13}$/)),
});

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = path.resolve(".local/deployed");
    if (!(yield* fs.exists(root))) return;
    for (const entry of yield* fs.readDirectory(root)) {
      const directory = path.join(root, entry);
      const metadata = path.join(directory, "environment.json");
      const destroyed = path.join(directory, "destroyed.json");
      if (!(yield* fs.exists(metadata)) || (yield* fs.exists(destroyed))) continue;
      const { slug } = yield* fs
        .readFileString(metadata)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Environment))));
      if (slug !== entry)
        return yield* Effect.die(new Error("Deployment directory does not match its owner"));
      yield* Console.log(`Recovering cleanup for ${slug}`);
      const code = yield* processes.exitCode(
        ChildProcess.make("bun", ["run", "test-stage", "destroy", slug, "--no-input", "--yes"], {
          cwd: path.resolve("apps/hosted/cloud"),
          env: { CI: "true" },
          extendEnv: true,
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
      if (Number(code) !== 0) return yield* Effect.die(new Error(`Cleanup failed for ${slug}`));
      yield* fs.writeFileString(destroyed, "{}");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
