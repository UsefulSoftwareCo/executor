import { AppSkills } from "apps/contracts";
/** Retained trusted-code builds using Effect platform services and direct handler invocation. */
import { build as compile } from "esbuild";
import { captureTelemetry, traceHeaders } from "@executor-js/telemetry";
import { Crypto, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  HostRequirementsError,
  HostInspectError,
  HostCallError,
  HostDataError,
  DeclaredRequirements,
  HostRequest,
  HostResponse,
  ToolResultObservation,
  HostedTool,
  type HostContext,
  type ResolvedAccountsInput,
} from "apps/contracts";
import {
  RuntimeBuildFailed,
  RuntimeBuildUnavailable,
  RuntimeProtocolFailed,
  type Runtime,
} from "../contracts/runtime.ts";
import { SourceFiles } from "../contracts/deployment.ts";
import { BuildId, Json } from "../contracts/shared.ts";
import { buildUi } from "./node-ui.ts";
import { BlobStore } from "../contracts/blobs.ts";
import { materializeNodeBuild, nodeBuildAsset, retainNodeBuild } from "./node-builds.ts";
import { hostPackages, installNodeDependencies } from "./node-dependencies.ts";
import type { NodeRuntimeOptions } from "../node.ts";
import { PublishedAppFramework } from "../contracts/worker-build.ts";

type Handler = (
  request: Request,
  context: HostContext,
  accounts: ResolvedAccountsInput,
) => Promise<Response>;
type NodeRuntimeServices =
  | BlobStore
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;
const HostedModule = Schema.Struct({
  // SAFETY: this is the framework-generated entry point, not the author's
  // module. Responses are parsed independently before entering the SDK.
  default: Schema.declare((value): value is Handler => typeof value === "function"),
});
const Package = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString)),
});
const FrameworkPackage = Schema.Struct({
  peerDependencies: Schema.Record(Schema.String, Schema.String),
  peerDependenciesMeta: Schema.Record(
    Schema.String,
    Schema.Struct({ optional: Schema.optional(Schema.Boolean) }),
  ),
});
const packageName = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

function attempt<A, E>(work: (signal: AbortSignal) => Promise<A>, error: E) {
  return Effect.tryPromise({ try: work, catch: () => error });
}

function dispatch<A, E>(
  handler: Handler,
  command: HostRequest,
  context: HostContext,
  value: Schema.Decoder<A>,
  error: Schema.Decoder<E>,
) {
  return Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(HostRequest)(command).pipe(
      Effect.mapError(() => new RuntimeProtocolFailed()),
    );
    const telemetry = yield* captureTelemetry;
    const headers = { "content-type": "application/json", ...(yield* traceHeaders) };
    const response = yield* attempt(
      (signal) =>
        handler(
          new Request("https://apps.internal/dispatch", {
            method: "POST",
            headers,
            body: JSON.stringify(request),
            signal,
          }),
          { ...context, telemetry },
          Redacted.value(context.accounts),
        ),
      new RuntimeProtocolFailed(),
    );
    const body = yield* attempt(() => response.json(), new RuntimeProtocolFailed());
    const envelope = yield* Schema.decodeUnknownEffect(HostResponse)(body).pipe(
      Effect.mapError(() => new RuntimeProtocolFailed()),
    );
    if (!envelope.ok)
      return yield* Schema.decodeUnknownEffect(error)(envelope.error).pipe(
        Effect.mapError(() => new RuntimeProtocolFailed()),
        Effect.flatMap(Effect.fail),
      );
    if (envelope.toolError === true) {
      (yield* ToolResultObservation).failed();
      yield* Effect.annotateCurrentSpan({
        "executor.outcome": "failed",
        "error.type": "McpToolError",
      });
    }
    if (!response.ok) return yield* Effect.fail(new RuntimeProtocolFailed());
    return yield* Schema.decodeUnknownEffect(value)(envelope.value).pipe(
      Effect.mapError(() => new RuntimeProtocolFailed()),
    );
  });
}

/** Create native operations; the composition boundary supplies platform services. */
export const nodeRuntime = (options: NodeRuntimeOptions): Runtime<NodeRuntimeServices> => {
  const load = (build: BuildId) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const location = yield* materializeNodeBuild(options.workDirectory, build);
      const url = yield* path
        .toFileUrl(path.join(location, "app.mjs"))
        .pipe(Effect.mapError(() => new RuntimeBuildUnavailable()));
      const module = yield* attempt(() => import(url.href), new RuntimeBuildUnavailable()).pipe(
        Effect.withSpan("runtime.node.import"),
      );
      return (yield* Schema.decodeUnknownEffect(HostedModule)(module).pipe(
        Effect.mapError(() => new RuntimeBuildUnavailable()),
      )).default;
    }).pipe(Effect.withSpan("runtime.node.load", { attributes: { "executor.build.id": build } }));

  return {
    build: ({ files }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = path.resolve(options.workDirectory);
          const source = yield* Schema.decodeUnknownEffect(SourceFiles)(files).pipe(
            Effect.mapError(() => new RuntimeBuildFailed({ stage: "source" })),
          );
          yield* fs
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })));
          const temporary = yield* fs
            .makeTempDirectoryScoped({ directory, prefix: ".building-" })
            .pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })));
          // Keep the scoped parent in place when its build child is moved into
          // retained storage, so normal scope cleanup still removes a real directory.
          const staging = path.join(temporary, "build");
          yield* fs
            .makeDirectory(staging)
            .pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })));
          const crypto = yield* Crypto.Crypto;
          const build = BuildId.make(
            `bld_${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })))}`,
          );
          for (const file of source) {
            const location = path.join(staging, "source", file.path);
            yield* fs.makeDirectory(path.dirname(location), { recursive: true }).pipe(
              Effect.andThen(fs.writeFileString(location, file.content)),
              Effect.mapError(() => new RuntimeBuildFailed({ stage: "source" })),
            );
          }
          const manifest = source.find((file) => file.path === "package.json");
          const dependencies =
            manifest === undefined
              ? {}
              : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Package))(
                  manifest.content,
                ).pipe(
                  Effect.map((parsed) =>
                    parsed.dependencies === undefined ? {} : parsed.dependencies,
                  ),
                  Effect.mapError(() => new RuntimeBuildFailed({ stage: "dependencies" })),
                );
          const publishedFramework = dependencies.apps !== undefined;
          if (
            Object.keys(dependencies).some((name) =>
              publishedFramework ? name === "@executor-js/sdk" : hostPackages.includes(name),
            )
          ) {
            return yield* Effect.fail(new RuntimeBuildFailed({ stage: "dependencies" }));
          }
          yield* fs
            .writeFileString(
              path.join(staging, "package.json"),
              JSON.stringify({ private: true, type: "module", dependencies }),
            )
            .pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "dependencies" })));
          if (
            Object.keys(dependencies).length > 0 ||
            source.some((file) => file.path === "bun.lock" || file.path === "package-lock.json")
          ) {
            yield* installNodeDependencies(
              staging,
              path.join(directory, ".dependencies"),
              source,
              publishedFramework,
            ).pipe(Effect.withSpan("runtime.node.dependencies"));
          }
          yield* fs
            .writeFileString(
              path.join(staging, "entry.ts"),
              [
                'import app from "./source/index.ts";',
                'import { createAppHandler, hostContext } from "apps/host";',
                "const handler = createAppHandler(app);",
                `const files = ${JSON.stringify(source)};`,
                // Redacted owns a private store per Effect instance. Decode on
                // the host side and re-wrap with the selected app framework.
                "export default (request, context, accounts) => handler(request, { ...context, ...hostContext(accounts, context.approval), files });",
              ].join("\n"),
            )
            .pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })));
          const frameworkDirectory = publishedFramework
            ? path.join(staging, "node_modules/apps")
            : path.dirname(
                yield* path
                  .fromFileUrl(new URL(import.meta.resolve("apps")))
                  .pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" }))),
              );
          const frameworkPackage = yield* fs
            .readFileString(
              path.join(frameworkDirectory, publishedFramework ? "." : "..", "package.json"),
            )
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(FrameworkPackage))),
              Effect.mapError(() => new RuntimeBuildFailed({ stage: "dependencies" })),
            );
          if (publishedFramework) {
            yield* fs.readFileString(path.join(frameworkDirectory, "runtime.json")).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedAppFramework)),
              ),
              Effect.mapError(
                () => new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" }),
              ),
            );
          }
          const optionalPeers = new Set(
            Object.keys(frameworkPackage.peerDependencies).filter(
              (name) => frameworkPackage.peerDependenciesMeta[name]?.optional === true,
            ),
          );
          // The compiler callbacks record only trusted package names, never app source or diagnostics.
          const missingPeers = new Set<string>();
          yield* Effect.tryPromise({
            try: () =>
              compile({
                entryPoints: [path.join(staging, "entry.ts")],
                outfile: path.join(staging, "app.mjs"),
                bundle: true,
                platform: "node",
                format: "esm",
                target: "node22",
                logLevel: "silent",
                // Bundle the framework once. Effect and its platform resolve to the host;
                // other npm packages load natively from the retained dependency tree.
                plugins: [
                  {
                    name: "host-framework",
                    setup(builder) {
                      builder.onResolve({ filter: /\.wasm$/ }, (args) => ({
                        path: args.path.startsWith(".")
                          ? path.resolve(args.resolveDir, args.path)
                          : path.join(staging, "node_modules", args.path),
                        namespace: "executor-wasm",
                      }));
                      builder.onLoad({ filter: /.*/, namespace: "executor-wasm" }, (args) =>
                        Effect.runPromise(
                          fs.readFile(args.path).pipe(
                            Effect.map((bytes): import("esbuild").OnLoadResult => ({
                              contents: `export default new WebAssembly.Module(Buffer.from(${JSON.stringify(Buffer.from(bytes).toString("base64"))}, "base64"));`,
                              loader: "js",
                            })),
                          ),
                        ),
                      );
                      builder.onResolve(
                        { filter: /^(apps|effect|@effect\/platform-node)(\/.*)?$/ },
                        (args) => {
                          if (publishedFramework) {
                            if (args.pluginData === "selected-framework") return undefined;
                            if (args.path !== "apps" && !args.path.startsWith("apps/"))
                              return { path: args.path, external: true };
                            return builder.resolve(args.path, {
                              resolveDir: path.join(staging, "source"),
                              kind: args.kind,
                              pluginData: "selected-framework",
                            });
                          }
                          // esbuild's Promise callback is an external adapter seam. The Path
                          // service owns URL conversion; runtime operations compose Effects.
                          return Effect.runPromise(
                            Effect.sync(() => new URL(import.meta.resolve(args.path))).pipe(
                              Effect.flatMap(path.fromFileUrl),
                              Effect.map((location) => ({
                                path: location,
                                external: args.path !== "apps" && !args.path.startsWith("apps/"),
                              })),
                            ),
                          );
                        },
                      );
                      builder.onResolve({ filter: /^@executor-js\/sdk(\/.*)?$/ }, () => ({
                        errors: [{ text: "App bundles cannot import the Executor SDK" }],
                      }));
                      // Optional peers belong to the app's retained dependency tree, even
                      // when their import originates in a bundled framework helper.
                      builder.onResolve({ filter: /^[^./]/ }, (args) => {
                        const name = packageName(args.path);
                        if (!optionalPeers.has(name)) return undefined;
                        if (!Object.hasOwn(dependencies, name)) {
                          missingPeers.add(name);
                          return {
                            errors: [{ text: `Add ${name} to package.json dependencies.` }],
                          };
                        }
                        return { path: args.path, external: true };
                      });
                      // Framework-owned libraries resolve from the framework, whatever their protocol.
                      // Authored dependencies still load from the app's retained installation.
                      builder.onResolve({ filter: /^[^./]/ }, async (args) => {
                        if (
                          publishedFramework ||
                          args.pluginData === "framework-dependency" ||
                          !args.importer.startsWith(frameworkDirectory + "/")
                        )
                          return undefined;
                        const resolved = await builder.resolve(args.path, {
                          resolveDir: frameworkDirectory,
                          kind: args.kind,
                          pluginData: "framework-dependency",
                        });
                        return {
                          path: resolved.path,
                          errors: resolved.errors,
                          warnings: resolved.warnings,
                          external: true,
                        };
                      });
                      // Keep authored npm dependencies external, but let the resolver above
                      // locate framework dependencies before externalizing their absolute paths.
                      builder.onResolve({ filter: /^[^./]/ }, (args) =>
                        args.pluginData === "framework-dependency" ||
                        args.pluginData === "selected-framework"
                          ? undefined
                          : { path: args.path, external: true },
                      );
                    },
                  },
                ],
              }),
            catch: () => {
              const dependency = [...missingPeers].sort()[0];
              return dependency === undefined
                ? new RuntimeBuildFailed({ stage: "compile" })
                : new RuntimeBuildFailed({ stage: "dependencies", dependency });
            },
          }).pipe(Effect.withSpan("runtime.node.compile"));
          const url = yield* path
            .toFileUrl(path.join(staging, "app.mjs"))
            .pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "declaration" })));
          const module = yield* attempt(
            () => import(url.href),
            new RuntimeBuildFailed({ stage: "declaration" }),
          );
          const hosted = yield* Schema.decodeUnknownEffect(HostedModule)(module).pipe(
            Effect.mapError(() => new RuntimeBuildFailed({ stage: "declaration" })),
          );
          const requirements = yield* dispatch(
            hosted.default,
            { operation: "requirements" },
            {
              accounts: Redacted.make({}),
            },
            DeclaredRequirements,
            HostRequirementsError,
          ).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "declaration" })));
          const ui = yield* buildUi(staging, source, dependencies, optionalPeers);
          const result = { build, requirements, ...(ui === undefined ? {} : { ui }) };
          yield* fs.writeFileString(path.join(staging, "build.json"), JSON.stringify(result)).pipe(
            Effect.andThen(retainNodeBuild(staging, result)),
            Effect.andThen(fs.writeFileString(path.join(staging, ".executor-ready"), build)),
            Effect.andThen(fs.rename(staging, path.join(directory, build))),
            Effect.withSpan("runtime.node.retain"),
            Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })),
          );
          return result;
        }),
      ).pipe(Effect.withSpan("runtime.node.build")),
    asset: ({ build, path: assetPath }) =>
      nodeBuildAsset(build, assetPath).pipe(Effect.withSpan("runtime.node.asset")),
    skills: ({ build, ...context }) =>
      load(build).pipe(
        Effect.flatMap((handler) =>
          dispatch(handler, { operation: "skills" }, context, AppSkills, HostInspectError),
        ),
        Effect.withSpan("runtime.node.skills"),
      ),
    inspect: ({ build, ...context }) =>
      load(build)
        .pipe(
          Effect.flatMap((handler) =>
            dispatch(
              handler,
              { operation: "inspect" },
              context,
              Schema.Array(HostedTool),
              HostInspectError,
            ),
          ),
        )
        .pipe(Effect.withSpan("runtime.node.inspect")),
    query: ({ build, name, input, ...context }) =>
      load(build)
        .pipe(
          Effect.flatMap((handler) =>
            dispatch(handler, { operation: "query", name, input }, context, Json, HostDataError),
          ),
        )
        .pipe(Effect.withSpan("runtime.node.query")),
    mutate: ({ build, name, input, ...context }) =>
      load(build)
        .pipe(
          Effect.flatMap((handler) =>
            dispatch(handler, { operation: "mutate", name, input }, context, Json, HostDataError),
          ),
        )
        .pipe(Effect.withSpan("runtime.node.mutate")),
    workflow: ({ build, command, ...context }) =>
      load(build).pipe(
        Effect.flatMap((handler) => dispatch(handler, command, context, Json, HostCallError)),
        Effect.withSpan("runtime.node.workflow"),
      ),
    webhook: ({ build, command, ...context }) =>
      load(build).pipe(
        Effect.flatMap((handler) => dispatch(handler, command, context, Json, HostCallError)),
        Effect.withSpan("runtime.node.webhook"),
      ),
    call: ({ build, tool, input, ...context }) =>
      load(build)
        .pipe(
          Effect.flatMap((handler) =>
            dispatch(handler, { operation: "call", tool, input }, context, Json, HostCallError),
          ),
        )
        .pipe(Effect.withSpan("runtime.node.call")),
  };
};
