// The redaction rules themselves are tested in `@executor-js/sdk`
// (`telemetry-url-redaction.test.ts`). These tests cover the cloud-specific
// adapter: the span-processor seam every isolate span passes through on its
// way to the exporter.

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

import { STRIPPED_QUERY_ATTRIBUTE } from "@executor-js/sdk";

import { UrlRedactingSpanProcessor } from "./redact-span-urls";

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
    expect(exported?.attributes["url.full"]).toBe("https://app.test/api/oauth/callback");
    expect(exported?.attributes["url.path"]).toBe("/api/oauth/callback");
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBe("code,domain,state");
  });

  it("drops a query value regardless of its parameter name", () => {
    // Query-auth placement names are arbitrary strings — a key configured as
    // `?owner=…` is exactly as much a credential as `?key=…`.
    const exported = exportSpanWith({
      "url.full": "https://app.test/api/integrations?owner=synthetic-owner-secret",
      "url.query": "owner=synthetic-owner-secret",
    });

    expect(JSON.stringify(exported?.attributes)).not.toContain("synthetic-owner-secret");
    expect(exported?.attributes["url.full"]).toBe("https://app.test/api/integrations");
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBe("owner");
  });

  it("leaves a query-free span unchanged", () => {
    const exported = exportSpanWith({
      "url.full": "https://app.test/api/integrations",
      "url.path": "/api/integrations",
    });

    expect(exported?.attributes["url.full"]).toBe("https://app.test/api/integrations");
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBeUndefined();
  });

  it("scrubs URL-bearing link attributes", () => {
    // Span links carry attributes exactly as spans do — `ReadableSpan.links`
    // is a fourth channel to the exporter, and a link stamped with the peer's
    // URL must not export the credential the span's own attributes dropped.
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new UrlRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
    });
    const tracer = provider.getTracer("test");
    const upstream = tracer.startSpan("upstream");
    const span = tracer.startSpan("http.server GET", {
      links: [
        {
          context: upstream.spanContext(),
          attributes: {
            // Malformed on purpose: the free-text regex alone would not match
            // it, so the URL-aware attribute path must handle link attributes.
            "url.full": "http://exa mple.test/graphql?key=synthetic-link-key-secret",
            "peer.note":
              "after GET https://canary:synthetic-link-userinfo-secret@api.test/graphql?owner=synthetic-link-owner-secret",
          },
        },
      ],
    });
    span.end();
    upstream.end();

    const exported = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "http.server GET");
    const links = JSON.stringify(exported?.links);
    expect(links).not.toContain("synthetic-link-key-secret");
    expect(links).not.toContain("synthetic-link-userinfo-secret");
    expect(links).not.toContain("synthetic-link-owner-secret");
    // Non-vacuous: the link, its identity, and the scrubbed URLs survive.
    expect(exported?.links).toHaveLength(1);
    expect(links).toContain(upstream.spanContext().spanId);
    expect(links).toContain("https://api.test/graphql");
  });

  it("scrubs a credential URL inside an array attribute on the span and on a link", () => {
    // OTel attributes permit string[] values, so an array element is a fifth
    // way a credential-bearing URL reaches the exporter. The arrays are
    // planted by direct mutation: `setAttribute` sanitization would drop a
    // mixed-type array, but the processor's contract is
    // `Record<string, unknown>` — upstream bridges and hand-built
    // ReadableSpans hand it arbitrary bags.
    const SECRET = "synthetic-array-canary-secret";
    const canary = () => [`https://canary:${SECRET}@api.test/graphql?key=${SECRET}`, 42];
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new UrlRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
    });
    const tracer = provider.getTracer("test");
    const upstream = tracer.startSpan("upstream");
    const span = tracer.startSpan("http.server GET", {
      // The placeholder attribute keeps the link's bag defined — the SDK
      // normalizes an empty bag away, and the canary is planted by mutation.
      links: [{ context: upstream.spanContext(), attributes: { "peer.kind": "canary" } }],
    });
    // oxlint-disable-next-line executor/no-double-cast -- boundary: planting an out-of-contract attribute bag on the SDK span IS the fixture; no public API accepts a mixed-type array
    const bags = span as unknown as {
      attributes: Record<string, unknown>;
      links: ReadonlyArray<{ attributes?: Record<string, unknown> }>;
    };
    bags.attributes["url.full"] = canary();
    const linkAttributes = bags.links[0]?.attributes;
    expect(linkAttributes).toBeDefined();
    if (linkAttributes !== undefined) linkAttributes["peer.urls"] = canary();
    span.end();
    upstream.end();

    const exported = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "http.server GET");
    const serialized = JSON.stringify({
      attributes: exported?.attributes,
      links: exported?.links,
    });
    expect(serialized).not.toContain(SECRET);
    // Non-vacuous: the scrubbed URL and the non-string element survive.
    expect(exported?.attributes["url.full"]).toEqual(["https://api.test/graphql", 42]);
    expect(exported?.links[0]?.attributes?.["peer.urls"]).toEqual(["https://api.test/graphql", 42]);
    expect(exported?.attributes[STRIPPED_QUERY_ATTRIBUTE]).toBe("key,userinfo");
  });

  it("scrubs a credential URL inside an array attribute on a span event", () => {
    // Event attributes permit string[] exactly as span and link attributes do,
    // and the event walk redacts free text — so an array element is the same
    // channel one level down. Planted by direct mutation for the same reason
    // as the span/link array canary: `addEvent` sanitization would drop a
    // mixed-type array, but upstream bridges hand the processor arbitrary bags.
    const SECRET = "synthetic-event-array-canary-secret";
    const exported = exportSpanWith({}, (span) => {
      // The placeholder attribute keeps the event's bag defined; the canary is
      // planted by mutation.
      span.addEvent("canary", { "event.kind": "canary" });
      // oxlint-disable-next-line executor/no-double-cast -- boundary: planting an out-of-contract attribute bag on the SDK span IS the fixture; no public API accepts a mixed-type array
      const bags = span as unknown as {
        events: ReadonlyArray<{ attributes?: Record<string, unknown> }>;
      };
      const eventAttributes = bags.events[0]?.attributes;
      expect(eventAttributes).toBeDefined();
      if (eventAttributes !== undefined) {
        eventAttributes["event.urls"] = [
          `https://canary:${SECRET}@api.test/graphql?key=${SECRET}`,
          42,
        ];
      }
    });

    expect(JSON.stringify(exported?.events)).not.toContain(SECRET);
    // Non-vacuous: the scrubbed URL and the non-string element survive.
    expect(exported?.events[0]?.attributes?.["event.urls"]).toEqual([
      "https://api.test/graphql",
      42,
    ]);
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
