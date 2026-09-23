/** Local role shortcuts must issue real sessions without becoming a production auth route. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Authentication } from "@executor-js/hosted-server";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Redacted, Schema } from "effect";
import { DevtoolsState } from "@executor-js/devtools/contracts";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { AuthDatabase } from "../self-host/src/contracts/database.ts";
import { testAccountAuth } from "./accounts.ts";
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
                  HttpRouter.add("POST", "/api/devtools/account", dev.signIn),
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
          const publicConfig = yield* Effect.promise(() => configuration.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsState)),
          );
          assert.ok(publicConfig.kind === "accounts");
          assert.deepEqual(publicConfig.accounts.map((account) => account.role).sort(), [
            "admin",
            "member",
            "owner",
          ]);
          const member = publicConfig.accounts.find((account) => account.role === "member");
          assert.ok(member);
          const selection = { organization: publicConfig.organization.id, userId: member.id };
          const endpoint = "/api/devtools/account";
          assert.equal(
            (yield* request(endpoint, selection, { origin: "https://example.com" })).status,
            403,
          );
          assert.equal(
            (yield* request(endpoint, selection, { host: "rebinding.example.com:55453" })).status,
            403,
          );
          assert.equal((yield* request(endpoint, { role: "superadmin" })).status, 400);
          assert.equal((yield* request(endpoint)).headers.get("set-cookie"), null);
          const first = yield* request(endpoint, selection);
          const second = yield* request(endpoint, selection);
          assert.equal(first.status, 200);
          assert.equal(second.status, 200);
          const cookie = Schema.decodeUnknownSync(Schema.NonEmptyString)(
            first.headers.getSetCookie()[0],
          );
          assert.ok(cookie.includes("HttpOnly"));
          assert.notEqual(second.headers.get("set-cookie"), first.headers.get("set-cookie"));
          const headers = new Headers({
            cookie: first.headers
              .getSetCookie()
              .map((cookie) => cookie.split(";")[0])
              .join("; "),
          });
          const active = yield* request("/api/devtools", undefined, {
            cookie: Schema.decodeUnknownSync(Schema.NonEmptyString)(headers.get("cookie")),
          });
          const activeState = yield* Effect.promise(() => active.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsState)),
          );
          assert.ok(activeState.kind === "accounts");
          assert.equal(activeState.selected, member.id);
          assert.equal(activeState.impersonating, true);
          const currentSession = yield* request("/api/auth/get-session", undefined, {
            cookie: Schema.decodeUnknownSync(Schema.NonEmptyString)(headers.get("cookie")),
          });
          const sessionMetadata = yield* Effect.promise(() => currentSession.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  session: Schema.Struct({ impersonatedBy: Schema.NonEmptyString }),
                  user: Schema.Struct({ id: Schema.String }),
                }),
              ),
            ),
          );
          assert.equal(sessionMetadata.user.id, member.id);
          assert.equal(sessionMetadata.session.impersonatedBy, "executor-devtools-operator");
          const forbiddenAdmin = yield* request(
            "/api/auth/admin/impersonate-user",
            { userId: publicConfig.accounts.find((account) => account.role === "owner")?.id },
            { cookie: Schema.decodeUnknownSync(Schema.NonEmptyString)(headers.get("cookie")) },
          );
          assert.equal(forbiddenAdmin.status, 403);
          yield* Effect.gen(function* () {
            const auth = yield* Authentication;
            assert.ok(yield* auth.current(headers));
          }).pipe(Effect.provide(native.identity));
          const ownerAccount = publicConfig.accounts.find((account) => account.role === "owner");
          assert.ok(ownerAccount);
          const ownerLogin = yield* request(endpoint, {
            organization: publicConfig.organization.id,
            userId: ownerAccount.id,
          });
          const ownerCookie = ownerLogin.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0])
            .join("; ");
          assert.equal(
            (yield* request("/api/auth/admin/list-users", undefined, { cookie: ownerCookie }))
              .status,
            403,
          );
          const fixtures = testAccountAuth({
            origin,
            secret: Redacted.make(settings.BETTER_AUTH_SECRET),
            cookiePrefix: "executor-hosted",
            database: yield* AuthDatabase,
          });
          const fixtureContext = yield* Effect.promise(() => fixtures.$context);
          yield* Effect.promise(async () => {
            if (!fixtureContext.test.addMember)
              throw new Error("Fixture membership helper missing");
            for (let index = 0; index < 102; index++) {
              const user = await fixtureContext.test.saveUser(
                fixtureContext.test.createUser({
                  name: `Additional person ${index}`,
                  email: `additional-${index}@example.test`,
                  emailVerified: true,
                }),
              );
              await fixtureContext.test.addMember({
                userId: user.id,
                organizationId: publicConfig.organization.id,
                role: "member",
              });
            }
          });
          const expanded = yield* request("/api/devtools")
            .pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsState)));
          assert.ok(expanded.kind === "accounts");
          assert.equal(expanded.accounts.length, 105);
          assert.equal(new Set(expanded.accounts.map((account) => account.id)).size, 105);
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
          const normalConfig = yield* Effect.promise(() =>
            normal.handler(new Request(origin + "/api/auth/self-host/config")),
          );
          assert.deepEqual(yield* Effect.promise(() => normalConfig.json()), {
            setup: false,
            sso: false,
          });
          const denied = yield* Effect.promise(() =>
            normal.handler(
              new Request(origin + endpoint, {
                method: "POST",
                headers: { origin, "content-type": "application/json" },
                body: JSON.stringify({ role: "owner" }),
              }),
            ),
          );
          assert.equal(denied.status, 404);
          assert.equal(denied.headers.get("set-cookie"), null);
          const foreign = yield* Effect.promise(async () => {
            const test = fixtureContext.test;
            if (!test.createOrganization || !test.saveOrganization || !test.addMember)
              throw new Error("Organization fixtures unavailable");
            const organization = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
              await test.saveOrganization(
                test.createOrganization({ name: "Other organization", slug: "other-devtools" }),
              ),
            );
            const user = await test.saveUser(
              test.createUser({
                name: "Robin Ellis",
                email: "robin@example.test",
                emailVerified: true,
              }),
            );
            await test.addMember({
              organizationId: organization.id,
              userId: user.id,
              role: "member",
            });
            return { organization, user };
          });
          const otherDirectory = yield* request("/api/devtools?organization=other-devtools").pipe(
            Effect.flatMap((response) => Effect.promise(() => response.json())),
            Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsState)),
          );
          assert.ok(otherDirectory.kind === "accounts");
          assert.equal(otherDirectory.organization.id, foreign.organization.id);
          assert.deepEqual(
            otherDirectory.accounts.map((account) => account.id),
            [foreign.user.id],
          );
          const crossOrganization = yield* request(endpoint, {
            organization: publicConfig.organization.id,
            userId: foreign.user.id,
          });
          assert.equal(crossOrganization.status, 403);
          assert.equal(crossOrganization.headers.get("set-cookie"), null);
          assert.equal(
            (yield* request(endpoint, {
              organization: foreign.organization.id,
              userId: foreign.user.id,
            })).status,
            200,
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
