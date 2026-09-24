import { Effect, Exit, Schema } from "effect";
import { SourceError, type SourceFile, type SourceFiles } from "@executor-js/sdk/core";
import {
  sourceDisplayInlineLimits,
  sourceDisplayLimits,
  type SourceDisplayEntries,
  type SourceDisplayEntry,
  type SourceDisplayFile,
} from "../contracts/source-display.ts";

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
const formatFile = Effect.fn("source.display.format")(function* (file: SourceFile) {
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

const byteSize = (content: string) => new TextEncoder().encode(content).byteLength;

/**
 * List an authorized source response for read-only display. Never write it back.
 * Every file keeps its path and stored size. Only files within the inline budget carry
 * contents, and only those are formatted. The inline budget bounds parser work;
 * sequential files bound parser memory.
 */
export const sourceDisplay = <A extends { readonly files: SourceFiles }>(
  source: A,
): Effect.Effect<Omit<A, "files"> & { readonly files: typeof SourceDisplayEntries.Type }> =>
  Effect.gen(function* () {
    let remaining = sourceDisplayInlineLimits.requestBytes;
    const entry = (file: SourceFile): Effect.Effect<SourceDisplayEntry> => {
      const size = byteSize(file.content);
      if (size > sourceDisplayInlineLimits.fileBytes || size > remaining)
        return Effect.succeed({ path: file.path, size });
      remaining -= size;
      return formatFile(file).pipe(
        Effect.map(({ content }) => ({ path: file.path, size, content })),
      );
    };
    const [first, ...rest] = source.files;
    return {
      ...source,
      files: [yield* entry(first), ...(yield* Effect.forEach(rest, entry))],
    };
  });

/**
 * Display one file from an immutable source. Invalid, unsupported, and over-budget files
 * retain their exact original contents.
 */
export const sourceDisplayFile = (
  files: SourceFiles,
  path: string,
): Effect.Effect<SourceDisplayFile, SourceError> =>
  Effect.gen(function* () {
    const file = files.find((file) => file.path === path);
    if (file === undefined) return yield* new SourceError({ reason: "not-found" });
    const size = byteSize(file.content);
    const { content } = size <= sourceDisplayLimits.fileBytes ? yield* formatFile(file) : file;
    return { path: file.path, size, content };
  });
