/** Browser build adapter. HTML is parsed, server imports are blocked, and all assets are retained. */
import { Effect, FileSystem, Path } from "effect";
import { build } from "esbuild";
import { prepareUiBuild, uiContentType, isBrowserAppImport, isServerUiImport } from "./ui-build.ts";
import type { UiBuildEntry, UiBuildFile } from "../contracts/ui-build.ts";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";
import type { SourceFiles } from "../contracts/deployment.ts";

/** A conventional ui/index.html opts into a frontend without evaluating server code. */
export const buildUi = (
  directory: string,
  files: SourceFiles,
  dependencies: Readonly<Record<string, string>>,
  optionalPeers: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const plan = yield* prepareUiBuild(files);
    if (plan === undefined) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = yield* fs.realPath(directory);
    const source = path.join(staging, "source");
    const output = path.join(staging, "ui");
    const framework = path.dirname(yield* path.fromFileUrl(new URL(import.meta.resolve("apps"))));
    const entries = plan.entries.map((logical) => ({
      logical,
      source: path.join(source, logical),
    }));
    const assets: UiBuildFile[] = [];
    const outputs: UiBuildEntry[] = [];
    const missingPeers = new Set<string>();
    if (entries.length > 0) {
      const result = yield* Effect.tryPromise({
        try: () =>
          build({
            absWorkingDir: staging,
            entryPoints: entries.map((e) => e.source),
            outdir: output,
            bundle: true,
            platform: "browser",
            format: "esm",
            target: "es2022",
            jsx: "automatic",
            entryNames: "[name]-[hash]",
            assetNames: "[name]-[hash]",
            splitting: true,
            metafile: true,
            write: false,
            logLevel: "silent",
            loader: { ".svg": "file", ".woff2": "file" },
            define: { "process.env.NODE_ENV": '"production"' },
            plugins: [
              {
                name: "browser-boundary",
                setup(builder) {
                  builder.onResolve({ filter: /^apps(?:\/.*)?$/ }, (args) => {
                    if (!isBrowserAppImport(args.path))
                      return { errors: [{ text: "This apps entry point is server-only." }] };
                    if (dependencies.apps !== undefined) {
                      if (args.pluginData === "resolved") return undefined;
                      return builder.resolve(args.path, {
                        kind: args.kind,
                        resolveDir: source,
                        pluginData: "resolved",
                      });
                    }
                    return Effect.runPromise(
                      path
                        .fromFileUrl(new URL(import.meta.resolve(args.path)))
                        .pipe(Effect.map((path) => ({ path }))),
                    );
                  });
                  builder.onResolve({ filter: /^[^./]/ }, async (args) => {
                    if (args.pluginData === "resolved") return undefined;
                    const name = args.path
                      .split("/")
                      .slice(0, args.path.startsWith("@") ? 2 : 1)
                      .join("/");
                    if (optionalPeers.has(name) && !Object.hasOwn(dependencies, name)) {
                      missingPeers.add(name);
                      return { errors: [{ text: `Add ${name} to package.json dependencies.` }] };
                    }
                    const frameworkImport =
                      args.importer.startsWith(framework + path.sep) &&
                      args.path !== "react" &&
                      !args.path.startsWith("react/");
                    return builder.resolve(args.path, {
                      kind: args.kind,
                      resolveDir: optionalPeers.has(name)
                        ? source
                        : frameworkImport
                          ? framework
                          : args.resolveDir,
                      pluginData: "resolved",
                    });
                  });
                  builder.onLoad({ filter: /.*/ }, (args) => {
                    if (
                      isServerUiImport(path.relative(source, args.path).split(path.sep).join("/"))
                    )
                      return {
                        errors: [
                          {
                            text: "Server app modules cannot be imported by the UI. Use type-only references and shared schemas.",
                          },
                        ],
                      };
                    return undefined;
                  });
                },
              },
            ],
          }),
        catch: () => {
          const dependency = [...missingPeers].sort()[0];
          return new RuntimeBuildFailed({
            stage: "compile",
            ...(dependency === undefined ? {} : { dependency }),
          });
        },
      });
      for (const file of result.outputFiles) {
        const relative = path.relative(output, file.path).split(path.sep).join("/");
        assets.push({ path: relative, contentType: uiContentType(relative), body: file.contents });
      }
      for (const entry of entries) {
        const emitted = Object.entries(result.metafile.outputs).find(
          ([, meta]) =>
            meta.entryPoint !== undefined &&
            path.resolve(staging, meta.entryPoint) === entry.source,
        );
        if (emitted === undefined) return yield* new RuntimeBuildFailed({ stage: "compile" });
        const url = path
          .relative(output, path.resolve(staging, emitted[0]))
          .split(path.sep)
          .join("/");
        const css =
          emitted[1].cssBundle === undefined
            ? undefined
            : path
                .relative(output, path.resolve(staging, emitted[1].cssBundle))
                .split(path.sep)
                .join("/");
        outputs.push({ source: entry.logical, path: url, ...(css === undefined ? {} : { css }) });
      }
    }
    const complete = yield* plan.finish(assets, outputs);
    for (const file of complete) {
      const destination = path.join(output, file.path);
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.writeFile(destination, file.body);
    }
    return complete.map(({ path, contentType }) => ({ path, contentType }));
  }).pipe(
    Effect.mapError((error) =>
      error instanceof RuntimeBuildFailed ? error : new RuntimeBuildFailed({ stage: "compile" }),
    ),
  );
