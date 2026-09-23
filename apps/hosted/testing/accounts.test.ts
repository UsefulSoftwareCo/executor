/** Fixture sessions must work with unmodified host auth and retain organization isolation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { betterAuth } from "better-auth";
import { Authentication, OrganizationId } from "@executor-js/hosted-server";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import { ConfigProvider, Effect, Exit, FileSystem, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { selfHostDatabase } from "../self-host/src/database.ts";
import { selfHostAuth } from "../self-host/src/auth.ts";
import { AuthDatabase } from "../self-host/src/contracts/database.ts";
import { cloudAuthOptions, cloudAuthSettings } from "../cloud/src/implementation/auth-options.ts";
import { cloudSessionCookiePrefix } from "../cloud/src/contracts/browser.ts";
import { unavailableAuthEmail } from "../cloud/src/contracts/email.ts";
import { TestOrigin, provisionTestAccount, testAccountAuth } from "./accounts.ts";

test("only exact loopback origins are accepted", () => {
  for (const url of [
    "https://executor.sh",
    "https://localhost.example.com",
    "https://user@localhost",
    "http://localhost/path",
  ])
    assert.equal(Schema.is(TestOrigin)(url), false);
  assert.equal(Schema.is(TestOrigin)("http://127.0.0.1:4400"), true);
  assert.equal(Schema.is(TestOrigin)("http://member-test.localhost:55453"), true);
});

for (const host of ["self-host", "cloud"] as const) {
  test(`${host} fixtures authenticate with real host policy, reuse identities and preserve roles`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const origin = host === "cloud" ? "https://127.0.0.1:5395" : "http://127.0.0.1:55439";
          const secret = "synthetic-fixture-signing-secret-1234567890";
          yield* Effect.gen(function* () {
            const database = yield* AuthDatabase;
            const sql = yield* SqlClient.SqlClient;
            const cookiePrefix =
              host === "cloud" ? cloudSessionCookiePrefix(origin) : "executor-hosted";
            const auth = testAccountAuth({
              origin,
              secret: Redacted.make(secret),
              database,
              cookiePrefix,
            });
            const input = {
              host,
              name: "owner",
              organization: "agent-tests",
              role: "owner",
              origin,
            } as const;
            const owner = Redacted.value(yield* provisionTestAccount(auth, input));
            const again = Redacted.value(yield* provisionTestAccount(auth, input));
            assert.equal(again.userId, owner.userId);
            assert.equal(again.organizationId, owner.organizationId);
            assert.equal((yield* sql`select id from "user"`).length, 1);
            assert.equal((yield* sql`select id from "member"`).length, 1);
            assert.ok(Date.parse(owner.expiresAt) <= Date.now() + 3600_000);
            assert.ok(owner.cookies.every((cookie) => cookie.name.includes(cookiePrefix)));
            const member = Redacted.value(
              yield* provisionTestAccount(auth, { ...input, name: "member", role: "member" }),
            );
            assert.ok(
              Exit.isFailure(
                yield* Effect.exit(provisionTestAccount(auth, { ...input, name: "member" })),
              ),
            );
            const requestHeaders = new Headers(member.headers);
            if (host === "self-host") {
              const native = yield* selfHostAuth;
              // The actual host service verifies the signed cookie against the persisted session.
              yield* Effect.gen(function* () {
                const identity = yield* Authentication;
                assert.equal((yield* identity.current(requestHeaders))?.userId, member.userId);
                assert.equal(
                  (yield* identity.membership(
                    requestHeaders,
                    OrganizationId.make(member.organizationId),
                  )).role,
                  "member",
                );
                assert.equal(
                  yield* identity.current(
                    new Headers({ cookie: "executor-hosted.session_token=invalid" }),
                  ),
                  null,
                );
              }).pipe(Effect.provide(native.identity));
              assert.ok(
                Exit.isFailure(
                  yield* Effect.exit(
                    provisionTestAccount(auth, { ...input, organization: "second-org" }),
                  ),
                ),
              );
            } else {
              const settings = yield* cloudAuthSettings;
              const base = cloudAuthOptions(settings, [], unavailableAuthEmail);
              yield* migrateHostedSchemas({ ...base, database, secret });
              const native = betterAuth({
                ...base,
                database,
                secret,
                advanced: { ...base.advanced, cookiePrefix },
              });
              const session = yield* Effect.promise(() =>
                native.api.getSession({ headers: requestHeaders }),
              );
              assert.equal(session?.user.id, member.userId);
              const role = yield* Effect.promise(() =>
                native.api.getActiveMemberRole({
                  headers: requestHeaders,
                  query: { organizationId: member.organizationId },
                }),
              );
              assert.equal(role.role, "member");
              const other = Redacted.value(
                yield* provisionTestAccount(auth, {
                  ...input,
                  name: "other",
                  organization: "other-tests",
                }),
              );
              yield* Effect.promise(() =>
                assert.rejects(
                  () =>
                    native.api.getActiveMemberRole({
                      headers: requestHeaders,
                      query: { organizationId: other.organizationId },
                    }),
                  { status: "FORBIDDEN" },
                ),
              );
            }
          }).pipe(
            Effect.provide(selfHostDatabase),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                EXECUTOR_DATA_DIR: directory,
                BETTER_AUTH_URL: origin,
                BETTER_AUTH_SECRET: secret,
                GOOGLE_CLIENT_ID: "synthetic-google",
                GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
                GITHUB_CLIENT_ID: "synthetic-github",
                GITHUB_CLIENT_SECRET: "synthetic-github-secret",
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ));
}
