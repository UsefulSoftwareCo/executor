/** URL transport policy shared by hosts. It does not grant access or replace protocol rules. */
import { Config, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import ipaddr from "ipaddr.js";

/** Classify a WHATWG URL hostname without DNS. Reserved localhost names and loopback IPs only. */
export const isLoopbackHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.(?:\d{1,2}|1\d\d|2[0-4]\d|25[0-5])){3}$/.test(host)
  );
};

/** An exact HTTP origin, including its port. No paths, credentials, wildcards, query or fragment. */
export const HttpOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        url.protocol === "http:" &&
        !url.hostname.includes("*") &&
        url.origin === value
      );
    },
    { message: "Expected an exact HTTP origin, without a trailing slash" },
  ),
).pipe(Schema.brand("HttpOrigin"));
export type HttpOrigin = typeof HttpOrigin.Type;

/** Trusted host policy. Explicit HTTP origins never imply access to sibling hosts or other ports. */
export const UrlPolicy = Schema.Struct({
  allowLoopbackHttp: Schema.Boolean,
  allowedHttpOrigins: Schema.Array(HttpOrigin),
});
export type UrlPolicy = typeof UrlPolicy.Type;

/** HTTPS everywhere, with HTTP for reserved loopback hosts regardless of deployment mode. */
export const defaultUrlPolicy: UrlPolicy = { allowLoopbackHttp: true, allowedHttpOrigins: [] };
/** Use where a protocol requires HTTPS even when the host allows other HTTP endpoints. */
export const httpsOnlyUrlPolicy: UrlPolicy = { allowLoopbackHttp: false, allowedHttpOrigins: [] };

/**
 * What a host needs to fetch a URL a user supplied: the rule, and the client that enforces it.
 * A Node host passes the connect-time client from `@executor-js/utils/safe-fetch`, which
 * re-checks every resolved address. Cloudflare has no dispatcher seam, so it passes the
 * platform fetch client and relies on `global_fetch_strictly_public` and `parseDestination`.
 */
export interface HostEgress {
  readonly policy: UrlPolicy;
  readonly client: HttpClient.HttpClient;
}

/** Parse an absolute endpoint under host policy; reject userinfo and fragments, preserve queries. */
export const parseEndpoint = (value: string, policy: UrlPolicy): URL | undefined => {
  const url = URL.parse(value);
  if (url === null || url.username || url.password || url.href.includes("#")) return undefined;
  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ((policy.allowLoopbackHttp && isLoopbackHostname(url.hostname)) ||
        policy.allowedHttpOrigins.some((origin) => origin === url.origin)))
  )
    return url;
  return undefined;
};

/** Shared local, self-host and Cloud environment settings. Invalid entries fail startup/deploy. */
export const urlPolicyConfig = Config.all({
  allowLoopbackHttp: Config.Boolean("EXECUTOR_URL_ALLOW_LOOPBACK_HTTP").pipe(
    Config.withDefault(defaultUrlPolicy.allowLoopbackHttp),
  ),
  allowedHttpOrigins: Config.schema(
    Schema.fromJsonString(Schema.Array(HttpOrigin)),
    "EXECUTOR_URL_ALLOW_HTTP_ORIGINS",
  ).pipe(Config.withDefault(defaultUrlPolicy.allowedHttpOrigins)),
});

/** An IPv4-mapped address reaches the mapped IPv4 destination, so classify that address. */
const unwrap = (address: ipaddr.IPv4 | ipaddr.IPv6) =>
  "isIPv4MappedAddress" in address && address.isIPv4MappedAddress()
    ? address.toIPv4Address()
    : address;

/**
 * True when a literal address is globally routable unicast in either family. Everything else,
 * including loopback, private, link-local, unique-local, carrier-grade NAT, multicast,
 * broadcast, unspecified, NAT64 and reserved space, is not a public destination.
 */
export const isPublicAddress = (value: string): boolean =>
  ipaddr.isValid(value) && unwrap(ipaddr.parse(value)).range() === "unicast";

/** True when a literal address is loopback, the one exception local development opts into. */
export const isLoopbackAddress = (value: string): boolean =>
  ipaddr.isValid(value) && unwrap(ipaddr.parse(value)).range() === "loopback";

/** Reserved internal name suffixes that never identify a public destination. */
const internalSuffixes = [".internal", ".local", ".localdomain", ".lan", ".home.arpa"];

/** The bare address in a WHATWG hostname. IPv6 literals arrive bracketed and may carry a zone. */
const addressLiteral = (host: string) =>
  host.startsWith("[") && host.endsWith("]") ? (host.slice(1, -1).split("%")[0] ?? "") : host;

/**
 * A cheap syntactic reject for a hostname the host would fetch: literal private addresses in
 * either family, single-label names and reserved internal suffixes. This is not the security
 * boundary. A name is only an address after DNS, so the safe dispatcher in
 * `@executor-js/utils/safe-fetch` re-checks the resolved addresses at connect time.
 */
export const isPrivateHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return true;
  const literal = addressLiteral(host);
  if (ipaddr.isValid(literal)) return !isPublicAddress(literal);
  // A bracketed hostname is always an IPv6 literal, so one that does not parse is not a name.
  if (host.startsWith("[")) return true;
  if (isLoopbackHostname(host)) return true;
  // A single-label name is resolved by the host's own search domains, never publicly.
  if (!host.includes(".")) return true;
  return internalSuffixes.some((suffix) => host.endsWith(suffix));
};

/**
 * Parse an absolute endpoint the host itself will fetch on a user's behalf. This adds a
 * destination rule to the transport rule in `parseEndpoint`: private and internal address
 * space is refused unless the deployment opted in, either through `allowLoopbackHttp` for
 * reserved loopback hosts or through an exact `allowedHttpOrigins` entry. It rejects early
 * and with a clear message; the connect-time check is what a resolved name must still pass.
 */
export const parseDestination = (value: string, policy: UrlPolicy): URL | undefined => {
  const url = parseEndpoint(value, policy);
  if (url === undefined) return undefined;
  if (!isPrivateHostname(url.hostname)) return url;
  if (policy.allowLoopbackHttp && isLoopbackHostname(url.hostname)) return url;
  return policy.allowedHttpOrigins.some((origin) => origin === url.origin) ? url : undefined;
};

/** Apply the destination policy to a redirect `Location`, resolved against the hop it came from. */
export const redirectDestination = (
  location: string,
  from: URL | string,
  policy: UrlPolicy,
): URL | undefined => {
  const resolved = URL.parse(location, from);
  return resolved === null ? undefined : parseDestination(resolved.href, policy);
};
