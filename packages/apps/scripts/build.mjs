/** Stage a standalone npm package. Workspace dependencies are included in its JS and declarations. */
import { build } from "esbuild";
import ts from "typescript";
import { generateFrameworkReference } from "./reference.mjs";
import { readFile, writeFile, mkdir, rm, readdir, copyFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = resolve(root, "..");
const out = join(root, "dist");
// TypeScript reports source file names with POSIX separators on every platform.
const packagesPrefix = packages.split("\\").join("/") + "/";
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const entries = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([key]) => !key.endsWith(".json"))
    .map(([key, source]) => [key === "." ? "index" : key.slice(2), join(root, source)]),
);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Keep a single shared Effect instance across entry points. Optional protocols
// remain external so importing the root never requires their peer packages.
await build({
  entryPoints: entries,
  outdir: join(out, "js"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["module"],
  external: ["node:*", ...Object.keys(manifest.peerDependencies)],
});

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  declaration: true,
  emitDeclarationOnly: true,
  allowImportingTsExtensions: true,
  rootDir: packages,
  outDir: join(out, "types"),
};
const graph = ts.createProgram(Object.values(entries), compilerOptions);
const program = ts.createProgram(
  graph
    .getSourceFiles()
    .filter(
      (file) =>
        !file.isDeclarationFile &&
        file.fileName.startsWith(packagesPrefix) &&
        !file.fileName.includes("/node_modules/"),
    )
    .map((file) => file.fileName),
  compilerOptions,
);
const emitted = program.emit();
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
if (diagnostics.length > 0) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }),
  );
}

await writeFile(
  join(out, "framework-reference.json"),
  JSON.stringify(await generateFrameworkReference()),
);

// Internal package declarations travel with apps; consumers never need private
// workspace packages. Relative .js specifiers work with NodeNext and bundlers.
async function declarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await declarations(file);
      continue;
    }
    const content = await readFile(file, "utf8");
    const specifiers = [
      ...content.matchAll(/(?:from\s*|import\s*\(\s*)["'](@executor-js\/[^"']+)["']/g),
    ];
    let rewritten = content;
    for (const [, specifier] of specifiers) {
      const source = await realpath(fileURLToPath(import.meta.resolve(specifier)));
      if (!source.startsWith(packages + sep))
        throw new Error(`Unbundled declaration: ${specifier}`);
      const target = join(out, "types", relative(packages, source)).replace(/\.ts$/, ".js");
      let local = relative(dirname(file), target).split("\\").join("/");
      if (!local.startsWith(".")) local = "./" + local;
      rewritten = rewritten.replaceAll(`"${specifier}"`, JSON.stringify(local));
    }
    rewritten = rewritten.replace(
      /((?:from\s*|import\s*\(\s*)["'][.][^"']*)\.ts(["'])/g,
      "$1.js$2",
    );
    await writeFile(file, rewritten);
  }
}
await declarations(join(out, "types"));

// Worker hosts retain these ready-to-link modules with each deployment. They
// include runtime dependencies and do not execute npm package scripts.
const snapshot = async (names, external) => {
  const directory = join(out, ".framework");
  const result = await build({
    entryPoints: Object.fromEntries(names.map((name) => [name, entries[name]])),
    outdir: directory,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    external,
  });
  return Object.fromEntries(
    result.outputFiles.map((file) => [
      `node_modules/apps/${relative(directory, file.path).split("\\").join("/")}`,
      file.text,
    ]),
  );
};
await writeFile(
  join(out, "runtime.json"),
  JSON.stringify({
    protocol: 1,
    version: manifest.version,
    server: await snapshot(
      [
        "index",
        "host",
        "storage/facet",
        "contracts",
        "mcp",
        "graphql",
        "openapi",
        "skills",
        "skills/effect",
        "operations/approval",
      ],
      [],
    ),
    browser: await snapshot(["index", "client", "effect", "react"], ["react", "react/*"]),
  }),
);

const exports = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([key]) => !key.endsWith(".json"))
    .map(([key, source]) => [
      key,
      {
        types: `./types/apps/${source.slice(2).replace(/\.ts$/, ".d.ts")}`,
        import: `./js/${key === "." ? "index" : key.slice(2)}.js`,
      },
    ]),
);
await writeFile(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      type: "module",
      sideEffects: false,
      exports: {
        ...exports,
        "./package.json": "./package.json",
        "./runtime.json": "./runtime.json",
        "./framework-reference.json": "./framework-reference.json",
      },
      files: [
        "js",
        "types",
        "runtime.json",
        "framework-reference.json",
        "check-publish.mjs",
        "README.md",
      ],
      dependencies: {
        effect: manifest.dependencies.effect,
        "@effect/sql-sqlite-do": manifest.dependencies["@effect/sql-sqlite-do"],
        "@cloudflare/workers-types": manifest.devDependencies["@cloudflare/workers-types"],
      },
      peerDependencies: manifest.peerDependencies,
      peerDependenciesMeta: manifest.peerDependenciesMeta,
      publishConfig: { access: "public", tag: "beta" },
      scripts: { prepublishOnly: "node check-publish.mjs" },
    },
    null,
    2,
  ) + "\n",
);
await copyFile(join(root, "README.md"), join(out, "README.md"));
await copyFile(join(root, "scripts/check-publish.mjs"), join(out, "check-publish.mjs"));
console.log(`Built ${manifest.name}@${manifest.version} in ${out}`);
