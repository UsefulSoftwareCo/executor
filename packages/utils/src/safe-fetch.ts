import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import { Effect } from "effect";
import { safeLookup, type AddressLookup } from "./safe-dns.ts";
import type { UrlPolicy } from "./url-policy.ts";

export { safeLookup, DestinationRefused, type AddressLookup } from "./safe-dns.ts";

export const safeDispatcher = (policy: UrlPolicy, resolve?: AddressLookup) =>
  Effect.acquireRelease(
    Effect.sync(() => new Undici.Agent({ connect: { lookup: safeLookup(policy, resolve) } })),
    (agent) => Effect.promise(() => agent.destroy()),
  );

export const safeHttpClient = (policy: UrlPolicy, resolve?: AddressLookup) =>
  Effect.flatMap(safeDispatcher(policy, resolve), (dispatcher) =>
    Effect.provideService(NodeHttpClient.makeUndici, NodeHttpClient.Dispatcher, dispatcher),
  );
