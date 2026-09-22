/** Real SQL checks for the tracked ORM and native transaction boundary. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AccountId, OwnerId, ProviderId, makeExecutorStorage } from "../src/index.ts";

const withStorage = <A, E>(
  work: (
    storage: Effect.Success<ReturnType<typeof makeExecutorStorage>>,
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        return yield* work(storage);
      }).pipe(Effect.provide(pgliteLayer())),
    ),
  );

const provider = ProviderId.make("prv_test");
const account = {
  id: AccountId.make("acc_test"),
  owner: OwnerId.make("alice"),
  provider,
  method: "key",
  label: "Work",
  encryptedCredentials: new Uint8Array([1, 2, 3]),
  createdAt: new Date(0),
};

test("real SQL rollback and cancellation leave no rows or live notification", () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const db = storage.orm("3.0.0");
      const initial = yield* Deferred.make<void>();
      const rows: number[] = [];
      const subscriber = yield* storage.reactivity.subscribe(db.count("providers")).pipe(
        Stream.take(2),
        Stream.runForEach(({ value }) =>
          Effect.gen(function* () {
            rows.push(value);
            yield* Deferred.succeed(initial, undefined);
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(initial);
      yield* db
        .transaction(
          Effect.gen(function* () {
            yield* db.create("providers", { id: provider, definition: {} });
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.result);
      assert.equal(yield* db.count("providers"), 0);
      const inserted = yield* Deferred.make<void>();
      const cancelled = yield* db
        .transaction(
          Effect.gen(function* () {
            yield* db.create("providers", { id: provider, definition: {} });
            yield* Deferred.succeed(inserted, undefined);
            yield* Effect.never;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inserted);
      yield* Fiber.interrupt(cancelled);
      assert.equal(yield* db.count("providers"), 0);
      yield* db.create("providers", { id: provider, definition: {} });
      yield* Fiber.join(subscriber);
      assert.deepEqual(rows, [0, 1]);
    }),
  ));

test("joined and empty reads observe related table writes", () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const db = storage.orm("3.0.0");
      yield* db.create("providers", { id: provider, definition: { name: "Before" } });
      yield* db.create("accounts", account);
      const ready = yield* Deferred.make<void>();
      const definitions: unknown[] = [];
      const subscriber = yield* storage.reactivity
        .subscribe(db.findMany("accounts", { join: (b) => b.providerDefinition() }))
        .pipe(
          Stream.take(2),
          Stream.runForEach(({ value }) =>
            Effect.gen(function* () {
              definitions.push(value[0]?.providerDefinition?.definition);
              yield* Deferred.succeed(ready, undefined);
            }),
          ),
          Effect.forkChild,
        );
      yield* Deferred.await(ready);
      yield* db.updateMany("providers", {
        where: (b) => b("id", "=", provider),
        set: { definition: { name: "After" } },
      });
      yield* Fiber.join(subscriber);
      assert.deepEqual(definitions, [{ name: "Before" }, { name: "After" }]);
    }),
  ));

test("an untracked outer SQL transaction is rejected before a tracked write", () =>
  withStorage((storage) =>
    Effect.gen(function* () {
      const db = storage.orm("3.0.0");
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql
        .withTransaction(db.create("providers", { id: provider, definition: {} }))
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(yield* db.count("providers"), 0);
    }),
  ));
