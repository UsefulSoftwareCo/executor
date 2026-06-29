// ---------------------------------------------------------------------------
// Per-request layer provisioning for `HttpRouter.toWebHandler`
// ---------------------------------------------------------------------------
//
// `HttpRouter.toWebHandler` builds the application layer once into a
// boot-scoped `Context` and reuses it for every request, so any
// `Effect.acquireRelease` inside that layer fires once at worker boot.
// On Cloudflare Workers a postgres.js socket (a `Writable` I/O object)
// opened during request 1 cannot be touched from request 2 — the
// runtime throws "Cannot perform I/O on behalf of a different request".
//
// `Layer.provideMerge` and (despite the name) `HttpRouter.provideRequest`
// both build the inner layer at construction time. The only primitive
// that actually rebuilds per request is a router middleware whose
// per-request handler builds the layer with a *fresh* `MemoMap` and a
// per-request scope, so `acquireRelease` fires per request and finalizers
// run when the request fiber's scope closes.
//
// The fresh `MemoMap` matters: `Layer.build` would otherwise inherit
// `CurrentMemoMap` from the boot context (`HttpRouter.toWebHandler`
// installs one when it builds the app layer). Cloudflare Workers serves
// concurrent requests from the same isolate, and the boot MemoMap is
// shared across those request fibers — so two in-flight requests would
// both reuse the first one's memoized layer build (one postgres socket
// shared across two request handlers, which the runtime forbids). A
// per-request MemoMap scopes memoization to a single request fiber.
//
// See `apps/cloud/src/api.request-scope.node.test.ts` for the regression
// coverage that pins this rule down (sequential AND concurrent cases).
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

/**
 * Build an `HttpRouter.middleware` that provides `layer`'s services to
 * each request. The layer is rebuilt per HTTP request so
 * `Effect.acquireRelease` fires per request and is released when the
 * request fiber's scope closes.
 *
 * The returned value is a `Middleware`. Use `.layer` to apply it as a
 * standalone layer; use `.combine(other)` to fold it into another
 * middleware whose per-request body needs services this layer provides
 * (e.g. `ExecutionStackMiddleware`'s auth logic that yields
 * `DbService` + `UserStoreService` — combining drops those from the
 * outer middleware's `requires`).
 */
export const requestScopedMiddleware = <A>(layer: Layer.Layer<A>) =>
  HttpRouter.middleware<{ provides: A }>()((httpEffect) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Fresh MemoMap per request — see file-level note for why we
        // must NOT inherit `CurrentMemoMap` from the boot context.
        const memoMap = yield* Layer.makeMemoMap;
        const scope = yield* Effect.scope;
        const services = yield* Layer.buildWithMemoMap(layer, memoMap, scope);
        return yield* Effect.provideContext(httpEffect, services);
      }),
    ),
  );
