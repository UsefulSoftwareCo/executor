/** Node HTTP adapter with connection-time destination checks. */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import { Effect } from "effect";
import { safeLookup, type AddressLookup } from "./safe-dns.ts";
import type { UrlPolicy } from "./url-policy.ts";

export { safeLookup, DestinationRefused, type AddressLookup } from "./safe-dns.ts";

/** One Undici agent for the host process, destroyed with the scope that built it. */
export const safeDispatcher = (policy: UrlPolicy, resolve?: AddressLookup) =>
  Effect.acquireRelease(
    Effect.sync(() => new Undici.Agent({ connect: { lookup: safeLookup(policy, resolve) } })),
    (agent) => Effect.promise(() => agent.destroy()),
  );

/**
 * An `HttpClient` that refuses a private destination at connect time. Node hosts only. The
 * agent lives for the caller's scope, which is the host process, not one request.
 */
export const safeHttpClient = (policy: UrlPolicy, resolve?: AddressLookup) =>
  Effect.flatMap(safeDispatcher(policy, resolve), (dispatcher) =>
    Effect.provideService(NodeHttpClient.makeUndici, NodeHttpClient.Dispatcher, dispatcher),
  );
