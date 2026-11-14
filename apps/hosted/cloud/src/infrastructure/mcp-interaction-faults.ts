/**
 * The storage of a session object's record of issued requests (`mcp-interaction-store.ts`), with
 * nothing in front of it. Every deployed build bundles this module. Only a local `alchemy dev`
 * build replaces it with `mcp-interaction-faults-local.ts` (`localTestModules` in
 * `worker-build.ts`), so no deployed Worker contains that test fault for a binding or a request
 * to turn on.
 */
import type * as Cloudflare from "alchemy/Cloudflare";
import type { Effect } from "effect";
import type { HttpServerRequest } from "effect/http";

export type Kv = Cloudflare.DurableObjectStorage["kv"];

/** The record's storage, and a request run with whatever faults the build installs. */
export interface InteractionFaults {
  readonly kv: Kv;
  readonly during: <A, E, R>(
    request: HttpServerRequest.HttpServerRequest,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/** The object's storage as it is; every request runs unchanged. */
export const interactionFaults = (kv: Kv): InteractionFaults => ({
  kv,
  during: (_request, work) => work,
});
