/** Browser-safe public registry reads shared with server-side discovery. */
import { Clock, Duration, Effect, Option, Result, Schema, Stream } from "effect";
import { issueSummary } from "@executor-js/telemetry/schema-issue";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import {
  Publication,
  PublicationSnapshot,
  RegistryError,
  type Registry,
} from "../contracts/registry.ts";
import { wireRevision, wireRevisionHeader } from "../contracts/wire-revision.ts";

const maxResponseBytes = 32 * 1024 * 1024;

/**
 * How long the complete public listing is reused before the registry is read again. Publishing
 * reaches other executors within this time. A failed read is never kept.
 */
const publicListingFreshness = Duration.minutes(5);

/** Read a bounded response body; a stream failure is a network failure. */
const readBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.catch((error) =>
      error.reason instanceof HttpClientError.EmptyBodyError
        ? Stream.empty
        : Stream.fail(new RegistryError({ reason: "network" })),
    ),
    Stream.runFoldEffect(
      () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
      (state, chunk) => {
        const size = state.size + chunk.length;
        if (size > maxResponseBytes) return Effect.fail(new RegistryError({ reason: "limit" }));
        state.chunks.push(chunk);
        return Effect.succeed({ size, chunks: state.chunks });
      },
    ),
    Effect.map(({ size, chunks }) => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }),
  );

/** A registry request that states the wire revision this release reads. */
const registryRequest = (url: URL) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader(wireRevisionHeader, String(wireRevision)),
  );

/** A listing's name for a log line, bounded: the registry chose it, and it may not be a package name. */
const listingLabel = (entry: unknown) =>
  typeof entry === "object" && entry !== null && "name" in entry && typeof entry.name === "string"
    ? JSON.stringify(entry.name.slice(0, 140))
    : "without a name";

/**
 * Keep the listings this release can read. Each one it cannot is left out and logged with what
 * failed to decode, so one entry never fails the whole catalog.
 */
const readableListings = (entries: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const listings: Array<Publication> = [];
    for (const entry of entries) {
      const decoded = Schema.decodeUnknownResult(Publication)(entry);
      if (Result.isSuccess(decoded)) {
        listings.push(decoded.success);
        continue;
      }
      const issues = [...new Set(issueSummary(decoded.failure.issue))].slice(0, 10).join(", ");
      yield* Effect.logWarning(
        `Left out public registry listing ${listingLabel(entry)}, which this Executor release cannot read (${issues}). A newer release reads listings in formats added since this one, not malformed ones.`,
      );
    }
    const unreadable = entries.length - listings.length;
    if (unreadable > 0)
      yield* Effect.annotateCurrentSpan("registry.listings_unreadable", unreadable);
    return listings;
  });

const parseJson = (bytes: Uint8Array): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return Option.none();
  }
};

/**
 * Read the public catalog through its configured HTTPS origin; installation validates the selected
 * revision. The complete listing is reused for {@link publicListingFreshness}.
 */
export const remoteRegistry = (origin: string): Registry => {
  const read = <A>(operation: string, path: string, schema: Schema.Decoder<A>) => {
    const url = new URL(path, origin);
    return Effect.gen(function* () {
      const response = yield* HttpClient.execute(registryRequest(url)).pipe(
        Effect.mapError(() => new RegistryError({ reason: "network" })),
      );
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
      // Browsers expose a manual redirect as an opaque response with status 0.
      if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
        // Taking one chunk ends the stream early, which cancels the unread body.
        yield* Stream.runDrain(Stream.take(response.stream, 1)).pipe(Effect.ignore);
        return yield* new RegistryError({ reason: "status", status: response.status });
      }
      const body = yield* readBody(response);
      const value = parseJson(body);
      if (response.status < 200 || response.status >= 300) {
        const error = Option.flatMap(value, (json) =>
          Schema.decodeUnknownOption(Schema.toCodecJson(RegistryError))(json),
        );
        return yield* Option.isSome(error)
          ? error.value
          : new RegistryError({ reason: "status", status: response.status });
      }
      if (Option.isNone(value)) return yield* new RegistryError({ reason: "invalid-response" });
      return yield* Schema.decodeUnknownEffect(schema)(value.value).pipe(
        Effect.mapError(() => new RegistryError({ reason: "invalid-source" })),
      );
    }).pipe(
      // Browsers, Node, Bun, and workerd all support "manual"; workerd rejects "error".
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      // Trace headers would make a browser's cross-origin read a preflighted request.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
      Effect.tapError((error) => Effect.annotateCurrentSpan("registry.error.reason", error.reason)),
      Effect.withSpan("registry.request", {
        attributes: {
          "registry.operation": operation,
          "server.address": url.host,
          "url.path": url.pathname,
        },
      }),
    );
  };
  const file = (name: string, commit: string, path: string) => {
    const url = new URL(
      `/api/registry/file?name=${encodeURIComponent(name)}&commit=${encodeURIComponent(commit)}&path=${encodeURIComponent(path)}`,
      origin,
    );
    return Effect.gen(function* () {
      const response = yield* HttpClient.execute(registryRequest(url)).pipe(
        Effect.mapError(() => new RegistryError({ reason: "network" })),
      );
      yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
      const body = yield* readBody(response);
      if (response.status === 200) return body;
      const error = Option.flatMap(parseJson(body), (json) =>
        Schema.decodeUnknownOption(Schema.toCodecJson(RegistryError))(json),
      );
      return yield* Option.isSome(error)
        ? error.value
        : new RegistryError({ reason: "status", status: response.status });
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
      Effect.withSpan("registry.request", {
        attributes: { "registry.operation": "file", "server.address": url.host },
      }),
    );
  };
  const list = (name?: string) =>
    read(
      "list",
      `/api/registry/apps${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
      Schema.Array(Schema.Unknown),
    ).pipe(Effect.flatMap(readableListings));
  // Only a settled listing is shared. Concurrent reads of an expired listing each fetch it, so no
  // request ever waits on another's fetch; a Worker isolate cannot resume one request from another.
  let kept: { readonly listings: ReadonlyArray<Publication>; readonly until: number } | undefined;
  const listAll = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (kept !== undefined && now < kept.until) return kept.listings;
    const listings = yield* list();
    kept = { listings, until: now + Duration.toMillis(publicListingFreshness) };
    return listings;
  });
  return {
    origin,
    file,
    files: (name, commit) => Effect.succeed((path: string) => file(name, commit, path)),
    // A name selects one listing to install, so it is always read from the registry.
    list: (name) => (name === undefined ? listAll : list(name)),
    snapshot: (name, commit) =>
      read(
        "snapshot",
        `/api/registry/source?name=${encodeURIComponent(name)}&commit=${encodeURIComponent(commit)}`,
        PublicationSnapshot,
      ).pipe(
        Effect.flatMap((value) =>
          value.publication.name === name && value.publication.commit === commit
            ? Effect.succeed(value)
            : Effect.fail(new RegistryError({ reason: "changed" })),
        ),
      ),
  };
};
