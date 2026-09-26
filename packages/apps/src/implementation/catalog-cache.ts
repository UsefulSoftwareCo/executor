/** Revisioned catalog storage shared by remote protocols. Executables are never persisted. */
import { CacheError } from "@executor-js/app-cache";
import { Duration, Effect, Schema } from "effect";
import type { AppCache, CacheLoadContext } from "../contracts/cache.ts";
import { JsonObject, type JsonValue } from "../contracts/schema.ts";
import { wrap } from "./schema.ts";

export interface CatalogCacheOptions {
  /** App/build scope, optionally narrowed to the current account. */
  readonly cache?: AppCache;
  /** Reuse metadata for this duration. Defaults to five minutes. */
  readonly freshFor?: Duration.Input;
  /** Serve retained metadata while refreshing. Defaults to one day. */
  readonly staleFor?: Duration.Input;
  /** Await a fresh revision at an explicit logical connection or refresh boundary. */
  readonly revalidate?: boolean;
}
const schema = <A>(decoder: Schema.Decoder<A>) => wrap(decoder, false);
const Manifest = Schema.Struct({
  revision: Schema.String,
  pages: Schema.Int,
  summaries: Schema.Int,
});
const invoke = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });

export const catalogCache = <A extends { readonly name: string }, S>(
  options: CatalogCacheOptions & {
    readonly prefix: readonly JsonValue[];
    readonly schema: Schema.Decoder<A>;
    /** Schema-free projection stored beside the full pages, so browsing never reads schemas. */
    readonly summary: { readonly schema: Schema.Decoder<S>; readonly of: (tool: A) => S };
    readonly load: (context?: CacheLoadContext) => Effect.Effect<readonly A[], unknown>;
  },
) =>
  Effect.gen(function* () {
    const cache = options.cache;
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
    const refresh = (context: CacheLoadContext) =>
      Effect.gen(function* () {
        const tools = yield* options.load(context);
        // Content-addressed, so refreshing an unchanged catalog renews the same parts.
        const digest = yield* invoke(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(tools))),
        );
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
        const flush = () =>
          invoke(async () => {
            if (batch.length) await context.cache.write(batch, retention);
            batch = [];
            batchBytes = 0;
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
        return { revision, pages, summaries };
      });
    const getOptions = {
      key,
      schema: schema(Manifest),
      freshFor,
      staleFor,
      load: (context: CacheLoadContext) =>
        Effect.runPromise(refresh(context), { signal: context.signal }),
    };
    const current = () =>
      cache === undefined
        ? Effect.fail(new CacheError({ reason: "unavailable" }))
        : invoke(() => cache.get(getOptions));
    if (options.revalidate) {
      if (cache === undefined) yield* local;
      else yield* invoke(() => cache.revalidate(getOptions));
    }
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
            invoke(() =>
              cache.readMany(
                Array.from({ length: Math.min(4, count - offset) }, (_, index) =>
                  part(revision, kind, offset + index),
                ),
                schema(Schema.Array(decoder)),
              ),
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
    const metadata = () =>
      Effect.gen(function* () {
        if (cache === undefined) return yield* local;
        const manifest = yield* current();
        return yield* pages(cache, manifest.revision, "page", manifest.pages, options.schema);
      });

    return {
      list: metadata,
      summaries: () =>
        Effect.gen(function* () {
          if (cache === undefined) return (yield* local).map((tool) => options.summary.of(tool));
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
          ? local.pipe(Effect.map((tools) => tools.find((tool) => tool.name === name)))
          : current().pipe(
              Effect.flatMap((manifest) =>
                invoke(() =>
                  cache.read(part(manifest.revision, "tool", name), schema(options.schema)),
                ),
              ),
            ),
    };
  });
