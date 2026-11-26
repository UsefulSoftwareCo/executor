import { Array as Arr, Effect } from "effect";
import {
  SourceError,
  isTextFile,
  sourceFileBytes,
  type SourceFiles,
  type SourceTextFile,
} from "@executor-js/sdk/core";
import {
  SourceFormatter,
  sourceDisplayInlineLimits,
  sourceDisplayLimits,
  type SourceDisplayEntries,
  type SourceDisplayEntry,
  type SourceDisplayFile,
} from "../contracts/source-display.ts";

const byteSize = (content: string) => new TextEncoder().encode(content).byteLength;

const formatted = (files: ReadonlyArray<SourceTextFile>) =>
  (files.length === 0
    ? Effect.succeed(files)
    : Effect.flatMap(SourceFormatter, (formatter) => formatter.format(files))
  ).pipe(Effect.map((files) => new Map(files.map((file) => [file.path, file.content]))));

const formattedContent = (contents: ReadonlyMap<string, string>, file: SourceTextFile) => {
  const content = contents.get(file.path);
  return content === undefined
    ? Effect.die(new Error(`Source formatter omitted ${file.path}`))
    : Effect.succeed(content);
};

export const sourceDisplay = <A extends { readonly files: SourceFiles }>(
  source: A,
): Effect.Effect<
  Omit<A, "files"> & { readonly files: typeof SourceDisplayEntries.Type },
  never,
  SourceFormatter
> =>
  Effect.gen(function* () {
    let remaining = sourceDisplayInlineLimits.requestBytes;
    const listed = Arr.map(source.files, (file) => {
      const size = sourceFileBytes(file);
      const text = isTextFile(file) ? file : undefined;
      const inline =
        text !== undefined && size <= sourceDisplayInlineLimits.fileBytes && size <= remaining;
      if (inline) remaining -= size;
      return { file, text, size, inline };
    });
    const contents = yield* formatted(
      listed.flatMap(({ text, inline }) => (inline && text !== undefined ? [text] : [])),
    );
    const entry = ({ file, text, size, inline }: (typeof listed)[number]) =>
      text === undefined
        ? Effect.succeed<SourceDisplayEntry>({ path: file.path, size, binary: true })
        : inline
          ? formattedContent(contents, text).pipe(
              Effect.map((content): SourceDisplayEntry => ({ path: file.path, size, content })),
            )
          : Effect.succeed<SourceDisplayEntry>({ path: file.path, size });
    const [first, ...rest] = listed;
    return {
      ...source,
      files: [yield* entry(first), ...(yield* Effect.forEach(rest, entry))],
    };
  });

export const sourceDisplayFile = (
  files: SourceFiles,
  path: string,
): Effect.Effect<SourceDisplayFile, SourceError, SourceFormatter> =>
  Effect.gen(function* () {
    const file = files.find((file) => file.path === path);
    if (file === undefined) return yield* new SourceError({ reason: "not-found" });
    if (!isTextFile(file)) return { path: file.path, size: sourceFileBytes(file), binary: true };
    const size = byteSize(file.content);
    const content =
      size <= sourceDisplayLimits.fileBytes
        ? yield* formattedContent(yield* formatted([file]), file)
        : file.content;
    return { path: file.path, size, content };
  });
