// ---------------------------------------------------------------------------
// Introspection must not log a credential carried in the query string.
//
// `query` is a supported credential carrier, so a GraphQL endpoint can be
// reached with `?token=<secret>`. Introspection logs the raw failure cause on
// any transport error, and every `HttpClientError` renders `${method}
// ${request.url}` into its message — so if the request is built from a URL
// STRING, the secret is inside that message and goes straight to the log.
//
// Building the request from a URL OBJECT moves the query into
// `request.urlParams`, out of `request.url` and therefore out of the message,
// while the client still recombines the two when it executes.
//
// Both directions are asserted. A test that only checked "the secret is absent"
// would pass just as happily against a logger that captured nothing at all, or
// a change that stopped sending the parameter entirely.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { GraphqlIntrospectionError } from "./errors";
import { introspect } from "./introspect";

const SECRET = "tok_live_introspection_MUST_NOT_LOG";
const ENDPOINT = "https://graph.example.test/graphql";

/** Collects everything a logger would have written, message and cause alike —
 *  `Cause.pretty` is the renderer that rebuilds the first line from the error's
 *  live `message` getter, which is the exact path the leak took. */
const capturingLogger = (sink: Array<string>) =>
  Logger.make<unknown, void>((options) => {
    sink.push(String(options.message));
    sink.push(Cause.pretty(options.cause));
  });

/** A fetch that records the URL it was handed and then fails at the transport
 *  layer, which is what drives introspection down its logging path. */
const failingFetch = (seen: Array<string>): typeof globalThis.fetch =>
  (async (input: RequestInfo | URL) => {
    seen.push(input instanceof Request ? input.url : String(input));
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the platform fetch rejecting on a dead host
    throw new Error("getaddrinfo ENOTFOUND graph.example.test");
  }) as typeof globalThis.fetch;

const clientLayer = (seen: Array<string>) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(failingFetch(seen))),
  );

describe("GraphQL introspection credential logging", () => {
  it.effect("does not write a query-carried credential to the log", () =>
    Effect.gen(function* () {
      const logged: Array<string> = [];
      const seen: Array<string> = [];

      yield* introspect(ENDPOINT, undefined, { token: SECRET }).pipe(
        Effect.flip,
        Effect.provide(clientLayer(seen)),
        Effect.provide(Logger.layer([capturingLogger(logged)])),
      );

      const output = logged.join("\n");

      // Positive control FIRST: prove the logger actually captured the failure.
      // Without this, an empty capture would satisfy every assertion below.
      expect(output).toContain("graphql introspection request failed");
      expect(output).toContain("graph.example.test");

      // The credential is absent from everything that was logged.
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain("token=");
    }),
  );

  it.effect("still sends the query-carried credential on the wire", () =>
    Effect.gen(function* () {
      const logged: Array<string> = [];
      const seen: Array<string> = [];

      yield* introspect(ENDPOINT, undefined, { token: SECRET }).pipe(
        Effect.flip,
        Effect.provide(clientLayer(seen)),
        Effect.provide(Logger.layer([capturingLogger(logged)])),
      );

      // Keeping it out of the log is only correct if it still reaches the
      // upstream — otherwise this "fix" silently breaks authentication.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(`token=${SECRET}`);
    }),
  );

  it.effect("keeps a credential carried in the endpoint's own query out of the log", () =>
    Effect.gen(function* () {
      // A configured endpoint can carry the secret itself, with no separate
      // queryParams argument at all.
      const logged: Array<string> = [];
      const seen: Array<string> = [];

      yield* introspect(`${ENDPOINT}?token=${SECRET}`).pipe(
        Effect.flip,
        Effect.provide(clientLayer(seen)),
        Effect.provide(Logger.layer([capturingLogger(logged)])),
      );

      const output = logged.join("\n");
      expect(output).toContain("graphql introspection request failed");
      expect(output).not.toContain(SECRET);
      expect(seen[0]).toContain(`token=${SECRET}`);
    }),
  );

  it.effect("fails a malformed endpoint instead of dialing it without the query params", () =>
    Effect.gen(function* () {
      // Only a parseable endpoint can carry the query in `urlParams`. An
      // unparseable one must fail rather than quietly dial without the
      // credential it was told to send.
      const logged: Array<string> = [];
      const seen: Array<string> = [];

      const error = yield* introspect("not a url", undefined, { token: SECRET }).pipe(
        Effect.flip,
        Effect.provide(clientLayer(seen)),
        Effect.provide(Logger.layer([capturingLogger(logged)])),
      );

      expect(error).toBeInstanceOf(GraphqlIntrospectionError);
      expect(error.reason).toBe("invalid-endpoint");

      // Nothing was sent: no request at all, rather than one missing the token.
      expect(seen).toHaveLength(0);
      // And the rejection itself does not echo the credential anywhere.
      expect(Cause.pretty(Cause.fail(error))).not.toContain(SECRET);
      expect(logged.join("\n")).not.toContain(SECRET);
    }),
  );
});
