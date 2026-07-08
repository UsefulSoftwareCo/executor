import { build, version as esbuildVersion } from "esbuild";
import { Effect, Option, Schema } from "effect";

import { AppExecutorError } from "../executor/app-tool-executor";
import type { ToolchainRef } from "./descriptor";

const BUNDLE_TARGET = "es2022";
const FILESET_NS = "executor-apps-fileset";
const VIRTUAL_NS = "executor-apps-virtual";
const VIRTUAL_ENTRY = "executor-apps:entry";
const VIRTUAL_APP = "executor:app";

export const toolchainRef = (): ToolchainRef => ({
  bundler: { name: "esbuild", version: esbuildVersion },
  executor: { name: "in-process-data-url", version: "0.1.0" },
  target: BUNDLE_TARGET,
});

export interface BundleInput {
  readonly files: ReadonlyMap<string, string>;
  readonly entry: string;
}

export interface BundleOutput {
  readonly code: string;
}

const EsbuildDiagnostic = Schema.Struct({ text: Schema.String });
const EsbuildFailure = Schema.Struct({ errors: Schema.Array(EsbuildDiagnostic) });
const decodeEsbuildFailure = Schema.decodeUnknownOption(EsbuildFailure);

const bundleFailureMessage = (entry: string, cause: unknown): string => {
  const decoded = Option.getOrNull(decodeEsbuildFailure(cause));
  const detail = decoded?.errors.map((error) => error.text).join("; ");
  return detail ? `bundle failed for ${entry}: ${detail}` : `bundle failed for ${entry}`;
};

const resolveRelative = (base: string, rel: string): string => {
  const parts = (base ? base.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
};

const candidates = (path: string): readonly string[] =>
  /\.(tsx?|jsx?)$/.test(path)
    ? [path]
    : [
        path,
        `${path}.ts`,
        `${path}.tsx`,
        `${path}.js`,
        `${path}.jsx`,
        `${path}/index.ts`,
        `${path}/index.tsx`,
      ];

const virtualEntrySource = (authorEntry: string): string => `
import artifact from ${JSON.stringify(`/${authorEntry}`)};
export default artifact;
`;

const executorAppSource = `
const makeIntegrationDeclaration = (state) => Object.freeze({
  kind: "integration",
  slug: state.slug,
  mode: state.mode,
  ...(state.description !== undefined ? { description: state.description } : {}),
  array: () => makeIntegrationDeclaration({ ...state, mode: "many" }),
  describe: (text) => makeIntegrationDeclaration({ ...state, description: text }),
});
export const integration = (slug) =>
  makeIntegrationDeclaration({ slug, mode: "one" });
export const defineTool = (definition) => ({ ...definition, "~executorAppTool": true });
`;

const isAllowedBare = (path: string): boolean => path === "zod" || path.startsWith("zod/");

const fileSetPlugin = (files: ReadonlyMap<string, string>, authorEntry: string) => ({
  name: "executor-apps-fileset",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup(build2: any) {
    const norm = (path: string) => path.replace(/^\.\//, "").replace(/\/\.\//g, "/");
    build2.onResolve(
      { filter: /.*/ },
      (args: { path: string; importer: string; namespace?: string }) => {
        if (args.path === VIRTUAL_ENTRY) return { path: VIRTUAL_ENTRY, namespace: VIRTUAL_NS };
        if (args.path === VIRTUAL_APP) return { path: VIRTUAL_APP, namespace: VIRTUAL_NS };
        const fromFileSet = args.namespace === FILESET_NS || args.namespace === VIRTUAL_NS;
        if (!fromFileSet) return undefined;
        if (isAllowedBare(args.path)) return undefined;
        if (args.path.startsWith("/")) {
          const joined = norm(args.path.slice(1));
          for (const candidate of candidates(joined)) {
            if (files.has(candidate)) return { path: candidate, namespace: FILESET_NS };
          }
          return { errors: [{ text: `cannot resolve "${args.path}" in the app file set` }] };
        }
        if (args.path.startsWith(".")) {
          const base = args.importer.split("/").slice(0, -1).join("/");
          const joined = norm(resolveRelative(base, args.path));
          for (const candidate of candidates(joined)) {
            if (files.has(candidate)) return { path: candidate, namespace: FILESET_NS };
          }
          return {
            errors: [
              { text: `cannot resolve "${args.path}" from "${args.importer}" in the app file set` },
            ],
          };
        }
        return { errors: [{ text: `bare import "${args.path}" is not allowed` }] };
      },
    );
    build2.onLoad({ filter: /.*/, namespace: VIRTUAL_NS }, (args: { path: string }) => ({
      contents: args.path === VIRTUAL_ENTRY ? virtualEntrySource(authorEntry) : executorAppSource,
      loader: "ts",
      resolveDir: process.cwd(),
    }));
    build2.onLoad({ filter: /.*/, namespace: FILESET_NS }, (args: { path: string }) => {
      const contents = files.get(args.path);
      if (contents === undefined)
        return { errors: [{ text: `missing file in set: ${args.path}` }] };
      const loader = args.path.endsWith(".tsx")
        ? "tsx"
        : args.path.endsWith(".ts")
          ? "ts"
          : args.path.endsWith(".jsx")
            ? "jsx"
            : "js";
      return { contents, loader, resolveDir: process.cwd() };
    });
  },
});

export const bundleEntry = (input: BundleInput): Effect.Effect<BundleOutput, AppExecutorError> =>
  Effect.tryPromise({
    try: () =>
      build({
        entryPoints: [VIRTUAL_ENTRY],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        target: BUNDLE_TARGET,
        minify: false,
        treeShaking: true,
        jsx: "automatic",
        logLevel: "silent",
        plugins: [fileSetPlugin(input.files, input.entry) as never],
      }),
    catch: (cause) =>
      new AppExecutorError({
        kind: "bundle",
        message: bundleFailureMessage(input.entry, cause),
        cause,
      }),
  }).pipe(
    Effect.flatMap((result) => {
      const out = result.outputFiles?.[0]?.text;
      return out === undefined
        ? Effect.fail(
            new AppExecutorError({
              kind: "bundle",
              message: `bundle failed for ${input.entry}: esbuild produced no output`,
            }),
          )
        : Effect.succeed({ code: out });
    }),
  );
