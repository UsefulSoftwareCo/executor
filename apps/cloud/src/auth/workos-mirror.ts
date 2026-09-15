// ---------------------------------------------------------------------------
// WorkOsMirror — the WRITE side of cloud's local membership mirror.
//
// WorkOS owns users and organization memberships. This service keeps the
// `accounts` / `memberships` rows (db/schema.ts) in step with it so the read
// side (`auth/member-directory.ts`, the cloud `MemberDirectory`) never has to
// ask WorkOS. Three feeders write through it: the login callback (user +
// memberships already in hand), Executor-initiated changes (write-through in
// `auth/handlers.ts` and `account/workos-account-service.ts`), and the WorkOS
// Events API reconciler (dashboard-side changes, replayed in order from a
// persisted cursor). The one-off backfill runs the same store out-of-band.
//
// The queries live in `workos-mirror-store.ts`; this file binds them to the
// per-request `DbService`. Per-request layer shape, like `UserStoreService`:
// it holds the request's postgres socket, so it is rebuilt per request
// (`RequestScopedServicesLive`) and never shared across Workers requests.
// ---------------------------------------------------------------------------

import { Context, Effect, Layer } from "effect";

import { DbService } from "../db/db";
import { makeWorkOsMirrorStore, type WorkOsMirrorShape } from "./workos-mirror-store";

export { WorkOsMirrorError } from "./errors";
export {
  mirrorMembershipFromWorkOs,
  mirrorUserFromWorkOs,
  type WorkOsMembershipPayload,
  type WorkOsMirrorMembership,
  type WorkOsMirrorShape,
  type WorkOsMirrorUser,
  type WorkOsUserPayload,
} from "./workos-mirror-store";

export class WorkOsMirror extends Context.Service<WorkOsMirror, WorkOsMirrorShape>()(
  "@executor-js/cloud/WorkOsMirror",
) {
  static Live = Layer.effect(this)(
    Effect.map(DbService.asEffect(), ({ db }) => makeWorkOsMirrorStore(db)),
  );
}

/**
 * A FRESH `WorkOsMirror` layer (new layer value per call), for a service built
 * once but invoked across many Workers requests — the same reason
 * `makeUserStoreLayer` exists. See [[makeDbLayer]].
 */
export const makeWorkOsMirrorLayer = (): Layer.Layer<WorkOsMirror, never, DbService> =>
  Layer.effect(WorkOsMirror)(
    Effect.map(DbService.asEffect(), ({ db }) => makeWorkOsMirrorStore(db)),
  );
