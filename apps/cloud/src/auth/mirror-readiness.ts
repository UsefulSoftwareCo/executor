// ---------------------------------------------------------------------------
// MirrorReadiness — the request-scoped service that answers whether the
// membership mirror may authorize this request (see
// `mirror-readiness-store.ts` for the rule and why it exists).
//
// Per-request layer shape, like `UserStoreService` and `WorkOsMirror`: it
// reads the request's postgres socket, so it is rebuilt per request
// (`RequestScopedServicesLive`) and never shared across Workers requests. One
// indexed point read per authorization, on the same socket the membership
// read uses next.
// ---------------------------------------------------------------------------

import { Clock, Context, Effect, Layer } from "effect";

import { DbService, type DrizzleDb } from "../db/db";
import {
  WorkOsMirrorError,
  tryPromiseService,
  userStoreReasonFromCause,
  withServiceLogging,
} from "./errors";
import { readMirrorReadiness, type MirrorReadinessState } from "./mirror-readiness-store";

export {
  MIRROR_RECONCILER_LAG_BUDGET,
  MirrorReadinessState,
  describeMirrorReadiness,
  mirrorReadinessFrom,
  type MirrorReadinessRow,
} from "./mirror-readiness-store";

export interface MirrorReadinessShape {
  /**
   * The mirror's readiness as of now. Fails with `WorkOsMirrorError` when the
   * row cannot be read — the caller must not treat that as either ready or
   * not; it is the same infra failure as any other mirror read.
   */
  readonly state: () => Effect.Effect<MirrorReadinessState, WorkOsMirrorError>;
}

const makeService = (db: DrizzleDb): MirrorReadinessShape => ({
  state: () =>
    Effect.flatMap(Clock.currentTimeMillis, (millis) =>
      withServiceLogging(
        "workos_mirror.readiness",
        (failure) =>
          new WorkOsMirrorError({
            operation: "readiness",
            reason: userStoreReasonFromCause(failure),
          }),
        tryPromiseService(() => readMirrorReadiness(db, new Date(millis))),
      ),
    ),
});

export class MirrorReadiness extends Context.Service<MirrorReadiness, MirrorReadinessShape>()(
  "@executor-js/cloud/MirrorReadiness",
) {
  static Live = Layer.effect(this)(Effect.map(DbService.asEffect(), ({ db }) => makeService(db)));
}

/**
 * A FRESH `MirrorReadiness` layer (new layer value per call), for a service
 * built once but invoked across many Workers requests — the MCP
 * org-authorization seam and the document gate — for the same reason
 * `makeUserStoreLayer` exists. See [[makeDbLayer]].
 */
export const makeMirrorReadinessLayer = (): Layer.Layer<MirrorReadiness, never, DbService> =>
  Layer.effect(MirrorReadiness)(Effect.map(DbService.asEffect(), ({ db }) => makeService(db)));
