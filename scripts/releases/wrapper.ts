/** Build the small npm launcher with exact native runtime aliases. Nothing is published. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import manifest from "../../apps/cli/package.json" with { type: "json" };
import { platforms, platformPackage, platformVersion, release } from "./config.ts";

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
        files: ["bin.mjs", "README.md", "LICENSE"],
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
  yield* fs.writeFileString(
    path.join(directory, "bin.mjs"),
    `#!/usr/bin/env node
const name = "executor-" + process.platform + "-" + process.arch;
const supported = ${JSON.stringify(platforms.map(platformPackage))};
if (!supported.includes(name)) {
  console.error("Executor does not support " + process.platform + "/" + process.arch + ".");
  process.exitCode = 1;
} else {
  let entry;
  try { entry = import.meta.resolve(name + "/bin.mjs"); }
  catch {
    console.error("Executor's native runtime is missing. Reinstall with: ${release.npmInstall} --include=optional");
    process.exitCode = 1;
  }
  if (entry !== undefined) await import(entry);
}
`,
  );
  yield* fs.chmod(path.join(directory, "bin.mjs"), 0o755);
  yield* fs.copyFile(
    path.join(root, "scripts/releases/README.md"),
    path.join(directory, "README.md"),
  );
  yield* fs.copyFile(path.join(root, "apps/cli/LICENSE"), path.join(directory, "LICENSE"));
  const code = yield* processes.exitCode(
    ChildProcess.make("npm", ["pack", "--ignore-scripts"], {
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
