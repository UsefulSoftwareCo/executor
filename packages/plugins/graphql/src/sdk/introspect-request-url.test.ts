// ---------------------------------------------------------------------------
// The exact URL introspection dials.
//
// Keeping a query-carried credential out of the log means splitting the query
// off `request.url` and into `request.urlParams` (see
// `introspect-credential-logging.test.ts`). The client recombines the two by
// appending each pair through `URLSearchParams`, so the query is re-serialized
// in form-urlencoded form rather than passed through byte-for-byte.
//
// That is a real, if narrow, wire change, and it is not recoverable: raw query
// bytes only survive inside `request.url`, which is the single field every
// `HttpClientError` message renders. So the normalization is pinned here by
// exact string equality rather than described in prose — a `toContain` check
// would let any of these encodings drift silently, and an upstream that signs
// its query string would notice.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { GraphqlIntrospectionError } from "./errors";
import { introspect } from "./introspect";

const ENDPOINT = "https://graph.example.test/graphql";

/** Records the URL handed to the platform, then fails the transport so the
 *  effect finishes without a live host. */
const recordingFetch = (seen: Array<string>): typeof globalThis.fetch =>
  (async (input: RequestInfo | URL) => {
    seen.push(input instanceof Request ? input.url : String(input));
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the platform fetch rejecting on a dead host
    throw new Error("getaddrinfo ENOTFOUND graph.example.test");
  }) as typeof globalThis.fetch;

const clientLayer = (seen: Array<string>) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(recordingFetch(seen))),
  );

const silentLogger = Logger.layer([Logger.make<unknown, void>(() => {})]);

/** Runs introspection against a fetch that always fails, and returns the one
 *  URL it was asked to dial. */
const dialedUrl = (endpoint: string, queryParams?: Record<string, string>) =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    yield* introspect(endpoint, undefined, queryParams).pipe(
      Effect.flip,
      Effect.provide(clientLayer(seen)),
      Effect.provide(silentLogger),
    );
    expect(seen).toHaveLength(1);
    return seen[0];
  });

describe("GraphQL introspection request URL", () => {
  it.effect("merges query params into an endpoint that already has some", () =>
    Effect.gen(function* () {
      // Endpoint params keep their position and order; merged params are
      // appended after them.
      const url = yield* dialedUrl(`${ENDPOINT}?apiVersion=2&region=eu`, {
        token: "s3cr3t",
        trace: "on",
      });
      expect(url).toBe(`${ENDPOINT}?apiVersion=2&region=eu&token=s3cr3t&trace=on`);
    }),
  );

  it.effect("adds a query to an endpoint that has none", () =>
    Effect.gen(function* () {
      const url = yield* dialedUrl(ENDPOINT, { token: "s3cr3t" });
      expect(url).toBe(`${ENDPOINT}?token=s3cr3t`);
    }),
  );

  it.effect("overwrites a duplicate param in place rather than appending it", () =>
    Effect.gen(function* () {
      // The supplied param wins, and it keeps the endpoint param's position —
      // so the stale value is gone, not merely shadowed.
      const url = yield* dialedUrl(`${ENDPOINT}?token=stale&keep=1`, { token: "fresh" });
      expect(url).toBe(`${ENDPOINT}?token=fresh&keep=1`);
    }),
  );

  it.effect("collapses repeats of an overwritten key to the supplied value", () =>
    Effect.gen(function* () {
      const url = yield* dialedUrl(`${ENDPOINT}?a=1&a=2`, { a: "3" });
      expect(url).toBe(`${ENDPOINT}?a=3`);
    }),
  );

  it.effect("keeps repeated keys the caller did not overwrite", () =>
    Effect.gen(function* () {
      const url = yield* dialedUrl(`${ENDPOINT}?a=1&a=2&b=3`);
      expect(url).toBe(`${ENDPOINT}?a=1&a=2&b=3`);
    }),
  );

  it.effect("re-encodes a %20 space as +", () =>
    Effect.gen(function* () {
      // Documented normalization, not an accident: `URLSearchParams` serializes
      // a space in form-urlencoded form. The decoded value is unchanged.
      const url = yield* dialedUrl(`${ENDPOINT}?token=a%20b`);
      expect(url).toBe(`${ENDPOINT}?token=a+b`);
    }),
  );

  it.effect("leaves a + space as +", () =>
    Effect.gen(function* () {
      const url = yield* dialedUrl(`${ENDPOINT}?token=a+b`);
      expect(url).toBe(`${ENDPOINT}?token=a+b`);
    }),
  );

  it.effect("percent-encodes a literal tilde", () =>
    Effect.gen(function* () {
      // `~` is legal in a raw query and is left alone by `URL`, but the
      // form-urlencoded serializer escapes it.
      const url = yield* dialedUrl(`${ENDPOINT}?sig=~tilde~`);
      expect(url).toBe(`${ENDPOINT}?sig=%7Etilde%7E`);
    }),
  );

  it.effect("gives a valueless flag a trailing =", () =>
    Effect.gen(function* () {
      const url = yield* dialedUrl(`${ENDPOINT}?debug`);
      expect(url).toBe(`${ENDPOINT}?debug=`);
    }),
  );

  it.effect("leaves an already-encoded reserved character encoded", () =>
    Effect.gen(function* () {
      const url = yield* dialedUrl(`${ENDPOINT}?a=%2B`);
      expect(url).toBe(`${ENDPOINT}?a=%2B`);
    }),
  );

  it.effect("rejects an endpoint carrying userinfo, without echoing it", () =>
    Effect.gen(function* () {
      // `user:pass@host` is a credential placement that `URL` keeps in the
      // origin, so it would ride along in `request.url` and render into every
      // `HttpClientError` message — the exact leak the query split closes.
      const seen: Array<string> = [];
      const logged: Array<string> = [];

      const error = yield* introspect("https://svc:hunter2@graph.example.test/graphql").pipe(
        Effect.flip,
        Effect.provide(clientLayer(seen)),
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              logged.push(String(options.message));
              logged.push(Cause.pretty(options.cause));
            }),
          ]),
        ),
      );

      expect(error).toBeInstanceOf(GraphqlIntrospectionError);
      expect(error.reason).toBe("invalid-endpoint");

      // Nothing was dialed, and neither the error nor the log names the secret.
      expect(seen).toHaveLength(0);
      const rendered = `${Cause.pretty(Cause.fail(error))}\n${logged.join("\n")}`;
      expect(rendered).not.toContain("hunter2");
      expect(rendered).not.toContain("svc:");
    }),
  );

  it.effect("rejects userinfo even when only a username is present", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const error = yield* introspect("https://svc@graph.example.test/graphql", undefined, {
        token: "s3cr3t",
      }).pipe(Effect.flip, Effect.provide(clientLayer(seen)), Effect.provide(silentLogger));

      expect(error.reason).toBe("invalid-endpoint");
      expect(seen).toHaveLength(0);
    }),
  );
});
