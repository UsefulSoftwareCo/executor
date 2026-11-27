import { build } from "esbuild";
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { Module } from "@alchemy.run/cloudflare-runtime/core";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";

const HostBundle = Schema.mutable(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        name: Schema.String,
        type: Schema.Literals(["ESModule", "CommonJsModule", "Text", "Json", "PythonModule"]),
        content: Schema.String,
      }),
      Schema.Struct({
        name: Schema.String,
        type: Schema.Literals(["Data", "Wasm"]),
        content: Schema.Uint8ArrayFromBase64,
      }),
    ]),
  ),
);

const SourceMapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

export const writeWorkerdHostBundle = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { modules, maps } = yield* buildWorkerdHost(true);
    const contents = yield* Schema.encodeEffect(Schema.fromJsonString(HostBundle))(modules);
    yield* fs.writeFileString(file, contents);
    const sourceRoot = `${path.relative(path.dirname(path.resolve(file)), maps.directory)}/`;
    yield* fs.writeFileString(
      `${file}.map`,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(maps.files).map(([name, map]) => [name, { ...map, sourceRoot }]),
        ),
      ),
    );
  });

export const workerdHostModules = Effect.gen(function* () {
  const file = yield* Config.String("EXECUTOR_WORKER_BUNDLE").pipe(Config.option);
  if (Option.isNone(file)) return yield* bundleWorkerdHost;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(file.value)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HostBundle))));
}).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));

const buildWorkerdHost = (sourceMap: boolean) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
    const outdir = path.join(directory, ".runtime-host");
    const compiled = yield* Effect.tryPromise(() =>
      build({
        entryPoints: { main: path.join(directory, "workerd-entry.js") },
        outdir,
        bundle: true,
        format: "esm",
        platform: "browser",
        conditions: ["workerd"],
        target: "es2022",
        write: false,
        external: ["cloudflare:*"],
        loader: { ".wasm": "copy" },
        ...(sourceMap ? { sourcemap: "external" as const, sourcesContent: false } : {}),
      }),
    );
    const maps: Record<string, { readonly [key: string]: unknown }> = {};
    const modules: Module[] = [];
    for (const file of compiled.outputFiles) {
      const name = path.relative(outdir, file.path).split(path.sep).join("/");
      if (name.endsWith(".map"))
        maps[name.slice(0, -".map".length)] = yield* Schema.decodeUnknownEffect(SourceMapJson)(
          file.text,
        );
      else
        modules.push({
          name,
          ...(file.path.endsWith(".wasm")
            ? { type: "Wasm" as const, content: file.contents }
            : { type: "ESModule" as const, content: file.text }),
        });
    }
    modules.sort((a, b) =>
      a.name === "main.js" ? -1 : b.name === "main.js" ? 1 : a.name.localeCompare(b.name),
    );
    return { modules, maps: { directory: outdir, files: maps } };
  }).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));

export const bundleWorkerdHost = buildWorkerdHost(false).pipe(Effect.map(({ modules }) => modules));
