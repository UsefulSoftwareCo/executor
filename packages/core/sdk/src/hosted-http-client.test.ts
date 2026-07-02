import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  type HostedHostnameResolver,
  makeHostedFetch,
  makeHostedHttpClientLayer,
  validateHostedOutboundUrl,
} from "./hosted-http-client";

const publicResolver: HostedHostnameResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

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

  it.effect("rejects hostnames that resolve to local or private addresses", () =>
    Effect.gen(function* () {
      const error = yield* validateHostedOutboundUrl("https://api.example/openapi.json", {
        resolveHostname: async () => [{ address: "10.0.0.10", family: 4 }],
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(error, "HostedOutboundRequestBlocked")).toBe(true);
    }),
  );

  it.effect("checks DNS before the first fetch call", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof globalThis.fetch = (async () => {
        calls++;
        return new Response("unexpected", { status: 200 });
      }) as typeof globalThis.fetch;

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://api.example/start"));
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({
            fetch: fakeFetch,
            resolveHostname: async () => [{ address: "169.254.169.254", family: 4 }],
          }),
        ),
        Effect.result,
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(0);
    }),
  );

  it("applies the DNS guard to fetch callers", async () => {
    let calls = 0;
    const hostedFetch = makeHostedFetch({
      fetch: (async () => {
        calls++;
        return new Response("unexpected", { status: 200 });
      }) as typeof globalThis.fetch,
      resolveHostname: async () => [{ address: "10.0.0.20", family: 4 }],
    });

    await expect(hostedFetch("https://api.example/token")).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
    });
    expect(calls).toBe(0);
  });

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
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({ fetch: fakeFetch, resolveHostname: publicResolver }),
        ),
        Effect.result,
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(1);
    }),
  );

  it.effect("follows cross-origin redirects but strips credential headers", () =>
    Effect.gen(function* () {
      const seen: Array<{
        url: string;
        authorization: string | null;
        cookie: string | null;
      }> = [];
      const fakeFetch: typeof globalThis.fetch = (async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(init?.headers);
        seen.push({
          url,
          authorization: headers.get("authorization"),
          cookie: headers.get("cookie"),
        });
        if (url === "https://api.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example/blob" },
          });
        }
        return new Response("bytes", { status: 200 });
      }) as typeof globalThis.fetch;

      const response = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(
          HttpClientRequest.get("https://api.example/start").pipe(
            HttpClientRequest.setHeaders({
              authorization: "Bearer secret",
              cookie: "session=abc",
              accept: "application/octet-stream",
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({ fetch: fakeFetch, resolveHostname: publicResolver }),
        ),
      );

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({
        url: "https://api.example/start",
        authorization: "Bearer secret",
        cookie: "session=abc",
      });
      expect(seen[1]).toMatchObject({
        url: "https://cdn.example/blob",
        authorization: null,
        cookie: null,
      });
    }),
  );

  it.effect("keeps credential headers on same-origin redirects", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; authorization: string | null }> = [];
      const fakeFetch: typeof globalThis.fetch = (async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        seen.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url === "https://api.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "/moved" },
          });
        }
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch;

      const response = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(
          HttpClientRequest.get("https://api.example/start").pipe(
            HttpClientRequest.setHeaders({ authorization: "Bearer secret" }),
          ),
        );
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({ fetch: fakeFetch, resolveHostname: publicResolver }),
        ),
      );

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toMatchObject({
        url: "https://api.example/moved",
        authorization: "Bearer secret",
      });
    }),
  );

  it.effect("rejects cross-origin redirects to private addresses", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof globalThis.fetch = (async (input) => {
        calls++;
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://api.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        return new Response("unexpected", { status: 200 });
      }) as typeof globalThis.fetch;

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://api.example/start"));
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({ fetch: fakeFetch, resolveHostname: publicResolver }),
        ),
        Effect.result,
      );

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(1);
    }),
  );
});
