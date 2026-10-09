/** Narrow adapter for worker-bundler's pinned esbuild plugin hook. No filesystem or Node runtime is needed. */
import { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { boundBuildMessage, describeBuildCause, RuntimeBuildFailed } from "../contracts/runtime.ts";
import type { SourceFiles } from "../contracts/deployment.ts";
import { isBrowserAppImport, isServerUiImport, uiContentType } from "./ui-build.ts";
import type { UiBuildEntry, UiBuildFile, UiBuildPlan } from "../contracts/ui-build.ts";
import { Effect, Option, Path, Schema } from "effect";
import type { Plugin } from "esbuild";
import { compileUiTailwind } from "./ui-tailwind.ts";

const Package = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const namespace = "executor-browser";
const assetUrl = "executor-asset-url";
const scriptImports = new Set(["import-statement", "dynamic-import", "require-call"]);
const browserAsset = /\.(?:svg|woff2)$/;
/** Metafile inputs carry their plugin namespace, as in `virtual:node_modules/react/index.js`. */
const packageInput = (input: string) =>
  input.slice(input.indexOf(":") + 1).startsWith("node_modules/");
const sourceMapComment = /\n\/\/# sourceMappingURL=[^\n]*\n?$/;
const decodeAssetWrapper = Schema.decodeUnknownOption(
  Schema.Struct({ namespace: Schema.String, commonjs: Schema.Boolean }),
);

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
        // A file-loader URL is relative to the asset root, which is not the page's URL. Script
        // imports receive it resolved against their own module instead; CSS urls already are.
        // Package specifiers are classified by the file they resolve to. `require` receives the
        // URL string itself, as it did from the file loader.
        build.onResolve({ filter: /.*/, namespace: assetUrl }, (args) => {
          const wrapped = decodeAssetWrapper(args.pluginData);
          if (Option.isNone(wrapped)) return { errors: [{ text: "Browser asset missing." }] };
          return wrapped.value.commonjs
            ? {
                path: args.path,
                namespace: assetUrl,
                pluginData: { namespace: wrapped.value.namespace, commonjs: false },
              }
            : { path: args.path, namespace: wrapped.value.namespace };
        });
        build.onResolve({ filter: /^[^./]|\.(?:svg|woff2)$/ }, async (args) => {
          if (
            args.pluginData === assetUrl ||
            args.namespace === namespace ||
            !scriptImports.has(args.kind)
          )
            return undefined;
          const file = await build.resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
            pluginData: assetUrl,
          });
          if (file.errors.length > 0) return { errors: file.errors };
          if (file.external || !browserAsset.test(file.path))
            return {
              path: file.path,
              namespace: file.namespace,
              external: file.external,
              sideEffects: file.sideEffects,
              suffix: file.suffix,
              pluginData: file.pluginData,
              warnings: file.warnings,
            };
          const commonjs = args.kind === "require-call";
          return {
            path: file.path,
            namespace: assetUrl,
            ...(commonjs ? { suffix: "?commonjs" } : {}),
            pluginData: { namespace: file.namespace, commonjs },
            warnings: file.warnings,
          };
        });
        build.onLoad({ filter: /.*/, namespace: assetUrl }, (args) => {
          const wrapped = decodeAssetWrapper(args.pluginData);
          if (Option.isNone(wrapped)) return { errors: [{ text: "Browser asset missing." }] };
          const file = JSON.stringify(args.path);
          return {
            contents: wrapped.value.commonjs
              ? `module.exports = require(${file}).default;\n`
              : `import file from ${file};\nexport default new URL(file, import.meta.url).href;\n`,
            loader: "js",
            pluginData: wrapped.value,
          };
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
          if (browserAsset.test(args.path)) {
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
          // A chunk built only from installed packages keeps no source map: mapping vendor
          // code locates nothing in the app, and the maps were most of a large build's assets.
          const packageChunks = new Set(
            Object.entries(result.metafile.outputs)
              .filter(
                ([file, metadata]) =>
                  file.endsWith(".js") &&
                  Object.keys(metadata.inputs).length > 0 &&
                  Object.keys(metadata.inputs).every(packageInput),
              )
              .map(([file]) => path.resolve("/", file)),
          );
          for (const file of result.outputFiles) {
            const absolute = path.resolve("/", file.path);
            if (absolute.endsWith(".map") && packageChunks.has(absolute.slice(0, -4))) continue;
            const relative = relativeOutput(file.path);
            if (relative === undefined) return fail();
            assets.push({
              path: relative,
              contentType: uiContentType(relative),
              body: packageChunks.has(absolute)
                ? new TextEncoder().encode(file.text.replace(sourceMapComment, "\n"))
                : file.contents,
            });
          }
        });
      },
    };
    return {
      plugin,
      finish: () =>
        compileUiTailwind(
          assets,
          plan.html,
          Effect.tryPromise(() => import("tailwindcss-iso/oxide.wasm")).pipe(
            Effect.map((module) => module.default),
          ),
        ).pipe(Effect.flatMap((compiled) => plan.finish(compiled, outputs))),
    };
  }).pipe(
    Effect.provide(Path.layer),
    Effect.mapError((cause) =>
      Schema.is(RuntimeBuildFailed)(cause)
        ? cause
        : new RuntimeBuildFailed({
            stage: "compile",
            message: boundBuildMessage(`The app UI failed to build: ${describeBuildCause(cause)}`),
          }),
    ),
  );
