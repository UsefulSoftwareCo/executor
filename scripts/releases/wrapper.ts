import { createHash } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import manifest from "../../apps/cli/package.json" with { type: "json" };
import { platformArchive, platforms, release } from "./config.ts";
import { npmCommand } from "./npm.ts";

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const directory = path.join(root, ".local/releases", release.version, "wrapper");
  const archives = path.resolve(root, process.argv[2] ?? ".local/releases");
  const sha256 = (file: string) =>
    Effect.gen(function* () {
      const hash = createHash("sha256");
      yield* fs.stream(file).pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => {
            hash.update(bytes);
          }),
        ),
      );
      return hash.digest("hex");
    });
  const runtimes: Record<string, string> = {};
  for (const target of platforms) {
    const file = path.join(
      archives,
      `${release.version}-${target.platform}-${target.arch}`,
      platformArchive(target),
    );
    if (yield* fs.exists(file)) runtimes[`${target.platform}-${target.arch}`] = yield* sha256(file);
  }
  if (Object.keys(runtimes).length === 0)
    return yield* Effect.die(
      new Error(`No release archive for ${release.version} in ${archives}.`),
    );
  if (yield* fs.exists(directory)) yield* fs.remove(directory, { recursive: true });
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "package.json"),
    JSON.stringify(
      {
        ...manifest,
        private: false,
        bin: { executor: "bin.mjs" },
        files: ["bin.mjs", "bin/executor", "bin/package.json", "README.md", "LICENSE"],
        publishConfig: { access: "public", tag: release.channel },
        runtimes,
      },
      null,
      2,
    ),
  );
  yield* fs.copyFile(
    path.join(root, "scripts/releases/npm-launcher.mjs"),
    path.join(directory, "bin.mjs"),
  );
  yield* fs.chmod(path.join(directory, "bin.mjs"), 0o755);
  yield* fs.makeDirectory(path.join(directory, "bin"));
  yield* fs.writeFileString(
    path.join(directory, "bin/package.json"),
    `${JSON.stringify({ type: "commonjs" })}\n`,
  );
  yield* fs.writeFileString(
    path.join(directory, "bin/executor"),
    `#!/usr/bin/env node\nimport("../bin.mjs");\n`,
  );
  yield* fs.chmod(path.join(directory, "bin/executor"), 0o755);
  yield* fs.copyFile(
    path.join(root, "scripts/releases/README.md"),
    path.join(directory, "README.md"),
  );
  yield* fs.copyFile(path.join(root, "apps/cli/LICENSE"), path.join(directory, "LICENSE"));
  const npm = yield* npmCommand;
  const code = yield* processes.exitCode(
    ChildProcess.make(npm.command, [...npm.prefix, "pack", "--ignore-scripts"], {
      cwd: directory,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (code !== 0) return yield* Effect.die(new Error(`npm pack failed (${code})`));
  yield* Console.log(
    `Launcher archive: ${path.join(directory, `executor-${release.version}.tgz`)} (runtimes: ${Object.keys(runtimes).join(", ")})`,
  );
});

NodeRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(NodeServices.layer)));
