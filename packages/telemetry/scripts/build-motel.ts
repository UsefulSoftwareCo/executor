/** Build Motel outside the monorepo's Effect override, including its runtime and worker assets. */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const build = Effect.gen(function* () {
  if (process.versions.bun !== "1.3.11")
    return yield* Effect.die(new Error("Build the collector with Bun 1.3.11."));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url));
  const source = path.join(root, "motel");
  const output = path.join(root, "dist/motel");
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "executor-motel-build-" });
  yield* fs.copyFile(path.join(source, "package.json"), path.join(scratch, "package.json"));
  yield* fs.copyFile(path.join(source, "bun.lock"), path.join(scratch, "bun.lock"));
  yield* fs.copy(path.join(source, "patches"), path.join(scratch, "patches"));
  const command = (args: readonly string[]) =>
    processes
      .exitCode(
        ChildProcess.make(process.execPath, args, {
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
  yield* command(["install", "--frozen-lockfile"]);
  const upstream = path.join(scratch, "node_modules/@kitlangton/motel");
  yield* fs.copyFile(
    path.join(source, "server.mjs"),
    path.join(upstream, "src/executor-server.ts"),
  );
  yield* fs.makeDirectory(output, { recursive: true });
  yield* command([
    "build",
    path.join(upstream, "src/executor-server.ts"),
    path.join(upstream, "src/services/telemetryWorker.ts"),
    path.join(upstream, "src/services/telemetryQueryWorker.ts"),
    "--target",
    "bun",
    "--sourcemap=external",
    "--outdir",
    path.join(output, "src"),
    "--entry-naming",
    "[name].ts",
  ]);
  yield* fs.copyFile(
    process.execPath,
    path.join(output, process.platform === "win32" ? "bun.exe" : "bun"),
  );
  yield* fs.chmod(path.join(output, process.platform === "win32" ? "bun.exe" : "bun"), 0o755);
  yield* fs.copy(path.join(upstream, "web/dist"), path.join(output, "web/dist"), {
    overwrite: true,
  });
  yield* fs.copy(path.join(upstream, "skills"), path.join(output, "skills"), { overwrite: true });
  yield* fs.copyFile(path.join(upstream, "LICENSE"), path.join(output, "MOTEL-LICENSE"));
  yield* fs.copyFile(path.join(source, "BUN-LICENSE.md"), path.join(output, "BUN-LICENSE.md"));
  yield* fs.writeFileString(
    path.join(output, "build.json"),
    JSON.stringify({
      motel: "0.2.8",
      bun: process.versions.bun,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  yield* Effect.logInfo(`Built Motel with its runtime at ${output}`);
});

BunRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(BunServices.layer)));
