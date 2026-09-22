/** Real disk PGlite lifecycle. Existing SQLite files are never opened or overwritten. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { AccountId, OwnerId, ProviderId } from "@executor-js/sdk/core";
import { openStorage } from "../src/implementation/storage.ts";

test("PGlite persists exact account data across close/reopen and leaves the old SQLite path intact", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-pglite-" });
        const oldPath = path.join(directory, "executor.sqlite");
        yield* fs.writeFileString(oldPath, "untouched legacy fixture");
        const provider = ProviderId.make("prv_fixture");
        const account = {
          id: AccountId.make("acc_fixture"),
          owner: OwnerId.make("local"),
          provider,
          method: "key",
          label: "Default",
          createdAt: new Date("2026-07-01T12:34:56.789Z"),
          encryptedCredentials: new Uint8Array([1, 2, 3]),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* openStorage(directory);
            const orm = storage.orm("3.0.0");
            yield* orm.create("providers", { id: provider, definition: {} });
            yield* orm.create("accounts", account);
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* openStorage(directory);
            assert.deepEqual(yield* storage.orm("3.0.0").findMany("accounts"), [account]);
          }),
        );
        assert.equal(yield* fs.readFileString(oldPath), "untouched legacy fixture");
        assert.equal((yield* fs.stat(path.join(directory, "executor.pglite"))).mode & 0o777, 0o700);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  ));
