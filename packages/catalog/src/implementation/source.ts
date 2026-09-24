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

/** No hostnames or response text enter an import failure. */
const destinationRefused = () =>
  new CatalogImportFailed({
    code: "destination_blocked",
    reason:
      "This API definition URL or its redirect is not allowed by the host. Use an allowed definition URL.",
  });

const httpFailure = (httpStatus: number) => {
  const reason = (() => {
    switch (httpStatus) {
      case 401:
      case 403:
        return "Access to this API definition was denied. Use a definition URL that Executor can read without signing in.";
      case 404:
      case 410:
        return "This API definition was not found. Check the definition URL for the current JSON or YAML document.";
      case 429:
        return "The API definition host is limiting requests. Wait before importing again.";
      default:
        return httpStatus >= 500
          ? "The API definition host could not serve the document. Try again later."
          : "The API definition host returned an unsuccessful response. Check the definition URL and try again.";
    }
  })();
  return new CatalogImportFailed({ code: "document_http", httpStatus, reason });
};

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
      if (destination === undefined) return yield* Effect.fail(destinationRefused());
      const response = yield* egress.client.get(destination);
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        // Release the hop's body before issuing the next request.
        yield* response.text.pipe(Effect.ignore);
        if (location === undefined)
          return yield* new CatalogImportFailed({
            code: "document_redirect",
            reason:
              "The API definition host returned a redirect without a destination. Use the direct JSON or YAML definition URL.",
          });
        destination = redirectDestination(location, destination, egress.policy);
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        return yield* httpFailure(response.status);
      const text = yield* response.text;
      if (text.length > 40_000_000)
        return yield* Effect.fail(
          new CatalogImportFailed({
            code: "document_size",
            reason: "This API definition exceeds the 40 MB import limit.",
          }),
        );
      return text;
    }
    return yield* new CatalogImportFailed({
      code: "document_redirect",
      reason:
        "The API definition URL redirected too many times. Use the direct JSON or YAML definition URL.",
    });
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag(
      "TimeoutError",
      () =>
        new CatalogImportFailed({
          code: "document_timeout",
          reason:
            "The API definition did not finish downloading within 30 seconds. Try again or use another definition URL.",
        }),
    ),
    // Only a fetch-backed client reads this; an Undici dispatcher never follows a redirect.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

/** Download a JSON/YAML document. The product supplies the policy and the client that enforce it. */
export const readApiDocument = (url: string, egress: HostEgress) =>
  Effect.gen(function* () {
    const text = yield* read(url, egress).pipe(
      Effect.mapError((error) =>
        Schema.is(CatalogImportFailed)(error)
          ? error
          : new CatalogImportFailed({
              code: "document_fetch",
              reason: "Could not read this API definition. Check the URL and try again.",
            }),
      ),
    );
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("["))
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError(
          () =>
            new CatalogImportFailed({
              code: "document_json",
              reason:
                "This API definition is not valid JSON. Check its syntax or use the direct JSON or YAML definition URL.",
            }),
        ),
      );
    const { parse } = yield* Effect.promise(() => import("yaml"));
    return yield* Effect.try({
      try: () => parse(text) as unknown,
      catch: () =>
        new CatalogImportFailed({
          code: "document_yaml",
          reason:
            "This API definition is not valid YAML. Check its syntax or use the direct JSON or YAML definition URL.",
        }),
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
            code: "document_kind",
            reason: "MCP entries are generated without an API definition.",
          });
        // `connectUrl` locates the definition; `feeds` names the registry lists an entry came from.
        const url = URL.parse(entry.connectUrl ?? "");
        if (url === null || url.protocol !== "https:")
          return yield* new CatalogImportFailed({
            code: "document_url",
            reason: "The catalog must provide a public HTTPS definition URL.",
          });
        // Registry entries are third-party input: they never reach a host-internal destination.
        return yield* readApiDocument(url.href, egress);
      }),
  };
};
