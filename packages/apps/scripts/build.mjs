import { build } from "esbuild";
import ts from "typescript-5";
import { generateFrameworkReference } from "./reference.mjs";
import { frameworkProtocol } from "../src/contracts/protocol-version.ts";
import { readFile, writeFile, mkdir, rm, readdir, copyFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = resolve(root, "..");
const out = join(root, "dist");
const packagesPrefix = packages.split("\\").join("/") + "/";
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const entries = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([key]) => !key.endsWith(".json"))
    .map(([key, source]) => [key === "." ? "index" : key.slice(2), join(root, source)]),
);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const loaded = (metafile, names, directory) => {
  const outputs = new Map(
    Object.entries(metafile.outputs).map(([file, output]) => [resolve(file), output]),
  );
  const kept = new Set();
  const visit = (file) => {
    const output = outputs.get(file);
    if (output === undefined || kept.has(file)) return;
    kept.add(file);
    for (const imported of output.imports) if (!imported.external) visit(resolve(imported.path));
  };
  for (const name of names) visit(join(directory, `${name}.js`));
  return { kept, emitted: [...outputs.keys()] };
};

const packaged = await build({
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
  metafile: true,
});
{
  const { kept, emitted } = loaded(packaged.metafile, Object.keys(entries), join(out, "js"));
  for (const file of emitted) if (!kept.has(file)) await rm(file);
}

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

const snapshotDirectory = join(out, ".framework");
const moduleName = (file) =>
  `node_modules/apps/${relative(snapshotDirectory, file.path).split("\\").join("/")}`;
const snapshot = async (names, external, sourcemap = false) => {
  const result = await build({
    entryPoints: Object.fromEntries(names.map((name) => [name, entries[name]])),
    outdir: snapshotDirectory,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    external,
    metafile: true,
    ...(sourcemap ? { sourcemap: "external", sourcesContent: false } : {}),
  });
  const { kept } = loaded(result.metafile, names, snapshotDirectory);
  return result.outputFiles.filter((file) => kept.has(file.path.replace(/\.map$/, "")));
};
const serverEntries = [
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
];
const server = Object.fromEntries(
  (await snapshot(serverEntries, [])).map((file) => [moduleName(file), file.text]),
);
await writeFile(
  join(out, "runtime.json"),
  JSON.stringify({
    protocol: frameworkProtocol,
    version: manifest.version,
    server,
    browser: Object.fromEntries(
      (await snapshot(["index", "client", "effect", "react"], ["react", "react/*"])).map((file) => [
        moduleName(file),
        file.text,
      ]),
    ),
  }),
);

const chunkNames = (text) => text.replace(/-[A-Z0-9]{8}\.js/g, ".js");
const byCode = new Map(Object.entries(server).map(([name, text]) => [chunkNames(text), name]));
const mapped = await snapshot(serverEntries, [], true);
const maps = {};
for (const file of mapped) {
  if (!file.path.endsWith(".map")) continue;
  const code = mapped.find((output) => `${output.path}.map` === file.path);
  const name = code === undefined ? undefined : byCode.get(chunkNames(code.text));
  if (name !== undefined)
    maps[name] = {
      ...JSON.parse(file.text),
      sourceRoot: `${relative(out, dirname(file.path)).split("\\").join("/")}/`,
    };
}
await writeFile(join(out, "runtime.json.map"), JSON.stringify(maps));

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
