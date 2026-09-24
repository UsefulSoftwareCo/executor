/** Local role shortcuts must issue real sessions without becoming a production auth route. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { selfHostDatabase } from "../self-host/src/database.ts";
import { selfHostAuth } from "../self-host/src/auth.ts";
import { developmentSettings, developmentSignIn } from "./development.ts";

const origin = "http://member-test.localhost:55453";
const settings = {
  NODE_ENV: "test",
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: "synthetic-development-signing-secret-1234",
  EXECUTOR_DATA_DIR: "unused",
};

test("test server refuses production mode, public targets, and HTTPS it cannot serve", async () => {
  for (const overrides of [
    { NODE_ENV: "production" },
    { BETTER_AUTH_URL: "http://example.com:4400" },
    { BETTER_AUTH_URL: "https://member-test.localhost:4400" },
  ]) {
    const result = await Effect.runPromise(
      Effect.exit(
        developmentSettings.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ...settings, ...overrides }),
          ),
        ),
      ),
    );
    assert.ok(Exit.isFailure(result));
  }
});

test("member picker uses same-origin POSTs, refreshes sessions, and stays absent from normal auth", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* Effect.gen(function* () {
          const target = yield* developmentSettings;
          const dev = yield* developmentSignIn(target, "agent-tests");
          const native = yield* selfHostAuth;
          const web = yield* Effect.acquireRelease(
            Effect.sync(() =>
              HttpRouter.toWebHandler(
                Layer.mergeAll(
                  HttpRouter.add("GET", "/api/devtools", dev.status),
                  HttpRouter.add("POST", "/api/devtools/operator", dev.signIn),
                  HttpRouter.add("*", "/api/auth/*", native.handler),
                ).pipe(Layer.provide(HttpServer.layerServices)),
                { disableLogger: true },
              ),
            ),
            (web) => Effect.promise(() => web.dispose()),
          );
          const request = (path: string, body?: unknown, headers?: Record<string, string>) =>
            Effect.promise(() =>
              web.handler(
                new Request(origin + path, {
                  method: body === undefined ? "GET" : "POST",
                  headers: {
                    host: new URL(origin).host,
                    origin,
                    "content-type": "application/json",
                    ...headers,
                  },
                  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
              ),
            );
          const configuration = yield* request("/api/devtools");
          assert.equal(configuration.status, 200);
          assert.deepEqual(yield* Effect.promise(() => configuration.json()), {
            kind: "operator",
            host: "self-host",
          });
          for (const headers of [{ origin: "https://example.com" }, { host: "example.com" }]) {
            const denied = yield* request("/api/devtools/operator", {}, headers);
            assert.equal(denied.status, 403);
            assert.equal(denied.headers.get("set-cookie"), null);
          }
          assert.equal((yield* request("/api/auth/admin/list-users")).status, 401);
          const login = yield* request("/api/devtools/operator", {});
          assert.equal(login.status, 200);
          const cookie = login.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          const directory = yield* request("/api/auth/admin/list-users", undefined, { cookie });
          assert.equal(directory.status, 200);
          const users = yield* Effect.promise(() => directory.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  users: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
                }),
              ),
            ),
          );
          const member = users.users.find(
            (user) => user.email === "agent-rhys-member@example.test",
          );
          assert.ok(member);
          const switched = yield* request(
            "/api/auth/admin/impersonate-user",
            { userId: member.id },
            { cookie },
          );
          assert.equal(switched.status, 200);
          const switchedCookie = switched.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          const current = yield* request("/api/auth/get-session", undefined, {
            cookie: switchedCookie,
          });
          const identity = yield* Effect.promise(() => current.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  user: Schema.Struct({ id: Schema.String }),
                  session: Schema.Struct({ impersonatedBy: Schema.String }),
                }),
              ),
            ),
          );
          assert.equal(identity.user.id, member.id);
          assert.equal(identity.session.impersonatedBy, "executor-devtools-operator");
          assert.equal(
            (yield* request("/api/auth/admin/list-users", undefined, { cookie: switchedCookie }))
              .status,
            403,
          );
          const stopped = yield* request(
            "/api/auth/admin/stop-impersonating",
            {},
            { cookie: switchedCookie },
          );
          assert.equal(stopped.status, 200);
          const restoredCookie = stopped.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          assert.equal(
            (yield* request("/api/auth/admin/list-users", undefined, { cookie: restoredCookie }))
              .status,
            200,
          );
          const normal = yield* Effect.acquireRelease(
            Effect.sync(() =>
              HttpRouter.toWebHandler(
                HttpRouter.add("*", "/api/auth/*", native.handler).pipe(
                  Layer.provide(HttpServer.layerServices),
                ),
                { disableLogger: true },
              ),
            ),
            (web) => Effect.promise(() => web.dispose()),
          );
          assert.equal(
            (yield* Effect.promise(() =>
              normal.handler(
                new Request(origin + "/api/devtools/operator", {
                  method: "POST",
                  headers: { origin },
                }),
              ),
            )).status,
            404,
          );
        }).pipe(
          Effect.provide(selfHostDatabase),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ...settings, EXECUTOR_DATA_DIR: directory }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ));
