import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Stateless live queries must not allocate a cloud storage notification channel. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Deferred, Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import {
  aesGcmCredentials,
  BuildId,
  createExecutor,
  makeExecutorStorage,
  OwnerId,
  runtimeAdapter,
} from "@executor-js/sdk/core";

for (const database of [undefined, {}]) {
  test(`live query allocates a storage feed only for a declared database (${database !== undefined})`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
          const observed: string[] = [];
          const executor = yield* createExecutor({
            storage,
            sources: memorySourceStorage(),
            credentials,
            blobs: memoryBlobStore(),
            runtime: runtimeAdapter({
              build: () =>
                Effect.succeed({
                  build: BuildId.make("bld_fixture"),
                  requirements: { accounts: {}, ...(database === undefined ? {} : { database }) },
                }),
              workflow: () => Effect.die("Unexpected workflow invocation"),
              webhook: () => Effect.die("Unexpected webhook invocation"),
              inspect: () => Effect.succeed([]),
              call: () => Effect.succeed(null),
              mutate: () => Effect.succeed(null),
              query: () => Effect.succeed("fresh"),
              changes: (app) =>
                Stream.sync(() => {
                  observed.push(app);
                }),
            }),
          });
          const { app } = yield* executor.apps.deploy({
            owner: OwnerId.make("fixture"),
            name: "Fixture",
            files: [{ path: "index.ts", content: "Synthetic runtime" }],
          });
          const stream = yield* executor.appData.subscribe({
            app: app.id,
            name: "query",
            input: {},
          });
          const values = yield* Stream.runCollect(Stream.take(stream, 1));
          assert.equal(values[0]?.value, "fresh");
          assert.deepEqual(observed, database === undefined ? [] : [app.id]);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(BrowserCrypto.layer, pgliteLayer()))),
    ));
}

test("first data does not wait for notifications and setup-time writes are reconciled", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const ready = yield* Deferred.make<void>();
        const first = yield* Deferred.make<void>();
        let value = "initial";
        const executor = yield* createExecutor({
          storage,
          sources: memorySourceStorage(),
          blobs: memoryBlobStore(),
          credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
          runtime: runtimeAdapter({
            build: () =>
              Effect.succeed({
                build: BuildId.make("bld_watch_setup"),
                requirements: { accounts: {}, database: {} },
              }),
            workflow: () => Effect.die("Unexpected workflow invocation"),
            webhook: () => Effect.die("Unexpected webhook invocation"),
            inspect: () => Effect.succeed([]),
            call: () => Effect.succeed(null),
            query: () => Effect.sync(() => value),
            mutate: () =>
              Effect.sync(() => {
                value = "written during setup";
                return value;
              }),
            changes: () =>
              Stream.callback<void>((queue) =>
                Deferred.await(ready).pipe(Effect.andThen(Queue.offer(queue, undefined))),
              ),
          }),
        });
        const { app } = yield* executor.apps.deploy({
          owner: OwnerId.make("fixture"),
          name: "Delayed notifications",
          files: [{ path: "index.ts", content: "Synthetic runtime" }],
        });
        const input = { app: app.id, name: "value", input: {} };
        const stream = yield* executor.appData.subscribe(input);
        const reading = yield* stream.pipe(
          Stream.tap((snapshot) =>
            snapshot.value === "initial" ? Deferred.succeed(first, undefined) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(first).pipe(Effect.timeout("2 seconds"));
        yield* executor.appData.mutate(input);
        yield* Deferred.succeed(ready, undefined);
        const values = yield* Fiber.join(reading).pipe(Effect.timeout("2 seconds"));
        assert.deepEqual(
          values.map((snapshot) => snapshot.value),
          ["initial", "written during setup"],
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BrowserCrypto.layer, pgliteLayer()))),
  ));
