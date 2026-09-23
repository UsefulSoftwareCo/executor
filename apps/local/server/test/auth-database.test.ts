/** Retained local sessions move once into the shared auth database. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { AppId } from "@executor-js/sdk";
import { SessionHash } from "../src/contracts/auth.ts";
import { openLocalAuthDatabase } from "../src/implementation/auth-database.ts";
import { openBrowserSessions } from "../src/implementation/session-store.ts";

test("imports existing browser sessions once and preserves revocation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-shared-auth-" });
        const hash = SessionHash.make("a".repeat(64));
        const session = {
          hash,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          access: "dashboard" as const,
        };
        const appHash = SessionHash.make("b".repeat(64));
        const appSession = {
          hash: appHash,
          expiresAt: session.expiresAt,
          access: {
            app: AppId.make("app_00000000-0000-4000-8000-000000000001"),
            origin: "http://127.0.0.1:5000",
            parent: hash,
          },
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            const legacy = yield* openBrowserSessions(directory);
            yield* legacy.put(session, new Date("2026-01-01T00:00:00.000Z"));
            yield* legacy.put(appSession, new Date("2026-01-01T00:00:00.000Z"));
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const shared = yield* openLocalAuthDatabase(directory);
            const migrated = yield* openBrowserSessions(directory, shared.sql);
            assert.equal((yield* migrated.get(hash))?.hash, hash);
            assert.deepEqual((yield* migrated.get(appHash))?.access, appSession.access);
            yield* migrated.revoke(hash);
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const shared = yield* openLocalAuthDatabase(directory);
            const migrated = yield* openBrowserSessions(directory, shared.sql);
            assert.equal(yield* migrated.get(hash), null);
            assert.deepEqual((yield* migrated.get(appHash))?.access, appSession.access);
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const legacy = yield* openBrowserSessions(directory);
            assert.equal((yield* legacy.get(hash))?.hash, hash);
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
