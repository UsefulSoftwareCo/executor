import * as Resource from "@effect/opentelemetry/Resource";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import { describe, expect, it } from "@effect/vitest";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { Effect, Exit, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import {
  redactSpanUrlAttributes,
  STRIPPED_QUERY_ATTRIBUTE,
  UrlRedactingSpanProcessor,
} from "./redact-span-urls";

// Synthetic placeholders only — never a real authorization code or state.
const CODE = "synthetic-authorization-code";
const STATE = "synthetic-csrf-state";

const callbackUrl = `https://app.test/api/oauth/callback?code=${CODE}&state=${STATE}&domain=example.test`;

/** Ends one real SDK span carrying `attributes` through the redacting
 *  processor, and returns what the exporter actually received. Using the real
 *  provider (rather than a hand-built span) exercises the `onEnding` → `onEnd`
 *  hook sequence exactly as production does. `configure` runs before the span
 *  ends, for recording exceptions and setting a status. */
const exportSpanWith = (
  attributes: Record<string, string>,
  configure?: (span: Span) => void,
): ReadableSpan | undefined => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new UrlRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
  });
  const span = provider.getTracer("test").startSpan("http.server GET");
  span.setAttributes(attributes);
  configure?.(span);
  span.end();
  return exporter.getFinishedSpans()[0];
};

describe("redactSpanUrlAttributes", () => {
  it("strips the authorization code and state from url.full and url.query", () => {
    const attributes: Record<string, unknown> = {
      "url.full": callbackUrl,
      "url.query": `code=${CODE}&state=${STATE}&domain=example.test`,
      "url.path": "/api/oauth/callback",
      "http.request.method": "GET",
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["code", "state"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(JSON.stringify(attributes)).not.toContain(STATE);
    // Route-level visibility is preserved.
    expect(attributes["url.path"]).toBe("/api/oauth/callback");
    expect(attributes["url.full"]).toBe("https://app.test/api/oauth/callback?domain=example.test");
    expect(attributes["url.query"]).toBe("domain=example.test");
  });

  it("strips a code nested inside the login redirect's returnTo parameter", () => {
    // `/login` is not an app-owned path, so its span comes from the worker
    // boundary — the callback query rides along inside `returnTo`
    // (auth/return-to.ts + the sign-in redirect in start.ts).
    const returnTo = encodeURIComponent(`/api/oauth/callback?code=${CODE}&state=${STATE}`);
    const attributes: Record<string, unknown> = {
      "url.full": `https://app.test/login?returnTo=${returnTo}`,
      "url.query": `returnTo=${returnTo}`,
    };

    const stripped = redactSpanUrlAttributes(attributes);

    expect(stripped).toEqual(["returnTo.code", "returnTo.state"]);
    expect(JSON.stringify(attributes)).not.toContain(CODE);
    expect(JSON.stringify(attributes)).not.toContain(STATE);
    expect(String(attributes["url.full"])).toContain("%2Fapi%2Foauth%2Fcallback");
  });

  it("leaves a span with no sensitive parameters untouched", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "https://app.test/api/integrations?owner=org",
      "url.query": "owner=org",
      "url.path": "/api/integrations",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual([]);
    expect(attributes["url.full"]).toBe("https://app.test/api/integrations?owner=org");
    expect(attributes["url.query"]).toBe("owner=org");
  });

  it("strips the other sensitive OAuth parameters", () => {
    const attributes: Record<string, unknown> = {
      "url.query":
        "id_token=synthetic-id-token&session_state=synthetic-session&error_description=synthetic-detail&error=access_denied",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual([
      "error_description",
      "id_token",
      "session_state",
    ]);
    // `error` is an enumerable code, not a secret — it stays.
    expect(attributes["url.query"]).toBe("error=access_denied");
  });

  it("drops a query parameter it has no allowlist entry for — unknown names cannot leak", () => {
    // GraphQL integrations authenticate with arbitrary query-param names
    // (`?key=…`); no blocklist can enumerate them, so the default is drop.
    const attributes: Record<string, unknown> = {
      "url.full": "https://api.test/graphql?key=synthetic-graphql-key&owner=org",
      "url.query": "key=synthetic-graphql-key&owner=org",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual(["key"]);
    expect(JSON.stringify(attributes)).not.toContain("synthetic-graphql-key");
    expect(attributes["url.full"]).toBe("https://api.test/graphql?owner=org");
    expect(attributes["url.query"]).toBe("owner=org");
  });

  it("strips userinfo from a URL attribute", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "https://svc:synthetic-basic-password@api.test/graphql",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual(["userinfo"]);
    expect(attributes["url.full"]).toBe("https://api.test/graphql");
    expect(JSON.stringify(attributes)).not.toContain("synthetic-basic-password");
  });

  it("scrubs a URL embedded in a free-text attribute", () => {
    const attributes: Record<string, unknown> = {
      "error.message": "request to https://api.test/graphql?key=synthetic-key failed",
    };

    redactSpanUrlAttributes(attributes);

    expect(attributes["error.message"]).toBe("request to https://api.test/graphql failed");
  });

  it("degrades an unparseable URL attribute instead of passing it through", () => {
    const attributes: Record<string, unknown> = {
      "url.full": "http://exa mple.test/graphql?key=synthetic-key",
    };

    expect(redactSpanUrlAttributes(attributes)).toEqual(["key"]);
    expect(attributes["url.full"]).toBe("http://exa mple.test/graphql");
  });
});

describe("UrlRedactingSpanProcessor", () => {
  it("scrubs the span before the exporter sees it", () => {
    const exported = exportSpanWith({
      "url.full": callbackUrl,
      "url.query": `code=${CODE}&state=${STATE}`,
      "url.path": "/api/oauth/callback",
    });

    expect(exported).toBeDefined();
    expect(JSON.stringify(exported?.attributes)).not.toContain(CODE);
    expect(JSON.stringify(exported?.attributes)).not.toContain(STATE);
    expect(exported?.attributes["url.path"]).toBe("/api/oauth/callback");
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBe("code,state");
  });

  it("leaves a span with no sensitive parameters unchanged", () => {
    const exported = exportSpanWith({
      "url.full": "https://app.test/api/integrations?owner=org",
      "url.query": "owner=org",
    });

    expect(exported?.attributes["url.full"]).toBe("https://app.test/api/integrations?owner=org");
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBeUndefined();
  });

  it("scrubs the URL out of exception events and the status message", () => {
    // The shape `@effect/opentelemetry` exports for a failed request:
    // `TransportError.message` embeds the raw URL, and the bridge copies it
    // into `exception.message`/`exception.stacktrace` event attributes and
    // into `status.message`.
    const message = `Transport: fetch failed (GET https://canary:synthetic-userinfo-secret@api.test/graphql?key=synthetic-key-secret)`;
    const exported = exportSpanWith({}, (span) => {
      // oxlint-disable-next-line executor/no-error-constructor -- boundary: OTel's recordException takes a plain JS Error; reproducing the bridge's exception shape IS the fixture
      span.recordException(new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
    });

    // Non-vacuous: the exception event exists and kept its scrubbed URL.
    const events = JSON.stringify(exported?.events);
    expect(events).toContain("exception");
    expect(events).toContain("https://api.test/graphql");
    expect(events).not.toContain("synthetic-userinfo-secret");
    expect(events).not.toContain("synthetic-key-secret");
    expect(exported?.status.message).toBe("Transport: fetch failed (GET https://api.test/graphql)");
  });
});

describe("credential canary — no export channel carries the secret", () => {
  const USERINFO_SECRET = "synthetic-canary-userinfo-secret";
  const KEY_SECRET = "synthetic-canary-query-key-secret";

  it.effect(
    "a failed outbound request exports no attribute, event, or status with the secret",
    () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new UrlRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
      });
      const tracerLayer = OtelTracer.layer.pipe(
        Layer.provide(Layer.succeed(OtelTracer.OtelTracerProvider)(provider)),
        Layer.provide(Resource.layer({ serviceName: "executor-cloud-test" })),
      );
      return Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;

        // Port 1 refuses immediately, so both requests fail without any network
        // dependency, and the failing error's message embeds the raw URL
        // (`TransportError.message` is "Transport: … (GET <url>)"). The secret
        // rides in userinfo and in a query parameter named `key` — a real
        // GraphQL-integration auth shape no name blocklist would catch.
        const withUserinfo = yield* client
          .get(`http://canary-user:${USERINFO_SECRET}@127.0.0.1:1/graphql?key=${KEY_SECRET}`)
          .pipe(Effect.withSpan("canary.outbound_userinfo"), Effect.exit);
        const refused = yield* client
          .get(`http://127.0.0.1:1/graphql?key=${KEY_SECRET}`)
          .pipe(Effect.withSpan("canary.outbound_refused"), Effect.exit);
        expect(Exit.isFailure(withUserinfo)).toBe(true);
        expect(Exit.isFailure(refused)).toBe(true);

        yield* Effect.promise(() => provider.forceFlush());
        const spans = exporter.getFinishedSpans();

        // Non-vacuous: the failures produced ERROR spans that recorded
        // exception events and a status message.
        const errored = spans.filter((span) => span.status.code === SpanStatusCode.ERROR);
        expect(errored.length).toBeGreaterThan(0);
        expect(errored.some((span) => span.events.length > 0)).toBe(true);
        expect(errored.some((span) => (span.status.message ?? "") !== "")).toBe(true);

        const serialized = JSON.stringify(
          spans.map((span) => ({
            name: span.name,
            attributes: span.attributes,
            events: span.events,
            status: span.status,
          })),
        );
        expect(serialized).not.toContain(USERINFO_SECRET);
        expect(serialized).not.toContain(KEY_SECRET);
        // The scrub redacts; it does not erase — the host survives for debugging.
        expect(serialized).toContain("127.0.0.1");
      }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, tracerLayer)));
    },
  );
});
