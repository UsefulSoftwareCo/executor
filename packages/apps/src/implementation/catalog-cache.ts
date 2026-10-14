/** Revisioned catalog storage shared by remote protocols. Executables are never persisted. */
import { CacheError } from "@executor-js/app-cache";
import { Deferred, Duration, Effect, Exit, Schema } from "effect";
import type { AccountCredential, AppCache, CacheLoadContext } from "../contracts/cache.ts";
import { JsonObject, type JsonValue } from "../contracts/schema.ts";
import { fromPromise, method, toPromise } from "./authoring.ts";
import { getWithReads, type CacheWithReads } from "./cache.ts";
import { wrap } from "./schema.ts";

export interface CatalogCacheOptions {
  /** The app's cache. An account's catalog is kept in that account's scope. */
  readonly cache?: AppCache;
  /** Reuse metadata for this duration. Defaults to five minutes. */
  readonly freshFor?: Duration.Input;
  /** Serve retained metadata while refreshing. Defaults to one day. */
  readonly staleFor?: Duration.Input;
  /** Await a fresh revision at an explicit logical connection or refresh boundary. */
  readonly revalidate?: boolean;
}
/** Whose catalog a remote router reads, and the headers, such as credentials, it sends. */
export type CatalogAccount = AccountCredential<{
  /** Headers for this account's requests, such as its credentials. */
  readonly headers?: Readonly<Record<string, string>>;
}>;

/** Why a read cannot use its account's scope. */
export type CatalogScopeProblem = "missing-account" | "unselected-account";

/**
 * The cache an account's catalog lives in: the account's own scope, which token renewals keep.
 * `credential` is what the read sends, such as headers or a token; it never enters a key. A
 * credential without an account, or an account the app was not given, fails with `invalid`.
 */
export const catalogScope = <E>(
  options: {
    readonly cache?: AppCache | undefined;
    readonly account?: { readonly id: string } | undefined;
  },
  credential: unknown,
  invalid: (problem: CatalogScopeProblem) => E,
): Effect.Effect<AppCache | undefined, E> => {
  const { account, cache } = options;
  if (account === undefined)
    return credential === undefined
      ? Effect.succeed(cache)
      : Effect.fail(invalid("missing-account"));
  if (cache === undefined) return Effect.succeed(undefined);
  // The cache refuses an account that is not one of the app's selected accounts.
  return Effect.try({
    try: () => cache.forAccount(account),
    catch: () => invalid("unselected-account"),
  });
};

const schema = <A>(decoder: Schema.Decoder<A>) => wrap(decoder, false);

/**
 * The revision this isolate last saw for each catalog, by the store key of its manifest. That key
 * is a digest of the cache's scope and the catalog's key, so each account selection an app Worker
 * serves keeps its own entry. Resolving a tool reads its part under this revision in the same
 * round trip as the manifest, and uses it only when the store's manifest names that revision. A
 * part's key holds its revision, a digest of the whole catalog, so it is the part a separate read
 * would return. Any other revision costs that separate read, as every call made before. Only
 * digests are kept: no app data, account or key.
 */
const seenRevisions = new Map<string, string>();
const seenLimit = 256;
const seen = (key: string, revision: string) => {
  seenRevisions.delete(key);
  seenRevisions.set(key, revision);
  if (seenRevisions.size > seenLimit) {
    const oldest = seenRevisions.keys().next();
    if (oldest.done !== true) seenRevisions.delete(oldest.value);
  }
};
/** `header` describes the whole catalog, such as an MCP server's instructions, in the same revision. */
const Manifest = Schema.Struct({
  revision: Schema.String,
  pages: Schema.Int,
  summaries: Schema.Int,
  header: Schema.optionalKey(JsonObject),
});

/** One load: the tools, and optionally a record describing the whole catalog. */
export interface CatalogLoad<A> {
  readonly tools: readonly A[];
  readonly header?: JsonObject;
}
/** The catalog a refresh replaces, read only when its loader asks for it. */
export interface KeptCatalog<A> {
  readonly header: JsonObject | undefined;
  readonly tools: Effect.Effect<readonly A[], unknown>;
}
export const catalogCache = <A extends { readonly name: string }, S>(
  options: Omit<CatalogCacheOptions, "cache"> & {
    /** The scope from `catalogScope`; undefined keeps discovery invocation-local. */
    readonly cache: AppCache | undefined;
    readonly prefix: readonly JsonValue[];
    readonly schema: Schema.Decoder<A>;
    /** Schema-free projection stored beside the full pages, so browsing never reads schemas. */
    readonly summary: { readonly schema: Schema.Decoder<S>; readonly of: (tool: A) => S };
    /** Past `freshFor`, serve the kept catalog while refreshing, or refresh first. */
    readonly stale?: "serve" | "revalidate";
    /**
     * Load the catalog. A refresh also gets the catalog it replaces, if one is kept, so a source
     * that can confirm it is unchanged need not load it again.
     */
    readonly load: (
      context?: CacheLoadContext,
      kept?: Effect.Effect<KeptCatalog<A> | undefined, unknown>,
    ) => Effect.Effect<CatalogLoad<A>, unknown>;
  },
) =>
  Effect.gen(function* () {
    const cache: CacheWithReads | undefined = options.cache;
    const key: JsonValue = [...options.prefix, "current"];
    const part = (revision: string, kind: string, name: string | number): JsonValue => [
      ...options.prefix,
      revision,
      kind,
      name,
    ];
    const freshFor = options.freshFor ?? "5 minutes";
    const staleFor = options.staleFor ?? "1 day";
    const retention =
      Duration.toMillis(Duration.fromInputUnsafe(freshFor)) +
      Duration.toMillis(Duration.fromInputUnsafe(staleFor)) +
      300_000;
    const local = yield* Effect.cached(options.load());
    const pages = <B>(
      cache: NonNullable<CatalogCacheOptions["cache"]>,
      revision: string,
      kind: "page" | "summary",
      count: number,
      decoder: Schema.Decoder<B>,
    ) =>
      Effect.gen(function* () {
        // Four pages fit the RPC byte budget even when a single tool is near the entry limit.
        const batches = yield* Effect.forEach(
          Array.from({ length: Math.ceil(count / 4) }, (_, batch) => batch * 4),
          (offset) =>
            fromPromise(method(cache, "readMany"), "cache")(
              Array.from({ length: Math.min(4, count - offset) }, (_, index) =>
                part(revision, kind, offset + index),
              ),
              schema(Schema.Array(decoder)),
            ),
          { concurrency: "unbounded" },
        );
        const values: B[] = [];
        for (const page of batches.flat()) {
          if (page === undefined) return yield* new CacheError({ reason: "unavailable" });
          values.push(...page);
        }
        return values;
      });
    /** The catalog a refresh replaces, from the scope that refresh writes. */
    const kept = (cache: AppCache) =>
      fromPromise(method(cache, "read"), "cache")(key, schema(Manifest)).pipe(
        Effect.map((manifest) =>
          manifest === undefined
            ? undefined
            : {
                header: manifest.header,
                tools: pages(cache, manifest.revision, "page", manifest.pages, options.schema),
              },
        ),
      );
    const refresh = (context: CacheLoadContext) =>
      Effect.gen(function* () {
        const { tools, header } = yield* options.load(context, kept(context.cache));
        // Content-addressed, so refreshing an unchanged catalog renews the same parts.
        // oxlint-disable-next-line executor/authored-code-through-adapter -- Web Crypto
        const digest = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify({ tools, header: header ?? null })),
            ),
          catch: (error) => error,
        });
        const revision = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        let pages = 0;
        let page: JsonObject[] = [];
        let pageBytes = 0;
        let summaries = 0;
        let summary: JsonObject[] = [];
        let summaryBytes = 0;
        let batch: { key: JsonValue; value: JsonValue }[] = [];
        let batchBytes = 0;
        let flushes = 0;
        const flush = () =>
          Effect.suspend(() => {
            const entries = batch;
            const bytes = batchBytes;
            batch = [];
            batchBytes = 0;
            if (!entries.length) return Effect.void;
            return fromPromise(method(context.cache, "write"), "cache")(entries, retention).pipe(
              Effect.withSpan("app.cache.flush", {
                attributes: {
                  "cache.flush.index": flushes++,
                  "cache.flush.entries": entries.length,
                  "cache.flush.bytes": bytes,
                },
              }),
            );
          });
        const append = (entry: { key: JsonValue; value: JsonValue }) =>
          Effect.gen(function* () {
            const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
            if (batch.length && (batch.length >= 64 || batchBytes + bytes > 4_000_000))
              yield* flush();
            batch.push(entry);
            batchBytes += bytes;
          });
        const pageOut = () =>
          Effect.gen(function* () {
            if (!page.length) return;
            yield* append({ key: part(revision, "page", pages++), value: page });
            page = [];
            pageBytes = 0;
          });
        const summaryOut = () =>
          Effect.gen(function* () {
            if (!summary.length) return;
            yield* append({ key: part(revision, "summary", summaries++), value: summary });
            summary = [];
            summaryBytes = 0;
          });
        // Optional wire fields can decode to undefined; persisted values are strictly JSON.
        const json = (value: unknown) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(JSON.stringify(value));
        for (const tool of tools) {
          const value = yield* json(tool);
          const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
          if (page.length && (page.length >= 64 || pageBytes + bytes > 500_000)) yield* pageOut();
          yield* append({ key: part(revision, "tool", tool.name), value });
          page.push(value);
          pageBytes += bytes;
          const brief = yield* json(options.summary.of(tool));
          const briefBytes = new TextEncoder().encode(JSON.stringify(brief)).byteLength;
          if (summary.length && summaryBytes + briefBytes > 500_000) yield* summaryOut();
          summary.push(brief);
          summaryBytes += briefBytes;
        }
        yield* pageOut();
        yield* summaryOut();
        yield* flush();
        // The cache publishes this manifest only after all parts, under its fenced loader lease.
        return {
          revision,
          pages,
          summaries,
          ...(header === undefined ? {} : { header: yield* json(header) }),
        };
      });
    const getOptions = {
      key,
      schema: schema(Manifest),
      freshFor,
      staleFor,
      ...(options.stale === undefined ? {} : { stale: options.stale }),
      // A cache may call the loader as a Promise; its own signal cancels that load.
      load: toPromise(refresh, (context: CacheLoadContext) => context.signal),
    };
    // A router reads its catalog's header and its tools together; concurrent reads share one
    // manifest round trip.
    let reading: Deferred.Deferred<typeof Manifest.Type, unknown> | undefined;
    /**
     * The manifest, and the stored value of the part of the tool `tool` names when it was read in
     * the same round trip: `part` is set only when the manifest's revision is the one the part was
     * read under, and holds `undefined` when that revision has no such tool. The part is not
     * decoded here, so a part read under another revision is never decoded at all.
     */
    const read = (tool?: string) =>
      Effect.suspend(
        (): Effect.Effect<
          { manifest: typeof Manifest.Type; part?: { readonly value: unknown } },
          unknown
        > => {
          if (cache === undefined) return Effect.fail(new CacheError({ reason: "unavailable" }));
          const shared = reading;
          if (shared !== undefined)
            return Deferred.await(shared).pipe(Effect.map((manifest) => ({ manifest })));
          const deferred = Deferred.makeUnsafe<typeof Manifest.Type, unknown>();
          reading = deferred;
          // Only Executor's own cache has it as an own property; a spread or wrapped cache does
          // not, so a cache whose app replaces `get` or `read` is always called through them.
          const together = Object.hasOwn(cache, getWithReads) ? cache[getWithReads] : undefined;
          let hinted: string | undefined;
          const fetched =
            together === undefined
              ? fromPromise(
                  method(cache, "get"),
                  "cache",
                )(getOptions).pipe(Effect.map((manifest) => ({ manifest })))
              : fromPromise(method({ together }, "together"), "cache")(getOptions, (stored) => {
                  hinted = tool === undefined ? undefined : seenRevisions.get(stored);
                  return hinted === undefined || tool === undefined
                    ? []
                    : [part(hinted, "tool", tool)];
                }).pipe(
                  Effect.map(({ value: manifest, key: stored, reads }) => {
                    seen(stored, manifest.revision);
                    return manifest.revision === hinted && reads !== undefined
                      ? { manifest, part: { value: reads[0] } }
                      : { manifest };
                  }),
                );
          return fetched.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (reading === deferred) reading = undefined;
              }).pipe(
                Effect.andThen(
                  Deferred.done(
                    deferred,
                    Exit.map(exit, ({ manifest }) => manifest),
                  ),
                ),
              ),
            ),
          );
        },
      );
    const current = () => read().pipe(Effect.map(({ manifest }) => manifest));
    if (options.revalidate) {
      if (cache === undefined) yield* local;
      else yield* fromPromise(method(cache, "revalidate"), "cache")(getOptions);
    }
    const metadata = () =>
      Effect.gen(function* () {
        if (cache === undefined) return (yield* local).tools;
        const manifest = yield* current();
        return yield* pages(cache, manifest.revision, "page", manifest.pages, options.schema);
      });

    return {
      list: metadata,
      /** The record stored with the current revision, if the source supplied one. */
      header: (): Effect.Effect<JsonObject | undefined, unknown> =>
        cache === undefined
          ? local.pipe(Effect.map(({ header }) => header))
          : current().pipe(Effect.map((manifest) => manifest.header)),
      summaries: () =>
        Effect.gen(function* () {
          if (cache === undefined)
            return (yield* local).tools.map((tool) => options.summary.of(tool));
          const manifest = yield* current();
          return yield* pages(
            cache,
            manifest.revision,
            "summary",
            manifest.summaries,
            options.summary.schema,
          );
        }),
      resolve: (name: string) =>
        cache === undefined
          ? local.pipe(Effect.map(({ tools }) => tools.find((tool) => tool.name === name)))
          : read(name).pipe(
              Effect.flatMap(({ manifest, part: found }) => {
                const separately = fromPromise(method(cache, "read"), "cache")(
                  part(manifest.revision, "tool", name),
                  schema(options.schema),
                );
                if (found === undefined) return separately;
                if (found.value === undefined) return Effect.succeed(undefined);
                // A part this schema cannot read is read again on its own, as without the hint,
                // and fails there if it is still unreadable.
                return Schema.decodeUnknownEffect(options.schema)(found.value).pipe(
                  Effect.catch(() => separately),
                );
              }),
            ),
    };
  });
