/**
 * Cloud Git reads need a credential coordinator call and a clone. An unchanged workspace is
 * served from one object per app code instead. Git stays authoritative; see `cachedWorkspaces`.
 */
import {
  SourceCommit,
  SourceError,
  SourceFiles,
  type AppCodeId,
  type BlobStoreError,
  type RepositoryBackend,
} from "@executor-js/sdk/core";
import { Effect, Option, Schedule, Schema } from "effect";

/** A strongly consistent object store with compare-and-swap on the version it returned. */
export interface WorkspaceObjects {
  readonly get: (
    code: AppCodeId,
  ) => Effect.Effect<
    Option.Option<{ readonly etag: string; readonly body: Uint8Array }>,
    BlobStoreError
  >;
  /** Unconditional replacement; returns the new version. */
  readonly put: (code: AppCodeId, body: Uint8Array) => Effect.Effect<string, BlobStoreError>;
  /** Replace only the version read earlier; false when anything replaced it since. */
  readonly replace: (
    code: AppCodeId,
    body: Uint8Array,
    etag: string,
  ) => Effect.Effect<boolean, BlobStoreError>;
}

/**
 * An unknown entry carries a fresh marker, so every invalidation changes the stored version and fences
 * a reader that saw the object before the write.
 */
const Entry = Schema.Union([
  Schema.Struct({ commit: SourceCommit, files: SourceFiles }),
  Schema.Struct({ commit: Schema.Null, invalidation: Schema.String }),
]);
const EntryJson = Schema.fromJsonString(Entry);
const decode = Schema.decodeUnknownOption(EntryJson);
const encode = (entry: typeof Entry.Type) =>
  Schema.encodeEffect(EntryJson)(entry).pipe(Effect.map((text) => new TextEncoder().encode(text)));
const unknownEntry = Effect.sync(
  () => ({ commit: null, invalidation: crypto.randomUUID() }) as const,
);

/**
 * Only the working branch is cached. Every host write to it replaces the object with a new
 * unknown entry after Git settles and before the write returns, so later reads miss. A miss
 * reads Git and records the snapshot only if the object still holds the version seen before
 * that read. A hit is rechecked against the Git head in the background, which repairs an entry
 * left behind when an invalidation could not be stored.
 */
export const cachedWorkspaces = (
  git: RepositoryBackend,
  objects: WorkspaceObjects,
  background: (work: Effect.Effect<void>) => Effect.Effect<boolean>,
): RepositoryBackend => {
  const invalidate = (code: AppCodeId) =>
    unknownEntry.pipe(
      Effect.flatMap(encode),
      Effect.flatMap((body) => objects.put(code, body)),
      Effect.retry({ times: 2, schedule: Schedule.exponential("100 millis") }),
      Effect.asVoid,
      Effect.catchCause(() =>
        Effect.logError("Workspace cache invalidation failed; the next read will repair it"),
      ),
      Effect.withSpan("source.workspace.cache.invalidate"),
    );
  /** Storage failures and unreadable objects are misses; they never replace a Git read. */
  const stored = (code: AppCodeId) =>
    objects.get(code).pipe(
      Effect.map(
        Option.map((object) => ({
          etag: object.etag,
          entry: decode(new TextDecoder().decode(object.body)),
        })),
      ),
      Effect.catchCause(() =>
        Effect.annotateCurrentSpan("source.workspace.cache.unavailable", true).pipe(
          Effect.as(Option.none()),
        ),
      ),
    );
  const revalidate = (code: AppCodeId, commit: string) =>
    git.head(code, "main").pipe(
      Effect.flatMap((head) =>
        head === commit
          ? Effect.void
          : Effect.annotateCurrentSpan("source.workspace.cache.stale", true).pipe(
              Effect.andThen(invalidate(code)),
            ),
      ),
      Effect.catchCause(() => Effect.logWarning("Workspace cache revalidation failed")),
      Effect.withSpan("source.workspace.cache.revalidate"),
    );
  const workspace = (code: AppCodeId) =>
    Effect.gen(function* () {
      const current = yield* stored(code);
      const hit = Option.flatMap(current, ({ entry }) => entry).pipe(
        Option.flatMap((entry) =>
          entry.commit === null
            ? Option.none()
            : Option.some({ commit: entry.commit, files: entry.files }),
        ),
      );
      yield* Effect.annotateCurrentSpan(
        "source.workspace.cache",
        Option.isSome(hit) ? "hit" : "miss",
      );
      if (Option.isSome(hit)) {
        yield* background(revalidate(code, hit.value.commit));
        return hit.value;
      }
      // Claim a version before reading Git. Any write that lands after this point replaces it.
      const version = Option.isSome(current)
        ? Option.some(current.value.etag)
        : yield* unknownEntry.pipe(
            Effect.flatMap(encode),
            Effect.flatMap((body) => objects.put(code, body)),
            Effect.map(Option.some),
            Effect.catchCause(() => Effect.succeed(Option.none<string>())),
          );
      const snapshot = yield* git.read(code, "main");
      if (Option.isSome(version))
        yield* background(
          encode(snapshot).pipe(
            Effect.flatMap((body) => objects.replace(code, body, version.value)),
            Effect.flatMap((saved) =>
              Effect.annotateCurrentSpan("source.workspace.cache.saved", saved),
            ),
            Effect.catchCause(() => Effect.logWarning("Workspace cache write failed")),
            Effect.withSpan("source.workspace.cache.save"),
          ),
        );
      return snapshot;
    }).pipe(Effect.withSpan("source.workspace.cache.read"));
  /** A commit's files never change, so the current entry also answers reads of that commit. */
  const revision = (code: AppCodeId, commit: string) =>
    stored(code).pipe(
      Effect.flatMap((current) => {
        const entry = Option.flatMap(current, ({ entry }) => entry);
        return Option.isSome(entry) && entry.value.commit === commit
          ? Effect.succeed({ commit: entry.value.commit, files: entry.value.files })
          : git.read(code, commit);
      }),
    );
  return {
    ...git,
    read: (code, ref) =>
      ref === "main"
        ? workspace(code)
        : Schema.is(SourceCommit)(ref)
          ? revision(code, ref)
          : git.read(code, ref),
    // A failed or interrupted push may still have landed, so every outcome invalidates.
    commit: (input) =>
      input.branch === "main"
        ? git.commit(input).pipe(Effect.ensuring(invalidate(input.id)))
        : git.commit(input),
    request: (code, request) =>
      new URL(request.url).pathname.endsWith("/git-receive-pack")
        ? Effect.gen(function* () {
            const response = yield* git.request(code, request);
            // The report arrives after Git updates its refs. Read it before invalidating so the
            // client cannot observe a completed push while the old snapshot is still stored.
            const body = yield* Effect.tryPromise({
              try: () => response.arrayBuffer(),
              catch: () => new SourceError({ reason: "git" }),
            });
            return new Response(response.body === null ? null : body, {
              status: response.status,
              headers: response.headers,
            });
          }).pipe(Effect.ensuring(invalidate(code)))
        : git.request(code, request),
  };
};
