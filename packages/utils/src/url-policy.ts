import { Config, Schema } from "effect";
import type { HttpClient } from "effect/http";
import ipaddr from "ipaddr.js";

export const isLoopbackHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.(?:\d{1,2}|1\d\d|2[0-4]\d|25[0-5])){3}$/.test(host)
  );
};

export const LoopbackOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          url.origin === value &&
          isLoopbackHostname(url.hostname)
        );
      } catch {
        return false;
      }
    },
    { message: "Dev tools require an exact loopback HTTP(S) origin" },
  ),
);

export const HttpOrigin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.hostname.includes("*") &&
        url.origin === value
      );
    },
    { message: "Expected an exact HTTP(S) origin, without a trailing slash" },
  ),
).pipe(Schema.brand("HttpOrigin"));
export type HttpOrigin = typeof HttpOrigin.Type;

export const UrlPolicy = Schema.Struct({
  allowLoopbackHttp: Schema.Boolean,
  allowedHttpOrigins: Schema.Array(HttpOrigin),
});
export type UrlPolicy = typeof UrlPolicy.Type;

export const defaultUrlPolicy: UrlPolicy = { allowLoopbackHttp: true, allowedHttpOrigins: [] };
export const httpsOnlyUrlPolicy: UrlPolicy = { allowLoopbackHttp: false, allowedHttpOrigins: [] };

export interface HostEgress {
  readonly policy: UrlPolicy;
  readonly client: HttpClient.HttpClient;
}

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

export const urlPolicyConfig = Config.all({
  allowLoopbackHttp: Config.Boolean("EXECUTOR_URL_ALLOW_LOOPBACK_HTTP").pipe(
    Config.withDefault(defaultUrlPolicy.allowLoopbackHttp),
  ),
  allowedHttpOrigins: Config.schema(
    Schema.fromJsonString(Schema.Array(HttpOrigin)),
    "EXECUTOR_URL_ALLOW_HTTP_ORIGINS",
  ).pipe(Config.withDefault(defaultUrlPolicy.allowedHttpOrigins)),
});

const unwrap = (address: ipaddr.IPv4 | ipaddr.IPv6) =>
  "isIPv4MappedAddress" in address && address.isIPv4MappedAddress()
    ? address.toIPv4Address()
    : address;

export const isPublicAddress = (value: string): boolean =>
  ipaddr.isValid(value) && unwrap(ipaddr.parse(value)).range() === "unicast";

export const isLoopbackAddress = (value: string): boolean =>
  ipaddr.isValid(value) && unwrap(ipaddr.parse(value)).range() === "loopback";

const internalSuffixes = [".internal", ".local", ".localdomain", ".lan", ".home.arpa"];

const addressLiteral = (host: string) =>
  host.startsWith("[") && host.endsWith("]") ? (host.slice(1, -1).split("%")[0] ?? "") : host;

export const isPrivateHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return true;
  const literal = addressLiteral(host);
  if (ipaddr.isValid(literal)) return !isPublicAddress(literal);
  if (host.startsWith("[")) return true;
  if (isLoopbackHostname(host)) return true;
  if (!host.includes(".")) return true;
  return internalSuffixes.some((suffix) => host.endsWith(suffix));
};

export const parseDestination = (value: string, policy: UrlPolicy): URL | undefined => {
  const url = parseEndpoint(value, policy);
  if (url === undefined) return undefined;
  if (!isPrivateHostname(url.hostname)) return url;
  if (policy.allowLoopbackHttp && isLoopbackHostname(url.hostname)) return url;
  return policy.allowedHttpOrigins.some((origin) => origin === url.origin) ? url : undefined;
};

export const redirectDestination = (
  location: string,
  from: URL | string,
  policy: UrlPolicy,
): URL | undefined => {
  const resolved = URL.parse(location, from);
  return resolved === null ? undefined : parseDestination(resolved.href, policy);
};

const urlsInText = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;
const trailingPunctuation = /[.,;:!?)\]}"'`>]+$/u;

const urlWithoutSecrets = (candidate: string) => {
  const url = URL.parse(candidate);
  if (url !== null && !/[^/]@/u.test(url.pathname)) {
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  }
  const authority = candidate.indexOf("://") + 3;
  const at = candidate.lastIndexOf("@");
  const rest = at >= authority ? candidate.slice(at + 1) : candidate.slice(authority);
  return candidate.slice(0, authority) + rest.replace(/[?#].*$/su, "");
};

export const withoutUrlSecrets = (text: string) =>
  text.replace(urlsInText, (found) => {
    const trailing = trailingPunctuation.exec(found)?.[0] ?? "";
    return urlWithoutSecrets(found.slice(0, found.length - trailing.length)) + trailing;
  });
