import { readExecutorSkills } from "@executor-js/app-templates/executor";
import { teamAppPending } from "@executor-js/hosted-server/provisioning";
import { AppManagementHost } from "@executor-js/app-management";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import { executorSelfHostApiDocument } from "../src/contracts/api.ts";
import { OrganizationId as ReferenceOrganizationId } from "@executor-js/hosted-server";
import { memorySourceStorage } from "@executor-js/sdk/testing";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Redacted, Schema, Option, Deferred } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  createExecutor,
  makeExecutorStorage,
  aesGcmCredentials,
  runtimeAdapter,
  RuntimeBuildFailed,
  type Executor,
} from "@executor-js/sdk/core";
import {
  Authentication,
  ApiAuthentication,
  CurrentOrganization,
  HostedCatalog,
  HostedExecutor,
  OrganizationDefaults,
  OrganizationId,
  organizationDefaults,
  organizationOwner,
  requireUserLive,
  requireOrganizationLive,
  hostedMcpBackend,
  OrganizationIcons,
  makeOrganizationIcons,
} from "@executor-js/hosted-server";
import { Principal, Unauthorized } from "../../server/src/contracts/auth.ts";
import { authOptions } from "@executor-js/hosted-server";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import { makeAuthDatabase } from "../src/implementation/auth-database.ts";
import { CurrentUserId } from "../../server/src/contracts/auth.ts";
import { execute, defaultMcpLimits } from "@executor-js/mcp";
import { hostedHandlers } from "@executor-js/hosted-server";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "@executor-js/hosted-server/contracts";

// This legacy fixture exercises shared handlers; full product composition is verified in e2e.
const selfHostApi = HttpApiBuilder.layer(HostedApi).pipe(
  Layer.provide(hostedHandlers),
  HttpRouter.provideRequest(
    Layer.succeed(AppManagementHost, Effect.die("App authoring is outside this fixture")),
  ),
);

import { workerdApps } from "@executor-js/sdk/node";

const origin = "https://executor.example.test";

test("inventory and MCP reads succeed without invoking a failing default provisioner", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table "organization" (id text primary key, metadata text)`;
        yield* sql`create table member (id text, "organizationId" text, "userId" text, role text)`;
        yield* sql`insert into "organization" (id) values ('org_source'), ('org_build')`;
        yield* sql`insert into member values ('m1', 'org_source', 'fixture', 'owner'), ('m2', 'org_build', 'fixture', 'owner')`;
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
        const executor = yield* createExecutor({
          blobs: memoryBlobStore(),
          sources: memorySourceStorage(),
          storage,
          credentials,
          runtime: runtimeAdapter({
            build: () => Effect.fail(new RuntimeBuildFailed({ stage: "compile" })),
            workflow: () => Effect.die("Unexpected workflow invocation"),
            webhook: () => Effect.die("Unexpected webhook invocation"),
            skills: () => Effect.die("This fixture does not load skills"),
            inspect: () => Effect.die("No build should be available"),
            index: () => Effect.die("No build should be available"),
            call: () => Effect.die("No build should be available"),
            query: () => Effect.die("No build should be available"),
            mutate: () => Effect.die("No build should be available"),
          }),
        });
        const normal = yield* organizationDefaults(
          executor,
          origin,
          storage,
          [],
          executorSelfHostApiDocument(origin),
        );
        const invalidSource = yield* organizationDefaults(
          executor,
          "ftp://executor.example.test",
          storage,
          [],
          executorSelfHostApiDocument(origin),
        );
        const initialize = OrganizationDefaults.of((organization) =>
          organization === "org_source" ? invalidSource(organization) : normal(organization),
        );
        const principal = Schema.decodeUnknownSync(Principal)({
          userId: "fixture",
          sessionId: "fixture",
          name: "Fixture",
        });
        const routes = selfHostApi.pipe(
          HttpRouter.provideRequest(
            Layer.succeed(GroupDatabase, Effect.succeed(yield* SqlClient.SqlClient)),
          ),
          HttpRouter.provideRequest(Layer.succeed(HostedExecutor, Effect.succeed(executor))),
          HttpRouter.provideRequest(Layer.succeed(OrganizationDefaults, initialize)),
          HttpRouter.provideRequest(
            Layer.succeed(HostedCatalog, {
              list: Effect.succeed([]),
              prepare: () => Effect.die("Not used"),
              custom: () => Effect.die("This fixture does not import custom apps"),
            }),
          ),
          Layer.provide(requireUserLive),
          Layer.provide(requireOrganizationLive),
          Layer.provide(
            Layer.succeed(Authentication, {
              origin,
              organization: (reference) => Effect.succeed(ReferenceOrganizationId.make(reference)),
              organizationSlug: () => Effect.succeed("fixture"),
              current: () => Effect.succeed(principal),
              membership: () => Effect.succeed({ role: "owner", headers: new Headers() }),
              removeOrganization: () => Effect.die("Organization removal is outside this fixture"),
            }),
          ),
          Layer.provide(
            Layer.succeed(ApiAuthentication, {
              origin,
              authenticate: () => Effect.fail(new Unauthorized()),
            }),
          ),
          HttpRouter.provideRequest(
            Layer.succeed(OrganizationIcons, makeOrganizationIcons(memoryBlobStore())),
          ),
          Layer.provide(HttpServer.layerServices),
        );
        const web = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (web) => Effect.promise(() => web.dispose()),
        );
        for (const id of ["org_source", "org_build"] as const) {
          const response = yield* Effect.promise(() =>
            web.handler(new Request(`${origin}/api/organizations/${id}/inventory`)),
          );
          assert.equal(
            response.status,
            200,
            `${id}: ${yield* Effect.promise(() => response.clone().text())}`,
          );
          const data = yield* Effect.promise(() => response.json());
          assert.deepEqual(data.apps, []);
          const organization = OrganizationId.make(id);
          const backend = yield* hostedMcpBackend.pipe(
            Effect.provideService(CurrentUserId, "fixture"),
            Effect.provideService(HostedExecutor, Effect.succeed(executor)),
            Effect.provideService(GroupDatabase, Effect.succeed(sql)),
            Effect.provideService(OrganizationDefaults, initialize),
            Effect.provideService(CurrentOrganization, {
              organization,
              owner: organizationOwner(organization),
              role: "owner",
            }),
          );
          const result = yield* execute(backend, defaultMcpLimits, "return await tools.search({})");
          assert.equal(result.execution.ok, true);
        }
        const rows = yield* sql`select metadata from "organization"`;
        assert.ok(
          rows.every((row) => row.metadata === null),
          "failed setup must remain retryable",
        );
        assert.deepEqual(yield* executor.apps.list(), []);
      }),
    ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeServices.layer)),
  ));

test(
  "completed default setup works in a read-only transaction without reading the user key",
  { timeout: 40_000 },
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const database = {
            db: yield* makeAuthDatabase,
            type: "postgres" as const,
            transaction: true,
          };
          yield* migrateHostedSchemas({
            ...authOptions(
              {
                url: origin,
                oauthRedirectUri: Option.none(),
              },
              [],
            ),
            database,
            secret: "synthetic-auth-secret-at-least-32-chars",
          });
          const organization = OrganizationId.make("org_repeat");
          yield* sql`insert into "organization" (id, name, slug, "createdAt") values (${organization}, 'Fixture', 'fixture', now())`;
          yield* sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('fixture', 'Fixture', 'fixture@example.test', true, now(), now())`;
          yield* sql`insert into member (id, "organizationId", "userId", role, "createdAt") values ('fixture-member', ${organization}, 'fixture', 'owner', now())`;
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-defaults-" });
          const storage = yield* makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          const credentials = yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto);
          const ready = yield* Deferred.make<Executor>();
          const blobs = memoryBlobStore();
          const { runtime } = yield* workerdApps({
            directory,
            blobs,
            executor: Deferred.await(ready),
            allowPrivateAppFetch: false,
          });
          const executor = yield* createExecutor({
            blobs,
            sources: memorySourceStorage(),
            storage,
            credentials,
            runtime,
          });
          yield* Deferred.succeed(ready, executor);
          const initialize = yield* organizationDefaults(
            executor,
            origin,
            storage,
            yield* readExecutorSkills,
            executorSelfHostApiDocument(origin),
          );
          const user = {
            userId: "fixture",
            name: "Fixture",
          };
          assert.equal(yield* teamAppPending(organization), true);
          yield* initialize(organization);
          assert.equal(yield* teamAppPending(organization), false);
          // A deployed app suppresses the skeleton even before completion metadata commits.
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`update organization set metadata = null where id = ${organization}`;
                assert.equal(yield* teamAppPending(organization), false);
                return yield* Effect.fail("rollback");
              }),
            )
            .pipe(Effect.flip);
          yield* sql
            .withTransaction(
              initialize(organization, user).pipe(Effect.andThen(Effect.fail("rollback"))),
            )
            .pipe(Effect.flip);
          assert.equal((yield* sql`select id from apikey`).length, 0);
          assert.equal(
            (yield* executor.accounts.list({ owner: organizationOwner(organization) })).length,
            0,
          );
          yield* Effect.forEach([0, 1, 2, 3], () => initialize(organization, user), {
            concurrency: 4,
          });
          assert.equal((yield* sql`select id from apikey`).length, 1);
          const owner = organizationOwner(organization);
          const before = yield* executor.apps.list({ owner });
          assert.equal(before.length, 1);
          const app = before[0];
          assert.ok(app);
          const profile = (yield* executor.apps.profiles.list({
            app: app.id,
            owner,
            subject: user.userId,
          }))[0];
          assert.ok(profile);
          assert.equal(Object.hasOwn(app, "accounts"), false);
          const account = profile.accounts.service;
          assert.equal(typeof account, "string");
          yield* storage.orm("4.0.0").transaction(
            Effect.gen(function* () {
              yield* sql`set transaction read only`;
              for (let i = 0; i < 3; i++) {
                yield* initialize(organization, user);
              }
            }),
          );
          assert.deepEqual(yield* executor.apps.list({ owner }), before);
          const saved = yield* executor.accounts.list({ owner });
          assert.equal(saved.length, 1);
          assert.equal(saved[0]?.id, account);
          const originalAccount = saved[0];
          assert.ok(originalAccount);
          yield* executor.accounts.remove({ owner, account: originalAccount.id });
          yield* initialize(organization, user);
          assert.deepEqual(yield* executor.accounts.list({ owner }), []);
          // This bare SDK fixture retains missing references; the hosted deletion
          // journey separately verifies its transactional selection cleanup.
          assert.equal(
            (yield* executor.apps.profiles.get({
              owner,
              app: app.id,
              profile: profile.id,
            })).accounts.service,
            originalAccount.id,
          );
          yield* executor.apps.remove({ owner, app: app.id });
          assert.equal(yield* teamAppPending(organization), false);
          yield* initialize(organization, user);
          assert.deepEqual(yield* executor.apps.list({ owner }), []);
        }),
      ).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeServices.layer)),
    ),
);
