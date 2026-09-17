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
// per-request scope, so `acquireRelease` fires per request. Background work
// retains that scope until its database writes finish; the response need not
// wait, but the platform keep-alive must include resource cleanup too.
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

import { Context, Effect, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";

/**
 * Retain this request's resources for already-started background work. The
 * caller owns task error reporting; the returned promise settles only after
 * all retained tasks AND resource finalizers finish, for the host's waitUntil.
 */
export class RequestBackgroundTasks extends Context.Service<
  RequestBackgroundTasks,
  { readonly retain: (task: Promise<unknown>) => Promise<void> }
>()("@executor-js/api/RequestBackgroundTasks") {}

/**
 * Build an `HttpRouter.middleware` that provides `layer`'s services to
 * each request. The layer is rebuilt per HTTP request so
 * `Effect.acquireRelease` fires per request. Resources close after the handler
 * and its registered background work settle, without delaying the response.
 *
 * The returned value is a `Middleware`. Use `.layer` to apply it as a
 * standalone layer; use `.combine(other)` to fold it into another
 * middleware whose per-request body needs services this layer provides
 * (e.g. `ExecutionStackMiddleware`'s auth logic that yields
 * `DbService` + `UserStoreService` — combining drops those from the
 * outer middleware's `requires`).
 */
export const requestScopedMiddleware = <A>(layer: Layer.Layer<A>) =>
  HttpRouter.middleware<{ provides: A | RequestBackgroundTasks }>()((httpEffect) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const pending = new Set<Promise<void>>();
        const released = Promise.withResolvers<void>();
        const background = RequestBackgroundTasks.of({
          retain: (task) => {
            // SDK tasks report their own failures. Both outcomes release the
            // resource lease; a rejected task must not leak its database.
            const settled = task.then(
              () => {
                pending.delete(settled);
              },
              () => {
                pending.delete(settled);
              },
            );
            pending.add(settled);
            return released.promise;
          },
        });
        return yield* restore(
          Effect.gen(function* () {
            // Never inherit the boot MemoMap: concurrent requests each own
            // their socket, including after either response has been sent.
            const memoMap = yield* Layer.makeMemoMap;
            const services = yield* Layer.buildWithMemoMap(layer, memoMap, scope);
            return yield* Effect.provideContext(httpEffect, services);
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(RequestBackgroundTasks, background),
          ),
        ).pipe(
          Effect.onExit((exit) => {
            const release = Effect.gen(function* () {
              // A retained task may start another task before it settles.
              while (pending.size > 0) {
                yield* Effect.promise(() => Promise.all(pending));
              }
            }).pipe(
              Effect.ensuring(Scope.close(scope, exit)),
              Effect.ensuring(Effect.sync(() => released.resolve())),
            );
            // With no background work, preserve synchronous teardown. Otherwise
            // the resource owner, including cleanup, is kept alive by the host.
            return pending.size === 0 ? release : release.pipe(Effect.forkDetach, Effect.asVoid);
          }),
        );
      }),
    ),
  );
