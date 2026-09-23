/** Exercise real password hashing, cookies, transactions, and admission with a fresh PGlite store. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { selfHostAuth } from "../src/auth.ts";
import { selfHostDatabase } from "../src/database.ts";

const origin = "http://localhost:55439";
test(
  "self-host setup has one owner, closes registration, and admits only a valid invitation",
  { timeout: 60_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-auth-parity-" });
          const configuration = ConfigProvider.fromUnknown({
            EXECUTOR_DATA_DIR: directory,
            BETTER_AUTH_URL: origin,
            BETTER_AUTH_SECRET: "synthetic-auth-parity-signing-secret-123456",
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const identity = yield* selfHostAuth;
              const sql = yield* SqlClient.SqlClient;
              const web = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  HttpRouter.toWebHandler(
                    HttpRouter.add("*", "/api/auth/*", identity.handler).pipe(
                      Layer.provide(HttpServer.layerServices),
                    ),
                    { disableLogger: true },
                  ),
                ),
                (web) => Effect.promise(() => web.dispose()),
              );
              const request = (path: string, body?: unknown, cookie = "") =>
                Effect.promise(() =>
                  web.handler(
                    new Request(`${origin}/api/auth${path}`, {
                      method: body === undefined ? "GET" : "POST",
                      headers: { origin, "content-type": "application/json", cookie },
                      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    }),
                  ),
                );
              const before = yield* request("/self-host/config");
              assert.deepEqual(yield* Effect.promise(() => before.json()), {
                setup: true,
                sso: false,
              });
              const setup = (email: string) =>
                request("/self-host/setup", {
                  name: "Owner",
                  email,
                  password: "synthetic-password-123",
                  organizationName: "Example",
                });
              const raced = yield* Effect.all(
                [setup("owner@example.test"), setup("other@example.test")],
                { concurrency: 2 },
              );
              assert.deepEqual(raced.map((r) => r.status).sort(), [200, 403]);
              const winner = raced.find((r) => r.status === 200);
              assert.ok(winner);
              const cookie = winner.headers
                .getSetCookie()
                .map((value) => value.split(";")[0])
                .join("; ");
              const members =
                yield* sql`select m.role, u.email from "member" m join "user" u on u.id = m."userId"`;
              assert.equal(members.length, 1);
              assert.equal(members[0]?.role, "owner");
              const email = String(members[0]?.email);
              const login = yield* request("/sign-in/email", {
                email,
                password: "synthetic-password-123",
              });
              assert.equal(login.status, 200);
              assert.equal(
                (yield* request("/sign-up/email", {
                  name: "Intruder",
                  email: "intruder@example.test",
                  password: "synthetic-password-123",
                })).status,
                400,
              );
              assert.equal(
                (yield* request("/sign-in/social", { provider: "google", callbackURL: "/apps" }))
                  .status,
                404,
              );
              assert.equal(
                (yield* request("/organization/create", { name: "Other", slug: "other" }, cookie))
                  .status,
                403,
              );
              const organizations = yield* sql`select id from "organization"`;
              const invite = yield* request(
                "/organization/invite-member",
                {
                  email: "member@example.test",
                  role: "member",
                  organizationId: organizations[0]?.id,
                },
                cookie,
              );
              assert.equal(invite.status, 200, yield* Effect.promise(() => invite.clone().text()));
              const invitation = yield* Effect.promise(() => invite.json());
              const id = String(invitation.id);
              const signup = (email: string) =>
                request("/self-host/register", {
                  invitation: id,
                  email,
                  name: "Member",
                  password: "synthetic-member-password",
                });
              assert.equal((yield* signup("wrong@example.test")).status, 403);
              const joined = yield* signup("member@example.test");
              assert.equal(joined.status, 200, yield* Effect.promise(() => joined.clone().text()));
              assert.equal((yield* signup("member@example.test")).status, 403);
              const allMembers = yield* sql`select role from "member" order by role`;
              assert.deepEqual(
                allMembers.map((row) => row.role),
                ["member", "owner"],
              );
              const user =
                yield* sql`select id, "emailVerified" from "user" where email = 'member@example.test'`;
              assert.equal(user[0]?.emailVerified, false);
              yield* sql`delete from "member" where "userId" = ${user[0]?.id}`;
              assert.equal(
                (yield* request("/sign-in/email", {
                  email: "member@example.test",
                  password: "synthetic-member-password",
                })).status,
                403,
              );
              const reinvite = yield* request(
                "/organization/invite-member",
                {
                  email: "member@example.test",
                  role: "member",
                  organizationId: organizations[0]?.id,
                },
                cookie,
              );
              assert.equal(reinvite.status, 200);
              const invitationAgain = yield* Effect.promise(() => reinvite.json());
              const rejoin = (password: string) =>
                request("/self-host/register", {
                  invitation: String(invitationAgain.id),
                  email: "member@example.test",
                  name: "Member",
                  password,
                });
              assert.equal((yield* rejoin("wrong-member-password")).status, 403);
              assert.equal((yield* rejoin("synthetic-member-password")).status, 200);
              assert.equal(
                (yield* sql`select id from "user" where email = 'member@example.test'`).length,
                1,
              );
            }).pipe(
              Effect.provide(selfHostDatabase),
              Effect.provideService(ConfigProvider.ConfigProvider, configuration),
            ),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ),
);
