/** Emit runtime JavaScript while preserving relative framework and asset paths. */
import { Effect, FileSystem, Path, type PlatformError } from "effect";
import ts from "typescript";

/** Compile source modules and copy resources; never include tests or declaration-only files. */
export const emit = (
  source: string,
  destination: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const name of yield* fs.readDirectory(source)) {
      if (name.endsWith(".d.ts") || name.endsWith(".test.ts") || name.endsWith(".types.ts"))
        continue;
      const from = path.join(source, name);
      const stat = yield* fs.stat(from);
      if (stat.type === "Directory") yield* emit(from, path.join(destination, name));
      else if (/\.tsx?$/.test(name)) {
        const contents = yield* fs.readFileString(from);
        const compiled = ts.transpileModule(contents, {
          fileName: from,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
            rewriteRelativeImportExtensions: true,
          },
        });
        // JSON imports need attributes under Node. The source uses bundler resolution.
        const withAttributes = compiled.outputText.replace(
          /(from\s+["'][^"']+\.json["'])(\s*;)/g,
          '$1 with { type: "json" }$2',
        );
        yield* fs.writeFileString(
          path.join(destination, name.replace(/\.tsx?$/, ".js")),
          withAttributes,
        );
      } else yield* fs.copyFile(from, path.join(destination, name));
    }
  });
