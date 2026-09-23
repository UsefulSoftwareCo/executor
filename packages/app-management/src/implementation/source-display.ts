import { Effect, Exit, Schema } from "effect";
import type { SourceFile, SourceFiles } from "@executor-js/sdk/core";
import { sourceDisplayLimits } from "../contracts/source-display.ts";

class SourceFormatUnavailable extends Schema.TaggedError<SourceFormatUnavailable>()(
  "SourceFormatUnavailable",
  {},
) {}

const jsonSource = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const formatFile = Effect.fn("source.display.format")(function* (file: SourceFile) {
  if (file.path.endsWith(".json")) {
    if (Exit.isFailure(jsonSource(file.content))) return file;
    const json = yield* Effect.promise(() => import("jsonc-parser"));
    // Whitespace edits preserve numeric literals that JSON.parse/stringify would round.
    return {
      ...file,
      content: json.applyEdits(
        file.content,
        json.format(file.content, undefined, { tabSize: 2, insertSpaces: true, eol: "\n" }),
      ),
    };
  }
  const typescript = /\.[cm]?tsx?$/.test(file.path);
  if (!typescript && !/\.[cm]?jsx?$/.test(file.path)) return file;
  // Module loading is cached by the runtime, and is never part of Worker startup.
  const [prettier, parser, printer] = yield* Effect.all(
    [
      Effect.promise(() => import("prettier/standalone")),
      typescript
        ? Effect.promise(() => import("prettier/plugins/typescript"))
        : Effect.promise(() => import("prettier/plugins/babel")),
      Effect.promise(() => import("prettier/plugins/estree")),
    ],
    { concurrency: "unbounded" },
  );
  const content = yield* Effect.tryPromise({
    try: () =>
      prettier.format(file.content, {
        parser: typescript ? "typescript" : "babel",
        filepath: file.path,
        plugins: [parser, printer],
        tabWidth: 2,
        embeddedLanguageFormatting: "off",
      }),
    catch: () => new SourceFormatUnavailable(),
  }).pipe(Effect.catchTag("SourceFormatUnavailable", () => Effect.succeed(file.content)));
  return { ...file, content };
});

/**
 * Format an authorized source response only on explicit display reads. Never write it back.
 * Invalid, unsupported, and over-budget files retain their exact original contents.
 * Sequential files bound parser memory; only the selected language's modules are loaded.
 */
export const sourceDisplay = <A extends { readonly files: SourceFiles }>(
  source: A,
  format: "display" | undefined,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    if (format === undefined) return source;
    let remaining = sourceDisplayLimits.requestBytes;
    const files = yield* Effect.forEach(source.files, (file) => {
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file.path)) return Effect.succeed(file);
      const bytes = new TextEncoder().encode(file.content).byteLength;
      if (bytes > sourceDisplayLimits.fileBytes || bytes > remaining) return Effect.succeed(file);
      remaining -= bytes;
      return formatFile(file);
    });
    return { ...source, files };
  });
