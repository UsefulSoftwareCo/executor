/** Narrow adapter for worker-bundler's pinned esbuild plugin hook. No filesystem or Node runtime is needed. */
import { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";
import type { SourceFiles } from "../contracts/deployment.ts";
import { isBrowserAppImport, isServerUiImport, uiContentType } from "./ui-build.ts";
import type { UiBuildEntry, UiBuildFile, UiBuildPlan } from "../contracts/ui-build.ts";
import { Effect, Path, Schema } from "effect";
import type { Plugin } from "esbuild";

const Package = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const namespace = "executor-browser";

/** Collect every output because createApp 0.2.4 retains only outputFiles[0]; gate the complete browser import graph. */
export const browserBuild = (
  files: SourceFiles,
  filesystem: InMemoryFileSystem,
  plan: UiBuildPlan,
  pinnedFiles: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const manifest = files.find((file) => file.path === "package.json");
    const declarations =
      manifest === undefined
        ? {}
        : ((yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Package))(manifest.content))
            .dependencies ?? {});
    const assets: UiBuildFile[] = [];
    const outputs: UiBuildEntry[] = [];
    const root = "/executor-ui/";
    const relativeOutput = (file: string) => {
      const absolute = path.resolve("/", file);
      return absolute.startsWith(root) ? absolute.slice(root.length) : undefined;
    };
    const plugin: Plugin = {
      name: "executor-browser-build",
      setup(build) {
        const entryPoints = build.initialOptions.entryPoints;
        const entry = Array.isArray(entryPoints) ? entryPoints[0] : undefined;
        if (typeof entry !== "string" || !plan.entries.includes(entry)) return;
        delete build.initialOptions.outfile;
        Object.assign(build.initialOptions, {
          outdir: root,
          entryNames: "[name]-[hash]",
          assetNames: "[name]-[hash]",
          splitting: true,
          metafile: true,
          sourcemap: "linked",
          // Mappings identify original file/line locations without publishing
          // authored source text or tree-shaken values to every app viewer.
          sourcesContent: false,
        });
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith("node:") || args.path.startsWith("cloudflare:"))
            return { errors: [{ text: "Runtime bindings cannot be imported by the UI." }] };
          if (args.path === "apps" || args.path.startsWith("apps/")) {
            if (!isBrowserAppImport(args.path))
              return { errors: [{ text: "This apps entry point is server-only." }] };
            return {
              path: `node_modules/apps/${args.path === "apps" ? "index" : args.path.slice(5)}.js`,
              namespace,
            };
          }
          if (args.path === "react" || args.path.startsWith("react/")) {
            if (!Object.hasOwn(declarations, "react"))
              return { errors: [{ text: "Declare react in package.json dependencies." }] };
          }
          if (args.namespace === namespace && args.path.startsWith(".")) {
            const resolved = path.join(path.dirname(args.importer), args.path);
            return Object.hasOwn(pinnedFiles, resolved)
              ? { path: resolved, namespace }
              : { errors: [{ text: "Browser framework module missing." }] };
          }
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace }, (args) => {
          const contents = pinnedFiles[args.path];
          return contents === undefined
            ? { errors: [{ text: "Browser framework module missing." }] }
            : { contents, loader: "js" };
        });
        build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
          if (isServerUiImport(args.path))
            return { errors: [{ text: "Server app modules cannot be imported by the UI." }] };
          if (args.path.endsWith(".svg") || args.path.endsWith(".woff2")) {
            const contents = filesystem.read(args.path);
            return contents === null
              ? { errors: [{ text: "Browser asset missing." }] }
              : { contents, loader: "file" };
          }
          return undefined;
        });
        build.onEnd((result) => {
          if (result.errors.length > 0) return;
          const fail = () => ({
            errors: [
              { text: "Browser compilation returned invalid outputs or unresolved imports." },
            ],
          });
          if (result.outputFiles === undefined || result.metafile === undefined) return fail();
          for (const [file, metadata] of Object.entries(result.metafile.outputs)) {
            if (metadata.imports.some((item) => item.external && !/^https?:\/\//.test(item.path)))
              return fail();
            if (metadata.entryPoint !== `virtual:${entry}`) continue;
            const output = relativeOutput(file);
            const css =
              metadata.cssBundle === undefined ? undefined : relativeOutput(metadata.cssBundle);
            if (output === undefined || (metadata.cssBundle !== undefined && css === undefined))
              return fail();
            outputs.push({ source: entry, path: output, ...(css === undefined ? {} : { css }) });
          }
          for (const file of result.outputFiles) {
            const relative = relativeOutput(file.path);
            if (relative === undefined) return fail();
            assets.push({
              path: relative,
              contentType: uiContentType(relative),
              body: file.contents,
            });
          }
        });
      },
    };
    return { plugin, finish: () => plan.finish(assets, outputs) };
  }).pipe(
    Effect.provide(Path.layer),
    Effect.mapError(() => new RuntimeBuildFailed({ stage: "compile" })),
  );
