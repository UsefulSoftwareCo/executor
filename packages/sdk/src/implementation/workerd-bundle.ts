/** Bundle only trusted runtime/framework source on the host. Authored code compiles inside workerd. */
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

/** Serialize a build artifact for installation or reuse by isolated processes from the same build. */
export const writeWorkerdHostBundle = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const modules = yield* bundleWorkerdHost;
    const contents = yield* Schema.encodeEffect(Schema.fromJsonString(HostBundle))(modules);
    yield* fs.writeFileString(file, contents);
  });

/** Load an explicitly prepared host artifact, or compile source for an ordinary development launch. */
export const workerdHostModules = Effect.gen(function* () {
  const file = yield* Config.String("EXECUTOR_WORKER_BUNDLE").pipe(Config.option);
  if (Option.isNone(file)) return yield* bundleWorkerdHost;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(file.value)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HostBundle))));
}).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));

/** Build the trusted Worker entry point for this installation. */
export const bundleWorkerdHost = Effect.gen(function* () {
  const path = yield* Path.Path;
  const directory = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  const outdir = path.join(directory, ".runtime-host");
  const compiled = yield* Effect.tryPromise(() =>
    build({
      // esbuild resolves .js to .ts in a checkout; installed packages contain the emitted .js.
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
    }),
  );
  const modules: Module[] = compiled.outputFiles.map((file) => ({
    name: path.relative(outdir, file.path).split(path.sep).join("/"),
    ...(file.path.endsWith(".wasm")
      ? { type: "Wasm" as const, content: file.contents }
      : { type: "ESModule" as const, content: file.text }),
  }));
  modules.sort((a, b) =>
    a.name === "main.js" ? -1 : b.name === "main.js" ? 1 : a.name.localeCompare(b.name),
  );
  return modules;
}).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));
