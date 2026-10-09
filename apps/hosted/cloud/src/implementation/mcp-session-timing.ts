/**
 * How long an MCP request waits on its session object beyond what the object's own clock observed.
 * A Durable Object's clock only advances on I/O: CPU after the request's last I/O, and time the
 * request waits while the isolate runs other work, are invisible to its spans, and on a busy object
 * even its start and end times lag. The object reports the duration it observed and how many
 * requests it was already answering; the gateway compares that duration with its own wait.
 */
import { Clock, Effect } from "effect";
import { HttpServerResponse } from "effect/http";

/** Carries the object's own handling time to the gateway, which removes it from the response. */
const handledHeader = "x-executor-session-handled-ms";

/** Requests being answered by one object, or by every session object in one isolate. */
interface Answering {
  count: number;
}

/**
 * Module state lives as long as the isolate, so every session object in it shares this count.
 * Alchemy runs a Durable Object's constructor effect once per object, so the session factory
 * cannot hold it.
 */
const isolate: Answering = { count: 0 };

/**
 * Answer one object's requests. Each request's span records how many other requests this object
 * and its isolate were answering when it started; a request counts until its response is ready, so
 * an open stream does not. The response carries the time the object observed until then.
 */
export const makeAnswer = () => {
  const object: Answering = { count: 0 };
  return <E, R>(
    handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "executor.mcp.concurrent.object": object.count,
          "executor.mcp.concurrent.isolate": isolate.count,
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

/**
 * Forward one request to its session object. The forward span records the gateway's wait until
 * the response headers arrived and the duration the object's clock observed, each on its own
 * clock. `unseen_ms` is their difference: the hop both ways, time before the object's clock first
 * advanced, and CPU after its last advance. CPU between two of the object's I/O waits is already
 * inside `handled_ms`, so the residual is not the object's CPU. A request that starts on a lagging
 * clock observes more than really passed; when that exceeds the gateway's wait, `clocks_disagree`
 * marks it and no residual is recorded. A shorter lag cannot be told apart from the durations, and
 * comparing the two machines' timestamps is no better: they differ by milliseconds on quiet calls.
 * A response without the header (from a request the object failed or that was interrupted before
 * its response was ready, or from an older object version during a deploy) records none of these.
 * A cancelled MCP call is answered: the object ends its POST with an empty stream.
 */
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
