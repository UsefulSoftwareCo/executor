import { executorSelfHostApiDocument } from "../src/contracts/api.ts";
import { memorySourceStorage } from "@executor-js/sdk/testing";
/** Persisted PGlite auth and product storage through the real self-host composition. */
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { betterAuth } from "better-auth";
import { makeSignature } from "better-auth/crypto";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { CompiledQuery } from "kysely";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { defaultUrlPolicy } from "@executor-js/utils/url-policy";
import { SqlClient } from "effect/unstable/sql";
import {
  Inventory,
  authOptions,
  authSettings,
  catalogLive,
  requireOrganizationLive,
  requireUserLive,
} from "@executor-js/hosted-server";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import {
  App,
  AccountConnection,
  Account,
  ToolPage,
  BuildId,
  OwnerId,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import { selfHostDatabase } from "../src/database.ts";
import { AuthDatabase, DatabaseUnavailable } from "../src/contracts/database.ts";
import { selfHostAuth } from "../src/auth.ts";
import { selfHostExecutor } from "../src/executor.ts";
import { hostedHandlers } from "@executor-js/hosted-server";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "@executor-js/hosted-server/contracts";

// This legacy fixture exercises shared handlers; full product composition is verified in e2e.
const selfHostApi = HttpApiBuilder.layer(HostedApi).pipe(Layer.provide(hostedHandlers));
import { Authentication, OrganizationForbidden, OrganizationId } from "@executor-js/hosted-server";

const secret = "synthetic-storage-auth-signing-key-only";
const encryptionKey = "ab".repeat(32);
const origin = "http://127.0.0.1:55438";
test(
  "PGlite preserves auth and SDK data across restart, enforces isolation and current membership",
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-self-host-" });
          const configuration = ConfigProvider.fromUnknown({
            EXECUTOR_DATA_DIR: directory,
            BETTER_AUTH_URL: origin,
            BETTER_AUTH_SECRET: secret,
            EXECUTOR_ENCRYPTION_KEY: encryptionKey,
            GOOGLE_CLIENT_ID: "synthetic-google",
            GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
            GITHUB_CLIENT_ID: "synthetic-github",
            GITHUB_CLIENT_SECRET: "synthetic-github-secret",
          });
          const configured = selfHostDatabase.pipe(
            Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, configuration)),
          );
          const saved = yield* Effect.scoped(
            Effect.gen(function* () {
              const pool = yield* AuthDatabase;
              const conflict = yield* Effect.scoped(
                Effect.void.pipe(Effect.provide(Layer.fresh(configured))),
              ).pipe(Effect.flip);
              assert.ok(Schema.is(DatabaseUnavailable)(conflict));
              const settings = yield* authSettings;
              const options = { ...authOptions(settings, []), database: pool, secret };
              yield* migrateHostedSchemas(options);
              const auth = betterAuth(options);
              const context = yield* Effect.promise(() => auth.$context);
              const suffix = crypto.randomUUID();
              const alice = yield* Effect.promise(() =>
                context.internalAdapter.createUser(
                  { name: "Alice", email: `alice-${suffix}@example.test`, emailVerified: true },
                  { method: "admin" },
                ),
              );
              const bob = yield* Effect.promise(() =>
                context.internalAdapter.createUser(
                  { name: "Bob", email: `bob-${suffix}@example.test`, emailVerified: true },
                  { method: "admin" },
                ),
              );
              const session = yield* Effect.promise(() =>
                context.internalAdapter.createSession(alice.id),
              );
              const signature = yield* Effect.promise(() => makeSignature(session.token, secret));
              const cookie = `executor-hosted.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
              const headers = new Headers({ cookie, origin });
              const a = yield* Effect.promise(() =>
                auth.api.createOrganization({
                  body: { name: "Alpha", slug: `alpha-${suffix}`, userId: alice.id },
                }),
              );
              const b = yield* Effect.promise(() =>
                auth.api.createOrganization({
                  body: { name: "Beta", slug: `beta-${suffix}`, userId: bob.id },
                }),
              );
              assert.ok(a && b);
              const ownerA = OwnerId.make(`organization:${a.id}`);
              const ownerB = OwnerId.make(`organization:${b.id}`);
              const storage = yield* makeExecutorStorage({ provider: "postgresql" });
              const credentials = yield* aesGcmCredentials(Redacted.make(encryptionKey), crypto);
              const executor = yield* createExecutor({
                blobs: memoryBlobStore(),
                sources: memorySourceStorage(),
                storage,
                credentials,
                runtime: runtimeAdapter({
                  build: () =>
                    Effect.succeed({
                      build: BuildId.make("bld_fixture"),
                      requirements: {
                        accounts: {
                          service: {
                            cardinality: "one",
                            definition: {
                              name: "Synthetic",
                              auth: {
                                key: {
                                  type: "secrets",
                                  label: "API key",
                                  fields: {
                                    type: "object",
                                    properties: { token: { type: "string" } },
                                    required: ["token"],
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    }),
                  workflow: () => Effect.die("Unexpected workflow invocation"),
                  webhook: () => Effect.die("Unexpected webhook invocation"),
                  skills: () => Effect.die("This fixture does not load skills"),
                  inspect: () => Effect.succeed([]),
                  query: () => Effect.succeed(null),
                  mutate: () => Effect.succeed(null),
                  call: () => Effect.succeed(null),
                }),
              });
              const { app } = yield* executor.apps.deploy({
                owner: ownerA,
                name: "Example",
                files: [{ path: "index.ts", content: "synthetic test source" }],
              });
              const provider = app.requirements.accounts.service?.provider;
              assert.ok(provider);
              const one = yield* executor.accounts.add({
                owner: ownerA,
                provider,
                method: "key",
                label: "Alpha account",
                fields: Redacted.make({ token: "synthetic-token" }),
              });
              const two = yield* executor.accounts.add({
                owner: ownerB,
                provider,
                method: "key",
                label: "Beta account",
                fields: Redacted.make({ token: "other-synthetic-token" }),
              });
              const profile = yield* executor.apps.profiles.create({
                app: app.id,
                owner: ownerA,
                subject: alice.id,
                idempotencyKey: "test",
                accounts: { service: one.id },
              });
              // Re-running each owner's migrator preserves both sides of the shared database.
              yield* migrateHostedSchemas(options);
              assert.equal(
                (yield* Effect.promise(() => auth.api.getSession({ headers })))?.user.id,
                alice.id,
              );
              assert.deepEqual(
                yield* executor.accounts.get({ account: one.id, owner: ownerA }),
                one,
              );
              assert.deepEqual(
                (yield* executor.apps.profiles.get({ app: app.id, profile: profile.id })).accounts,
                {
                  service: one.id,
                },
              );

              const started = yield* Deferred.make<void>();
              const labels: string[][] = [];
              const subscriber = yield* storage.reactivity
                .subscribe(executor.accounts.list({ owner: ownerA }))
                .pipe(
                  Stream.take(2),
                  Stream.runForEach(({ value }) =>
                    Effect.gen(function* () {
                      labels.push(value.map((account) => account.label));
                      yield* Deferred.succeed(started, undefined);
                    }),
                  ),
                  Effect.forkChild,
                );
              yield* Deferred.await(started);
              yield* storage
                .orm("4.0.0")
                .transaction(
                  executor.accounts
                    .update({ owner: ownerA, account: one.id, label: "Rolled back" })
                    .pipe(Effect.andThen(Effect.fail("rollback"))),
                )
                .pipe(Effect.result);
              assert.equal((yield* executor.accounts.get({ account: one.id })).label, one.label);
              yield* executor.accounts.update({
                owner: ownerA,
                account: one.id,
                label: "Committed",
              });
              yield* Fiber.join(subscriber);
              assert.deepEqual(labels, [[one.label], ["Committed"]]);

              // An auth transaction must hold the same reservation as SDK writes.
              const held = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const authTransaction = yield* Effect.promise(() =>
                pool.db.transaction().execute(async (transaction) => {
                  await transaction.executeQuery(CompiledQuery.raw("select 1"));
                  await Effect.runPromise(Deferred.succeed(held, undefined));
                  await Effect.runPromise(Deferred.await(release));
                }),
              ).pipe(Effect.forkChild);
              yield* Deferred.await(held);
              const finished = yield* Ref.make(false);
              const accountWrite = yield* executor.accounts
                .update({ owner: ownerA, account: one.id, label: "After auth transaction" })
                .pipe(
                  Effect.tap(() => Ref.set(finished, true)),
                  Effect.forkChild,
                );
              yield* Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                assert.equal(yield* Ref.get(finished), false);
              }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
              yield* Fiber.join(authTransaction);
              yield* Fiber.join(accountWrite);
              assert.equal(
                (yield* executor.accounts.get({ account: one.id })).label,
                "After auth transaction",
              );

              const identity = yield* selfHostAuth;
              // This fixture composes the real routes; it never leaves loopback.
              const egress = {
                policy: defaultUrlPolicy,
                client: yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)),
              };
              const services = yield* Effect.context<AuthDatabase | SqlClient.SqlClient>();
              const routes = selfHostApi.pipe(
                HttpRouter.provideRequest(
                  catalogLive([], executorSelfHostApiDocument(origin), egress),
                ),
                HttpRouter.provideRequest(selfHostExecutor([], egress)),
                Layer.provide(requireUserLive),
                Layer.provide(requireOrganizationLive),
                Layer.provide(identity.identity),
                Layer.provide(identity.apiIdentity),
                Layer.provide(HttpServer.layerServices),
                Layer.provide(Layer.succeedContext(services)),
                Layer.provide(NodeServices.layer),
              );
              const web = yield* Effect.acquireRelease(
                Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
                (web) => Effect.promise(() => web.dispose()),
              );
              const request = (path: string, init?: RequestInit) =>
                Effect.promise(() =>
                  web.handler(new Request(`${origin}${path}`, { headers, ...init })),
                );
              const own = yield* request(`/api/organizations/${a.id}/inventory`);
              assert.equal(own.status, 200);
              const inventory = yield* Effect.promise(() => own.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(Inventory))),
              );
              const installedExecutor = inventory.apps.find((app) => app.name === "Executor");
              assert.ok(installedExecutor);
              assert.ok(installedExecutor.requirements.accounts.service);
              assert.equal(installedExecutor.owner, ownerA);
              yield* executor.apps.remove({ owner: ownerA, app: installedExecutor.id });
              const afterDelete = yield* request(`/api/organizations/${a.id}/inventory`).pipe(
                Effect.flatMap((response) => Effect.promise(() => response.json())),
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(Inventory))),
              );
              assert.ok(!afterDelete.apps.some((app) => app.name === "Executor"));
              assert.equal(inventory.accounts.length, 1);
              assert.equal(inventory.accounts[0]?.id, one.id);
              assert.equal((yield* request(`/api/organizations/${b.id}/inventory`)).status, 403);
              const renamed = yield* request(`/api/organizations/${a.id}/accounts/${one.id}`, {
                method: "PATCH",
                headers: { cookie, origin, "content-type": "application/json" },
                body: JSON.stringify({ label: "Renamed" }),
              });
              assert.equal(renamed.status, 200);
              const foreign = yield* request(`/api/organizations/${a.id}/accounts/${two.id}`, {
                method: "PATCH",
                headers: { cookie, origin, "content-type": "application/json" },
                body: JSON.stringify({ label: "Forbidden" }),
              });
              assert.equal(foreign.status, 404);
              assert.equal(
                (yield* executor.accounts.get({ account: two.id, owner: ownerB })).label,
                two.label,
              );
              const post = (path: string, body: unknown) =>
                request(`/api/organizations/${a.id}${path}`, {
                  method: "POST",
                  headers: { cookie, origin, "content-type": "application/json" },
                  body: JSON.stringify(body),
                });
              const source = `import { query, mutation, defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "HTTP fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ accounts: { service } }, async (appContext) => ({  mutations: { hello: mutation({ description: "Say hello",
            input: object({}) }, async (operationContext, _input) => {
            const { accounts } = { ...appContext, ...operationContext };
            return ({ connected: accounts.service.fields.token === "synthetic-http-token" });
        }) } }));
`;
              const deployed = yield* post("/apps/deploy", {
                name: "HTTP fixture",
                files: [{ path: "index.ts", content: source }],
              });
              assert.equal(
                deployed.status,
                200,
                yield* Effect.promise(() => deployed.clone().text()),
              );
              const installed = yield* Effect.promise(() => deployed.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(App))),
              );
              const pending = yield* post(`/apps/${installed.id}/connections`, {
                requirement: "service",
              });
              assert.equal(pending.status, 200);
              const connection = yield* Effect.promise(() => pending.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(AccountConnection))),
              );
              const submitted = yield* post(`/connections/${connection.id}/submit`, {
                method: "key",
                label: "Default",
                fields: { token: "synthetic-http-token" },
              });
              assert.equal(submitted.status, 200);
              const connected = yield* Effect.promise(() => submitted.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(Account))),
              );
              assert.ok(!JSON.stringify(connected).includes("synthetic-http-token"));
              const loaded = yield* request(
                `/api/organizations/${a.id}/apps/${installed.id}/tools`,
              );
              assert.equal(loaded.status, 200);
              const tools = yield* Effect.promise(() => loaded.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(ToolPage))),
              );
              assert.equal(tools.items[0]?.name, "hello");
              const invoked = yield* post(`/apps/${installed.id}/tools/call`, {
                tool: "mutations.hello",
                input: {},
              });
              assert.deepEqual(yield* Effect.promise(() => invoked.json()), { connected: true });
              assert.equal(
                (yield* request(`/api/organizations/${b.id}/apps/${installed.id}`)).status,
                403,
              );
              const sql = yield* SqlClient.SqlClient;
              yield* sql`update "member" set "role" = 'member' where "userId" = ${alice.id} and "organizationId" = ${a.id}`;
              assert.equal(
                (yield* request(`/api/organizations/${a.id}/apps/${installed.id}`)).status,
                200,
              );
              assert.equal(
                (yield* post(`/apps/${installed.id}/tools/call`, {
                  tool: "mutations.hello",
                  input: {},
                })).status,
                403,
              );
              assert.equal(
                (yield* post(`/connections/${connection.id}/submit`, {
                  method: "key",
                  label: "No",
                  fields: { token: "no" },
                })).status,
                403,
              );
              yield* sql`update "member" set "role" = 'owner' where "userId" = ${alice.id} and "organizationId" = ${a.id}`;
              const removed = yield* request(`/api/organizations/${a.id}/apps/${installed.id}`, {
                method: "DELETE",
                headers: { cookie, origin },
              });
              assert.equal(removed.status, 200);
              // Snapshot identities before closing the database and running startup migrations again.
              return {
                cookie,
                alice: alice.id,
                organization: a.id,
                one: one.id,
                two: two.id,
                app: app.id,
              };
            }).pipe(
              Effect.provide(Layer.fresh(configured)),
              Effect.provideService(ConfigProvider.ConfigProvider, configuration),
            ),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const database = yield* AuthDatabase;
              const settings = yield* authSettings;
              const auth = betterAuth({ ...authOptions(settings, []), database, secret });
              const headers = new Headers({ cookie: saved.cookie, origin });
              assert.equal(
                (yield* Effect.promise(() => auth.api.getSession({ headers })))?.user.id,
                saved.alice,
              );
              const storage = yield* makeExecutorStorage({ provider: "postgresql" });
              const accounts = yield* storage.orm("4.0.0").findMany("accounts");
              assert.equal(accounts.find((account) => account.id === saved.one)?.label, "Renamed");
              assert.equal(
                accounts.find((account) => account.id === saved.two)?.label,
                "Beta account",
              );
              const apps = yield* storage.orm("4.0.0").findMany("apps");
              assert.equal(apps[0]?.id, saved.app);
              // Revocation uses current membership, not the session's remembered organization.
              const identity = yield* selfHostAuth;
              const sql = yield* SqlClient.SqlClient;
              yield* sql`delete from "member" where "userId" = ${saved.alice} and "organizationId" = ${saved.organization}`;
              const service = yield* Layer.build(identity.identity);
              const current = yield* Authentication.pipe(Effect.provideContext(service));
              const denied = yield* current
                .membership(headers, OrganizationId.make(saved.organization))
                .pipe(Effect.flip);
              assert.ok(Schema.is(OrganizationForbidden)(denied));
            }).pipe(
              Effect.provide(Layer.fresh(configured)),
              Effect.provideService(ConfigProvider.ConfigProvider, configuration),
            ),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ),
);
