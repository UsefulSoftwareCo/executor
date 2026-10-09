/** Compile server and browser source inside workerd using Cloudflare's dependency resolver. */
import { createApp, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import {
  boundBuildMessage,
  describeBuildCause,
  RuntimeAppsDependencyMissing,
  RuntimeBuildFailed,
} from "../contracts/runtime.ts";
import type { SourceFiles } from "../contracts/deployment.ts";
import { prepareUiBuild } from "./ui-build.ts";
import { Effect, Option, Path, Schema } from "effect";
import type { Plugin } from "esbuild";
import { PublishedAppFramework, WorkerBundle } from "../contracts/worker-build.ts";
import { appProtocol } from "./app-protocols.ts";
import { browserBuild } from "./worker-browser-build.ts";
import { sourceImports } from "./worker-source-imports.ts";
import { serverSourceMap, sourceLocation } from "./worker-source-map.ts";
import { wasmBuild } from "./worker-wasm-build.ts";
import { workerDependencies } from "./worker-dependencies.ts";
import apps from "apps/package.json" with { type: "json" };

/**
 * What the compiling host contributes. `registry` replaces the public npm registry. A host has no
 * framework of its own: every source declares the `apps` release it uses in `dependencies.apps`.
 * `apps` supplies the package files of one declared release, so a test deployment can build apps
 * against its own unpublished framework. Any other declared release installs from the registry.
 */
export interface WorkerHost {
  readonly registry?: string;
  readonly apps?: {
    readonly version: string;
    /** Package-relative paths and contents, as in the published archive. */
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
/**
 * The build's own entry for each framework import. These re-exports belong to this host's export
 * list, not to the release, so they stay with the app and the stored framework is the release's.
 */
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
/** Shown compiler errors; the rest are counted. */
const shownCompileErrors = 5;

/** Keep the compiler's own errors and the first failing location for the deployer. */
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

/**
 * Compilation returns browser bytes separately; neither imports nor credentials cross from server
 * execution. The selected framework's protocol must be supported before anything compiles. The
 * bundle holds only the app's modules; `framework` holds the release's server modules, which a
 * host stores once and links on load (see `assembleWorkerBundle`).
 */
export const compileWorkerApp = (files: SourceFiles, host: WorkerHost) =>
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
    filesystem.write(entry, protocol.workerEntry(files));
    const plan = yield* prepareUiBuild(files);
    const browser =
      plan === undefined
        ? undefined
        : yield* browserBuild(files, filesystem, plan, selected.browser);
    const path = yield* Path.Path;
    const wasm = wasmBuild(filesystem, path);
    const sourceMap = serverSourceMap(entry);
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
            // The browser plugin wraps script-imported assets in a module-relative URL first; its
            // own lookup of the asset file then reaches the source resolver.
            ...(browser === undefined ? [] : [browser.plugin]),
            sourceImports(filesystem, path),
          ],
        }),
      catch: compileFailure,
    });
    const map = sourceMap.map();
    if (map === undefined)
      return yield* new RuntimeBuildFailed({
        stage: "compile",
        message: "The compiler returned no source map for the server bundle.",
      });
    const bundle = yield* Schema.decodeUnknownEffect(Schema.toType(WorkerBundle))({
      ...compiled,
      modules: { ...compiled.modules, ...frameworkEntries, ...wasm.modules },
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
      // Locates this build's declaration failures; never retained with it.
      sourceMap: map,
    };
  }).pipe(Effect.provide(Path.layer), Effect.withSpan("runtime.cloud.compile"));
