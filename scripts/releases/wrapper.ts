/**
 * Build the `executor` npm package: a launcher that starts the executable from the platform package
 * it names as an exact optional dependency. Nothing is published.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import manifest from "../../apps/cli/package.json" with { type: "json" };
import { platforms, platformPackage, platformVersion, release } from "./config.ts";
import { npmCommand } from "./npm.ts";

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const directory = path.join(root, ".local/releases", release.version, "wrapper");
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
        optionalDependencies: Object.fromEntries(
          platforms.map((target) => [
            platformPackage(target),
            `npm:executor@${platformVersion(target)}`,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  // The launcher reads its platform packages and channel from this package.json.
  yield* fs.copyFile(
    path.join(root, "scripts/releases/npm-launcher.mjs"),
    path.join(directory, "bin.mjs"),
  );
  yield* fs.chmod(path.join(directory, "bin.mjs"), 0o755);
  // Executor 1 declared bin/executor. Command shims outlive the package they were made for: an
  // upgrade that does not relink them, such as `bun add executor@beta` inside Bun's global
  // directory, leaves them starting this path. Keep every published entry point working.
  // The extensionless file is CommonJS: Node 20.0 to 20.9 refuse one that the package's
  // "type": "module" makes ESM.
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
    `Launcher archive: ${path.join(directory, `executor-${release.version}.tgz`)}`,
  );
});

NodeRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(NodeServices.layer)));
