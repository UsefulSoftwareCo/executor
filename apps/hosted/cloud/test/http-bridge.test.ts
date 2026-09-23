/** Behavioral regressions for the pinned Alchemy HTTP bridge patch. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Exit, Schema, Scope, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

type Handler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Scope.Scope | HttpServerRequest.HttpServerRequest
>;
const Bridge = Schema.Struct({
  makeRequestEffect: Schema.declare(
    (
      value,
    ): value is (
      request: Request,
      handler: Handler,
    ) => Effect.Effect<Response, never, Scope.Scope> => typeof value === "function",
  ),
});
// This implementation is the subject of our package patch, not a product import.
const bridge = Schema.decodeUnknownSync(Bridge)(
  await import(
    new URL("./Workers/HttpServer.js", import.meta.resolve("alchemy/Cloudflare/Bridge")).href
  ),
);

test(
  "the HTTP response does not wait for cleanup owned by the event scope",
  { timeout: 5_000 },
  async () => {
    const scope = Scope.makeUnsafe();
    const release = Deferred.makeUnsafe<void>();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Deferred.await(release).pipe(
          Effect.andThen(
            Effect.sync(() => {
              finished = true;
            }),
          ),
        ),
      );
      return HttpServerResponse.text("ready");
    });
    try {
      const response = await Promise.race([
        Effect.runPromise(
          bridge
            .makeRequestEffect(new Request("https://fixture.test/"), handler)
            .pipe(Effect.provideService(Scope.Scope, scope)),
        ),
        new Promise<Response>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Response waited for cleanup")), 1_000);
        }),
      ]);
      assert.equal(await response.text(), "ready");
      assert.equal(finished, false);
    } finally {
      clearTimeout(timer);
      Effect.runSync(Deferred.succeed(release, undefined));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    assert.equal(finished, true);
  },
);

test("a streamed response retains its request resources until the body finishes", async () => {
  const scope = Scope.makeUnsafe();
  const releaseBody = Deferred.makeUnsafe<void>();
  let finished = false;
  const handler = Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        finished = true;
      }),
    );
    return HttpServerResponse.stream(
      Stream.fromEffect(
        Deferred.await(releaseBody).pipe(Effect.as(new TextEncoder().encode("streamed"))),
      ),
    );
  });
  const response = await Effect.runPromise(
    bridge
      .makeRequestEffect(new Request("https://fixture.test/"), handler)
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));
  assert.equal(finished, false);
  Effect.runSync(Deferred.succeed(releaseBody, undefined));
  assert.equal(await response.text(), "streamed");
  assert.equal(finished, true);
});
