import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

export class HostedOutboundRequestBlocked extends Schema.TaggedErrorClass<HostedOutboundRequestBlocked>()(
  "HostedOutboundRequestBlocked",
  {
    url: Schema.String,
    reason: Schema.String,
  },
) {}

export interface HostedHttpClientOptions {
  readonly allowLocalNetwork?: boolean;
  readonly maxRedirects?: number;
  readonly fetch?: typeof globalThis.fetch;
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

const isPrivateIpv4 = ([a, b]: readonly [number, number, number, number]): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168);

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
  if (ipv4) return isPrivateIpv4(ipv4);
  const mappedIpv4 = parseIpv4MappedIpv6(normalized);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  return (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
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
  });

const guardFetch = (
  underlying: typeof globalThis.fetch,
  options: HostedHttpClientOptions,
): typeof globalThis.fetch =>
  (async (input, init) => {
    const maxRedirects = options.maxRedirects ?? 10;
    let current: Parameters<typeof globalThis.fetch>[0] | URL = input;
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const url = current instanceof Request ? current.url : String(current);
      Effect.runSync(validateHostedOutboundUrl(url, options));
      const response = await underlying(current, { ...init, redirect: "manual" });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location") &&
        redirects < maxRedirects
      ) {
        const next = new URL(response.headers.get("location")!, url);
        if (next.origin !== new URL(url).origin) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch-compatible adapter must reject blocked requests
          throw new HostedOutboundRequestBlocked({
            url: next.toString(),
            reason: "Cross-origin redirects are not allowed",
          });
        }
        current = next.toString();
        continue;
      }
      return response;
    }
    return await underlying(current, { ...init, redirect: "manual" });
  }) as typeof globalThis.fetch;

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
