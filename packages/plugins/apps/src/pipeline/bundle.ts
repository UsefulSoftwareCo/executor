import { build, version as esbuildVersion } from "esbuild";

import { Effect } from "effect";

import { ToolSandboxError } from "../seams/tool-sandbox";
import type { ToolchainRef } from "./descriptor";

const BUNDLE_TARGET = "es2022";

/** The toolchain (esbuild version + target) recorded into the descriptor so a
 *  re-collect on a different esbuild is not falsely claimed byte-identical. */
export const toolchainRef = (): ToolchainRef => ({
  bundler: "esbuild",
  bundlerVersion: esbuildVersion,
  target: BUNDLE_TARGET,
});

// ---------------------------------------------------------------------------
// bundle — the FDI pipeline's bundle stage.
//
// One esbuild pass per artifact entry. The platform module (`executor:app`)
// stays EXTERNAL, the sandbox shim provides the real behavior. A small allowlist
// of schema libraries (`zod`) is INLINED from node_modules so the author's
// schema runs in the sandbox and exposes the Standard Schema JSON-schema
// extension. Every other bare import is rejected with a diagnostic: npm deps in
// user bundles are out of scope.
//
// Output is a single CJS string with the externals left as `require(...)`
// calls the sandbox resolves.
// ---------------------------------------------------------------------------

/** Modules the platform provides inside the sandbox (kept external, resolved by
 *  the sandbox `require` shim). */
export const PLATFORM_MODULES = new Set<string>(["executor:app"]);

/** npm modules we deliberately inline (schema runtime that must run in the
 *  sandbox). Everything else bare is rejected. */
export const INLINABLE_MODULES = new Set<string>(["zod"]);

const isInlinable = (path: string): boolean => {
  if (INLINABLE_MODULES.has(path)) return true;
  // zod subpaths (`zod/v4`, `zod/mini`) are fine too.
  return [...INLINABLE_MODULES].some((m) => path === m || path.startsWith(`${m}/`));
};

export interface BundleInput {
  readonly files: ReadonlyMap<string, string>;
  readonly entry: string;
}

export interface BundleOutput {
  readonly code: string;
}

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

const candidates = (path: string): string[] => {
  if (/\.(tsx?|jsx?)$/.test(path)) return [path];
  return [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.jsx`,
    `${path}/index.ts`,
    `${path}/index.tsx`,
  ];
};

const FILESET_NS = "fileset";
const VIRTUAL_ENTRY = "executor-apps://entry";

/** The virtual entry esbuild starts from: re-export the author entry. */
const virtualEntrySource = (authorEntry: string) => `
import __artifactModule from ${JSON.stringify(`/${authorEntry}`)};
globalThis.__artifact = __artifactModule;
`;

const fileSetPlugin = (files: ReadonlyMap<string, string>, authorEntry: string) => ({
  name: "executor-apps-fileset",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup(build2: any) {
    const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/\.\//g, "/");

    build2.onResolve(
      { filter: /.*/ },
      (args: { path: string; importer: string; namespace?: string; resolveDir?: string }) => {
        if (args.path === VIRTUAL_ENTRY) {
          return { path: VIRTUAL_ENTRY, namespace: "virtual" };
        }
        // Imports originating OUTSIDE the file set (from inlined npm modules
        // like zod, or the virtual entry's `import "zod"`) are left to
        // esbuild's default node resolution. We only govern file-set imports.
        const fromFileSet = args.namespace === FILESET_NS || args.namespace === "virtual";
        if (!fromFileSet) return undefined;

        if (PLATFORM_MODULES.has(args.path)) {
          return { path: args.path, external: true };
        }
        if (isInlinable(args.path)) {
          // Inline from node_modules via default resolution.
          return undefined;
        }
        // Absolute (virtual entry uses `/tools/x.ts`) or relative -> file set.
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
        return {
          errors: [
            {
              text: `bare import "${args.path}" is not allowed: apps may only import platform modules (${[...PLATFORM_MODULES].join(", ")}), the schema runtime (zod), or files within the scope`,
            },
          ],
        };
      },
    );

    build2.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
      contents: virtualEntrySource(authorEntry),
      loader: "ts",
      resolveDir: process.cwd(),
    }));

    build2.onLoad({ filter: /.*/, namespace: FILESET_NS }, (args: { path: string }) => {
      const contents = files.get(args.path);
      if (contents === undefined) {
        return { errors: [{ text: `missing file in set: ${args.path}` }] };
      }
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

/** Bundle one entry from the file set to a single CJS string. */
export const bundleEntry = (input: BundleInput): Effect.Effect<BundleOutput, ToolSandboxError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await build({
        entryPoints: [VIRTUAL_ENTRY],
        bundle: true,
        write: false,
        format: "cjs",
        platform: "neutral",
        target: BUNDLE_TARGET,
        minify: false,
        treeShaking: true,
        jsx: "automatic",
        logLevel: "silent",
        external: [...PLATFORM_MODULES],
        plugins: [fileSetPlugin(input.files, input.entry) as never],
      });
      const out = result.outputFiles?.[0]?.text;
      if (out === undefined) throw new Error("esbuild produced no output");
      return { code: out };
    },
    catch: (cause) =>
      new ToolSandboxError({
        kind: "bundle",
        message: `bundle failed for ${input.entry}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
