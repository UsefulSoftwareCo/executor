/** Network adapter for the official app feed: an index of vetted apps and each app's source. */
import { Effect, Exit, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { isTextFile } from "@executor-js/sdk";
import {
  CatalogEntry,
  CatalogFeed,
  CatalogFeedSource,
  CatalogImportFailed,
  CatalogUnavailable,
  PreparedApp,
  type CatalogIcon,
  type CatalogSource,
} from "../contracts/catalog.ts";
import { unknownEntryRecovery } from "../contracts/setup.ts";

// An agent may pass a server URL; the reply says what install takes, without repeating it.
const entryMissing = (id: string) =>
  new CatalogImportFailed({
    code: "entry_missing",
    reason: URL.canParse(id)
      ? "This URL is not a catalog entry. Install takes the id of an entry the catalog lists; add a remote MCP server by its URL with the custom MCP import."
      : "This entry is no longer in the catalog. Refresh and choose another app.",
    recovery: unknownEntryRecovery,
  });

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

/** Icons load in the user's browser, so only web and inline image addresses are kept. */
const iconUrl = (src: string, base: string) => {
  if (!URL.canParse(src, base)) return undefined;
  const url = new URL(src, base);
  return ["https:", "http:"].includes(url.protocol) || url.href.startsWith("data:image/")
    ? url.href
    : undefined;
};

const resolveIcons = (icons: readonly CatalogIcon[], base: string) =>
  icons.flatMap((icon) => {
    const src = iconUrl(icon.src, base);
    return src === undefined ? [] : [{ ...icon, src }];
  });

/** The index's apps as last read, with the validator that lets the feed confirm them unchanged. */
interface KeptIndex {
  readonly etag: string;
  readonly entries: readonly CatalogEntry[];
}

/**
 * Read the feed at `feedUrl`, its `index.json`. Redirects are not followed. Listing reads only the
 * index, and asks the feed whether the index changed since the last read: an unchanged index is
 * not downloaded or decoded again. Listings that start while one is reading share its read. Preparing reads only the chosen app's source document, `apps/<id>.json` beside the index:
 * the publisher writes every listed app there and deletes the documents of apps it delists, so the
 * document exists exactly when the entry is listed. Reading the whole index to find one entry cost
 * seconds on every install.
 */
export const catalogSource = (client: HttpClient.HttpClient, feedUrl: string): CatalogSource => {
  /** A missing document reads as `None`; any other failure is `CatalogUnavailable`. */
  const read = <A>(url: string, schema: Schema.Decoder<A>) =>
    Effect.gen(function* () {
      const response = yield* client.get(url);
      if (response.status === 404) return Option.none<A>();
      if (response.status !== 200) return yield* new CatalogUnavailable();
      return Option.some(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(yield* response.text),
      );
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new CatalogUnavailable()),
    );
  let kept: KeptIndex | undefined;
  const readIndex = Effect.gen(function* () {
    const previous = kept;
    // Blocked egress usually never answers, and a person waits on this in onboarding, so the feed
    // has 10 seconds to start answering. The transfer and decoding share the 30 seconds below.
    const response = yield* client
      .get(
        feedUrl,
        previous === undefined ? undefined : { headers: { "if-none-match": previous.etag } },
      )
      .pipe(Effect.timeout("10 seconds"));
    if (response.status === 304 && previous !== undefined) return previous.entries;
    if (response.status !== 200) return yield* new CatalogUnavailable();
    const feed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogFeed))(
      yield* response.text,
    );
    const entries = feed.apps.map(({ source: _source, ...entry }) =>
      CatalogEntry.make({ ...entry, icons: resolveIcons(entry.icons, feedUrl) }),
    );
    const etag = response.headers["etag"];
    kept = etag === undefined ? undefined : { etag, entries };
    return entries;
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new CatalogUnavailable()),
  );
  // Settled through a native promise, so on Workers each waiting request resumes in its own I/O
  // context (see the SDK's Handoff). An interrupted read settles with nothing, and its waiters read.
  let reading:
    | Promise<Exit.Exit<readonly CatalogEntry[], CatalogUnavailable> | undefined>
    | undefined;
  const list: Effect.Effect<readonly CatalogEntry[], CatalogUnavailable> = Effect.suspend(() => {
    const shared = reading;
    if (shared !== undefined)
      return Effect.promise(() => shared).pipe(
        Effect.flatMap((exit) => (exit === undefined ? list : exit)),
      );
    let settle: (
      exit: Exit.Exit<readonly CatalogEntry[], CatalogUnavailable> | undefined,
    ) => void = () => undefined;
    reading = new Promise((resolve) => {
      settle = resolve;
    });
    return readIndex.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          reading = undefined;
          settle(Exit.hasInterrupts(exit) ? undefined : exit);
        }),
      ),
    );
  });
  return {
    list,
    prepare: (id) =>
      Effect.gen(function* () {
        // Feed entry ids are never URLs, so one is refused without reading the feed.
        if (URL.canParse(id)) return yield* entryMissing(id);
        const reference = new URL(`apps/${encodeURIComponent(id)}.json`, feedUrl).href;
        const found = yield* read(reference, CatalogFeedSource);
        if (Option.isNone(found)) return yield* entryMissing(id);
        // Only a listed catalog identifier is recorded, never an arbitrary lookup input.
        yield* Effect.annotateCurrentSpan({ "catalog.entry.id": id });
        const source = found.value;
        const manifest = Option.fromNullishOr(
          source.files.find((file) => file.path === "package.json"),
        ).pipe(
          Option.filter(isTextFile),
          Option.flatMap((file) => decodeManifest(file.content)),
        );
        if (!Option.exists(manifest, ({ name }) => name === source.package))
          return yield* new CatalogImportFailed({
            code: "invalid_source",
            reason: "This app's published source does not match its catalog entry.",
          });
        return PreparedApp.make({
          files: source.files,
          origin: { reference, name: source.package, commit: null },
        });
      }),
  };
};

/** Refuse an install when the catalog is off: no entry is listed, so none can be prepared. */
export const turnedOffPrepare = (id: string) => Effect.fail(entryMissing(id));
