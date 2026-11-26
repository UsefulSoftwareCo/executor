import { Effect, Layer, Scope } from "effect";
import { HttpRouter } from "effect/http";

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
