import { Data, Effect, FileSystem, Path, Schema } from "effect";
import ts from "typescript-5";

class SavePathFailed extends Data.TaggedError("SavePathFailed")<{ readonly message: string }> {}

const roots = [
  "apps/hosted/server/src/implementation/api.ts",
  "apps/hosted/cloud/src/main.ts",
  "apps/hosted/server/src/implementation/accounts.ts",
  "apps/hosted/server/src/implementation/app-account-links.ts",
  "apps/hosted/server/src/implementation/app-accounts.ts",
  "packages/sdk/src/implementation/storage-schema.ts",
  "packages/sdk/src/implementation/storage-migrations.ts",
];
const schemaDirectory = "apps/hosted/server/src/implementation";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    exports: Schema.optional(
      Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
    ),
  }),
);
const Workspaces = Schema.fromJsonString(
  Schema.Struct({ workspaces: Schema.Array(Schema.String) }),
);

const exportTarget = (target: unknown): string | undefined =>
  typeof target === "string"
    ? target
    : typeof target === "object" && target !== null
      ? exportTarget(
          (target as Record<string, unknown>)["source"] ??
            (target as Record<string, unknown>)["import"] ??
            (target as Record<string, unknown>)["default"],
        )
      : undefined;

const parsed = /\.(?:[cm]?[jt]sx?)$/;

const importsOf = (file: string, text: string) => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith("x")
      ? ts.ScriptKind.TSX
      : /\.[cm]?js$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS,
  );
  const errors = (source as unknown as { readonly parseDiagnostics?: ReadonlyArray<ts.Diagnostic> })
    .parseDiagnostics;
  if (errors === undefined || errors.length > 0)
    return new SavePathFailed({
      message: `TypeScript cannot parse ${file}, so e2e/save-path.ts cannot read its imports: ${
        errors === undefined
          ? "this TypeScript reports no parse diagnostics"
          : errors
              .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "))
              .join("; ")
      }`,
    });
  return ts.preProcessFile(text, true, true).importedFiles.map((imported) => imported.fileName);
};

export const closureOf = (root: string, entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isFile = (file: string) =>
      Effect.gen(function* () {
        const absolute = path.join(root, file);
        return (yield* fs.exists(absolute)) && (yield* fs.stat(absolute)).type === "File";
      });
    const packages = new Map<string, { directory: string; exports: Map<string, string> }>();
    for (const pattern of (yield* fs
      .readFileString(path.join(root, "package.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Workspaces)))).workspaces) {
      const directories = pattern.endsWith("/*")
        ? (yield* fs.readDirectory(path.join(root, pattern.slice(0, -2)))).map(
            (name) => `${pattern.slice(0, -2)}/${name}`,
          )
        : [pattern];
      for (const directory of directories) {
        if (!(yield* fs.exists(path.join(root, directory, "package.json")))) continue;
        const manifest = yield* fs
          .readFileString(path.join(root, directory, "package.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));
        const exports = new Map<string, string>();
        const entries =
          manifest.exports === undefined
            ? []
            : typeof manifest.exports === "string"
              ? [[".", manifest.exports] as const]
              : Object.entries(manifest.exports);
        for (const [subpath, target] of entries) {
          const file = exportTarget(target);
          if (file !== undefined) exports.set(subpath, path.normalize(path.join(directory, file)));
        }
        packages.set(manifest.name, { directory, exports });
      }
    }
    const resolve = (from: string, specifier: string) =>
      Effect.gen(function* () {
        if (specifier.startsWith(".")) {
          const base = path.normalize(path.join(path.dirname(from), specifier));
          if (base.split("/").includes(".generated")) return undefined;
          for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")])
            if (yield* isFile(candidate)) return candidate;
          unresolved.push(`${from}: ${specifier}`);
          return undefined;
        }
        const parts = specifier.split("/");
        const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
        const workspace = packages.get(name);
        if (workspace === undefined) return undefined;
        const subpath = `.${specifier.slice(name.length)}`;
        const exact = workspace.exports.get(subpath);
        const wildcard = [...workspace.exports].flatMap(([key, target]) => {
          const star = key.indexOf("*");
          if (star === -1) return [];
          const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
          if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return [];
          return [
            target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length)),
          ];
        })[0];
        const file = exact ?? wildcard;
        if (file !== undefined && (yield* isFile(file))) return file;
        unresolved.push(`${from}: ${specifier}`);
        return undefined;
      });
    const found = new Set<string>();
    const unresolved: Array<string> = [];
    let round = [...new Set(entries)];
    while (round.length > 0) {
      for (const file of round) {
        if (!(yield* isFile(file)))
          return yield* new SavePathFailed({
            message: `${file}, which e2e/save-path.ts follows, does not exist. Update its roots.`,
          });
        found.add(file);
      }
      const next = new Set<string>();
      for (const file of round.filter((candidate) => parsed.test(candidate))) {
        const specifiers = importsOf(file, yield* fs.readFileString(path.join(root, file)));
        if (specifiers instanceof SavePathFailed) return yield* specifiers;
        for (const specifier of specifiers) {
          const resolved = yield* resolve(file, specifier);
          if (resolved !== undefined && !found.has(resolved)) next.add(resolved);
        }
      }
      round = [...next];
    }
    if (unresolved.length > 0)
      return yield* new SavePathFailed({
        message: `e2e/save-path.ts cannot follow these imports of the repository's own files, so a change behind them would not select the save scenarios: ${unresolved.join(", ")}. Resolve them in e2e/save-path.ts.`,
      });
    return found as ReadonlySet<string>;
  });

export const savePathFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))));
  const schemas = (yield* fs.readDirectory(path.join(root, schemaDirectory)))
    .filter((name) => name.endsWith("-schema.ts"))
    .map((name) => `${schemaDirectory}/${name}`);
  return yield* closureOf(root, [...roots, ...schemas]);
});
