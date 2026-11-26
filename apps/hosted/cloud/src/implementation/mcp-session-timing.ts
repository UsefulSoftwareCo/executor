import { Clock, Effect } from "effect";
import { HttpServerResponse } from "effect/http";

const handledHeader = "x-executor-session-handled-ms";

interface Answering {
  count: number;
}

interface Isolate extends Answering {
  id: string | undefined;
  first: number | undefined;
  requests: number;
  objects: number;
}

const isolate: Isolate = { count: 0, id: undefined, first: undefined, requests: 0, objects: 0 };

export const makeAnswer = (held: () => Record<string, number>) => {
  const object: Answering = { count: 0 };
  isolate.objects += 1;
  return <E, R>(
    handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        isolate.id ??= crypto.randomUUID();
        isolate.first ??= started;
        isolate.requests += 1;
        const answering = {
          "executor.mcp.isolate.id": isolate.id,
          "executor.mcp.concurrent.object": object.count,
          "executor.mcp.concurrent.isolate": isolate.count,
        };
        yield* Effect.annotateCurrentSpan(answering);
        yield* Effect.withSpan(Effect.void, "mcp.session.admitted", {
          attributes: {
            ...answering,
            "executor.mcp.isolate.age_ms": started - isolate.first,
            "executor.mcp.isolate.requests": isolate.requests,
            "executor.mcp.isolate.objects": isolate.objects,
            ...held(),
          },
        });
        object.count += 1;
        isolate.count += 1;
        return started;
      }),
      (started) =>
        Effect.gen(function* () {
          const response = yield* handle;
          const handled = (yield* Clock.currentTimeMillis) - started;
          return HttpServerResponse.setHeader(response, handledHeader, String(handled));
        }),
      () =>
        Effect.sync(() => {
          object.count -= 1;
          isolate.count -= 1;
        }),
    );
};

export const timedForward = <E, R>(
  forward: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.gen(function* () {
    const sent = yield* Clock.currentTimeMillis;
    const response = yield* forward;
    const waited = (yield* Clock.currentTimeMillis) - sent;
    const handled = Number(response.headers[handledHeader]);
    if (Number.isSafeInteger(handled) && handled >= 0)
      yield* Effect.annotateCurrentSpan({
        "executor.mcp.session.waited_ms": waited,
        "executor.mcp.session.handled_ms": handled,
        "executor.mcp.session.clocks_disagree": handled > waited,
        ...(handled > waited ? {} : { "executor.mcp.session.unseen_ms": waited - handled }),
      });
    return HttpServerResponse.removeHeader(response, handledHeader);
  });
