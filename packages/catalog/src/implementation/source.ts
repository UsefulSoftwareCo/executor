/** Network adapter for the public, read-only integrations.sh feed and API documents. */
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  httpsOnlyUrlPolicy,
  parseDestination,
  redirectDestination,
  type HostEgress,
} from "@executor-js/utils/url-policy";
import {
  CatalogFeed,
  CatalogImportFailed,
  CatalogUnavailable,
  type CatalogSource,
} from "../contracts/catalog.ts";

/** A destination refused by host policy is reported exactly like any other unreachable URL. */
class DestinationRefused {
  readonly _tag = "DestinationRefused";
}

const maximumHops = 5;

/**
 * Fetch under the host destination policy. Redirects are never followed by the platform: each
 * hop is re-checked by `parseDestination`, and the host's own client re-checks the addresses
 * that hop resolves to, so a public first hop cannot hand the host an internal target.
 */
const read = (url: string, egress: HostEgress) =>
  Effect.gen(function* () {
    let destination = parseDestination(url, egress.policy);
    for (let hop = 0; hop <= maximumHops; hop++) {
      if (destination === undefined) return yield* Effect.fail(new DestinationRefused());
      const response = yield* egress.client.get(destination);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        // Release the hop's body before issuing the next request.
        yield* response.text.pipe(Effect.ignore);
        destination =
          location === undefined
            ? undefined
            : redirectDestination(location, destination, egress.policy);
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(new DestinationRefused());
      const text = yield* response.text;
      if (text.length > 20_000_000)
        return yield* Effect.fail(
          new CatalogImportFailed({
            reason: "This API definition exceeds the 20 MB import limit.",
          }),
        );
      return text;
    }
    return yield* Effect.fail(new DestinationRefused());
  }).pipe(
    Effect.timeout("30 seconds"),
    // Only a fetch-backed client reads this; an Undici dispatcher never follows a redirect.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

/** Download a JSON/YAML document. The product supplies the policy and the client that enforce it. */
export const readApiDocument = (url: string, egress: HostEgress) =>
  Effect.gen(function* () {
    const text = yield* read(url, egress).pipe(
      Effect.mapError(
        () =>
          new CatalogImportFailed({
            reason: "Could not read this API definition. Check the URL and try again.",
          }),
      ),
    );
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("["))
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError(
          () => new CatalogImportFailed({ reason: "This API definition is not valid JSON." }),
        ),
      );
    const { parse } = yield* Effect.promise(() => import("yaml"));
    return yield* Effect.try({
      try: () => parse(text) as unknown,
      catch: () => new CatalogImportFailed({ reason: "This API definition is not valid YAML." }),
    });
  });

/**
 * Fetch only published GET endpoints; this never invokes the registry's discovery agent. The
 * registry is a public HTTPS service, so it is read under the public-only policy on every host.
 */
export const catalogSource = (client: HttpClient.HttpClient): CatalogSource => {
  const egress: HostEgress = { policy: httpsOnlyUrlPolicy, client };
  return {
    list: read("https://integrations.sh/api.json", egress).pipe(
      Effect.flatMap((text) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogFeed))(text),
      ),
      Effect.map((feed) => feed.data),
      Effect.mapError(() => new CatalogUnavailable()),
    ),
    document: (entry) =>
      Effect.gen(function* () {
        if (entry.kind === "mcp")
          return yield* new CatalogImportFailed({
            reason: "MCP entries are generated without an API definition.",
          });
        const url = URL.parse(entry.feeds?.[0] ?? entry.connectUrl ?? "");
        if (url === null || url.protocol !== "https:")
          return yield* new CatalogImportFailed({
            reason: "The catalog must provide a public HTTPS definition URL.",
          });
        // Registry entries are third-party input: they never reach a host-internal destination.
        return yield* readApiDocument(url.href, egress);
      }),
  };
};
