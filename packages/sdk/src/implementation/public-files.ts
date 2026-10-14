/**
 * Deploys copy a source's `ui/public/` files into the host's blob store, under the app code
 * lineage that owns them and named by their Git blob, so redeploys copy only changed files. Each
 * build lists its files at `<build>/public.json`; serving reads only listed files. Removing an app
 * releases its lineage's files. There is no API for this store.
 */
import { Effect, Option, Schema, Stream } from "effect";
import { RuntimeBuildUnavailable, type RuntimePublicFile } from "../contracts/runtime.ts";
import { BlobKey, type BlobStorage } from "../contracts/blobs.ts";
import {
  PublicFileManifest,
  PublicFilePath,
  publicFileContentType,
  publicFileFolder,
  publicFileKey,
  type PublicFile,
} from "../contracts/public-files.ts";
import type { AppCodeId, BuildId } from "../contracts/shared.ts";
import {
  GitObjectId,
  SourceError,
  gitBlobId,
  inlineBytes,
  isTextFile,
  publicFileLimits,
  publicSourcePrefix,
  type CommitFile,
  type SourceFile,
  type SourceStoredFile,
  type SourceTextFile,
} from "../contracts/source.ts";

/** Where the bytes of a snapshot's stored files come from: a repository, a store or a registry. */
export type StoredBytes = (file: {
  readonly path: string;
  readonly object: GitObjectId;
}) => Effect.Effect<Uint8Array, SourceError>;

/** A lineage's own copies: the files its deploys retained. */
export const storeBytes =
  (blobs: BlobStorage, code: AppCodeId): StoredBytes =>
  ({ object }) =>
    blobs.get(publicFileKey(code, object)).pipe(
      Effect.mapError(() => new SourceError({ reason: "storage" })),
      Effect.flatMap((found) =>
        Option.isSome(found)
          ? Effect.succeed(found.value)
          : Effect.fail(new SourceError({ reason: "not-found" })),
      ),
    );

/** Files a public path names, relative to the page's origin. */
export const servedPath = (path: string) => path.slice(publicSourcePrefix.length);

/** Every name in a store folder, page by page. */
const listed = (blobs: BlobStorage, folder: BlobKey) =>
  Effect.gen(function* () {
    const names = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = yield* blobs.list(folder, { startAfter: after, limit: 1000 });
      for (const name of page.names) names.add(name);
      if (!page.truncated || page.names.length === 0) return names;
      after = page.names.at(-1);
    }
  });

/** Copies above this size go one at a time, so a deploy holds at most one large file. */
const smallFile = 1024 * 1024;

/**
 * Copy a source's public files into the lineage's store, skipping files it already holds, and
 * return the build's listing and the files as the deployment retains them: text stays inline,
 * and binary files become stored entries that name the lineage's copy. Stored files missing from
 * the store are read through `stored`; each one's bytes must hash to the blob it names.
 */
export const retainPublicFiles = (
  blobs: BlobStorage,
  code: AppCodeId,
  files: ReadonlyArray<SourceFile>,
  stored: StoredBytes | undefined,
) =>
  Effect.gen(function* () {
    const served = files.filter((file) => file.path.startsWith(publicSourcePrefix));
    if (served.length === 0) return { manifest: [], retained: [] as SourceFile[] };
    for (const file of served)
      if (!Schema.is(PublicFilePath)(servedPath(file.path)))
        return yield* new SourceError({ reason: "invalid-source" });
    const present = yield* listed(blobs, publicFileFolder(code)).pipe(
      Effect.mapError(() => new SourceError({ reason: "storage" })),
    );
    let total = 0;
    const copy = (file: SourceFile) =>
      Effect.gen(function* () {
        const inline = "object" in file ? undefined : inlineBytes(file);
        const object =
          "object" in file ? file.object : yield* gitBlobId(inline ?? new Uint8Array());
        if (!present.has(object)) {
          const bytes =
            inline ??
            (stored === undefined
              ? yield* new SourceError({ reason: "invalid-source" })
              : yield* stored({ path: file.path, object }));
          if ((yield* gitBlobId(bytes)) !== object)
            return yield* new SourceError({ reason: "storage" });
          if (bytes.length > publicFileLimits.fileBytes)
            return yield* new SourceError({ reason: "limit" });
          yield* blobs
            .put(publicFileKey(code, object), bytes)
            .pipe(Effect.mapError(() => new SourceError({ reason: "storage" })));
          present.add(object);
        }
        const size = "object" in file ? file.size : (inline?.length ?? 0);
        total += size;
        if (total > publicFileLimits.bytes) return yield* new SourceError({ reason: "limit" });
        const entry: PublicFile = {
          path: servedPath(file.path),
          object,
          size,
          contentType: publicFileContentType(file.path),
        };
        const kept: SourceFile = isTextFile(file)
          ? file
          : ({ path: file.path, object, size } satisfies SourceStoredFile);
        return { entry, kept };
      });
    const small = served.filter((file) => !("object" in file) || file.size <= smallFile);
    const large = served.filter((file) => "object" in file && file.size > smallFile);
    const copied = [
      ...(yield* Effect.forEach(small, copy, { concurrency: 8 })),
      ...(yield* Effect.forEach(large, copy, { concurrency: 1 })),
    ];
    return {
      manifest: copied.map(({ entry }) => entry),
      retained: copied.map(({ kept }) => kept),
    };
  }).pipe(
    Effect.withSpan("sdk.apps.public.retain", { attributes: { "public.files": files.length } }),
  );

const manifestKey = (build: BuildId) => BlobKey.make(`${build}/public.json`);

/** Retain a build's listing before any deployment names the build. */
export const writePublicManifest = (
  blobs: BlobStorage,
  build: BuildId,
  manifest: PublicFileManifest,
) =>
  Schema.encodeEffect(Schema.fromJsonString(PublicFileManifest))(manifest).pipe(
    Effect.flatMap((text) => blobs.put(manifestKey(build), new TextEncoder().encode(text))),
    Effect.mapError(() => new SourceError({ reason: "storage" })),
  );

/** A build's listing; builds without public files, including every earlier build, have none. */
export const readPublicManifest = (blobs: BlobStorage, build: BuildId) =>
  blobs
    .get(manifestKey(build))
    .pipe(
      Effect.flatMap((found) =>
        Option.isNone(found)
          ? Effect.succeedNone
          : Schema.decodeUnknownEffect(Schema.fromJsonString(PublicFileManifest))(
              new TextDecoder().decode(found.value),
            ).pipe(Effect.map(Option.some)),
      ),
    );

/**
 * Save files whose stored entries name blobs outside the target repository: each one becomes an
 * upload read through `stored`. Inline files are kept as they are.
 */
export const uploadsFrom = (
  files: ReadonlyArray<SourceFile>,
  stored: StoredBytes,
): ReadonlyArray<CommitFile> =>
  files.map((file) =>
    "object" in file
      ? { path: file.path, object: file.object, size: file.size, read: stored(file) }
      : file,
  );

/** Copy a snapshot's stored files into a lineage's store, so its retained files can name them. */
export const adoptStoredFiles = (
  blobs: BlobStorage,
  code: AppCodeId,
  files: ReadonlyArray<SourceFile>,
  stored: StoredBytes,
) =>
  retainPublicFiles(
    blobs,
    code,
    files.filter((file): file is SourceStoredFile => "object" in file),
    stored,
  ).pipe(Effect.asVoid);

/** Release every public file of a removed lineage. Missing objects are already released. */
export const releasePublicFiles = (blobs: BlobStorage, code: AppCodeId) =>
  Effect.gen(function* () {
    const folder = publicFileFolder(code);
    const names = yield* listed(blobs, folder);
    yield* Effect.forEach(
      names,
      (name) =>
        Schema.decodeUnknownEffect(GitObjectId)(name).pipe(
          Effect.flatMap((object) => blobs.remove(publicFileKey(code, object))),
          Effect.ignore,
        ),
      { concurrency: 8, discard: true },
    );
  }).pipe(Effect.withSpan("sdk.apps.public.release"));

/** Serve a listed public file from the lineage's store, streaming the requested range. */
export const publicFileAsset = (
  blobs: BlobStorage,
  code: string,
  entry: PublicFile,
): RuntimePublicFile => {
  const key = publicFileKey(code, entry.object);
  return {
    contentType: entry.contentType,
    size: entry.size,
    object: entry.object,
    key,
    read: (range) =>
      blobs.stream(key, range).pipe(
        Effect.mapError(() => new RuntimeBuildUnavailable()),
        Effect.flatMap((found) =>
          // The build lists the file, so missing bytes are a storage fault.
          Option.isNone(found)
            ? Effect.fail(new RuntimeBuildUnavailable())
            : Effect.succeed(
                found.value.body.pipe(Stream.mapError(() => new RuntimeBuildUnavailable())),
              ),
        ),
      ),
  };
};

/** Text files of a list, the only ones code and manifests are read from. */
export const textFiles = (files: ReadonlyArray<SourceFile>): ReadonlyArray<SourceTextFile> =>
  files.filter(isTextFile);
