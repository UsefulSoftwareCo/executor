import { Context, Effect, Layer } from "effect";
import { makeUserStore } from "../auth/user-store";
import { DbService } from "../db/db";
import { tryPromiseService, userStoreErrorFromFailure, withServiceLogging } from "./errors";

// ---------------------------------------------------------------------------
// UserStoreService — wraps the Drizzle-backed user store with Effect
// ---------------------------------------------------------------------------

type RawStore = ReturnType<typeof makeUserStore>;

// `op` names the store call so every span reads `user_store.<operation>`
// instead of one undifferentiated "user_store" bucket, failures log which
// query actually failed, and — because the same `op` is threaded onto the
// public error alongside the classified driver reason — an error report is
// diagnosable without the trace.
const makeService = (store: RawStore) => ({
  use: <A>(op: string, fn: (s: RawStore) => Promise<A>) =>
    withServiceLogging(
      `user_store.${op}`,
      (failure) => userStoreErrorFromFailure(op, failure),
      tryPromiseService(() => fn(store)),
    ),
});

type UserStoreServiceType = ReturnType<typeof makeService>;

export class UserStoreService extends Context.Service<UserStoreService, UserStoreServiceType>()(
  "@executor-js/cloud/UserStoreService",
) {
  static Live = Layer.effect(this)(
    Effect.map(DbService.asEffect(), ({ db }) => makeService(makeUserStore(db))),
  );
}

/**
 * A FRESH `UserStoreService` layer (new layer value per call). `UserStoreService.Live`
 * captures its `db` at build time; when a long-lived runtime's shared memo map
 * memoizes that const layer once, it pins the first request's postgres socket and
 * reuses it on later requests — illegal under Cloudflare's per-request I/O. Build
 * this (over a fresh `DbService` layer) anywhere a service is constructed once but
 * invoked across many requests (the MCP org-authorization seam). See [[makeDbLayer]].
 */
export const makeUserStoreLayer = (): Layer.Layer<UserStoreService, never, DbService> =>
  Layer.effect(UserStoreService)(
    Effect.map(DbService.asEffect(), ({ db }) => makeService(makeUserStore(db))),
  );
