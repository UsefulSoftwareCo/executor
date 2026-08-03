import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  type HostedHostnameResolver,
  makeHostedFetch,
  makeHostedHttpClientLayer,
  validateHostedOutboundUrl,
} from "./hosted-http-client";

const publicResolver: HostedHostnameResolver = async () => [{ address: "93.184.216.34" }];

// Reproduces the raw Promise rejection node:dns/promises produces at the
// adapter boundary under test. The rejection value is deliberately opaque:
// the guard discards it and maps every failure to the same tagged error, so
// carrying a getaddrinfo code here would imply a distinction that is not made.
const nodeDnsRejection = (): Promise<never> =>
  // oxlint-disable-next-line executor/no-promise-reject -- boundary: fixture mirrors the raw Promise rejection node:dns produces
  Promise.reject("getaddrinfo failure");

// The guard error is thrown inside the fetch adapter, so the HttpClient
// surfaces it wrapped in a RequestError whose cause is the blocked error.
const expectBlocked = (result: Result.Result<unknown, unknown>, reason: string) => {
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { cause: { _tag: "HostedOutboundRequestBlocked", reason } },
  });
};

describe("hosted outbound HTTP client", () => {
  it.effect("allows public HTTP and HTTPS URLs", () =>
    Effect.gen(function* () {
      yield* validateHostedOutboundUrl("https://example.com/openapi.json", {
        resolveHostname: publicResolver,
      });
      yield* validateHostedOutboundUrl("http://example.com/graphql", {
        resolveHostname: publicResolver,
      });
    }),
  );

  it.effect("rejects non-HTTP protocols", () =>
    Effect.gen(function* () {
      for (const url of ["file:///etc/passwd", "data:text/plain,x", "gopher://example.com/"]) {
        const error = yield* validateHostedOutboundUrl(url).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Only HTTP and HTTPS outbound requests are allowed",
        });
      }
    }),
  );

  // One representative per arm of the IPv4 blocklist, so deleting any range
  // turns a test red: this-network, loopback, RFC1918 x3, CGNAT, link-local,
  // 192.0.0.0/24, benchmark, multicast.
  it.effect("rejects local and private network URLs", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://localhost:3000",
        // The subdomain form is what a dev server or local reverse proxy
        // actually hands out, and it never reaches the resolved-address check.
        "http://app.localhost/",
        // WHATWG keeps every trailing dot, so a hostname stripped of only one
        // stays unequal to "localhost" and skips the whole name check while
        // still resolving to the same host.
        "http://localhost../",
        "http://0.0.0.0/",
        "http://127.0.0.1:3000",
        "http://10.0.0.1/openapi.json",
        "http://100.64.0.1/",
        "http://169.254.1.1/",
        "http://172.16.0.1/graphql",
        "http://192.0.0.1/",
        "http://192.168.1.10/mcp",
        "http://198.18.0.1/",
        "http://224.0.0.1/",
      ]) {
        // The public resolver pins WHICH rule blocked: were these to slip
        // past the pre-resolution check, resolution would succeed with a
        // public address and the URL would be allowed, failing the test.
        const error = yield* validateHostedOutboundUrl(url, {
          resolveHostname: publicResolver,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Local and private network addresses are not allowed",
        });
      }
      // The second entry is the same name with a second root dot appended:
      // the resolver treats it identically, so stripping only one dot would
      // let the metadata endpoint through by adding one character.
      for (const url of [
        "http://169.254.169.254/latest/meta-data/",
        "http://metadata.google.internal../computeMetadata/v1/",
      ]) {
        const metadataError = yield* validateHostedOutboundUrl(url, {
          // allowLocalNetwork isolates the metadata arm: without it the
          // local/private check would block the name first and the test would
          // pass whether or not the trailing dots were handled.
          allowLocalNetwork: true,
          resolveHostname: publicResolver,
        }).pipe(Effect.flip);
        expect(metadataError).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Metadata service addresses are not allowed",
        });
      }
    }),
  );

  it.effect("rejects native IPv6 loopback, link-local, ULA and multicast URLs", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://[::1]/",
        "http://[::]/",
        "http://[fe80::1]/",
        "http://[fd00::1]/",
        "http://[ff02::1]/",
        "http://[0:0:0:0:0:0:0:1]/",
      ]) {
        const error = yield* validateHostedOutboundUrl(url).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Local and private network addresses are not allowed",
        });
      }
    }),
  );

  // Every prefix that carries an IPv4 destination in its low 32 bits must be
  // classified by that destination. Reading the first non-empty group instead
  // would let "::169.254.169.254" — which starts with six zero words, not with
  // 0xa9fe — straight through to the metadata service.
  it.effect("rejects IPv6 literals that embed a private IPv4 address", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://[::169.254.169.254]/latest/meta-data/",
        "http://[::127.0.0.1]/",
        "http://[::10.0.0.1]/",
        "http://[64:ff9b::169.254.169.254]/",
        "http://[64:ff9b::127.0.0.1]/",
        // RFC 6052 IPv4-translatable (::ffff:0:0:0/96), 6to4 (2002::/16), and
        // RFC 8215 local-use NAT64 (64:ff9b:1::/48) each reach an embedded or
        // locally translated IPv4 destination too. Being address literals they
        // skip the resolved-address check entirely, so classifying them by
        // their own prefix is the whole guard, not one layer of it.
        "http://[::ffff:0:7f00:1]/",
        "http://[::ffff:0:a9fe:a9fe]/latest/meta-data/",
        "http://[2002:a9fe:a9fe::]/latest/meta-data/",
        "http://[2002:7f00:1::]/",
        "http://[64:ff9b:1::a9fe:a9fe]/",
      ]) {
        const error = yield* validateHostedOutboundUrl(url, {
          resolveHostname: publicResolver,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Local and private network addresses are not allowed",
        });
      }
    }),
  );

  // The mirror of the case above: classification reads the leading word, so a
  // public address keeps being allowed even when a *later* word spells a
  // blocked prefix — "2001:db8::fe80" is public, not link-local — and a
  // v4-compatible address to a public destination is allowed like its
  // v4-mapped equivalent.
  it.effect("allows IPv6 literals whose leading word is public", () =>
    Effect.gen(function* () {
      yield* validateHostedOutboundUrl("http://[2001:db8::fe80]/", {
        resolveHostname: publicResolver,
      });
      yield* validateHostedOutboundUrl("http://[::93.184.216.34]/", {
        resolveHostname: publicResolver,
      });
      // The added prefixes are classified by their embedded destination, not
      // blocked wholesale — 93.184.216.34 is 5db8:d822.
      yield* validateHostedOutboundUrl("http://[::ffff:0:5db8:d822]/", {
        resolveHostname: publicResolver,
      });
      yield* validateHostedOutboundUrl("http://[2002:5db8:d822::]/", {
        resolveHostname: publicResolver,
      });
    }),
  );

  // A resolved address the classifiers cannot decode is not evidence that the
  // destination is public — it is the guard admitting it cannot tell. Treating
  // it as "not private" would route every address these parsers reject
  // straight past the one check that exists to stop it.
  it.effect("rejects resolved addresses it cannot classify", () =>
    Effect.gen(function* () {
      for (const address of ["not-an-address", "10.0.0.1.5", "1:2:3:4:5:6:7:8:9", "::gggg"]) {
        const error = yield* validateHostedOutboundUrl("https://api.example/x", {
          resolveHostname: async () => [{ address }],
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Resolved address is local or private",
        });
      }
    }),
  );

  // node:dns can hand back a link-local address carrying its interface scope.
  // The zone identifier is not part of the address and must not defeat the
  // classification of the address it is attached to.
  it.effect("rejects resolved IPv6 addresses that carry a zone identifier", () =>
    Effect.gen(function* () {
      const error = yield* validateHostedOutboundUrl("https://api.example/x", {
        resolveHostname: async () => [{ address: "fe80::1%eth0" }],
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "HostedOutboundRequestBlocked",
        reason: "Resolved address is local or private",
      });

      // The blocked case alone cannot tell "zone stripped, then classified
      // link-local" from "parse failed, unclassifiable" — both reach the same
      // reason. A public zoned address is only allowed when the zone is
      // genuinely stripped before classification.
      yield* validateHostedOutboundUrl("https://api.example/x", {
        resolveHostname: async () => [{ address: "2001:db8::1%eth0" }],
      });
    }),
  );

  // The tagged error is the guard's contract: a malformed URL has to arrive as
  // a typed block, not as a raw TypeError escaping as an untyped defect.
  it.effect("rejects input that is not a URL", () =>
    Effect.gen(function* () {
      const error = yield* validateHostedOutboundUrl("not a url").pipe(Effect.flip);
      // The url field is asserted, not just the reason: it is the only part of
      // the error telling an operator which destination was refused.
      expect(error).toMatchObject({
        _tag: "HostedOutboundRequestBlocked",
        reason: "URL is invalid",
        url: "not a url",
      });
    }),
  );

  // The root dot is the same name to a resolver but a different string, so an
  // exact-match blocklist that skipped canonicalization would be defeated by
  // appending one character. This check sits above the allowLocalNetwork gate
  // deliberately — it is the one rule that holds even in self-host mode, which
  // is exactly where the bypass would be reachable.
  it.effect("blocks metadata hostnames written with a trailing root dot", () =>
    Effect.gen(function* () {
      for (const hostname of ["metadata.google.internal.", "metadata.", "instance-data."]) {
        const error = yield* validateHostedOutboundUrl(`http://${hostname}/latest/meta-data/`, {
          allowLocalNetwork: true,
          resolveHostname: async () => [{ address: "169.254.169.254" }],
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Metadata service addresses are not allowed",
        });
      }
    }),
  );

  // The named metadata hostnames are the classic cloud SSRF vector; they are
  // blocked before resolution, so no resolver is consulted.
  it.effect("rejects metadata service hostnames without resolving them", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://metadata/",
        "http://instance-data/",
      ]) {
        const resolved: string[] = [];
        const error = yield* validateHostedOutboundUrl(url, {
          resolveHostname: async (hostname) => {
            resolved.push(hostname);
            return [{ address: "93.184.216.34" }];
          },
        }).pipe(Effect.flip);
        expect(resolved).toEqual([]);
        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Metadata service addresses are not allowed",
        });
      }
    }),
  );

  it.effect("rejects hostnames that resolve to no addresses", () =>
    Effect.gen(function* () {
      const error = yield* validateHostedOutboundUrl("https://api.example/openapi.json", {
        resolveHostname: async () => [],
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "HostedOutboundRequestBlocked",
        reason: "Hostname did not resolve to an address",
      });
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
        const error = yield* validateHostedOutboundUrl(url, {
          resolveHostname: publicResolver,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "HostedOutboundRequestBlocked",
          reason: "Local and private network addresses are not allowed",
        });
      }
    }),
  );

  // Guards against over-blocking, not under-blocking: an embedded-IPv4 prefix
  // is only a container, so it must be classified by the address it carries
  // rather than treated as suspicious in itself. Deleting embeddedIpv4 does
  // NOT turn this red — these prefixes start with 0x0000/0x0064 and match none
  // of the first-word masks — so this pins the allow behavior against a future
  // change that blanket-blocks the prefix. The block path embeddedIpv4 does
  // carry is covered by "rejects IPv6 literals that embed a private IPv4".
  it.effect("allows IPv4-mapped IPv6 URLs for public addresses", () =>
    validateHostedOutboundUrl("http://[::ffff:93.184.216.34]/openapi.json"),
  );

  it.effect("can allow local network URLs explicitly", () =>
    validateHostedOutboundUrl("http://127.0.0.1:3000", { allowLocalNetwork: true }),
  );

  it.effect("rejects hostnames that resolve to local or private addresses", () =>
    Effect.gen(function* () {
      const error = yield* validateHostedOutboundUrl("https://api.example/openapi.json", {
        resolveHostname: async () => [{ address: "10.0.0.10" }],
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "HostedOutboundRequestBlocked",
        reason: "Resolved address is local or private",
      });
    }),
  );

  // A hostname may hold several A records, and an attacker only needs one of
  // them to point inside. Every address the name resolves to has to clear the
  // check, not just the first one the resolver happened to order first —
  // checking only `addresses[0]` leaves the rest of this file green.
  it.effect("rejects a hostname whose records mix a public address with a private one", () =>
    Effect.gen(function* () {
      const error = yield* validateHostedOutboundUrl("https://api.example/openapi.json", {
        resolveHostname: async () => [{ address: "93.184.216.34" }, { address: "169.254.169.254" }],
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "HostedOutboundRequestBlocked",
        reason: "Resolved address is local or private",
      });
    }),
  );

  // "beef.cafe" is a registrable DNS name spelled entirely in hex digits and
  // dots. It must go through resolution like any other hostname; treating it
  // as an address literal would skip the resolved-address check entirely.
  it.effect("resolves hex-digit hostnames instead of treating them as IP literals", () =>
    Effect.gen(function* () {
      const resolved: string[] = [];
      const error = yield* validateHostedOutboundUrl("https://beef.cafe/x", {
        resolveHostname: async (hostname) => {
          resolved.push(hostname);
          return [{ address: "169.254.169.254" }];
        },
      }).pipe(Effect.flip);

      expect(resolved).toEqual(["beef.cafe"]);
      expect(error).toMatchObject({
        _tag: "HostedOutboundRequestBlocked",
        reason: "Resolved address is local or private",
      });
    }),
  );

  it.effect("checks DNS before the first fetch call", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof globalThis.fetch = async () => {
        calls++;
        return new Response("unexpected", { status: 200 });
      };

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://api.example/start"));
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({
            fetch: fakeFetch,
            resolveHostname: async () => [{ address: "169.254.169.254" }],
          }),
        ),
        Effect.result,
      );

      expectBlocked(result, "Resolved address is local or private");
      expect(calls).toBe(0);
    }),
  );

  it("applies the DNS guard to fetch callers", async () => {
    let calls = 0;
    const underlying: typeof globalThis.fetch = async () => {
      calls++;
      return new Response("unexpected", { status: 200 });
    };
    const hostedFetch = makeHostedFetch({
      fetch: underlying,
      resolveHostname: async () => [{ address: "10.0.0.20" }],
    });

    await expect(hostedFetch("https://api.example/token")).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Resolved address is local or private",
    });
    expect(calls).toBe(0);
  });

  it("fails the request when the hostname cannot be resolved", async () => {
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("unexpected"),
      resolveHostname: () => nodeDnsRejection(),
    });

    await expect(hostedFetch("https://api.example/token")).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Hostname could not be resolved",
    });
  });

  // Omitting resolveHostname must not silently drop the resolved-address
  // check: the default adapter is the one that ships. The label is longer
  // than the 63 octets RFC 1035 allows, so getaddrinfo rejects it structurally
  // without emitting a query — the assertion cannot be flipped by a resolver
  // that wildcards NXDOMAIN, and it touches no network.
  it("uses the node:dns resolver when none is supplied", async () => {
    let calls = 0;
    const hostedFetch = makeHostedFetch({
      fetch: async () => {
        calls++;
        return new Response("unexpected");
      },
    });
    const overlongLabel = `${"a".repeat(300)}.example.com`;

    await expect(hostedFetch(`https://${overlongLabel}/x`)).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Hostname could not be resolved",
    });
    expect(calls).toBe(0);
  });

  it("resolves each hostname once per adapter within the cache window", async () => {
    const resolved: string[] = [];
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async (hostname) => {
        resolved.push(hostname);
        return [{ address: "93.184.216.34" }];
      },
    });

    await hostedFetch("https://api.example/one");
    await hostedFetch("https://api.example/two");
    await hostedFetch("https://cdn.example/blob");

    expect(resolved).toEqual(["api.example", "cdn.example"]);
  });

  // The cache is per adapter on purpose (see withResolutionCache): the MCP host
  // builds one per session, so a verdict reached in one session must not decide
  // requests in another. Hoisting the Cache to module scope — the shape that
  // makes this shared — keeps every other cache test green.
  it("keeps one adapter's cached resolutions out of another's", async () => {
    const makeCounting = () => {
      const resolved: string[] = [];
      const hostedFetch = makeHostedFetch({
        fetch: async () => new Response("ok"),
        resolveHostname: async (hostname) => {
          resolved.push(hostname);
          return [{ address: "93.184.216.34" }];
        },
      });
      return { hostedFetch, resolved };
    };

    const first = makeCounting();
    const second = makeCounting();

    await first.hostedFetch("https://api.example/one");
    await second.hostedFetch("https://api.example/two");

    expect(first.resolved).toEqual(["api.example"]);
    expect(second.resolved).toEqual(["api.example"]);
  });

  it("re-resolves a hostname after the cache window elapses", async () => {
    const resolved: string[] = [];
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async (hostname) => {
        resolved.push(hostname);
        return [{ address: "93.184.216.34" }];
      },
      dnsCacheTtlMillis: 20,
    });

    await hostedFetch("https://api.example/one");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await hostedFetch("https://api.example/two");

    expect(resolved).toEqual(["api.example", "api.example"]);
  });

  it("evicts the oldest hostname when the cache capacity is exceeded", async () => {
    const resolved: string[] = [];
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async (hostname) => {
        resolved.push(hostname);
        return [{ address: "93.184.216.34" }];
      },
      dnsCacheCapacity: 1,
    });

    await hostedFetch("https://api.example/one");
    await hostedFetch("https://cdn.example/blob");
    await hostedFetch("https://api.example/two");

    expect(resolved).toEqual(["api.example", "cdn.example", "api.example"]);
  });

  it("does not cache failed resolutions", async () => {
    let attempts = 0;
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async () => {
        attempts++;
        if (attempts === 1) return nodeDnsRejection();
        return [{ address: "93.184.216.34" }];
      },
    });

    await expect(hostedFetch("https://api.example/one")).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
    });
    const response = await hostedFetch("https://api.example/two");

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("shares one in-flight resolution across concurrent requests", async () => {
    let resolutions = 0;
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async () => {
        resolutions++;
        entered.resolve();
        await gate.promise;
        return [{ address: "93.184.216.34" }];
      },
    });

    // The second request is issued only once the first is provably inside the
    // resolver, so a single resolution can only mean it joined the in-flight
    // lookup. Firing both at once and counting would also pass if the second
    // simply arrived after the first settled and hit the TTL cache.
    const first = hostedFetch("https://api.example/one");
    await entered.promise;
    const second = hostedFetch("https://api.example/two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve();
    await Promise.all([first, second]);

    expect(resolutions).toBe(1);
  });

  // Concurrent callers share one resolution, so aborting one must not cancel
  // the lookup the others are waiting on. The survivor's outcome is the whole
  // point: before the shared lookup was detached from the requesting fiber it
  // failed with an untyped "All fibers interrupted without error".
  it("keeps concurrent requests alive when one caller aborts", async () => {
    let resolutions = 0;
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async () => {
        resolutions++;
        entered.resolve();
        await gate.promise;
        return [{ address: "93.184.216.34" }];
      },
    });

    const aborter = new AbortController();
    const aborted = hostedFetch("https://api.example/one", { signal: aborter.signal });
    const survivor = hostedFetch("https://api.example/two");
    // Gate on the resolver itself having been entered, not on a microtask tick:
    // the lookup sits behind runPromise plus forkDetach, so a bare `await` does
    // not reach it and the abort would land before the work it must not kill.
    await entered.promise;
    aborter.abort();
    gate.resolve();

    // Asserting the shape, not merely that it threw: the regression this test
    // exists to exclude also throws, so a bare toThrow() would accept it.
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect((await survivor).status).toBe(200);
    expect(resolutions).toBe(1);
  });

  // The guard's verdict is decided by the failure's cause, not by whether the
  // caller's signal happens to be aborted. Branching on `signal.aborted`
  // instead reclassifies a real SSRF block as an AbortError — which callers
  // read as a transport failure and retry — and keeps every test above green.
  it("reports a blocked URL as a guard failure even when the caller has aborted", async () => {
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async () => [{ address: "93.184.216.34" }],
    });

    const aborter = new AbortController();
    const blocked = hostedFetch("http://169.254.169.254/latest/meta-data", {
      signal: aborter.signal,
    });
    aborter.abort();

    await expect(blocked).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Metadata service addresses are not allowed",
    });
  });

  // A pending cache entry carries no expiry, so without a bound on the lookup
  // itself one stuck resolution would leave every later request for that
  // hostname joining the same dead Deferred for the adapter's lifetime.
  it("recovers from a resolution that never settles", async () => {
    let attempts = 0;
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response("ok"),
      resolveHostname: async () => {
        attempts++;
        if (attempts === 1) return new Promise<never>(() => {});
        return [{ address: "93.184.216.34" }];
      },
      dnsResolutionTimeoutMillis: 20,
    });

    await expect(hostedFetch("https://api.example/one")).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Hostname could not be resolved",
    });
    const response = await hostedFetch("https://api.example/two");

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("stops following redirects at the maxRedirects bound", async () => {
    let calls = 0;
    const alwaysRedirect: typeof globalThis.fetch = async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "/next" } });
    };
    const hostedFetch = makeHostedFetch({
      fetch: alwaysRedirect,
      resolveHostname: publicResolver,
      maxRedirects: 3,
    });

    const response = await hostedFetch("https://api.example/start");

    expect(calls).toBe(4);
    expect(response.status).toBe(302);
  });

  it("rejects redirects whose Location header is not a valid URL", async () => {
    const hostedFetch = makeHostedFetch({
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://[bad" } }),
      resolveHostname: publicResolver,
    });

    await expect(hostedFetch("https://api.example/start")).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Redirect target is not a valid URL",
    });
  });

  // Every redirect rule below is downstream of one instruction: the adapter
  // must ask the transport not to follow 3xx itself. A real fetch left on its
  // default follows internally, so hops 2..n are never re-validated and none of
  // the stripping runs — the guard sees one request and an already-followed
  // response. The fakes here cannot show that, so the mode is asserted directly.
  it("tells the transport not to follow redirects on any hop", async () => {
    const modes: Array<RequestRedirect | undefined> = [];
    const underlying: typeof globalThis.fetch = async (input, init) => {
      modes.push(init?.redirect);
      if (String(input) === "https://api.example/start") {
        return new Response(null, { status: 302, headers: { location: "/moved" } });
      }
      return new Response("ok", { status: 200 });
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });

    await hostedFetch("https://api.example/start");

    expect(modes).toEqual(["manual", "manual"]);
  });

  it("demotes POST to GET and drops the body on a 302 redirect", async () => {
    const seen: Array<{
      url: string;
      method: string;
      hasBody: boolean;
      contentType: string | null;
      contentLength: string | null;
      contentEncoding: string | null;
      contentLanguage: string | null;
    }> = [];
    const underlying: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        method: init?.method ?? "GET",
        hasBody: init?.body !== undefined && init?.body !== null,
        contentType: headers.get("content-type"),
        contentLength: headers.get("content-length"),
        contentEncoding: headers.get("content-encoding"),
        contentLanguage: headers.get("content-language"),
      });
      if (url === "https://api.example/start") {
        return new Response(null, { status: 302, headers: { location: "/see-here" } });
      }
      return new Response("ok", { status: 200 });
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });

    await hostedFetch("https://api.example/start", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "25",
        "content-encoding": "gzip",
        "content-language": "en",
      },
      body: "client_secret=supersecret",
    });

    expect(seen).toHaveLength(2);
    // One representative per content header the demotion drops: a bodyless GET
    // still advertising content-length: 25 reads as a truncated request, and
    // the upstream 4xx gets blamed on the caller.
    expect(seen[1]).toMatchObject({
      url: "https://api.example/see-here",
      method: "GET",
      hasBody: false,
      contentType: null,
      contentLength: null,
      contentEncoding: null,
      contentLanguage: null,
    });
  });

  // Integrations render credentials into arbitrary header names, so a
  // cross-origin hop keeps only a known-safe set. A 302 demotes the POST
  // first, so by the time the hop is taken there is no body left to leak.
  it("strips non-safelisted headers and the body on cross-origin redirects", async () => {
    const seen: Array<{
      url: string;
      apiKey: string | null;
      accept: string | null;
      acceptLanguage: string | null;
      userAgent: string | null;
      hasBody: boolean;
    }> = [];
    const underlying: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        apiKey: headers.get("x-api-key"),
        accept: headers.get("accept"),
        acceptLanguage: headers.get("accept-language"),
        userAgent: headers.get("user-agent"),
        hasBody: init?.body !== undefined && init?.body !== null,
      });
      if (url === "https://api.example/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/collect" },
        });
      }
      return new Response("ok", { status: 200 });
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });

    await hostedFetch("https://api.example/start", {
      method: "POST",
      headers: {
        "x-api-key": "rendered-credential",
        accept: "application/json",
        "accept-language": "en-GB",
        "user-agent": "executor-test",
      },
      body: "client_secret=supersecret",
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ apiKey: "rendered-credential", hasBody: true });
    // One representative per safelisted header: dropping user-agent on a hop
    // changes what the upstream serves — bot rules, content negotiation — so
    // the safelist is a contract, not an implementation detail.
    expect(seen[1]).toMatchObject({
      url: "https://evil.example/collect",
      apiKey: null,
      accept: "application/json",
      acceptLanguage: "en-GB",
      userAgent: "executor-test",
      hasBody: false,
    });
  });

  // Origin is scheme plus host, and the scheme half is the half that matters
  // here: comparing hosts alone would call an https -> http hop to the same
  // name same-origin and replay the credential headers over plaintext.
  it("treats a scheme downgrade to the same host as cross-origin", async () => {
    const seen: Array<{ url: string; apiKey: string | null }> = [];
    const underlying: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, apiKey: new Headers(init?.headers).get("x-api-key") });
      if (url === "https://api.example/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://api.example/moved" },
        });
      }
      return new Response("ok", { status: 200 });
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });

    await hostedFetch("https://api.example/start", {
      headers: { "x-api-key": "rendered-credential" },
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ url: "http://api.example/moved", apiKey: null });
  });

  // A 307/308 keeps the method, so stripping the body would send a bodyless
  // POST the caller never wrote and blame the upstream for the resulting 4xx.
  // The body cannot cross origins either, so the hop is refused outright.
  it("refuses a cross-origin redirect that would replay a body", async () => {
    let calls = 0;
    const underlying: typeof globalThis.fetch = async (input) => {
      calls++;
      if (String(input) === "https://api.example/start") {
        return new Response(null, {
          status: 307,
          headers: { location: "https://evil.example/collect" },
        });
      }
      return new Response("unexpected", { status: 200 });
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });

    await expect(
      hostedFetch("https://api.example/start", {
        method: "POST",
        headers: { "x-api-key": "rendered-credential" },
        body: "client_secret=supersecret",
      }),
    ).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Cross-origin redirect cannot replay a request body",
    });
    expect(calls).toBe(1);
  });

  // A stream reads once, so replaying the same object on the next hop sends an
  // empty body and still returns 200 — the caller's upload silently truncated.
  // The hop is refused rather than buffering every upload up front to make it
  // replayable: FetchHttpClient passes a ReadableStream for every streamed
  // body, so that buffer would land on every request, redirect or not.
  it("refuses to replay a streamed body across a redirect", async () => {
    const seen: Array<boolean> = [];
    const underlying: typeof globalThis.fetch = async (input, init) => {
      seen.push(init?.body instanceof ReadableStream);
      if (String(input) === "https://api.example/start") {
        return new Response(null, { status: 308, headers: { location: "/moved" } });
      }
      return new Response("ok");
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello-streamed-body"));
        controller.close();
      },
    });

    await expect(
      hostedFetch("https://api.example/start", { method: "POST", body: stream }),
    ).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      reason: "Redirect cannot replay a streamed request body",
    });
    // The first hop got the stream itself, unbuffered — the whole point of
    // refusing the replay rather than materializing it.
    expect(seen).toEqual([true]);
  });

  // The refusal is scoped to a replay. A 303 or 301 demotes to GET and drops
  // the body first, so there is no stream left to replay and the redirect is
  // followed normally — blocking those too would break every streamed upload
  // whose upstream answers with a see-other.
  it("follows a demoting redirect after a streamed body, since the body is dropped", async () => {
    const seen: Array<{ url: string; method: string; hasBody: boolean }> = [];
    const underlying: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      seen.push({
        url,
        method: init?.method ?? "GET",
        hasBody: init?.body !== undefined && init?.body !== null,
      });
      if (url === "https://api.example/start") {
        return new Response(null, { status: 303, headers: { location: "/moved" } });
      }
      return new Response("ok");
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello-streamed-body"));
        controller.close();
      },
    });

    const response = await hostedFetch("https://api.example/start", {
      method: "POST",
      body: stream,
    });

    expect(response.status).toBe(200);
    expect(seen[1]).toMatchObject({
      url: "https://api.example/moved",
      method: "GET",
      hasBody: false,
    });
  });

  // One representative per arm of redirectDemotesToGet, mirroring the
  // arm-coverage rule this file states for the IPv4 blocklist: 303 demotes any
  // method, 301 demotes a non-GET, and 308 replays method and body untouched.
  it("applies the right method semantics per redirect status", async () => {
    const run = async (status: number, method: string) => {
      const seen: Array<{ method: string; hasBody: boolean }> = [];
      const underlying: typeof globalThis.fetch = async (input, init) => {
        seen.push({
          method: init?.method ?? "GET",
          hasBody: init?.body !== undefined && init?.body !== null,
        });
        if (String(input) === "https://api.example/start") {
          return new Response(null, { status, headers: { location: "/moved" } });
        }
        return new Response("ok", { status: 200 });
      };
      const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });
      await hostedFetch(
        "https://api.example/start",
        method === "HEAD" ? { method } : { method, body: "secret=1" },
      );
      return seen[1];
    };

    expect(await run(303, "POST")).toMatchObject({ method: "GET", hasBody: false });
    expect(await run(301, "POST")).toMatchObject({ method: "GET", hasBody: false });
    expect(await run(308, "POST")).toMatchObject({ method: "POST", hasBody: true });
    // The demotion exempts GET and HEAD: turning a HEAD probe into a GET makes
    // the caller download a body it deliberately asked not to receive.
    expect(await run(301, "HEAD")).toMatchObject({ method: "HEAD" });
  });

  it("preserves method and headers from a Request input across redirects", async () => {
    const seen: Array<{ url: string; method: string; accept: string | null }> = [];
    const underlying: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      seen.push({
        url,
        method: init?.method ?? "GET",
        accept: new Headers(init?.headers).get("accept"),
      });
      if (url === "https://api.example/start") {
        return new Response(null, { status: 307, headers: { location: "/moved" } });
      }
      return new Response("ok", { status: 200 });
    };
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });

    const response = await hostedFetch(
      new Request("https://api.example/start", {
        method: "DELETE",
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      url: "https://api.example/moved",
      method: "DELETE",
      accept: "application/json",
    });
  });

  // A Request always exposes its body as a ReadableStream, whatever it was
  // constructed from, so a 307/308 after one hits the same one-shot problem as
  // an explicitly streamed body and is refused for the same reason. The
  // alternative is not "replay it" — the bytes are gone once the first hop
  // reads them — it is sending a bodyless POST under a 200 and calling that
  // success.
  it("refuses to replay a Request input's body across a redirect", async () => {
    const underlying: typeof globalThis.fetch = async (input) =>
      String(input) === "https://api.example/start"
        ? new Response(null, { status: 307, headers: { location: "/moved" } })
        : new Response("ok", { status: 200 });
    const hostedFetch = makeHostedFetch({ fetch: underlying, resolveHostname: publicResolver });

    await expect(
      hostedFetch(new Request("https://api.example/start", { method: "POST", body: "payload" })),
    ).rejects.toMatchObject({
      _tag: "HostedOutboundRequestBlocked",
      url: "https://api.example/moved",
      reason: "Redirect cannot replay a streamed request body",
    });
  });

  it.effect("checks redirected URLs before following them", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof globalThis.fetch = async (input) => {
        calls++;
        const url = String(input);
        if (url === "https://public.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:3000/internal" },
          });
        }
        return new Response("unexpected", { status: 200 });
      };
      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://public.example/start"));
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({ fetch: fakeFetch, resolveHostname: publicResolver }),
        ),
        Effect.result,
      );

      expectBlocked(result, "Local and private network addresses are not allowed");
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
      const fakeFetch: typeof globalThis.fetch = async (input, init) => {
        const url = String(input);
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
      };

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
      const fakeFetch: typeof globalThis.fetch = async (input, init) => {
        const url = String(input);
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
      };

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

  // The layer has two branches and the ambient one is what ships when a
  // composition root provides FetchHttpClient.Fetch itself; leaving it
  // unguarded would be a complete SSRF bypass on the live path.
  it.effect("guards an ambient FetchHttpClient.Fetch when options.fetch is omitted", () =>
    Effect.gen(function* () {
      let calls = 0;
      const ambient: typeof globalThis.fetch = async () => {
        calls++;
        return new Response("unexpected", { status: 200 });
      };

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://api.example/start"));
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({
            resolveHostname: async () => [{ address: "169.254.169.254" }],
          }).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(ambient))),
        ),
        Effect.result,
      );

      expectBlocked(result, "Resolved address is local or private");
      expect(calls).toBe(0);
    }),
  );

  it.effect("rejects cross-origin redirects to private addresses", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof globalThis.fetch = async (input) => {
        calls++;
        const url = String(input);
        if (url === "https://api.example/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        return new Response("unexpected", { status: 200 });
      };

      const result = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(HttpClientRequest.get("https://api.example/start"));
      }).pipe(
        Effect.provide(
          makeHostedHttpClientLayer({ fetch: fakeFetch, resolveHostname: publicResolver }),
        ),
        Effect.result,
      );

      expectBlocked(result, "Metadata service addresses are not allowed");
      // On a redirect block the reported url is genuinely ambiguous — the
      // request the caller made, or the hop that was actually refused. It is
      // the hop: naming the original would point an operator at a URL that is
      // fine and hide the destination the guard stopped.
      expect(result).toMatchObject({
        failure: { cause: { url: "http://169.254.169.254/latest/meta-data/" } },
      });
      expect(calls).toBe(1);
    }),
  );
});
