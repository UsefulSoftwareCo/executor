import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { makeReactiveStore, type QuerySnapshot, type ReactiveStore } from "../src/index.ts";

const observe = <A>(store: ReactiveStore, query: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const results = yield* Queue.make<QuerySnapshot<A>>();
    const fiber = yield* store.subscribe(query).pipe(
      Stream.runForEach((snapshot) => Queue.offer(results, snapshot)),
      Effect.forkScoped,
    );
    return { results, fiber };
  });

test("empty reads become live and unrelated tables/datastores do not rerun the query", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeReactiveStore({ namespace: "one" });
        const other = yield* makeReactiveStore({ namespace: "two" });
        let rows: ReadonlyArray<string> = [];
        let evaluations = 0;
        const { results } = yield* observe(
          store,
          store.read(
            ["messages"],
            Effect.sync(() => {
              evaluations += 1;
              return rows;
            }),
          ),
        );
        assert.deepEqual((yield* Queue.take(results)).value, []);
        yield* other.write(["messages"], Effect.void);
        yield* store.write(["accounts"], Effect.void);
        yield* store.write(
          ["messages"],
          Effect.sync(() => {
            rows = ["hello"];
          }),
        );
        assert.deepEqual(yield* Queue.take(results), { revision: 2, value: ["hello"] });
        assert.equal(evaluations, 2);
      }),
    ),
  );
});

test("each evaluation replaces conditional dependencies", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeReactiveStore({ namespace: "conditional" });
        let selected = "first";
        let evaluations = 0;
        const query = Effect.gen(function* () {
          evaluations += 1;
          const table = yield* store.read(
            ["selection"],
            Effect.sync(() => selected),
          );
          return yield* store.read([table], Effect.succeed(table));
        });
        const { results } = yield* observe(store, query);
        assert.equal((yield* Queue.take(results)).value, "first");
        yield* store.write(
          ["selection"],
          Effect.sync(() => {
            selected = "second";
          }),
        );
        assert.equal((yield* Queue.take(results)).value, "second");
        yield* store.write(["first"], Effect.void);
        yield* store.write(["second"], Effect.void);
        assert.equal((yield* Queue.take(results)).value, "second");
        assert.equal(evaluations, 3);
      }),
    ),
  );
});

test("failed outer transactions and rolled-back nested writes do not publish", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeReactiveStore({ namespace: "transactions" });
        let evaluations = 0;
        const { results } = yield* observe(
          store,
          store.read(
            ["messages"],
            Effect.sync(() => ++evaluations),
          ),
        );
        yield* Queue.take(results);
        yield* store
          .transaction(
            Effect.gen(function* () {
              yield* store.write(["messages"], Effect.void);
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.catch(() => Effect.void));
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store
              .transaction(
                Effect.gen(function* () {
                  yield* store.write(["messages"], Effect.void);
                  return yield* Effect.fail("savepoint rollback");
                }),
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* store.write(["other"], Effect.void);
          }),
        );
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.write(["messages"], Effect.void);
            yield* store.transaction(store.write(["messages"], Effect.void));
          }),
        );
        assert.deepEqual(yield* Queue.take(results), { revision: 2, value: 2 });
      }),
    ),
  );
});

test("a write during the initial read retries before publishing a stale snapshot", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeReactiveStore({ namespace: "race" });
        const readStarted = yield* Deferred.make<void>();
        const readContinue = yield* Deferred.make<void>();
        let value = "old";
        let attempts = 0;
        const query = store.read(
          ["messages"],
          Effect.gen(function* () {
            attempts += 1;
            const snapshot = value;
            if (attempts === 1) {
              yield* Deferred.succeed(readStarted, undefined);
              yield* Deferred.await(readContinue);
            }
            return snapshot;
          }),
        );
        const { results } = yield* observe(store, query);
        yield* Deferred.await(readStarted);
        yield* store.write(
          ["messages"],
          Effect.sync(() => {
            value = "new";
          }),
        );
        yield* Deferred.succeed(readContinue, undefined);
        assert.deepEqual(yield* Queue.take(results), { revision: 1, value: "new" });
        assert.equal(attempts, 2);
      }),
    ),
  );
});

test("disconnect closes query resources and reconnect gets a fresh snapshot", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeReactiveStore({ namespace: "disconnect" });
        let value = "before";
        let evaluations = 0;
        const query = store.read(
          ["messages"],
          Effect.sync(() => {
            evaluations += 1;
            return value;
          }),
        );
        const first = yield* observe(store, query);
        yield* Queue.take(first.results);
        yield* Fiber.interrupt(first.fiber);
        yield* store.write(
          ["messages"],
          Effect.sync(() => {
            value = "after";
          }),
        );
        const next = yield* observe(store, query);
        assert.deepEqual(yield* Queue.take(next.results), { revision: 1, value: "after" });
        assert.equal(evaluations, 2);
      }),
    ),
  );
});

test("cancelled transaction bodies discard collected writes before notifying", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeReactiveStore({ namespace: "cancellation" });
        const entered = yield* Deferred.make<void>();
        const { results } = yield* observe(
          store,
          store.read(["messages"], Effect.succeed("snapshot")),
        );
        yield* Queue.take(results);
        const transaction = yield* store
          .transaction(
            Effect.interruptible(
              Effect.gen(function* () {
                assert.equal(yield* store.inTransaction, true);
                yield* store.write(["messages"], Effect.void);
                yield* Deferred.succeed(entered, undefined);
                yield* Effect.never;
              }),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(transaction);
        assert.equal(yield* store.inTransaction, false);
        yield* store.write(["messages"], Effect.void);
        assert.deepEqual(yield* Queue.take(results), { revision: 1, value: "snapshot" });
      }),
    ),
  );
});

test("nested query evaluation contributes its dependencies to the outer subscription", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeReactiveStore({ namespace: "nested-reads" });
        let value = "before";
        const query = store
          .evaluate(
            store.read(
              ["messages"],
              Effect.sync(() => value),
            ),
          )
          .pipe(Effect.map((result) => result.value));
        const { results } = yield* observe(store, query);
        assert.equal((yield* Queue.take(results)).value, "before");
        yield* store.write(
          ["messages"],
          Effect.sync(() => {
            value = "after";
          }),
        );
        assert.equal((yield* Queue.take(results)).value, "after");
      }),
    ),
  );
});
