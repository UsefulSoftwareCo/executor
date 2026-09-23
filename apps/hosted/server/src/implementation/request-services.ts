/** Request-owned services for an isolate-owned router. No live resource enters the router's cache. */
import { Effect, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";

/** Build each request's services in its event scope with an independent memo map. */
export const requestServices = <A, E, R>(services: Layer.Layer<A, E, R>) =>
  HttpRouter.middleware<{ provides: A }>()((handler) =>
    Effect.gen(function* () {
      const context = yield* Layer.buildWithMemoMap(
        services,
        yield* Layer.makeMemoMap,
        yield* Scope.Scope,
      );
      return yield* Effect.provideContext(handler, context);
    }),
  );
