import { dashboardBatchPath } from "@executor-js/dashboard-start/batch";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Option, Scope } from "effect";
import { HttpServerRequest } from "effect/http";

const BatchScope = Context.Reference<Scope.Scope | undefined>("cloud/BatchScope", {
  defaultValue: () => undefined,
});

export const withBatchExecution = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (
      request.method !== "POST" ||
      Option.isNone(url) ||
      url.value.pathname !== dashboardBatchPath
    )
      return yield* handler;
    const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
    return yield* handler.pipe(Effect.provideService(BatchScope, scope));
  });

export const makeBatchExecutionMemo = <A, E, R>(build: Effect.Effect<A, E, R | Scope.Scope>) =>
  Effect.map(makeExecutionMemo(build), (memo) =>
    Effect.flatMap(BatchScope, (scope) =>
      scope === undefined ? memo : Scope.provide(memo, scope),
    ),
  );
