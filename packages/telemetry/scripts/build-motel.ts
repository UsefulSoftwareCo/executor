/** Build the pinned Motel fork outside the monorepo's Effect override. */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { realpath } from "node:fs";
import { promisify } from "node:util";

const build = Effect.gen(function* () {
  if (process.versions.bun !== "1.3.11")
    return yield* Effect.die(new Error("Build the collector with Bun 1.3.11."));
  const runtime = process.argv.includes("--workerd") ? "workerd" : "bun";
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url));
  const source = path.join(root, "motel");
  const output = path.join(root, runtime === "workerd" ? "dist/motel-workerd" : "dist/motel");
  const pinned = yield* fs.readFileString(path.join(source, "source.json")).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            repository: Schema.NonEmptyString,
            revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
          }),
        ),
      ),
    ),
  );
  // Windows TEMP can use an 8.3 alias. Bun resolves workspace members to long
  // paths, so canonicalize their root too before it compares the frozen lock.
  const scratch = yield* fs
    .makeTempDirectoryScoped({ prefix: "executor-motel-build-" })
    .pipe(
      Effect.flatMap((directory) => Effect.tryPromise(() => promisify(realpath.native)(directory))),
    );
  const command = (binary: string, args: readonly string[]) =>
    processes
      .exitCode(
        ChildProcess.make(binary, args, {
          cwd: scratch,
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(
        Effect.flatMap((code) =>
          code === 0 ? Effect.void : Effect.die(new Error(`Motel build command exited ${code}`)),
        ),
      );
  const bun = (args: readonly string[]) => command(process.execPath, args);
  yield* command("git", ["init", "--quiet"]);
  yield* command("git", ["fetch", "--depth=1", pinned.repository, pinned.revision]);
  yield* command("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  yield* bun(["install", "--frozen-lockfile"]);
  yield* bun(["run", "web:build"]);
  yield* fs.makeDirectory(output, { recursive: true });
  if (runtime === "workerd") {
    yield* bun(["run", "workerd:build"]);
    yield* fs.copy(path.join(scratch, "dist/workerd"), output, { overwrite: true });
  } else {
    yield* fs.copyFile(
      path.join(source, "server.mjs"),
      path.join(scratch, "src/executor-server.ts"),
    );
    yield* bun([
      "build",
      "src/executor-server.ts",
      "src/services/telemetryWorker.ts",
      "src/services/telemetryQueryWorker.ts",
      "--target",
      "bun",
      "--sourcemap=external",
      "--outdir",
      path.join(output, "src"),
      "--entry-naming",
      "[name].ts",
    ]);
    const binary = path.join(output, process.platform === "win32" ? "bun.exe" : "bun");
    yield* fs.copyFile(process.execPath, binary);
    yield* fs.chmod(binary, 0o755);
    yield* fs.copyFile(path.join(source, "BUN-LICENSE.md"), path.join(output, "BUN-LICENSE.md"));
  }
  yield* fs.copy(path.join(scratch, "web/dist"), path.join(output, "web/dist"), {
    overwrite: true,
  });
  yield* fs.copy(path.join(scratch, "skills"), path.join(output, "skills"), { overwrite: true });
  yield* fs.copyFile(path.join(scratch, "LICENSE"), path.join(output, "MOTEL-LICENSE"));
  yield* fs.writeFileString(
    path.join(output, "build.json"),
    JSON.stringify({
      ...pinned,
      runtime,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  yield* Effect.logInfo(`Built Motel for ${runtime} at ${output}`);
});

BunRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(BunServices.layer)));
