/** Bun fetch adapter that connects only to an address checked by the shared host policy. */
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { DestinationRefused, safeLookup, type AddressLookup } from "./safe-dns.ts";
import { parseDestination, type UrlPolicy } from "./url-policy.ts";

/** Pin each request to an approved IP, preserving HTTP Host and TLS identity. Callers own redirects. */
export const safeHttpClient = (policy: UrlPolicy, resolve?: AddressLookup) =>
  Effect.gen(function* () {
    const lookup = safeLookup(policy, resolve);
    // This callback implements Effect's native fetch boundary. Body conversion,
    // interruption and HTTP error translation remain owned by FetchHttpClient.
    const checkedFetch: typeof globalThis.fetch = async (input, init) => {
      const original = parseDestination(
        input instanceof Request ? input.url : String(input),
        policy,
      );
      if (original === undefined) throw new DestinationRefused("Requested destination");
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      const hostname = original.hostname.replace(/^\[|\]$/g, "");
      const address = await new Promise<string>((accept, reject) => {
        lookup(hostname, {}, (error, address) => {
          if (error !== null) reject(error);
          else if (typeof address === "string") accept(address);
          else reject(new DestinationRefused(hostname));
        });
      });
      request.signal.throwIfAborted();
      const pinned = new URL(original);
      pinned.hostname = address.includes(":") ? `[${address}]` : address;
      const headers = new Headers(request.headers);
      headers.set("host", original.host);
      const options = {
        ...init,
        method: request.method,
        body: request.body,
        signal: request.signal,
        headers,
        // Do not let a proxy or automatic redirect perform another DNS lookup.
        proxy: false,
        redirect: "manual" as const,
        tls: { serverName: hostname },
      };
      return globalThis.fetch(pinned, options);
    };
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    return client.pipe(
      HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, checkedFetch)),
    );
  });
