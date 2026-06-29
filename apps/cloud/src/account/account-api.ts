import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  AccountProvider,
  makeAccountApiLayer,
  requestScopedMiddleware,
} from "@executor-js/api/server";

import { ApiKeyService } from "../auth/api-keys";
import { UserStoreService } from "../auth/context";
import { sessionFromSealed, type Session } from "../auth/middleware";
import { WorkOSClient } from "../auth/workos";
import { AutumnService } from "../extensions/billing/service";
import { DbService } from "../db/db";
import { AccountCaller, workosAccountProvider } from "./workos-account-service";

// ---------------------------------------------------------------------------
// Cloud account API — the shared, provider-neutral `AccountHandlers` backed by
// the WorkOS `AccountProvider`, mounted at the same `/account/*` paths the
// shared React `AccountApiClient` hits. Identical UI to self-host; only the
// service implementation differs.
//
// The caller is resolved ONCE per request by this middleware — the SAME
// cookie-only credential `SessionAuthLive` accepts: `WorkOSClient
// .authenticateSealedSession` over the request's `wos-session` cookie. The
// resolved session (or `null`) is injected into the service as `AccountCaller`;
// the service no longer parses the cookie itself, so `/account/*` accepts
// exactly the same credential set as before (cookie session only — NOT api-key
// Bearer, which is the executor `/api/*` plane). This API still carries NO
// HttpApiMiddleware: auth is the single resolution path in this middleware.
//
// GOTCHA: an HttpApi handler's service requirement (`AccountProvider`) is NOT
// erased by plain `Layer.provide`/`provideMerge` on the builder layer — it
// leaks into the app layer's requirements and breaks the build. So `AccountProvider`
// is provided through a per-request router middleware (like `protected.ts`'s
// `ExecutionStackMiddleware`): long-lived services (`WorkOSClient` from the boot
// core; `AutumnService` from this account layer's own provide — billing is
// app-only and not on the neutral boot core) are pulled from context, while the
// per-request `UserStoreService` (postgres) comes from `rsLive` combined in, so
// the socket lives in the request fiber's scope. `rsLive` is a parameter so
// tests can swap a fake.
// ---------------------------------------------------------------------------

// Builds the WorkOS `AccountProvider` per request, providing it to the handler.
// Long-lived `WorkOSClient | AutumnService` come from the surrounding context
// (Autumn provided by `makeAccountApiLive` for the seat-gate); the per-request
// `UserStoreService` is supplied by the combined `rsLive` layer.
// `ApiKeyService.WorkOS` is built here on top of the boot `WorkOSClient`.
const AccountProviderMiddleware = HttpRouter.middleware<{ provides: AccountProvider }>()(
  Effect.gen(function* () {
    // Long-lived services only (built once at boot). `UserStoreService` and
    // `DbService` are NOT grabbed here — they come per request from the combined
    // `requestScopedMiddleware(rsLive)` layer, which folds them into this
    // middleware's body context (so they drop out of `requires`).
    const longLived = yield* Effect.context<WorkOSClient | AutumnService>();
    const workos = yield* WorkOSClient;
    return (httpEffect) =>
      Effect.gen(function* () {
        // Resolve the caller ONCE off the request's `wos-session` cookie — the
        // same credential `SessionAuthLive` accepts (`authenticateSealedSession`
        // over the sealed-session cookie). `null` => no/invalid session, which
        // the service maps to AccountUnauthorized (401).
        const request = yield* HttpServerRequest.HttpServerRequest;
        const cookieValue = request.cookies["wos-session"] ?? "";
        const resolved = yield* workos
          .authenticateSealedSession(cookieValue)
          .pipe(Effect.orElseSucceed(() => null));
        // The account API never re-sets the cookie, so the fallback sealed
        // session is `""` (vs `SessionAuthLive`, which keeps the inbound cookie).
        const session: Session | null = resolved ? sessionFromSealed(resolved, "") : null;

        // Built inside the request body so the WorkOS account service closes
        // over the per-request `UserStoreService` (postgres socket) supplied by
        // the combined request-scoped layer.
        const accountProvider = yield* Effect.provide(
          AccountProvider.asEffect(),
          workosAccountProvider.pipe(
            Layer.provide(ApiKeyService.WorkOS),
            Layer.provide(Layer.succeed(AccountCaller)({ session })),
          ),
        );
        return yield* Effect.provideService(httpEffect, AccountProvider, accountProvider);
      }).pipe(Effect.provideContext(longLived));
  }),
);

/**
 * The cloud account-provider middleware fed to `ExecutorApp.make`'s
 * `providers.account` slot: the per-request `AccountProvider`-providing
 * middleware combined with `requestScopedMiddleware(rsLive)` (so the WorkOS
 * account service closes over the per-request postgres socket). `AutumnService`
 * (the seat-gate) stays a residual requirement, satisfied by the app `boot`.
 */
export const workosAccountMiddleware = (rsLive: Layer.Layer<DbService | UserStoreService>) =>
  AccountProviderMiddleware.combine(requestScopedMiddleware(rsLive)).layer;

export const makeAccountApiLive = (rsLive: Layer.Layer<DbService | UserStoreService>) => {
  // Cloud builds the WorkOS `AccountProvider` INSIDE the request body (so it
  // closes over the per-request postgres socket), so it can't be a self-
  // contained `Layer<AccountProvider>` — it combines its own middleware with
  // `requestScopedMiddleware(rsLive)` and passes that to the shared mount
  // helper. Cloud serves the account API at root (no prefixed router), matching
  // the rest of the cloud router.
  //
  // `AutumnService.Default` is provided HERE because the account provider's
  // seat-gate (`reserveMemberSlot` / member-limits) reads it — one of the few
  // app-only billing touchpoints. It is NOT on the neutral boot core.
  const accountMiddleware = AccountProviderMiddleware.combine(
    requestScopedMiddleware(rsLive),
  ).layer;
  return makeAccountApiLayer(accountMiddleware).pipe(Layer.provideMerge(AutumnService.Default));
};
