/**
 * The apps CLI's view of a source directory. Code is read as UTF-8 text; files under `ui/public/`
 * may be any bytes and are read only when they are sent. A source that fits one request is sent
 * as files; a larger one is pushed with Git.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import {
  SourceError,
  SourceFile,
  SourceFilePath,
  encodeBase64,
  gitBlobId,
  inlineBytes,
  isPublicSourcePath,
  publicFileLimits,
  publicSourcePrefix,
  removedPaths,
  sourceLimits,
  type SourceFiles,
} from "@executor-js/sdk/core";
import { pushTree, type PushFile } from "@executor-js/app-source/git-client";
import { SourceRejected } from "../client-error.ts";

/** One file of a local source. `text` holds code files, which must be UTF-8. */
export interface LocalFile {
  readonly path: string;
  readonly size: number;
  readonly text?: string | undefined;
  readonly read: Effect.Effect<Uint8Array, SourceError>;
}

export const ignoredSource = [".git", "node_modules", ".DS_Store"];
export const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`
    : bytes >= 1024
      ? `${Number((bytes / 1024).toFixed(1))} KiB`
      : `${bytes} bytes`;
export const formatCount = (count: number) => count.toLocaleString("en-US");
/** At most this many paths are named in a refusal; the count says how many there are. */
const namedPaths = 20;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decodeText = (bytes: Uint8Array) =>
  Effect.try({ try: () => utf8.decode(bytes), catch: () => "binary" as const }).pipe(Effect.option);

const largest = (files: ReadonlyArray<{ readonly path: string; readonly size: number }>) =>
  files.toSorted((left, right) => right.size - left.size).slice(0, 10);
const listed = (files: ReadonlyArray<{ readonly path: string; readonly size: number }>) =>
  files.map((file) => `${file.path} (${formatBytes(file.size)})`).join(", ");

/**
 * Check a source against what every host accepts, before anything is read or sent. Code
 * (everything outside ui/public/) is held in memory by saves and builds and stays within
 * `sourceLimits`; public files are served as they are and stay within `publicFileLimits`.
 */
const withinLimits = (files: ReadonlyArray<{ readonly path: string; readonly size: number }>) => {
  const code = files.filter((file) => !isPublicSourcePath(file.path));
  const served = files.filter((file) => isPublicSourcePath(file.path));
  const fail = (reason: "files" | "bytes", detail: string, paths: ReadonlyArray<string>) =>
    Effect.fail(new SourceRejected({ reason, detail, paths: [...paths] }));
  if (code.length > sourceLimits.files)
    return fail(
      "files",
      `The source has ${formatCount(code.length)} files; Executor accepts at most ${formatCount(sourceLimits.files)}. That limit counts code, every file outside ${publicSourcePrefix}; files under ${publicSourcePrefix} have their own. The CLI already skips ${ignoredSource.join(", ")}; remove generated or unneeded files, or move files the page serves as they are into ${publicSourcePrefix}.`,
      [],
    );
  const codeBytes = code.reduce((sum, file) => sum + file.size, 0);
  if (codeBytes > sourceLimits.bytes)
    return fail(
      "bytes",
      `The code outside ${publicSourcePrefix} holds ${formatBytes(codeBytes)} (${formatCount(codeBytes)} bytes); Executor accepts at most ${formatBytes(sourceLimits.bytes)} (${formatCount(sourceLimits.bytes)} bytes). The largest files: ${listed(largest(code))}. Files the page serves as they are belong in ${publicSourcePrefix}, which has its own limits.`,
      largest(code).map((file) => file.path),
    );
  if (served.length > publicFileLimits.files)
    return fail(
      "files",
      `The source has ${formatCount(served.length)} files under ${publicSourcePrefix}; Executor accepts at most ${formatCount(publicFileLimits.files)}.`,
      [],
    );
  const oversized = served.filter((file) => file.size > publicFileLimits.fileBytes);
  if (oversized.length > 0)
    return fail(
      "bytes",
      `${formatCount(oversized.length)} ${oversized.length === 1 ? "file is" : "files are"} larger than ${formatCount(publicFileLimits.fileBytes)} bytes, the most one file under ${publicSourcePrefix} may hold: ${listed(oversized.slice(0, namedPaths))}.`,
      oversized.slice(0, namedPaths).map((file) => file.path),
    );
  const servedBytes = served.reduce((sum, file) => sum + file.size, 0);
  if (servedBytes > publicFileLimits.bytes)
    return fail(
      "bytes",
      `The files under ${publicSourcePrefix} hold ${formatBytes(servedBytes)}; Executor accepts at most ${formatCount(publicFileLimits.bytes)} bytes. The largest files: ${listed(largest(served))}.`,
      largest(served).map((file) => file.path),
    );
  return Effect.void;
};

const invalid = (detail: string) => new SourceRejected({ reason: "invalid", detail, paths: [] });

/** A source must name canonical, unique paths and a root index.ts. */
const checkPaths = (files: ReadonlyArray<{ readonly path: string }>) =>
  Effect.gen(function* () {
    for (const file of files)
      if (!Schema.is(SourceFilePath)(file.path))
        return yield* invalid(`${JSON.stringify(file.path)} is not a valid source path.`);
    if (new Set(files.map((file) => file.path)).size !== files.length)
      return yield* invalid("The files are not a valid app source: expected unique paths.");
    if (!files.some((file) => file.path === "index.ts"))
      return yield* invalid("The files are not a valid app source: expected a root index.ts.");
  });

const binaryCode = (files: ReadonlyArray<LocalFile>) =>
  Effect.gen(function* () {
    const binary = files.filter(
      (file) => !isPublicSourcePath(file.path) && file.text === undefined,
    );
    if (binary.length > 0)
      return yield* new SourceRejected({
        reason: "binary",
        detail: `Executor stores code as UTF-8 text, and ${formatCount(binary.length)} ${binary.length === 1 ? "file is" : "files are"} not: ${binary
          .slice(0, namedPaths)
          .map((file) => file.path)
          .join(
            ", ",
          )}${binary.length > namedPaths ? `, and ${formatCount(binary.length - namedPaths)} more` : ""}. Only files under ${publicSourcePrefix} may be binary: move files the page serves as they are there.`,
        paths: binary.slice(0, namedPaths).map((file) => file.path),
      });
  });

/**
 * Read a JSON source list, or every file under a directory with POSIX paths relative to it. Code
 * files are read and must be UTF-8 text; public files are only listed with their sizes here.
 */
export const readSource = (location: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if ((yield* fs.stat(location)).type !== "Directory") {
      const entries = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(SourceFile)),
      )(yield* fs.readFileString(location)).pipe(
        Effect.mapError((error) =>
          invalid(
            `${location} is not a source directory or a JSON array of {"path", "content"} files: ${error.message}`,
          ),
        ),
      );
      const files: LocalFile[] = [];
      for (const entry of entries) {
        if ("object" in entry)
          return yield* invalid(
            `${entry.path} names a stored blob; a JSON source carries every file's contents.`,
          );
        const bytes = inlineBytes(entry);
        files.push({
          path: entry.path,
          size: bytes.length,
          text: "encoding" in entry ? undefined : entry.content,
          read: Effect.succeed(bytes),
        });
      }
      yield* withinLimits(files);
      yield* checkPaths(files);
      yield* binaryCode(files);
      return files as ReadonlyArray<LocalFile>;
    }
    const walk = (
      relative: ReadonlyArray<string>,
    ): Effect.Effect<
      ReadonlyArray<{ path: string; location: string; size: number }>,
      PlatformError
    > =>
      Effect.gen(function* () {
        const directory = path.join(location, ...relative);
        const entries = (yield* fs.readDirectory(directory))
          .filter((entry) => !ignoredSource.includes(entry))
          .sort();
        const nested = yield* Effect.forEach(entries, (entry) =>
          Effect.gen(function* () {
            const segments = [...relative, entry];
            const file = path.join(directory, entry);
            const info = yield* fs.stat(file);
            if (info.type === "Directory") return yield* walk(segments);
            if (info.type !== "File") return [];
            return [{ path: segments.join("/"), location: file, size: Number(info.size) }];
          }),
        );
        return nested.flat();
      });
    // Sizes come from the directory listing, so an oversized source is refused before it is read.
    const found = yield* walk([]);
    yield* withinLimits(found);
    yield* checkPaths(found);
    const files: ReadonlyArray<LocalFile> = yield* Effect.forEach(found, (file) =>
      Effect.gen(function* () {
        const read = fs
          .readFile(file.location)
          .pipe(Effect.mapError(() => new SourceError({ reason: "storage" })));
        if (isPublicSourcePath(file.path)) return { path: file.path, size: file.size, read };
        const text = yield* decodeText(yield* fs.readFile(file.location));
        return { path: file.path, size: file.size, text: Option.getOrUndefined(text), read };
      }),
    );
    yield* binaryCode(files);
    return files;
  });

/** Whether the whole source fits one request, as every text-only source within the limits did. */
export const fitsRequest = (files: ReadonlyArray<LocalFile>) =>
  files.reduce((sum, file) => sum + file.size, 0) <= sourceLimits.bytes;

/** The files of a request: code as text, public files as text or, when binary, base64. */
export const requestFiles = (files: ReadonlyArray<LocalFile>) =>
  Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      if (file.text !== undefined) return { path: file.path, content: file.text };
      const bytes = yield* file.read;
      const text = yield* decodeText(bytes);
      return Option.isSome(text)
        ? { path: file.path, content: text.value }
        : { path: file.path, content: encodeBase64(bytes), encoding: "base64" as const };
    }),
  ).pipe(
    Effect.flatMap((files) =>
      Schema.decodeUnknownEffect(Schema.NonEmptyArray(SourceFile))(files).pipe(
        Effect.mapError((error) =>
          invalid(`The files are not a valid app source: ${error.message}`),
        ),
      ),
    ),
  );

/** Only code files, for creating an app whose public files follow by Git. */
export const codeOnly = (files: ReadonlyArray<LocalFile>) =>
  files.filter((file) => !isPublicSourcePath(file.path));

/**
 * Push a local source as the next commit after `expected`, given the files the remote holds at
 * `expected`. Only blobs the remote lacks are sent, in batches under one push's bound.
 */
export const pushSource = (input: {
  readonly url: string;
  readonly authorization: string;
  readonly expected: string;
  readonly remote: SourceFiles;
  readonly files: ReadonlyArray<LocalFile>;
  readonly message: string;
}) =>
  Effect.gen(function* () {
    const present = new Set<string>();
    for (const file of input.remote)
      present.add("object" in file ? file.object : yield* gitBlobId(inlineBytes(file)));
    // Each file is hashed once here and read again only if its blob is sent.
    const files: ReadonlyArray<PushFile> = yield* Effect.forEach(
      input.files,
      (file) =>
        Effect.gen(function* () {
          const bytes =
            file.text === undefined ? yield* file.read : new TextEncoder().encode(file.text);
          return {
            path: file.path,
            object: yield* gitBlobId(bytes),
            size: bytes.length,
            read: file.text === undefined ? file.read : Effect.succeed(bytes),
          };
        }),
      { concurrency: 8 },
    );
    const pushed = yield* pushTree({
      url: input.url,
      authorization: input.authorization,
      expected: input.expected,
      present,
      files,
      message: input.message,
    });
    return {
      commit: pushed.commit,
      removed: removedPaths(
        input.remote.map((file) => file.path),
        files.map((file) => ({ path: file.path, content: "" })),
      ),
    };
  });
