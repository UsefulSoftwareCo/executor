import { createApp, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import {
  boundBuildMessage,
  describeBuildCause,
  RuntimeAppsDependencyMissing,
  RuntimeBuildFailed,
} from "../contracts/runtime.ts";
import type { CodeFiles } from "../contracts/source.ts";
import { prepareUiBuild } from "./ui-build.ts";
import { Effect, Option, Path, Schema } from "effect";
import type { Plugin } from "esbuild";
import { PublishedAppFramework, WorkerBundle } from "../contracts/worker-build.ts";
import { appProtocol } from "./app-protocols.ts";
import { browserBuild } from "./worker-browser-build.ts";
import { sourceImports } from "./worker-source-imports.ts";
import { serverSourceMap, sourceLocation } from "./worker-source-map.ts";
import { wasmBuild } from "./worker-wasm-build.ts";
import { jsonModules } from "./worker-json-modules.ts";
import { compiledFiles } from "./worker-compiled-files.ts";
import { serverFilesModule, serverFilesSource } from "./worker-bridge.ts";
import { workerDependencies } from "./worker-dependencies.ts";
import apps from "apps/package.json" with { type: "json" };

export interface WorkerHost {
  readonly registry?: string;
  readonly tarballFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly apps?: {
    readonly version: string;
    readonly files: Effect.Effect<Readonly<Record<string, string>>, RuntimeBuildFailed>;
  };
}

const frameworkExports = [
  "apps",
  "apps/host",
  "apps/storage/facet",
  "apps/contracts",
  "apps/mcp",
  "apps/graphql",
  "apps/openapi",
  "apps/skills",
  "apps/skills/effect",
  "apps/operations/approval",
];
const frameworkEntries = Object.fromEntries(
  frameworkExports.map((name) => [
    name,
    {
      js: `export * from "${name === "apps" ? "./" : "../".repeat(name.split("/").length - 1)}node_modules/apps/${name === "apps" ? "index" : name.slice(5)}.js";`,
    },
  ]),
);
const quietCompiler: Plugin = {
  name: "private-build-diagnostics",
  setup(build) {
    build.initialOptions.logLevel = "silent";
  },
};

const EsbuildFailure = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      location: Schema.NullOr(
        Schema.Struct({
          file: Schema.String,
          line: Schema.Int,
          column: Schema.Int,
          lineText: Schema.String,
        }),
      ),
    }),
  ),
});
const shownCompileErrors = 5;

const compileFailure = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(EsbuildFailure)(cause), {
    onNone: () => new RuntimeBuildFailed({ stage: "compile", message: describeBuildCause(cause) }),
    onSome: (failure) => {
      const errors = failure.errors.map(({ text, location }) => ({
        text,
        location: location === null ? undefined : sourceLocation(location),
      }));
      const first = errors[0]?.location;
      const lines = errors
        .slice(0, shownCompileErrors)
        .map(({ text, location }) =>
          location === undefined
            ? text
            : `${location.file}:${location.line}:${location.column}: ${text}`,
        );
      const more = errors.length - lines.length;
      return new RuntimeBuildFailed({
        stage: "compile",
        message: boundBuildMessage(
          [...lines, ...(more > 0 ? [`(${more} more errors)`] : [])].join("\n") ||
            describeBuildCause(cause),
        ),
        ...(first === undefined ? {} : { location: first }),
      });
    },
  });

const selectedFramework = (filesystem: InMemoryFileSystem) =>
  Effect.gen(function* () {
    const selected = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PublishedAppFramework),
    )(filesystem.read("node_modules/apps/runtime.json"));
    for (const modules of [selected.server, selected.browser]) {
      if (
        Object.keys(modules).some(
          (name) =>
            !name.startsWith("node_modules/apps/") ||
            !name.endsWith(".js") ||
            name.split("/").includes(".."),
        )
      )
        return yield* new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" });
    }
    return selected;
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(RuntimeBuildFailed)(error)
        ? error
        : new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" }),
    ),
  );

export const compileWorkerApp = (
  files: CodeFiles,
  host: WorkerHost,
  publicPaths: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const vendored = files.find((file) => file.path.split("/").includes("node_modules"));
    if (vendored !== undefined)
      return yield* new RuntimeBuildFailed({
        stage: "source",
        location: { file: vendored.path },
        message:
          "Source files cannot include node_modules. Declare packages in package.json dependencies; the build installs them.",
      });
    const filesystem = new InMemoryFileSystem(
      Object.fromEntries(files.map((file) => [file.path, file.content])),
    );
    const dependencies = yield* workerDependencies(filesystem, host);
    if (!(yield* dependencies.framework))
      return yield* new RuntimeAppsDependencyMissing({ version: apps.version });
    const selected = yield* selectedFramework(filesystem);
    const protocol = yield* appProtocol(selected.protocol);
    const entry = "__executor_worker.ts";
    filesystem.write(entry, protocol.workerEntry);
    const plan = yield* prepareUiBuild(files, publicPaths);
    const browser =
      plan === undefined
        ? undefined
        : yield* browserBuild(files, filesystem, plan, selected.browser);
    const path = yield* Path.Path;
    const wasm = wasmBuild(filesystem, path);
    const json = jsonModules(files, entry);
    const sourceMap = serverSourceMap(entry);
    const sizes = compiledFiles(filesystem);
    const compiled = yield* Effect.tryPromise({
      try: () =>
        createApp({
          files: filesystem,
          installDependencies: false,
          server: entry,
          externals: frameworkExports,
          minify: true,
          jsx: "automatic",
          define: { "process.env.NODE_ENV": '"production"' },
          ...(plan === undefined ? {} : { client: [...plan.entries] }),
          __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
            quietCompiler,
            dependencies.plugin,
            wasm.plugin,
            sourceMap.plugin,
            json.plugin,
            ...(browser === undefined ? [] : [browser.plugin]),
            sourceImports(filesystem, path),
            sizes.plugin,
          ],
        }),
      catch: (cause) => sizes.failure() ?? json.failure() ?? compileFailure(cause),
    });
    const map = sourceMap.map();
    if (map === undefined)
      return yield* new RuntimeBuildFailed({
        stage: "compile",
        message: "The compiler returned no source map for the server bundle.",
      });
    const bundle = yield* Schema.decodeUnknownEffect(Schema.toType(WorkerBundle))({
      ...compiled,
      modules: {
        ...compiled.modules,
        ...frameworkEntries,
        ...wasm.modules,
        ...json.modules,
        [serverFilesModule]: serverFilesSource(files),
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeBuildFailed({
            stage: "compile",
            message: boundBuildMessage(
              `The compiled bundle is invalid: ${describeBuildCause(cause)}`,
            ),
          }),
      ),
    );
    const ui = browser === undefined ? undefined : yield* browser.finish();
    return {
      bundle,
      framework: { version: selected.version, modules: selected.server },
      ui,
      protocol: selected.protocol,
      sourceMap: map,
    };
  }).pipe(Effect.provide(Path.layer), Effect.withSpan("runtime.cloud.compile"));
