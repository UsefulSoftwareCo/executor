import { BlockList, isIP } from "node:net";

import { Option } from "effect";

import type { TrustedProxyConfig } from "../config";

// ---------------------------------------------------------------------------
// Client IP for Better Auth's rate limiter.
//
// Better Auth only reads the client IP from request headers. Nothing tells it
// which TCP peer the request came from, so on a directly exposed self-host it
// found no header, logged a warning, and pooled every caller into one bucket of
// three sign-ins per ten seconds. The fix has two halves:
//
//   1. The server stamps the socket peer address onto CLIENT_IP_HEADER before
//      Better Auth sees the request, always overwriting anything the client
//      sent. A direct client can only ever rate-limit itself.
//   2. Behind a reverse proxy the peer is the proxy, so the operator names the
//      header the proxy sets (EXECUTOR_TRUSTED_PROXY_HEADER) and the addresses
//      it connects from (EXECUTOR_TRUSTED_PROXIES). That header is honoured only
//      on connections from one of those addresses and stripped otherwise, so a
//      client that reaches the container directly cannot assert a proxy header.
//
// Better Auth's own default reads `x-forwarded-for` from anyone. That is not
// restored here: a client could rotate the header to dodge the limit. Behind
// an unconfigured proxy every user therefore shares one bucket, so the stamper
// warns the operator once when it sees a proxy-style header in that state.
// ---------------------------------------------------------------------------

/** Server-stamped socket peer address. Never trusted from the client. */
export const CLIENT_IP_HEADER = "x-executor-client-ip";

/**
 * Headers a reverse proxy commonly sets to the client IP. Seeing one with no
 * trusted proxy configured is the signature of a proxied deployment that has
 * not told Executor about its proxy.
 */
export const PROXY_HINT_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

export interface IpRange {
  readonly address: string;
  readonly prefix: number;
  readonly family: "ipv4" | "ipv6";
}

/**
 * Parse an IP address or `address/prefix` CIDR range. `undefined` for anything
 * else, so a typo cannot silently become a non-matching (or all-matching) rule.
 */
export const parseIpRange = (value: string): IpRange | undefined => {
  const slash = value.indexOf("/");
  const address = slash === -1 ? value : value.slice(0, slash);
  const version = isIP(address);
  if (version === 0) return undefined;
  const family = version === 6 ? "ipv6" : "ipv4";
  const maxPrefix = version === 6 ? 128 : 32;
  if (slash === -1) return { address, prefix: maxPrefix, family };
  const prefixText = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  if (prefix > maxPrefix) return undefined;
  return { address, prefix, family };
};

const blockListOf = (ranges: readonly IpRange[]): BlockList => {
  const list = new BlockList();
  for (const range of ranges) list.addSubnet(range.address, range.prefix, range.family);
  return list;
};

// `isIP` rejects the `::ffff:` prefix form only when malformed; a dual-stack
// socket may report an IPv4 peer as an IPv4-mapped IPv6 address, which
// BlockList matches against IPv4 rules on its own.
const isTrustedPeer = (list: BlockList, address: string): boolean => {
  const version = isIP(address);
  return version !== 0 && list.check(address, version === 6 ? "ipv6" : "ipv4");
};

/** The `advanced.ipAddress` block handed to Better Auth. */
export interface ClientIpAddressOptions {
  /**
   * Header names Better Auth walks, in order, to find the client IP. The
   * proxy's header leads when one is configured; the server-stamped socket
   * address is the fallback for requests that did not come through the proxy.
   */
  readonly ipAddressHeaders: string[];
  /**
   * Hops Better Auth strips from the right of a forwarded chain. Only present
   * with a configured proxy; when every hop in a header is trusted, Better
   * Auth finds no client in it and moves to the next header.
   */
  readonly trustedProxies?: string[];
}

export const clientIpAddressOptions = (
  trustedProxy: TrustedProxyConfig | undefined,
): ClientIpAddressOptions =>
  trustedProxy
    ? {
        ipAddressHeaders: [trustedProxy.header, CLIENT_IP_HEADER],
        trustedProxies: [...trustedProxy.proxies],
      }
    : { ipAddressHeaders: [CLIENT_IP_HEADER] };

/**
 * The request with its headers replaced, everything else passed through.
 *
 * Deliberately NOT `new Request(request, { headers })`: Bun's copy constructor
 * never delivers a body that is not one of its own native streams, and the
 * Vite dev middleware hands the handler `Readable.toWeb(req)`, so every
 * sign-in POST hung until the client gave up (the production Bun.serve path
 * was unaffected). Rebuilding from the parts with the body passed explicitly
 * behaves the same on both paths; `duplex: "half"` is what the Fetch spec
 * requires when a request body is a stream.
 */
const withHeaders = (request: Request, headers: Headers): Request => {
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(request.url, init);
};

export interface ClientIpStamperOptions {
  /** Where the one-time unconfigured-proxy warning goes. Defaults to console.warn. */
  readonly warn?: (message: string) => void;
}

const unconfiguredProxyWarning = (header: string): string =>
  `[executor] An auth request carried ${header}, but no trusted proxy is configured, so every user behind that proxy shares one sign-in rate-limit bucket. Set EXECUTOR_TRUSTED_PROXY_HEADER and EXECUTOR_TRUSTED_PROXIES so the limit keys on the real client IP.`;

/**
 * Build the per-request rewrite that stamps the socket peer address onto
 * CLIENT_IP_HEADER (or removes it when the runtime cannot report one) and
 * drops the trusted-proxy header unless the peer is a configured proxy. The
 * `remoteAddress` is the TCP peer as reported by the HTTP server, not anything
 * read from the request.
 *
 * With no trusted proxy configured, the first request that carries one of
 * PROXY_HINT_HEADERS triggers a single operator warning for the stamper's
 * lifetime (one stamper per server).
 */
export const makeClientIpStamper = (
  trustedProxy: TrustedProxyConfig | undefined,
  options: ClientIpStamperOptions = {},
): ((request: Request, remoteAddress: Option.Option<string>) => Request) => {
  const proxies = trustedProxy
    ? blockListOf(trustedProxy.proxies.flatMap((entry) => parseIpRange(entry) ?? []))
    : undefined;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let warnedUnconfiguredProxy = false;
  return (request, remoteAddress) => {
    const headers = new Headers(request.headers);
    const peer = Option.getOrUndefined(remoteAddress);
    if (peer) {
      headers.set(CLIENT_IP_HEADER, peer);
    } else {
      headers.delete(CLIENT_IP_HEADER);
    }
    if (trustedProxy && proxies && !(peer && isTrustedPeer(proxies, peer))) {
      headers.delete(trustedProxy.header);
    }
    if (!trustedProxy && !warnedUnconfiguredProxy) {
      const hint = PROXY_HINT_HEADERS.find((header) => headers.has(header));
      if (hint) {
        warnedUnconfiguredProxy = true;
        warn(unconfiguredProxyWarning(hint));
      }
    }
    return withHeaders(request, headers);
  };
};
