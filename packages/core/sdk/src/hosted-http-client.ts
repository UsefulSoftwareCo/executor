import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

export class HostedOutboundRequestBlocked extends Schema.TaggedErrorClass<HostedOutboundRequestBlocked>()(
  "HostedOutboundRequestBlocked",
  {
    url: Schema.String,
    reason: Schema.String,
  },
) {}

export interface HostedResolvedAddress {
  readonly address: string;
  readonly family?: 4 | 6;
}

export type HostedHostnameResolver = (
  hostname: string,
) => Promise<ReadonlyArray<HostedResolvedAddress>>;

export interface HostedHttpClientOptions {
  readonly allowLocalNetwork?: boolean;
  readonly maxRedirects?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveHostname?: HostedHostnameResolver;
}

const parseIpv4 = (hostname: string): readonly [number, number, number, number] | null => {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const parsed: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    parsed.push(value);
  }
  return parsed as [number, number, number, number];
};

const parseIpv4MappedIpv6 = (
  hostname: string,
): readonly [number, number, number, number] | null => {
  const prefix = "::ffff:";
  if (!hostname.startsWith(prefix)) return null;
  const embedded = hostname.slice(prefix.length);
  const dotted = parseIpv4(embedded);
  if (dotted) return dotted;

  const parts = embedded.split(":");
  if (parts.length !== 2) return null;

  const words = parts.map((part) => Number.parseInt(part, 16));
  if (
    words.some(
      (word, index) =>
        parts[index] === "" ||
        !/^[0-9a-f]+$/i.test(parts[index]) ||
        !Number.isInteger(word) ||
        word < 0 ||
        word > 0xffff,
    )
  ) {
    return null;
  }

  const [high, low] = words;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
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

const isBlockedIpv6 = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:0" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  const firstWordText = normalized.split(":").find((part) => part.length > 0);
  if (!firstWordText || !/^[0-9a-f]{1,4}$/.test(firstWordText)) return false;
  const firstWord = Number.parseInt(firstWordText, 16);
  return (
    (firstWord & 0xffc0) === 0xfe80 ||
    (firstWord & 0xfe00) === 0xfc00 ||
    (firstWord & 0xff00) === 0xff00
  );
};

const isBlockedMetadataHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "metadata.google.internal" ||
    normalized === "metadata" ||
    normalized === "instance-data" ||
    normalized === "169.254.169.254"
  );
};

const isLocalOrPrivateHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isBlockedIpv4(ipv4);
  const mappedIpv4 = parseIpv4MappedIpv6(normalized);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return isBlockedIpv6(normalized);
};

const isAddressLiteral = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return parseIpv4(normalized) !== null || /^[0-9a-f:.]+$/i.test(normalized);
};

const resolveHostnameWithNodeDns: HostedHostnameResolver = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

export const validateHostedOutboundUrl = (
  value: string,
  options: HostedHttpClientOptions = {},
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

    if (isBlockedMetadataHostname(url.hostname)) {
      return yield* new HostedOutboundRequestBlocked({
        url: value,
        reason: "Metadata service addresses are not allowed",
      });
    }

    if (!options.allowLocalNetwork && isLocalOrPrivateHostname(url.hostname)) {
      return yield* new HostedOutboundRequestBlocked({
        url: value,
        reason: "Local and private network addresses are not allowed",
      });
    }

    const normalizedHostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!options.allowLocalNetwork && options.resolveHostname && !isAddressLiteral(url.hostname)) {
      const addresses = yield* Effect.tryPromise({
        try: () => options.resolveHostname!(normalizedHostname),
        catch: () =>
          new HostedOutboundRequestBlocked({
            url: value,
            reason: "Hostname could not be resolved",
          }),
      });

      if (addresses.length === 0) {
        return yield* new HostedOutboundRequestBlocked({
          url: value,
          reason: "Hostname did not resolve to an address",
        });
      }

      for (const { address } of addresses) {
        if (isLocalOrPrivateHostname(address)) {
          return yield* new HostedOutboundRequestBlocked({
            url: value,
            reason: "Resolved address is local or private",
          });
        }
      }
    }
  });

const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"] as const;

const stripCredentialHeaders = (init: RequestInit | undefined): RequestInit => {
  const headers = new Headers(init?.headers);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return { ...init, headers };
};

const guardFetch = (
  underlying: typeof globalThis.fetch,
  options: HostedHttpClientOptions,
): typeof globalThis.fetch =>
  (async (input, init) => {
    const guardOptions = {
      ...options,
      resolveHostname: options.resolveHostname ?? resolveHostnameWithNodeDns,
    };
    const maxRedirects = options.maxRedirects ?? 10;
    let current: Parameters<typeof globalThis.fetch>[0] | URL = input;
    let currentInit = init;
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const url = current instanceof Request ? current.url : String(current);
      await Effect.runPromise(validateHostedOutboundUrl(url, guardOptions));
      const response = await underlying(current, {
        ...currentInit,
        redirect: "manual",
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location") &&
        redirects < maxRedirects
      ) {
        const next = new URL(response.headers.get("location")!, url);
        // Cross-origin redirects are followed (the loop re-validates every
        // hop), but credentials minted for the original origin must not leak
        // to the redirect target — same as fetch/curl behavior.
        if (next.origin !== new URL(url).origin) {
          currentInit = stripCredentialHeaders(currentInit);
        }
        current = next.toString();
        continue;
      }
      return response;
    }
    return await underlying(current, { ...currentInit, redirect: "manual" });
  }) as typeof globalThis.fetch;

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
