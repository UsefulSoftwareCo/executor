import { Cache, Cause, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

export class HostedOutboundRequestBlocked extends Schema.TaggedErrorClass<HostedOutboundRequestBlocked>()(
  "HostedOutboundRequestBlocked",
  {
    url: Schema.String,
    reason: Schema.String,
  },
) {}

// Only the address is carried: every classifier decides from the address
// string alone, so a family field would be a second, unchecked source of
// truth for the same question.
export interface HostedResolvedAddress {
  readonly address: string;
}

export type HostedHostnameResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<ReadonlyArray<HostedResolvedAddress>>;

export interface HostedHttpClientOptions {
  readonly allowLocalNetwork?: boolean;
  readonly maxRedirects?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveHostname?: HostedHostnameResolver;
  /** How long a successful guard resolution is reused, default 60s. */
  readonly dnsCacheTtlMillis?: number;
  /** How many hostnames the guard resolution cache holds, default 256. */
  readonly dnsCacheCapacity?: number;
  /** How long a single guard resolution may run before failing, default 60s. */
  readonly dnsResolutionTimeoutMillis?: number;
}

// Octets are decimal-only and leading zeros are rejected. inet_aton reads a
// leading zero as octal, so accepting "0177.0.0.1" here would classify it as
// 177.0.0.1 (public) while the platform resolver dials 127.0.0.1 — the guard
// and the connection would disagree about the destination. WHATWG normalizes
// these forms, so the URL path never produces one, but a resolver answer
// reaches isAllowedResolvedAddress unnormalized.
const parseIpv4 = (hostname: string): readonly [number, number, number, number] | null => {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const parsed: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d*)$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    parsed.push(value);
  }
  return parsed as [number, number, number, number];
};

// `allowTrailingQuad` is the caller's statement that this segment ends the
// whole address, not merely that it ends its own half. Deciding it from the
// segment alone would legalize a quad at the end of the head half of a
// compressed literal: "127.0.0.1::1" would parse, land 0x7f00 in the leading
// word where no prefix or mask matches it, and be classified public.
const parseIpv6Groups = (text: string, allowTrailingQuad: boolean): number[] | null => {
  if (text === "") return [];
  const parts = text.split(":");
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    // A trailing dotted quad is the only place IPv4 syntax is legal.
    if (index === parts.length - 1 && part.includes(".")) {
      if (!allowTrailingQuad) return null;
      const dotted = parseIpv4(part);
      if (!dotted) return null;
      groups.push((dotted[0] << 8) | dotted[1], (dotted[2] << 8) | dotted[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
};

// Expands an IPv6 literal into its eight 16-bit words, resolving the "::"
// run to its true position. Classification has to work from the real words:
// the leading group of a compressed literal is not the leading word —
// "::127.0.0.1" starts with six zero words, not with 0x7f00 — so reading the
// first non-empty group instead lets loopback and metadata addresses past a
// guard whose whole purpose is blocking them.
const parseIpv6 = (hostname: string): ReadonlyArray<number> | null => {
  if (!hostname.includes(":")) return null;
  // node:dns returns link-local addresses with their interface scope
  // ("fe80::1%eth0"); the zone is not part of the address being classified.
  const [head, tail, ...extra] = hostname.replace(/%.*$/, "").split("::");
  if (extra.length > 0) return null;

  // The head half ends the address only when there is no "::" after it.
  const high = parseIpv6Groups(head, tail === undefined);
  if (high === null) return null;
  if (tail === undefined) return high.length === 8 ? high : null;

  const low = parseIpv6Groups(tail, true);
  if (low === null) return null;
  const elided = 8 - high.length - low.length;
  if (elided < 1) return null;
  return [...high, ...Array<number>(elided).fill(0), ...low];
};

const isBlockedIpv4 = ([a, b]: readonly [number, number, number, number]): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 0) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) ||
  a >= 224;

const dotted = (high: number, low: number): readonly [number, number, number, number] => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

// Prefixes that carry an IPv4 address at a fixed position, so the destination
// they actually reach is that address and not their own prefix: v4-mapped
// (::ffff:0:0/96), the deprecated v4-compatible form (::/96), RFC 6052's
// IPv4-translatable form (::ffff:0:0:0/96), the well-known NAT64 prefix
// (64:ff9b::/96), and 6to4 (2002::/16), which carries its address one word
// higher. Classifying by the prefix instead would let ::ffff:0:7f00:1 and
// 2002:a9fe:a9fe:: reach loopback and the metadata endpoint untouched.
const embeddedIpv4 = (
  words: ReadonlyArray<number>,
): readonly [number, number, number, number] | null => {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  const zeroThrough = (...parts: ReadonlyArray<number>) => parts.every((word) => word === 0);
  if (w0 === 0x2002) return dotted(w1, w2);
  const isV4Mapped = zeroThrough(w0, w1, w2, w3, w4) && w5 === 0xffff;
  const isV4Compatible = zeroThrough(w0, w1, w2, w3, w4, w5);
  const isV4Translatable = zeroThrough(w0, w1, w2, w3, w5) && w4 === 0xffff;
  const isNat64 = w0 === 0x0064 && w1 === 0xff9b && zeroThrough(w2, w3, w4, w5);
  if (!isV4Mapped && !isV4Compatible && !isV4Translatable && !isNat64) return null;
  return dotted(w6, w7);
};

// RFC 8215 reserves 64:ff9b:1::/48 for local-use NAT64. Where the IPv4 address
// sits inside one of these depends on the prefix length the local translator
// was configured with, which the address alone does not carry — so there is no
// embedded address to classify, and a translator that exists at all is by
// definition on the local network.
const isLocalUseNat64 = (words: ReadonlyArray<number>): boolean =>
  words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001;

const isBlockedIpv6 = (words: ReadonlyArray<number>): boolean => {
  if (isLocalUseNat64(words)) return true;
  const embedded = embeddedIpv4(words);
  if (embedded) return isBlockedIpv4(embedded);
  const leading = words[0];
  return (
    (leading & 0xffc0) === 0xfe80 || (leading & 0xfe00) === 0xfc00 || (leading & 0xff00) === 0xff00
  );
};

// Every hostname check runs against this form, so each one sees the same name.
// The trailing root dot matters: "metadata.google.internal." is the same name
// to the resolver but a different string, and an exact-match blocklist that
// skipped this would be defeated by appending one character.
const canonicalHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

const isBlockedMetadataHostname = (normalized: string): boolean =>
  normalized === "metadata.google.internal" ||
  normalized === "metadata" ||
  normalized === "instance-data" ||
  normalized === "169.254.169.254";

const isLocalOrPrivateHostname = (normalized: string): boolean => {
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(normalized);
  if (ipv6) return isBlockedIpv6(ipv6);
  return false;
};

// A resolved address is known to be an IP, so failing to decode it is not
// "this is a public name" — it is "the guard cannot classify this". Reusing
// isLocalOrPrivateHostname there would collapse both into `false` and let an
// address these parsers reject through the one check that exists to stop it.
const isAllowedResolvedAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return !isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(normalized);
  if (ipv6) return !isBlockedIpv6(ipv6);
  return false;
};

// A URL hostname is an IP literal only in canonical shapes: the WHATWG parser
// rewrites every IPv4 form (hex, octal, integer) to dotted decimal, and an
// IPv6 literal always contains a colon. A character-class test is not enough
// here: registrable names spelled entirely in hex digits ("beef.cafe") must
// count as DNS names, or they would skip the resolved-address check below.
const isAddressLiteral = (normalized: string): boolean =>
  parseIpv4(normalized) !== null || normalized.includes(":");

// `empty` separates "the resolver answered, with nothing" from "the resolver
// did not answer". Both fail closed and both must stay out of the success
// cache, but they are different operator diagnoses, so the block reason keeps
// them apart rather than collapsing into one message.
class HostedHostnameResolutionFailed extends Schema.TaggedErrorClass<HostedHostnameResolutionFailed>()(
  "HostedHostnameResolutionFailed",
  {
    hostname: Schema.String,
    empty: Schema.Boolean,
  },
) {}

const resolveHostnameWithNodeDns: HostedHostnameResolver = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => ({ address }));
};

type GuardResolver = (
  hostname: string,
) => Effect.Effect<ReadonlyArray<HostedResolvedAddress>, HostedHostnameResolutionFailed>;

// An empty answer becomes a failure at the resolver boundary, not at the call
// site, so it reaches every caller the same way: the cached path needs it in
// the error channel for the zero failure TTL to drop it, and putting it here
// rather than inside the cache keeps the uncached path — the exported
// validateHostedOutboundUrl — from having a second copy of the rule.
const toGuardResolver =
  (resolve: HostedHostnameResolver): GuardResolver =>
  (hostname) =>
    Effect.tryPromise({
      try: (signal) => resolve(hostname, signal),
      catch: () => new HostedHostnameResolutionFailed({ hostname, empty: false }),
    }).pipe(
      Effect.flatMap((addresses) =>
        addresses.length === 0
          ? Effect.fail(new HostedHostnameResolutionFailed({ hostname, empty: true }))
          : Effect.succeed(addresses),
      ),
    );

const DNS_CACHE_TTL_MILLIS = 60_000;
const DNS_CACHE_CAPACITY = 256;
const DNS_RESOLUTION_TIMEOUT_MILLIS = 60_000;

// The cache is what keeps the guard off the request hot path: without it,
// every outbound request pays a full system-resolver round trip before the
// fetch, and on networks whose resolver drops AAAA queries (common behind
// IPv4-only home routers) that round trip stalls for the resolver timeout,
// several seconds per request. Only the first request per hostname per TTL
// window pays it now; concurrent requests share one in-flight resolution and
// failed resolutions are not retained.
//
// The TTL does widen an existing hole rather than opening one. The guard hands
// the underlying fetch a hostname, never the addresses it checked, so the fetch
// resolves again on its own and the verdict is already advisory: an attacker
// serving a TTL-0 record defeats it in the unresolved gap with or without this
// cache. Caching lengthens that gap from milliseconds to the TTL, and only
// closing it — pinning the connection to the checked address — makes either
// window matter. Until then a zero TTL would buy no real protection while
// restoring the per-request stall this exists to remove.
//
// Scope is the guarded-fetch adapter, deliberately: the MCP host builds one
// adapter per session, so the window spans a session there; the per-request
// HTTP API path only dedupes hops within one request. A process-wide cache
// would need a layer seam through every composition root.
const withResolutionCache = (
  resolve: GuardResolver,
  options: HostedHttpClientOptions,
): GuardResolver => {
  const ttl = Duration.millis(options.dnsCacheTtlMillis ?? DNS_CACHE_TTL_MILLIS);
  // The cached effect is bounded because a pending entry is not subject to the
  // TTL: Cache stamps expiry only when the lookup settles, so a resolution
  // that never settles would leave every later request for that hostname
  // joining the same dead Deferred for the adapter's lifetime — the hostname
  // would be permanently unreachable. Timing out turns that into an ordinary
  // typed failure, which the zero failure TTL then drops so the next request
  // resolves again.
  //
  // It is a liveness backstop, not a latency policy, so it sits far above any
  // real resolver: a resolver that answers slowly still answers, and blocking
  // the request instead is a worse outcome than the wait. Callers that will
  // not wait that long abort their own fetch, which the detached lookup
  // survives on behalf of everyone else waiting on it.
  //
  // An empty answer is already a failure by the time it reaches the cache —
  // toGuardResolver raises it — so the zero failure TTL drops it. Were it a
  // success, one transient empty answer would stamp the full TTL on "no
  // addresses" and blackhole the hostname for the rest of the window; the
  // uncached code re-resolved every request and never could.
  const bounded: GuardResolver = (hostname) =>
    Effect.timeoutOrElse(resolve(hostname), {
      duration: Duration.millis(
        options.dnsResolutionTimeoutMillis ?? DNS_RESOLUTION_TIMEOUT_MILLIS,
      ),
      orElse: () => Effect.fail(new HostedHostnameResolutionFailed({ hostname, empty: false })),
    });
  const cache = Effect.runSync(
    Cache.makeWith(bounded, {
      capacity: options.dnsCacheCapacity ?? DNS_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? ttl : Duration.zero),
    }),
  );
  // The lookup runs on a detached fiber that no caller owns, and each caller
  // only joins it. A cache entry is shared, so running it on the requesting
  // fiber would make one caller's abort interrupt the resolution every other
  // caller is waiting on — they would fail with an untyped interrupt instead
  // of their own answer.
  return (hostname) => Effect.flatMap(Effect.forkDetach(Cache.get(cache, hostname)), Fiber.join);
};

const validateOutboundUrl = (
  value: string,
  options: HostedHttpClientOptions,
  resolve: GuardResolver,
): Effect.Effect<void, HostedOutboundRequestBlocked> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: () =>
        new HostedOutboundRequestBlocked({
          url: value,
          reason: "URL is invalid",
        }),
    });

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* new HostedOutboundRequestBlocked({
        url: value,
        reason: "Only HTTP and HTTPS outbound requests are allowed",
      });
    }

    const normalizedHostname = canonicalHostname(url.hostname);

    if (isBlockedMetadataHostname(normalizedHostname)) {
      return yield* new HostedOutboundRequestBlocked({
        url: value,
        reason: "Metadata service addresses are not allowed",
      });
    }

    if (!options.allowLocalNetwork && isLocalOrPrivateHostname(normalizedHostname)) {
      return yield* new HostedOutboundRequestBlocked({
        url: value,
        reason: "Local and private network addresses are not allowed",
      });
    }

    if (!options.allowLocalNetwork && !isAddressLiteral(normalizedHostname)) {
      // The empty answer is already a failure by the time it arrives here —
      // the cached lookup raises it, so it takes the zero failure TTL instead
      // of being retained as a successful "no addresses" for the full window.
      const addresses = yield* resolve(normalizedHostname).pipe(
        Effect.catchTag("HostedHostnameResolutionFailed", (error) =>
          Effect.fail(
            new HostedOutboundRequestBlocked({
              url: value,
              reason: error.empty
                ? "Hostname did not resolve to an address"
                : "Hostname could not be resolved",
            }),
          ),
        ),
      );

      for (const { address } of addresses) {
        if (!isAllowedResolvedAddress(address)) {
          return yield* new HostedOutboundRequestBlocked({
            url: value,
            reason: "Resolved address is local or private",
          });
        }
      }
    }
  });

// Defaults to the same node:dns resolver guardFetch uses so both public
// entry points enforce the same guard; omitting the resolver must not
// silently drop the resolved-address check.
export const validateHostedOutboundUrl = (
  value: string,
  options: HostedHttpClientOptions = {},
): Effect.Effect<void, HostedOutboundRequestBlocked> =>
  validateOutboundUrl(
    value,
    options,
    toGuardResolver(options.resolveHostname ?? resolveHostnameWithNodeDns),
  );

// Cross-origin redirects keep only headers that cannot carry credentials.
// A blocklist of well-known credential names is unsound here: integrations
// render credentials into arbitrary header names (X-Api-Key and friends),
// so everything not on this list is dropped on a cross-origin hop. The body
// is dropped with them — a credential-bearing POST body must not replay to
// a redirect target whose headers were just scrubbed.
const SAFE_REDIRECT_HEADERS = ["accept", "accept-language", "user-agent"] as const;

const retainSafeRedirectHeaders = (init: RequestInit | undefined): RequestInit => {
  const headers = new Headers(init?.headers);
  const kept = new Headers();
  for (const name of SAFE_REDIRECT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept.set(name, value);
  }
  // Rebuilt field by field rather than spread from the original: `referrer`
  // and `credentials` are credential-carrying too, and spreading would carry
  // them past the header scrub. The platform turns `referrer` into a real
  // Referer header — the whole URL, query string included, once the caller
  // asked for `referrerPolicy: "unsafe-url"` — so an OAuth callback whose
  // query holds a token would hand that token to the redirect target. Only
  // the transport-shaped fields survive.
  return {
    headers: kept,
    body: undefined,
    method: init?.method ?? "GET",
    signal: init?.signal,
    cache: init?.cache,
    keepalive: init?.keepalive,
    mode: init?.mode,
    redirect: init?.redirect,
  };
};

const CONTENT_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
] as const;

// Platform redirect semantics (fetch, curl): 303 always demotes to GET, and
// 301/302 demote any non-GET/HEAD method to GET; the body and its content
// headers go with it. Only 307/308 replay the method and body.
const demoteToGet = (init: RequestInit | undefined): RequestInit => {
  const headers = new Headers(init?.headers);
  for (const name of CONTENT_HEADERS) headers.delete(name);
  return { ...init, method: "GET", body: undefined, headers };
};

const redirectDemotesToGet = (status: number, method: string): boolean =>
  status === 303 || ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD");

// A stream can only be read once, so a hop that would replay it sends an empty
// body and still reports success — the caller's upload silently truncated. The
// stream is passed through untouched and the replay is refused instead:
// buffering it up front to make the rare redirect replayable would materialize
// every streamed upload in memory, and FetchHttpClient passes a ReadableStream
// for every streamed body, so that cost lands on the common path.
const isStreamedBody = (init: RequestInit | undefined): boolean =>
  init?.body instanceof ReadableStream;

// Every hop goes out through here, so this is the one place the transport's
// requirements are met. `redirect: "manual"` is what makes the guard see each
// hop at all — without it the platform follows 3xx internally and hops 2..n
// are never re-validated. `duplex: "half"` is required by undici whenever the
// body is a stream, and rejects the request outright when it is missing; since
// normalizeFetchInput turns every Request input into its ReadableStream body,
// omitting it would kill every body-bearing Request and every streamed upload.
const withStreamingDuplex = (init: RequestInit | undefined): RequestInit => ({
  ...init,
  redirect: "manual",
  // @ts-expect-error — undici/Bun extension, absent from the DOM RequestInit
  duplex: isStreamedBody(init) ? "half" : undefined,
});

// A Request input is read into url + init up front so redirect hops keep the
// request shape instead of silently degrading to a bare GET.
const normalizeFetchInput = (
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): { readonly url: string; readonly init: RequestInit | undefined } => {
  if (!(input instanceof Request)) {
    return { url: String(input), init };
  }
  const normalized: RequestInit = {
    method: input.method,
    headers: new Headers(input.headers),
    signal: input.signal,
    credentials: input.credentials,
    cache: input.cache,
    integrity: input.integrity,
    keepalive: input.keepalive,
    mode: input.mode,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    ...init,
  };
  if (input.body !== null && normalized.body === undefined) {
    normalized.body = input.body;
  }
  return { url: input.url, init: normalized };
};

// An abort during the guard would otherwise surface as the interrupt Effect
// raises when its fiber is cancelled ("All fibers interrupted without error"),
// which callers branching on `error.name === "AbortError"` read as a transport
// failure and retry. This is a Fetch adapter, so it rejects the way fetch does.
const rejectAsAbort = (signal: AbortSignal): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Fetch-compatible adapter must reject with the caller's own abort reason
  if (signal.reason !== undefined) throw signal.reason;
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: Fetch-compatible adapter must reject with an AbortError-shaped value
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Fetch-compatible adapter must reject with an AbortError-shaped value
  throw error;
};

const guardFetch = (
  underlying: typeof globalThis.fetch,
  options: HostedHttpClientOptions,
): typeof globalThis.fetch => {
  const resolve = withResolutionCache(
    toGuardResolver(options.resolveHostname ?? resolveHostnameWithNodeDns),
    options,
  );
  const maxRedirects = Math.max(0, options.maxRedirects ?? 10);
  // SAFETY: narrowed to the one thing a closure cannot express — Bun's fetch
  // type carries a static `preconnect` property, which packages built against
  // @types/bun require. The call signature is checked by the annotations, and
  // the return type is `Promise<Response>` on every path.
  return (async (input, init) => {
    const normalized = normalizeFetchInput(input, init);
    let currentUrl = normalized.url;
    let currentInit = normalized.init;
    const signal = currentInit?.signal ?? undefined;
    for (let redirects = 0; ; redirects++) {
      const guarded = await Effect.runPromiseExit(
        validateOutboundUrl(currentUrl, options, resolve),
        { signal },
      );
      if (Exit.isFailure(guarded)) {
        // Both halves are required. The cause decides that this was an
        // interrupt rather than a guard verdict — an aborted signal alone
        // would bury a real SSRF block under a retryable AbortError. The
        // signal's own state decides that the caller asked for it: an
        // interrupt from anywhere else must not be reported as the caller's
        // abort, which would fabricate a reason that never happened.
        if (signal?.aborted && Cause.hasInterruptsOnly(guarded.cause)) rejectAsAbort(signal);
        return await Effect.runPromise(Effect.failCause(guarded.cause));
      }
      const response = await underlying(currentUrl, withStreamingDuplex(currentInit));
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location") &&
        redirects < maxRedirects
      ) {
        // The 3xx is abandoned here. Undici keeps a connection out of the
        // pool until an unread body is consumed or cancelled, so a
        // redirect-heavy integration would leak one connection per hop. A
        // cancel that itself fails — a 3xx declaring Content-Length whose
        // connection dies mid-body rejects with "terminated" — is connection
        // hygiene failing, not the request: the redirect still proceeds.
        const body = response.body;
        if (body) {
          await Effect.runPromise(
            Effect.tryPromise({
              try: () => body.cancel(),
              catch: (error) => error,
            }).pipe(Effect.ignore),
          );
        }
        const location = response.headers.get("location")!;
        // A malformed Location header is a rejected redirect target, not a
        // client defect, so it surfaces as the tagged guard error.
        const next = await Effect.runPromise(
          Effect.try({
            try: () => new URL(location, currentUrl),
            catch: () =>
              new HostedOutboundRequestBlocked({
                url: location,
                reason: "Redirect target is not a valid URL",
              }),
          }),
        );
        if (redirectDemotesToGet(response.status, currentInit?.method ?? "GET")) {
          currentInit = demoteToGet(currentInit);
        }
        // A demotion has already dropped the body, so what is left here is a
        // 307/308 that would replay it. A stream cannot be replayed — the
        // first hop drained it — and sending the drained object would deliver
        // an empty body under a 200, so the hop is refused instead.
        if (isStreamedBody(currentInit)) {
          return await Effect.runPromise(
            Effect.fail(
              new HostedOutboundRequestBlocked({
                url: next.toString(),
                reason: "Redirect cannot replay a streamed request body",
              }),
            ),
          );
        }
        // Cross-origin redirects are followed (the loop re-validates every
        // hop), but credentials minted for the original origin — in any
        // header or in the body — must not leak to the redirect target.
        if (next.origin !== new URL(currentUrl).origin) {
          // A 307/308 replays the method, so a request still carrying a body
          // here would go out as a bodyless POST/PUT once the body is
          // stripped — a different request than the caller made, whose 4xx
          // would misattribute the cause. The hop is refused instead, so the
          // caller sees the guard decision rather than an upstream symptom.
          if (currentInit?.body !== undefined && currentInit?.body !== null) {
            return await Effect.runPromise(
              Effect.fail(
                new HostedOutboundRequestBlocked({
                  url: next.toString(),
                  reason: "Cross-origin redirect cannot replay a request body",
                }),
              ),
            );
          }
          currentInit = retainSafeRedirectHeaders(currentInit);
        }
        currentUrl = next.toString();
        continue;
      }
      return response;
    }
  }) as typeof globalThis.fetch;
};

export const makeHostedFetch = (options: HostedHttpClientOptions = {}): typeof globalThis.fetch =>
  // oxlint-disable-next-line executor/no-raw-fetch -- boundary: exposes a guarded Fetch API adapter for libraries that require fetch
  guardFetch(options.fetch ?? globalThis.fetch, options);

export const makeHostedHttpClientLayer = (
  options: HostedHttpClientOptions = {},
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      options.fetch
        ? Layer.succeed(FetchHttpClient.Fetch)(guardFetch(options.fetch, options))
        : Layer.effect(
            FetchHttpClient.Fetch,
            Effect.map(Effect.service(FetchHttpClient.Fetch), (underlying) =>
              guardFetch(underlying, options),
            ),
          ),
    ),
  );
