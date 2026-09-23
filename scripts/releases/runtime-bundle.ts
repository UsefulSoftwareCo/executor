/** Assemble the reachable local server code and its portable native resources. */
import { bundleWorkerdHost } from "@executor-js/sdk/node/build";
import { Effect, FileSystem, Path, Schema } from "effect";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { cp, lstat, readFile } from "node:fs/promises";
import { release } from "./config.ts";

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  os: Schema.optional(Schema.Array(Schema.String)),
  cpu: Schema.optional(Schema.Array(Schema.String)),
  libc: Schema.optional(Schema.Array(Schema.String)),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** Bundle both process entry points once; copy only locked native dependencies and resource files. */
export const bundleLocalRuntime = (root: string, stage: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const readManifest = (directory: string) =>
      fs
        .readFileString(path.join(directory, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
    const resolvePackage = (name: string, from: string) =>
      Effect.gen(function* () {
        const resolve = createRequire(path.join(from, "package.json"));
        // Assembly needs the manifest itself, including packages that do not export package.json.
        for (const modules of resolve.resolve.paths(name) ?? []) {
          const directory = path.join(modules, name);
          if (yield* fs.exists(path.join(directory, "package.json")))
            return yield* fs.realPath(directory);
        }
        return undefined;
      });
    const requiredPackage = (name: string, from: string) =>
      resolvePackage(name, from).pipe(
        Effect.flatMap((directory) =>
          directory === undefined
            ? Effect.die(new Error(`Missing runtime dependency ${name} from ${from}`))
            : Effect.succeed(directory),
        ),
      );
    const modules = yield* bundleWorkerdHost;
    const prepared = modules.map((module) => {
      const content =
        module.type === "Wasm"
          ? `Buffer.from(${JSON.stringify(Buffer.from(module.content).toString("base64"))}, "base64")`
          : JSON.stringify(module.content);
      return `{name:${JSON.stringify(module.name)},type:${JSON.stringify(module.type)},content:${content}}`;
    });
    const output = path.join(stage, "runtime");
    const bundled = yield* Effect.tryPromise(() =>
      build({
        absWorkingDir: root,
        entryPoints: {
          cli: "apps/local/server/src/bin.ts",
          desktop: "apps/local/desktop/src/server.ts",
        },
        outdir: output,
        outExtension: { ".js": ".mjs" },
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "node",
        target: "node24",
        minify: true,
        keepNames: true,
        sourcemap: "external",
        sourcesContent: false,
        legalComments: "external",
        metafile: true,
        define: { "process.env.EXECUTOR_DESKTOP_DEV": '"0"' },
        external: [
          "bun",
          "bun:*",
          "ws",
          "@electric-sql/pglite",
          "workerd",
          "sharp",
          "@napi-rs/keyring",
          "typescript",
        ],
        banner: {
          js: 'import { createRequire as __runtimeRequire } from "node:module"; import { fileURLToPath as __runtimeFile } from "node:url"; import { dirname as __runtimeDir } from "node:path"; const require = __runtimeRequire(import.meta.url); const __filename = __runtimeFile(import.meta.url); const __dirname = __runtimeDir(__filename);',
        },
        plugins: [
          {
            name: "local-runtime-resources",
            setup(builder) {
              builder.onLoad(
                { filter: /sdk[/\\]src[/\\]implementation[/\\]workerd-bundle\.ts$/ },
                () => ({
                  contents: `import { Effect } from "effect"; export const bundleWorkerdHost = Effect.succeed([${prepared.join(",")}]);`,
                  loader: "js",
                  resolveDir: path.join(root, "packages/sdk"),
                }),
              );
              // These modules locate static resources relative to their original source URL.
              // Every generated chunk lives in runtime/, so preserve those URLs after bundling.
              builder.onLoad(
                {
                  filter:
                    /(?:server[/\\]src[/\\]implementation[/\\]web|telemetry[/\\]src[/\\]local)\.ts$/,
                },
                async (args) => {
                  const relative = path.relative(root, args.path).split(path.sep).join("/");
                  return {
                    contents: (await readFile(args.path, "utf8")).replaceAll(
                      "import.meta.url",
                      `new URL(${JSON.stringify(`../${relative}`)}, import.meta.url).href`,
                    ),
                    loader: "ts",
                    resolveDir: path.dirname(args.path),
                  };
                },
              );
            },
          },
        ],
      }),
    );
    yield* fs.writeFileString(
      path.join(stage, "../runtime-meta.json"),
      JSON.stringify(bundled.metafile),
    );
    const dependencies: Record<string, string> = {};
    const licenseDirectories = new Set<string>();
    const copied = new Map<string, string>();
    const supported = (values: readonly string[] | undefined, current: string) =>
      values === undefined ||
      (!values.includes(`!${current}`) &&
        (values.includes(current) || values.every((value) => value.startsWith("!"))));
    const copyPackage = (directory: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const pkg = yield* readManifest(directory);
        if (
          !supported(pkg.os, process.platform) ||
          !supported(pkg.cpu, process.arch) ||
          !supported(pkg.libc, "glibc")
        )
          return;
        if (pkg.version === undefined)
          return yield* Effect.die(new Error(`Missing package version: ${directory}`));
        const previous = copied.get(pkg.name);
        if (previous !== undefined) {
          if (previous !== directory)
            return yield* Effect.die(new Error(`Conflicting runtime dependency: ${pkg.name}`));
          return;
        }
        copied.set(pkg.name, directory);
        dependencies[pkg.name] = pkg.version;
        licenseDirectories.add(directory);
        const destination = path.join(stage, "node_modules", pkg.name);
        yield* fs.makeDirectory(destination, { recursive: true });
        for (const file of yield* fs.readDirectory(directory)) {
          if (file !== "node_modules")
            yield* Effect.tryPromise(() =>
              cp(path.join(directory, file), path.join(destination, file), {
                recursive: true,
                verbatimSymlinks: true,
              }),
            );
        }
        for (const name of Object.keys(pkg.dependencies ?? {})) {
          if (pkg.optionalDependencies?.[name] !== undefined) continue;
          yield* copyPackage(yield* requiredPackage(name, directory));
        }
        for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
          const optional = yield* resolvePackage(name, directory);
          if (optional !== undefined) yield* copyPackage(optional);
        }
      }).pipe(Effect.orDie);
    const sdk = path.join(root, "packages/sdk");
    const alchemy = yield* requiredPackage("@alchemy.run/cloudflare-runtime", sdk);
    for (const [name, owner] of [
      ["ws", sdk],
      ["workerd", alchemy],
      ["sharp", alchemy],
      ["@electric-sql/pglite", yield* requiredPackage("@effect/sql-pglite", sdk)],
      ["@napi-rs/keyring", root],
      ["typescript", root],
      ["dugite", root],
    ] as const) {
      yield* copyPackage(yield* requiredPackage(name, owner));
    }
    // npm deliberately omits symbolic and hard links. Git uses argv[0] aliases;
    // preserve those commands with shell builtins instead of duplicating its binary.
    const materializeLinks = (
      directory: string,
    ): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(directory)) {
          const file = path.join(directory, name);
          const info = yield* Effect.tryPromise(() => lstat(file));
          if (info.isDirectory()) {
            yield* materializeLinks(file);
            continue;
          }
          if (!info.isSymbolicLink()) continue;
          const target = yield* fs.realPath(file);
          if (!target.startsWith(stage + path.sep))
            return yield* Effect.die(new Error(`Runtime resource escapes the package: ${file}`));
          const git = path.join(stage, "node_modules/dugite/git") + path.sep;
          const relative = path.relative(path.dirname(file), target).split(path.sep).join("/");
          yield* fs.remove(file);
          if (
            file.startsWith(git) &&
            path.basename(target) === "git" &&
            /^git-[a-z0-9-]+$/.test(name)
          ) {
            yield* fs.writeFileString(
              file,
              `#!/bin/sh\nexec "\${0%/*}/${relative}" ${JSON.stringify(name.slice(4))} "$@"\n`,
            );
            yield* fs.chmod(file, 0o755);
          } else {
            // Non-Git aliases are small resources or individual protocol helpers.
            yield* fs.copyFile(target, file);
          }
        }
      }).pipe(Effect.orDie);
    yield* materializeLinks(path.join(stage, "node_modules"));
    if (process.platform === "win32") {
      // The upstream executable has no application manifest. Its SQLite storage
      // needs this declaration to use the host's enabled Windows long-path support.
      const workerd = yield* Effect.try(() =>
        createRequire(path.join(stage, "package.json"))("workerd"),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ default: Schema.String }))));
      if (!workerd.default.startsWith(stage + path.sep))
        return yield* Effect.die(new Error("Workerd executable escapes the staged runtime"));
      yield* fs.copyFile(
        path.join(root, "scripts/releases/workerd.exe.manifest"),
        `${workerd.default}.manifest`,
      );
    }
    // workerd's Unix postinstall duplicates the executable in its CLI path. Its
    // public Node API already resolves the pinned platform binary, so share that path.
    if (process.platform !== "win32") {
      const executable = path.join(stage, "node_modules/workerd/bin/workerd");
      yield* fs.writeFileString(
        executable,
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const workerd = require("../lib/main.js").default;
const result = spawnSync(workerd, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
`,
      );
      yield* fs.chmod(executable, 0o755);
    }
    yield* fs.copy(path.join(alchemy, "dist/core/workers"), path.join(stage, "alchemy-workers"));
    yield* fs.copy(path.join(root, "apps/local/web/dist"), path.join(stage, "apps/local/web/dist"));
    yield* fs.copy(
      path.join(root, "packages/telemetry/dist/motel"),
      path.join(stage, "packages/telemetry/dist/motel"),
    );
    // Keep build diagnostics beside the artifact, without making every npm user
    // download external source maps. These files are not executable runtime assets.
    for (const [directory, name] of [
      [output, "runtime"],
      [path.join(stage, "packages/telemetry/dist/motel"), "motel"],
    ] as const) {
      for (const file of yield* fs.readDirectory(directory, { recursive: true })) {
        if (!file.endsWith(".map")) continue;
        const destination = path.join(stage, "../debug", name, file);
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.rename(path.join(directory, file), destination);
      }
    }
    for (const [name, directory, resource] of [
      ["@executor-js/app-templates", path.join(root, "packages/app-templates"), "executor"],
      ["apps", path.join(root, "packages/apps/dist"), "framework-reference.json"],
    ] as const) {
      const destination = path.join(stage, "node_modules", name);
      yield* fs.makeDirectory(destination, { recursive: true });
      yield* fs.copy(path.join(directory, resource), path.join(destination, resource));
      const pkg = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            exports: Schema.Record(Schema.String, Schema.Unknown),
            version: Schema.optional(Schema.String),
          }),
        ),
      )(yield* fs.readFileString(path.join(directory, "package.json")));
      const version = pkg.version ?? release.version;
      yield* fs.writeFileString(
        path.join(destination, "package.json"),
        JSON.stringify({ name, version, exports: pkg.exports }),
      );
      dependencies[name] = version;
      licenseDirectories.add(directory);
    }
    // Keep full license files for bundled code, as well as esbuild's inline/external notices.
    for (const input of Object.keys(bundled.metafile.inputs)) {
      if (input.startsWith("(disabled):")) continue;
      const absolute = path.resolve(root, input).split(path.sep).join("/");
      const boundary = absolute.lastIndexOf("/node_modules/");
      if (boundary < 0) continue;
      const parts = absolute.slice(boundary + 14).split("/");
      licenseDirectories.add(
        path.join(
          absolute.slice(0, boundary),
          "node_modules",
          ...parts.slice(0, parts[0]?.startsWith("@") ? 2 : 1),
        ),
      );
    }
    // The prepared Worker source is embedded in the host bundle; retain its SDK dependency notices too.
    const visited = new Set<string>();
    const collectNotices = (directory: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        if (visited.has(directory)) return;
        visited.add(directory);
        licenseDirectories.add(directory);
        const pkg = yield* readManifest(directory);
        for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
          const dependency = yield* resolvePackage(name, directory);
          if (dependency !== undefined) yield* collectNotices(dependency);
        }
      }).pipe(Effect.orDie);
    yield* collectNotices(sdk);
    const inventory: string[] = [];
    for (const directory of licenseDirectories) {
      const pkg = yield* readManifest(directory);
      const identity = `${pkg.name}@${pkg.version ?? "workspace"}`;
      inventory.push(identity);
      const destination = path.join(stage, "licenses", identity.replaceAll("/", "__"));
      yield* fs.makeDirectory(destination, { recursive: true });
      for (const name of yield* fs.readDirectory(directory))
        if (/^(licen[sc]e|notice|copying|copyright|third.party)([._-]|$)/i.test(name))
          yield* fs.copy(path.join(directory, name), path.join(destination, name), {
            overwrite: true,
          });
    }
    yield* fs.writeFileString(
      path.join(stage, "runtime-packages.txt"),
      [...new Set(inventory)].sort().join("\n") + "\n",
    );
    return dependencies;
  });
