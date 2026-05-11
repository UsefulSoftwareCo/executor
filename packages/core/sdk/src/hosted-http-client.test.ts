import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { makeHostedHttpClientLayer, validateHostedOutboundUrl } from "./hosted-http-client";

describe("hosted outbound HTTP client", () => {
  it.effect("allows public HTTP and HTTPS URLs", () =>
    Effect.gen(function* () {
      yield* validateHostedOutboundUrl("https://example.com/openapi.json");
      yield* validateHostedOutboundUrl("http://example.com/graphql");
    }),
  );

  it.effect("rejects local and private network URLs", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://10.0.0.1/openapi.json",
        "http://172.16.0.1/graphql",
        "http://192.168.1.10/mcp",
        "http://169.254.169.254/latest/meta-data/",
      ]) {
        const error = yield* validateHostedOutboundUrl(url).pipe(Effect.flip);
        expect(Predicate.isTagged(error, "HostedOutboundRequestBlocked")).toBe(true);
      }
    }),
  );

  it.effect("rejects IPv4-mapped IPv6 URLs for local and private networks", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://[::ffff:127.0.0.1]:3000",
        "http://[::ffff:10.0.0.1]/openapi.json",
        "http://[::ffff:172.16.0.1]/graphql",
        "http://[::ffff:192.168.1.10]/mcp",
        "http://[::ffff:169.254.169.254]/latest/meta-data/",
      ]) {
        const error = yield* validateHostedOutboundUrl(url).pipe(Effect.flip);
        expect(Predicate.isTagged(error, "HostedOutboundRequestBlocked")).toBe(true);
      }
    }),
  );

  it.effect("can allow local network URLs explicitly", () =>
    Effect.gen(function* () {
      yield* validateHostedOutboundUrl("http://127.0.0.1:3000", {
        allowLocalNetwork: true,
      });
    }),
  );

  it.effect("checks redirected URLs before following them", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof globalThis.fetch = (async (input) => {
        calls++;
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://public.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:3000/internal" },
          });
        }
        return new Response("unexpected", { status: 200 });
      }) as typeof globalThis.fetch;
      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://public.example/start"));
      }).pipe(Effect.provide(makeHostedHttpClientLayer({ fetch: fakeFetch })), Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(1);
    }),
  );

  it.effect("rejects cross-origin redirects before following them", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof globalThis.fetch = (async (input) => {
        calls++;
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://api.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.example/next" },
          });
        }
        return new Response("unexpected", { status: 200 });
      }) as typeof globalThis.fetch;

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://api.example/start"));
      }).pipe(Effect.provide(makeHostedHttpClientLayer({ fetch: fakeFetch })), Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(1);
    }),
  );
});
