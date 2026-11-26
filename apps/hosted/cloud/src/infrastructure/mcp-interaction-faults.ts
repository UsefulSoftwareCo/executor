import type * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";

export type Kv = Cloudflare.DurableObjectStorage["kv"];

export interface InteractionFaults {
  readonly kv: Kv;
  readonly during: <A, E, R>(
    request: HttpServerRequest.HttpServerRequest,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export const interactionFaults = (kv: Kv): InteractionFaults => ({
  kv,
  during: (_request, work) => work,
});
