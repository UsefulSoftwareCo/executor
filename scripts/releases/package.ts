/** Build a portable, platform-specific npm package. Nothing is published. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { emit } from "./emit.ts";
import { nativePlatform, platformVersion, release } from "./config.ts";
import { installWindowsGitHttpBackend } from "./windows-git.ts";

const Manifest = Schema.Struct({
  name: Schema.String,
  type: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optional(Schema.Boolean) })),
  ),
});
const readManifest = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
  });
const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const version = release.version;
  const target = nativePlatform(process.platform, process.arch);
  if (process.argv[2] !== undefined && process.argv[2] !== version)
    return yield* Effect.die(new Error("Build the version recorded in apps/cli/package.json."));
  const output = path.join(
    root,
    ".local/releases",
    `${version}-${process.platform}-${process.arch}`,
  );
  const stage = path.join(output, "package");
  const run = (command: string, args: readonly string[], cwd: string) =>
    processes
      .exitCode(
        ChildProcess.make(command, args, {
          cwd,
          env: { EXECUTOR_BUILD_VERSION: version },
          extendEnv: true,
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(
        Effect.flatMap((code) =>
          code === 0 ? Effect.void : Effect.die(new Error(`${command} exited ${code}`)),
        ),
      );
  yield* run("bun", ["run", "apps:build"], root);
  yield* run("bun", ["run", "telemetry:build"], root);
  yield* run("bun", ["run", "web:build"], root);
  yield* fs.makeDirectory(output, { recursive: true });
  if (yield* fs.exists(stage)) yield* fs.remove(stage, { recursive: true });
  yield* fs.makeDirectory(stage);

  const packages = new Map<string, { directory: string; manifest: typeof Manifest.Type }>();
  for (const name of yield* fs.readDirectory(path.join(root, "packages"))) {
    const directory = path.join(root, "packages", name);
    if (yield* fs.exists(path.join(directory, "package.json"))) {
      const manifest = yield* readManifest(path.join(directory, "package.json"));
      packages.set(manifest.name, { directory, manifest });
    }
  }
  const local = yield* readManifest(path.join(root, "apps/local/server/package.json"));
  const dependencies: Record<string, string> = {};
  const included = new Set<string>();
  const collect = (
    entries: Readonly<Record<string, string>>,
  ): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      for (const [name, requested] of Object.entries(entries)) {
        if (included.has(name)) continue;
        included.add(name);
        const internal = packages.get(name);
        if (internal === undefined) {
          dependencies[name] = requested;
          continue;
        }
        const relative = `packages/${path.basename(internal.directory)}`;
        const destination = path.join(stage, relative);
        dependencies[name] = `file:./${relative}`;
        yield* emit(path.join(internal.directory, "src"), path.join(destination, "src"));
        // Public package resources (for example authoring skills) live outside src.
        for (const exported of Object.values(internal.manifest.exports ?? {})) {
          if (exported.startsWith("./src/") || exported.includes("*")) continue;
          const target = path.join(destination, exported);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.copy(path.join(internal.directory, exported), target, { overwrite: true });
        }
        for (const resource of ["skills", "executor", "dist/motel", "LICENSE", "LICENSE.md"]) {
          const from = path.join(internal.directory, resource);
          if (yield* fs.exists(from))
            yield* fs.copy(from, path.join(destination, resource), { overwrite: true });
        }
        yield* fs.writeFileString(
          path.join(destination, "package.json"),
          JSON.stringify(
            {
              ...internal.manifest,
              version,
              private: true,
              exports: Object.fromEntries(
                Object.entries(internal.manifest.exports ?? {}).map(([key, value]) => [
                  key,
                  value.replace(/\.tsx?$/, ".js"),
                ]),
              ),
              // The enclosing artifact owns a single locked dependency tree.
              dependencies: undefined,
            },
            null,
            2,
          ),
        );
        yield* collect(internal.manifest.dependencies ?? {});
        yield* collect(
          Object.fromEntries(
            Object.entries(internal.manifest.peerDependencies ?? {}).filter(
              ([peer]) => internal.manifest.peerDependenciesMeta?.[peer]?.optional !== true,
            ),
          ),
        );
      }
    });
  yield* collect(local.dependencies ?? {});
  yield* emit(path.join(root, "apps/local/server/src"), path.join(stage, "apps/local/server/src"));
  yield* fs.copy(path.join(root, "apps/local/web/dist"), path.join(stage, "apps/local/web/dist"));
  yield* fs.copy(path.join(root, "patches"), path.join(stage, "patches"));
  yield* fs.copyFile(
    path.join(root, "scripts/releases/runtime-env.mjs"),
    path.join(stage, "runtime-env.mjs"),
  );
  yield* fs.copy(path.join(root, "scripts/releases/licenses"), path.join(stage, "licenses"));
  const rootManifest = yield* fs.readFileString(path.join(root, "package.json")).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            devDependencies: Schema.Struct({ dugite: Schema.NonEmptyString }),
            overrides: Schema.Record(Schema.String, Schema.String),
            patchedDependencies: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      ),
    ),
  );
  dependencies.dugite = rootManifest.devDependencies.dugite;
  const manifest = {
    name: "executor",
    version: platformVersion(target),
    private: false,
    type: "module",
    description: "Executor native runtime",
    license: "MIT",
    repository: { type: "git", url: `https://github.com/${release.repository}.git` },
    publishConfig: {
      access: "public",
      tag: `${release.channel}-${target.platform}-${target.arch}`,
    },
    engines: { node: ">=24.14.0" },
    os: [process.platform],
    cpu: [process.arch],
    files: [
      "bin.mjs",
      "runtime-env.mjs",
      "apps",
      "packages",
      "licenses",
      "bun.lock",
      "README.md",
      "LICENSE",
    ],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
    overrides: rootManifest.overrides,
    patchedDependencies: rootManifest.patchedDependencies,
    // These pinned build dependencies install their platform executables into the artifact.
    // App dependency installs still disable lifecycle scripts in the runtime.
    trustedDependencies: ["bun", "dugite", "esbuild"],
  };
  yield* fs.writeFileString(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2));
  yield* fs.writeFileString(
    path.join(stage, "bin.mjs"),
    `#!/usr/bin/env node\nimport { homedir } from "node:os";\nimport { join } from "node:path";\nimport { packagedRuntimeEnvironment } from "./runtime-env.mjs";\nObject.assign(process.env, packagedRuntimeEnvironment(process.env));\nprocess.env.EXECUTOR_DATA_DIR ??= join(homedir(), ".executor", "v2", "cli");\nprocess.env.EXECUTOR_BUILD_VERSION = ${JSON.stringify(version)};\nawait import("./apps/local/server/src/bin.js");\n`,
  );
  yield* fs.chmod(path.join(stage, "bin.mjs"), 0o755);
  yield* fs.copyFile(path.join(root, "scripts/releases/README.md"), path.join(stage, "README.md"));
  yield* fs.copyFile(path.join(root, "apps/cli/LICENSE"), path.join(stage, "LICENSE"));
  // Reuse the repository's resolved versions/integrities when projecting the runtime closure.
  yield* fs.copyFile(path.join(root, "bun.lock"), path.join(stage, "bun.lock"));
  yield* run("bun", ["install", "--lockfile-only"], stage);
  yield* run(
    "bun",
    [
      "install",
      "--production",
      "--frozen-lockfile",
      // Archives must not depend on hard links into a shared cache or forward-link extraction.
      process.platform === "darwin" ? "--backend=clonefile" : "--backend=copyfile",
    ],
    stage,
  );
  const bun = path.join(stage, "node_modules/bun/bin/bun.exe");
  const bunx = path.join(stage, "node_modules/bun/bin/bunx.exe");
  // Bun's postinstall hardlinks this alias even with --backend=copyfile.
  // node-tar's async hardlink queue can deadlock while npm packs the archive.
  // Keep both executable names, with independent files in the release staging tree.
  yield* fs.remove(bunx);
  yield* fs.copyFile(bun, bunx);
  yield* run(bun, ["--version"], stage);
  yield* run(bunx, ["--version"], stage);
  yield* installWindowsGitHttpBackend(stage);
  yield* run(
    "node",
    [
      "--input-type=module",
      "--eval",
      `import { spawnSync } from "node:child_process";
import { packagedRuntimeEnvironment } from "./runtime-env.mjs";
const result = spawnSync("git", ["--version"], {
  env: packagedRuntimeEnvironment({ ...process.env, PATH: "" }),
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(1);
const backend = spawnSync("git", ["http-backend"], {
  env: packagedRuntimeEnvironment({ ...process.env, PATH: "", GIT_PROJECT_ROOT: process.cwd(),
    GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: "/executor-release-probe-missing.git/info/refs",
    REQUEST_METHOD: "GET", QUERY_STRING: "service=git-upload-pack", SERVER_PROTOCOL: "HTTP/1.1" }),
  encoding: "utf8",
});
if (backend.error) throw backend.error;
if (backend.status !== 0 || !backend.stdout.includes("Status: 404")) {
  throw new Error("The bundled Git HTTP backend did not return the expected missing-repository response");
}`,
    ],
    stage,
  );
  // Windows npm is a shell wrapper. Invoke its JavaScript entry with Node, without a shell.
  const npm =
    process.platform === "win32"
      ? {
          command: process.execPath,
          prefix: [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")],
        }
      : { command: "npm", prefix: [] };
  yield* run(
    npm.command,
    [...npm.prefix, "pack", "--ignore-scripts", "--pack-destination", output],
    stage,
  );
  yield* Console.log(`Native artifact: ${output}`);
});
NodeRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(NodeServices.layer)));
