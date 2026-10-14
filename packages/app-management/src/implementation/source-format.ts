/**
 * Display formatting with Prettier and jsonc-parser. Their parsers are about 1.5 MB of
 * JavaScript, so a host whose every uploaded module costs startup time runs this elsewhere.
 */
import { Effect, Exit, Layer, Schema } from "effect";
import type { SourceTextFile } from "@executor-js/sdk/core";
import { SourceFormatter } from "../contracts/source-display.ts";

class SourceFormatUnavailable extends Schema.TaggedError<SourceFormatUnavailable>()(
  "SourceFormatUnavailable",
  {},
) {}

const jsonSource = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
/**
 * Apply non-overlapping formatter edits in one pass. jsonc-parser's applyEdits rebuilds the
 * whole string per edit, which costs hundreds of milliseconds on a large single-line file.
 */
const applyEdits = (
  text: string,
  edits: ReadonlyArray<{ offset: number; length: number; content: string }>,
) => {
  const parts: Array<string> = [];
  let position = 0;
  for (const edit of [...edits].sort((a, b) => a.offset - b.offset)) {
    parts.push(text.slice(position, edit.offset), edit.content);
    position = edit.offset + edit.length;
  }
  parts.push(text.slice(position));
  return parts.join("");
};
const formatFile = Effect.fn("source.display.format")(function* (file: SourceTextFile) {
  if (file.path.endsWith(".json")) {
    if (Exit.isFailure(jsonSource(file.content))) return file;
    const json = yield* Effect.promise(() => import("jsonc-parser"));
    // Whitespace edits preserve numeric literals that JSON.parse/stringify would round.
    const edits = json.format(file.content, undefined, {
      tabSize: 2,
      insertSpaces: true,
      eol: "\n",
    });
    return { ...file, content: applyEdits(file.content, edits) };
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

/** Format files in order, one at a time, so parser memory stays bounded by the largest file. */
export const formatSources = (files: ReadonlyArray<SourceTextFile>) =>
  Effect.forEach(files, formatFile);

/** Format in this process. */
export const localSourceFormatter = Layer.succeed(
  SourceFormatter,
  SourceFormatter.of({ format: formatSources }),
);
