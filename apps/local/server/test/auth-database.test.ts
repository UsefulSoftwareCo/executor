/** Retained local sessions move once into the shared auth database. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, FileSystem, Schema } from "effect";
import { AppId } from "@executor-js/sdk";
import { SessionHash } from "../src/contracts/auth.ts";
import { openLocalAuthDatabase } from "../src/implementation/auth-database.ts";
import { openBrowserSessions } from "../src/implementation/session-store.ts";
import { openStorage } from "../src/implementation/storage.ts";
import { makeLocalAuth } from "../src/implementation/auth.ts";
import { makeLocalMcpOAuth } from "../src/implementation/mcp-oauth.ts";
import { ServerConfig } from "../src/contracts/config.ts";

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

test("moves retained OAuth and latest browser sessions into the main engine without replay", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-unified-db-" });
        const config = Schema.decodeUnknownSync(ServerConfig)({
          directory,
          port: 43123,
          apiKey: "synthetic-unified-db-admin-000000000000",
          encryptionKey: "ab".repeat(32),
        });
        const revoked = SessionHash.make("c".repeat(64));
        const retained = SessionHash.make("d".repeat(64));
        const session = (hash: typeof revoked) => ({
          hash,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          access: "dashboard" as const,
        });
        const now = new Date("2026-01-01T00:00:00.000Z");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const old = yield* openBrowserSessions(directory);
            yield* old.put(session(revoked), now);
          }),
        );
        const operator = yield* Effect.scoped(
          Effect.gen(function* () {
            const old = yield* openLocalAuthDatabase(directory);
            const sessions = yield* openBrowserSessions(directory, old.sql);
            yield* sessions.revoke(revoked);
            yield* sessions.put(session(retained), now);
            const pairing = yield* makeLocalAuth(globalThis.crypto, directory, old.sql);
            yield* makeLocalMcpOAuth(config, pairing, globalThis.crypto, old);
            const users = yield* old.sql.unsafe<{ readonly id: string }>(
              "SELECT id FROM \"user\" WHERE email = 'operator@executor.local'",
            );
            assert.equal(users.length, 1);
            yield* old.sql.unsafe(
              'INSERT INTO "oauthClient" ("id", "clientId", "redirectUris") VALUES ($1, $2, $3::jsonb)',
              ["client-retained", "client-retained", '["http://127.0.0.1/callback"]'],
            );
            yield* old.sql.unsafe(
              'INSERT INTO "oauthRefreshToken" ("id", "token", "clientId", "userId", "expiresAt", "createdAt", "scopes") VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb)',
              [
                "refresh-retained",
                "synthetic-refresh-token",
                "client-retained",
                users[0]!.id,
                "2030-01-01T00:00:00.000Z",
                "2026-01-01T00:00:00.000Z",
                '["mcp"]',
              ],
            );
            yield* old.sql.unsafe("CREATE TABLE legacy_probe (id text PRIMARY KEY)");
            yield* old.sql.unsafe("INSERT INTO legacy_probe (id) VALUES ('must-not-import')");
            return users[0]!.id;
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const main = yield* openStorage(directory);
            const shared = yield* openLocalAuthDatabase(directory, main);
            const pairing = yield* makeLocalAuth(globalThis.crypto, directory, shared.sql);
            const failed = yield* Effect.exit(
              makeLocalMcpOAuth(config, pairing, globalThis.crypto, shared),
            );
            assert.ok(Exit.isFailure(failed));
            assert.equal((yield* shared.sql.unsafe('SELECT id FROM "oauthClient"')).length, 0);
            assert.equal(
              (yield* shared.sql.unsafe(
                "SELECT source FROM local_auth_imports WHERE source = 'mcp-auth.pglite.oauth'",
              )).length,
              0,
            );
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const old = yield* openLocalAuthDatabase(directory);
            yield* old.sql.unsafe("DROP TABLE legacy_probe");
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const main = yield* openStorage(directory);
            const shared = yield* openLocalAuthDatabase(directory, main);
            const sessions = yield* openBrowserSessions(directory, shared.sql);
            assert.equal(yield* sessions.get(revoked), null);
            assert.equal((yield* sessions.get(retained))?.hash, retained);
            const pairing = yield* makeLocalAuth(globalThis.crypto, directory, shared.sql);
            yield* makeLocalMcpOAuth(config, pairing, globalThis.crypto, shared);
            const users = yield* shared.sql.unsafe<{ readonly id: string }>(
              "SELECT id FROM \"user\" WHERE email = 'operator@executor.local'",
            );
            assert.deepEqual(
              users.map((user) => user.id),
              [operator],
            );
            assert.deepEqual(
              (yield* shared.sql.unsafe<{ readonly id: string }>(
                "SELECT id FROM \"oauthRefreshToken\" WHERE id = 'refresh-retained'",
              )).map((token) => token.id),
              ["refresh-retained"],
            );
            yield* sessions.revoke(retained);
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const main = yield* openStorage(directory);
            const shared = yield* openLocalAuthDatabase(directory, main);
            const sessions = yield* openBrowserSessions(directory, shared.sql);
            assert.equal(yield* sessions.get(retained), null);
            const pairing = yield* makeLocalAuth(globalThis.crypto, directory, shared.sql);
            yield* makeLocalMcpOAuth(config, pairing, globalThis.crypto, shared);
            const users = yield* shared.sql.unsafe<{ readonly id: string }>(
              "SELECT id FROM \"user\" WHERE email = 'operator@executor.local'",
            );
            assert.deepEqual(
              users.map((user) => user.id),
              [operator],
            );
            assert.equal(
              (yield* shared.sql.unsafe<{ readonly id: string }>(
                "SELECT id FROM \"oauthRefreshToken\" WHERE id = 'refresh-retained'",
              )).length,
              1,
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
