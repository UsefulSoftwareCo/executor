/** Network adapter for the official app feed: an index of vetted apps and each app's source. */
import { Effect, Option, Schema } from "effect";
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
      ? "This URL is not a catalog entry. Install takes the id of an entry the catalog lists; add a service by URL with apps.importCustom."
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

/**
 * Read the feed at `feedUrl`, its `index.json`. Redirects are not followed. Listing reads only the
 * index. Preparing reads only the chosen app's source document, `apps/<id>.json` beside the index:
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
  return {
    list: read(feedUrl, CatalogFeed).pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.mapError(() => new CatalogUnavailable()),
      Effect.map((feed) =>
        feed.apps.map(({ source: _source, ...entry }) =>
          CatalogEntry.make({ ...entry, icons: resolveIcons(entry.icons, feedUrl) }),
        ),
      ),
    ),
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

/** A host without a feed lists no feed apps. */
export const emptySource: CatalogSource = {
  list: Effect.succeed([]),
  prepare: (id) => Effect.fail(entryMissing(id)),
};
