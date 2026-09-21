/** Install ordinary app dependencies with the SDK's pinned tool, not a host-global npm. */
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { platform } from "node:os";
import type { SourceFiles } from "../contracts/deployment.ts";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";

/** These packages must resolve to the host's single framework/Effect instance. */
export const hostPackages = ["apps", "effect", "@effect/platform-node", "@executor-js/sdk"];
const InstalledPackage = Schema.Struct({
  name: Schema.optional(Schema.String),
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
});

/** Keep arbitrary package files and versions, honor an authored lock, and never run install scripts. */
export const installNodeDependencies = (
  directory: string,
  cacheDirectory: string,
  source: SourceFiles,
  publishedFramework = false,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const locks = source.filter(
      (file) => file.path === "bun.lock" || file.path === "package-lock.json",
    );
    if (locks.length > 1) return yield* new RuntimeBuildFailed({ stage: "dependencies" });
    for (const lock of locks)
      yield* fs.writeFileString(path.join(directory, lock.path), lock.content);
    const executable = yield* path.fromFileUrl(new URL(import.meta.resolve("bun/bin/bun.exe")));
    yield* Effect.annotateCurrentSpan("executor.dependencies.installer", "bun");
    yield* Effect.annotateCurrentSpan("executor.dependencies.locked", locks.length === 1);
    const code = yield* processes.exitCode(
      ChildProcess.make(
        executable,
        [
          "install",
          "--ignore-scripts",
          "--save-text-lockfile",
          "--linker=hoisted",
          // Copy-on-write clones have independent inodes. Elsewhere, copy bytes;
          // never use Bun's Linux hard links to the shared writable package cache.
          platform() === "darwin" ? "--backend=clonefile" : "--backend=copyfile",
          ...(locks.length === 1 ? ["--frozen-lockfile"] : []),
        ],
        {
          cwd: directory,
          // Services may have no HOME. Keep extracted packages at runtime scope,
          // never in the disposable app tree where they would be installed/archived twice.
          env: { BUN_INSTALL_CACHE_DIR: cacheDirectory },
          extendEnv: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      ),
    );
    if (code !== 0) return yield* new RuntimeBuildFailed({ stage: "dependencies" });

    // Inspect the actual installed names, including aliases and nested packages. This
    // works for registry, tarball and Git dependencies without depending on lock syntax.
    const pending = [path.join(directory, "node_modules")];
    const visited = new Set<string>();
    for (const modules of pending) {
      if (!(yield* fs.exists(modules))) continue;
      const real = yield* fs.realPath(modules);
      if (visited.has(real)) continue;
      visited.add(real);
      for (const name of yield* fs.readDirectory(modules)) {
        if (name.startsWith(".")) continue;
        if (name.startsWith("@")) {
          pending.push(path.join(modules, name));
          continue;
        }
        const location = path.join(modules, name);
        const manifest = yield* fs
          .readFileString(path.join(location, "package.json"))
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledPackage))),
          );
        if (
          manifest.name !== undefined &&
          (publishedFramework
            ? manifest.name === "@executor-js/sdk"
            : hostPackages.includes(manifest.name))
        )
          return yield* new RuntimeBuildFailed({ stage: "dependencies" });
        // Bun makes bin targets world-writable. Normalize only declared executables
        // before retention, so live and restored builds have the same portable mode.
        const bins =
          manifest.bin === undefined
            ? []
            : typeof manifest.bin === "string"
              ? [manifest.bin]
              : Object.values(manifest.bin);
        for (const bin of bins) {
          const target = yield* fs.realPath(path.resolve(location, bin));
          const root = yield* fs.realPath(location);
          if (!target.startsWith(root + path.sep))
            return yield* new RuntimeBuildFailed({ stage: "dependencies" });
          yield* fs.chmod(target, 0o755);
        }
        pending.push(path.join(location, "node_modules"));
      }
    }
  }).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "dependencies" })));
